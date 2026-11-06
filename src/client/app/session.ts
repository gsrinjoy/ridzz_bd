import { batch, effect } from '@preact/signals';
import type { AlertKind, ClientMessage, LocTuple, Position, RideInfo, Rider, ServerMessage, VoiceConfig } from '../../shared/protocol';
import { LocationTracker } from '../modules/location/tracker';
import { RideShell } from '../modules/power/rideShell';
import { ScreenWake } from '../modules/power/wakeLock';
import { RideSocket } from '../modules/ride/socket';
import { finishLog, flushLogs, restoreActive, saveActive } from '../modules/stats/logStore';
import { localDate, RideRecorder } from '../modules/stats/recorder';
import { CueDirector } from '../modules/voice/cueDirector';
import { speak, unlockSpeech, type Cue } from '../modules/voice/cues';
import { VoiceEngine } from '../modules/voice/engine';
import type { SfuApi, TracksResponse } from '../modules/voice/transports/sfu';
import { fetchFriends, fetchRoute } from '../modules/ride/api';
import { friends, openPlanner, route, incomingAlert, isAndroidApp, isIos, link, locationError, me, meter, myPosition, notice, prefs, pttHeld, ride, riders, session, setSession, stops, transmitting, voice, type Session } from './store';

/** Call status sounds can be turned off. Alerts and SOS always play. */
function callCue(cue: Cue): void {
  if (prefs.peek().callSounds) engine?.cue(cue);
}

const inCall = (r?: Rider) => !!r?.voice && r.online;

const ALERT_WORDS: Record<AlertKind, string> = {
  fuel: 'needs fuel',
  stop: 'wants to stop',
  regroup: 'says regroup',
  hazard: 'warns of a hazard',
  sos: 'needs help',
};

let socket: RideSocket | undefined;
let tracker: LocationTracker | undefined;
let engine: VoiceEngine | undefined;
let disposers: (() => void)[] = [];
let recorder: RideRecorder | undefined;
let director: CueDirector | undefined;
let lastCheckpoint = 0;
let plannerShown = false;
let routeTimer: ReturnType<typeof setTimeout> | undefined;
let routeKey = '';
let nativeLocation: { remove(): Promise<void> } | undefined;
const wake = new ScreenWake();

export const send = (msg: ClientMessage) => socket?.send(msg);

function wsUrl(s: Session): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/rides/${s.code}/ws?rider=${s.riderId}&token=${s.token}`;
}

function voiceFetch<T>(s: Session, path: string, method: string, body?: unknown): Promise<T> {
  return fetch(`/api/rides/${s.code}/voice/${path}`, {
    method,
    headers: { 'x-rider': s.riderId, 'x-token': s.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json() as Promise<T>);
}

function applyLocations(batchOfLocs: LocTuple[]): void {
  const next = { ...riders.value };
  for (const [id, la, lo, sp, hd, ts] of batchOfLocs) {
    const r = next[id];
    if (r) next[id] = { ...r, pos: { la, lo, sp, hd, ts } };
  }
  riders.value = next;
}

function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'state':
      batch(() => {
        ride.value = msg.ride;
        riders.value = Object.fromEntries(msg.riders.map((r) => [r.id, r]));
        stops.value = msg.stops;
        // Someone joining a ride that already has a plan should land on it.
        if (msg.stops.length && !plannerShown) {
          plannerShown = true;
          openPlanner.value = true;
        }
      });
      break;
    case 'rider': {
      const before = riders.value[msg.rider.id];
      // The server omits voice once a rider leaves the call, so it must not linger from the merge.
      const { voice: _stale, ...kept } = before ?? ({} as Partial<Rider>);
      riders.value = { ...riders.value, [msg.rider.id]: { ...kept, ...msg.rider } };
      if (msg.rider.id !== session.peek()?.riderId) {
        if (!inCall(before) && inCall(msg.rider)) director?.riderJoined(msg.rider.id);
        // Still published but offline means the link died, rather than a press of End.
        if (inCall(before) && !inCall(msg.rider)) director?.riderLeft(msg.rider.id, !!msg.rider.voice);
      }
      break;
    }
    case 'locs':
      applyLocations(msg.l);
      break;
    case 'talk': {
      const r = riders.value[msg.id];
      if (r) riders.value = { ...riders.value, [msg.id]: { ...r, talking: msg.on } };
      break;
    }
    case 'stops':
      stops.value = msg.stops;
      break;
    case 'ride':
      ride.value = msg.ride;
      break;
    case 'left': {
      const { [msg.id]: gone, ...rest } = riders.value;
      riders.value = rest;
      if (inCall(gone)) director?.riderLeft(msg.id, false);
      break;
    }
    case 'ended':
      notice.value = 'The ride was ended by the owner.';
      leaveRide('call-cut');
      break;
    case 'kicked':
      notice.value = 'You were removed from this ride.';
      leaveRide('call-cut');
      break;
    case 'rtc':
      engine?.signal(msg.from, msg.data);
      break;
    case 'alert': {
      const name = riders.value[msg.id]?.name ?? 'A rider';
      incomingAlert.value = { id: msg.id, name, kind: msg.kind, at: msg.at, ...(msg.pos ? { pos: msg.pos } : {}) };
      engine?.cue(msg.kind === 'sos' ? 'sos' : 'alert'); // Always plays, whatever the setting.
      if (prefs.value.spokenAlerts) speak(`${name} ${ALERT_WORDS[msg.kind]}`);
      break;
    }
  }
}

/** Runs only when the plan changes, so a settled route costs nothing during the ride. */
function planRoute(): void {
  const list = stops.value;
  const key = list.map((s) => `${s.la},${s.lo}`).join(';');
  if (key === routeKey) return;
  routeKey = key;
  clearTimeout(routeTimer);
  if (list.length < 2) {
    route.value = null;
    return;
  }
  routeTimer = setTimeout(() => {
    fetchRoute(list)
      .then((r) => {
        if (key === routeKey) route.value = r;
      })
      .catch(() => {
        // Offline or the free router is busy. The map falls back to straight lines.
        if (key === routeKey) route.value = null;
      });
  }, 400);
}

/** Crash insurance: a few KB every few minutes, never per fix. */
const CHECKPOINT_MS = 180_000;

function record(pos: Position, accuracyM: number | undefined, code: string): void {
  if (recorder && recorder.log.date !== localDate(pos.ts)) {
    // Past midnight: the day's log is done, and the rest starts a new one.
    void finishLog(recorder.log);
    recorder = undefined;
  }
  if (!recorder) {
    const id = `${localDate(pos.ts)}:${code}`;
    recorder = new RideRecorder(code, ride.value?.name ?? 'Ride', pos.ts, restoreActive(id));
  }
  // The first fix can beat the ride's details, so the name is filled in once known.
  if (ride.peek()?.name) recorder.log.rideName = (ride.peek() as RideInfo).name;
  recorder.add(pos, accuracyM);
  if (pos.ts - lastCheckpoint > CHECKPOINT_MS) {
    lastCheckpoint = pos.ts;
    saveActive(recorder.log);
  }
}

export function connect(s: Session): void {
  disconnect();
  link.value = 'connecting';
  socket = new RideSocket(wsUrl(s), onMessage, (state) => {
    link.value = state;
  });
  tracker = new LocationTracker(
    (pos, accuracyM) => {
      myPosition.value = pos;
      engine?.setSpeed(pos.sp);
      record(pos, accuracyM, s.code);
    },
    (pos) => send({ t: 'loc', ...pos }),
    (message) => (locationError.value = message),
    prefs.value.batterySaver,
  );
  tracker.start();
  void refreshFriends();
  void flushLogs();
  disposers.push(
    effect(() => {
      engine?.syncRiders(Object.values(riders.value));
    }),
    effect(planRoute),
    effect(() => {
      const healthy = link.value === 'live' && voice.value.status !== 'recovering';
      director?.setLink(healthy);
    }),
  );
}

export function disconnect(farewell?: Cue): void {
  disposers.forEach((d) => d());
  disposers = [];
  stopVoice(farewell);
  tracker?.stop();
  socket?.close();
  socket = tracker = undefined;
}

export function leaveRide(farewell: Cue = 'call-leave'): void {
  if (recorder) void finishLog(recorder.log);
  recorder = undefined;
  disconnect(farewell);
  batch(() => {
    setSession(null);
    ride.value = null;
    riders.value = {};
    stops.value = [];
    route.value = null;
  });
  plannerShown = false;
  routeKey = '';
}

/** Must run inside a tap: browsers only start audio from a user gesture. */
export async function startVoice(): Promise<void> {
  const s = session.value;
  if (!s || engine) return;
  // These two must stay above the first await: Safari drops the gesture after it.
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  void ctx.resume();
  unlockSpeech();
  voice.value = { ...voice.value, status: 'starting' };
  try {
    const config = await voiceFetch<VoiceConfig>(s, 'config', 'GET');
    const sfuApi: SfuApi = {
      newSession: () => voiceFetch(s, 'session', 'POST'),
      tracks: (id, body) => voiceFetch<TracksResponse>(s, `tracks/${id}`, 'POST', body),
      renegotiate: (id, body) => voiceFetch(s, `renegotiate/${id}`, 'PUT', body),
    };
    const created = new VoiceEngine({
      config,
      selfId: s.riderId,
      sfuApi,
      directPlayback: isIos(),
      sendSignal: (to, data) => send({ t: 'rtc', to, data }),
      publish: (pub) => send({ t: 'voice', pub }),
      onTransmit: (on) => {
        transmitting.value = on;
        send({ t: 'talk', on });
      },
      onMeter: (m) => (meter.value = m),
      onHealth: (state, peers) => {
        voice.value = { ...voice.value, status: state === 'live' ? 'live' : 'recovering', peers };
      },
    });
    engine = created;
    // Before the mic opens, so Android routes it to the helmet and keeps it alive when the screen locks.
    if (isAndroidApp()) await startNativeRide();
    await created.start(ctx, prefs.value.talkMode, prefs.value.sensitivity, prefs.value.noiseFilter);
    voice.value = { ...voice.value, status: 'live', transport: config.mode, startedAt: Date.now() };
    director = new CueDirector(callCue);
    callCue('call-join');
    created.syncRiders(Object.values(riders.value));
    // The Android app holds audio open from a foreground service; on the web the screen must stay on.
    if (!isAndroidApp() && (isIos() || 'wakeLock' in navigator)) void wake.enable();
    pollLinkQuality();
  } catch (e) {
    console.warn('voice start', e);
    void ctx.close();
    stopVoice();
    voice.value = { ...voice.value, status: 'blocked' };
  }
}

async function startNativeRide(): Promise<void> {
  await RideShell.start();
  void RideShell.requestBatteryExemption();
  nativeLocation = await RideShell.addListener('location', (pos) => tracker?.accept(pos));
  // The service's GPS replaces the browser's, which stops once the app is in the background.
  tracker?.stop();
}

export function stopVoice(farewell?: Cue): void {
  if (farewell) callCue(farewell);
  director?.destroy();
  director = undefined;
  chosenOutput = chosenInput = '';
  if (isAndroidApp() && nativeLocation) {
    void nativeLocation.remove();
    nativeLocation = undefined;
    void RideShell.stop();
    tracker?.start();
  }
  engine?.stop();
  engine = undefined;
  wake.disable();
  transmitting.value = false;
  voice.value = { status: 'off', transport: null, peers: 0, rttMs: null, startedAt: null };
}

function pollLinkQuality(): void {
  const timer = setInterval(() => {
    if (!engine) return clearInterval(timer);
    if (document.visibilityState !== 'visible') return;
    void engine.rttMs().then((rttMs) => (voice.value = { ...voice.value, rttMs }));
  }, 5000);
}

let lastMode = prefs.peek().talkMode;
effect(() => {
  const mode = prefs.value.talkMode;
  engine?.setMode(mode);
  if ((mode === 'mute') !== (lastMode === 'mute')) callCue(mode === 'mute' ? 'mute' : 'unmute');
  lastMode = mode;
});
effect(() => {
  engine?.setVolumes(prefs.value.volumes);
});
effect(() => {
  engine?.setSensitivity(prefs.value.sensitivity);
});
effect(() => {
  engine?.setNoiseFilter(prefs.value.noiseFilter);
});
effect(() => {
  engine?.setPtt(pttHeld.value);
});
effect(() => {
  if (tracker) tracker.saver = prefs.value.batterySaver;
});

export const setMeters = (on: boolean) => engine?.setMeters(on);
export const testSpeaker = () => engine?.cue('test');

export async function refreshFriends(): Promise<void> {
  try {
    friends.value = await fetchFriends();
  } catch {
    // Offline or no account yet: the list simply stays as it was.
  }
}

export type RouteKind = 'speaker' | 'earpiece' | 'bluetooth' | 'wired' | 'other';

export interface AudioRoute {
  id: string;
  label: string;
  kind: RouteKind;
  active: boolean;
}

const guessKind = (label: string): RouteKind =>
  /bluetooth|airpods|buds|sena|cardo|headset|hands-?free/i.test(label) ? 'bluetooth' : /speaker/i.test(label) ? 'speaker' : /wired|headphone|usb/i.test(label) ? 'wired' : 'other';

const canPickOutput = () => 'setSinkId' in AudioContext.prototype;

let chosenOutput = '';
let chosenInput = '';

async function devices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === kind && d.deviceId !== 'communications');
}

/** Null means the phone's own controls decide, as on iPhones. */
export async function audioOutputs(): Promise<AudioRoute[] | null> {
  if (isAndroidApp()) return (await RideShell.listRoutes()).routes;
  if (!canPickOutput()) return null;
  return (await devices('audiooutput')).map((d, i) => ({
    id: d.deviceId,
    label: d.label || `Output ${i + 1}`,
    kind: guessKind(d.label),
    active: d.deviceId === chosenOutput || (!chosenOutput && d.deviceId === 'default'),
  }));
}

export async function selectOutput(id: string): Promise<void> {
  if (isAndroidApp()) return RideShell.setRoute({ id });
  await engine?.selectOutput(id);
  chosenOutput = id;
}

export async function audioInputs(): Promise<AudioRoute[]> {
  return (await devices('audioinput')).map((d, i) => ({
    id: d.deviceId,
    label: d.label || `Microphone ${i + 1}`,
    kind: guessKind(d.label),
    active: d.deviceId === chosenInput || (!chosenInput && d.deviceId === 'default'),
  }));
}

export async function selectInput(id: string): Promise<void> {
  await engine?.selectInput(id);
  chosenInput = id;
}
export const sendAlert = (kind: AlertKind) => send({ t: 'alert', kind });
export const currentRider = (): Rider | undefined => me.value;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void engine?.recover();
});

export { locationError, meter };
