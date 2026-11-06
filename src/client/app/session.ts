import { batch, effect, untracked } from '@preact/signals';
import { distanceM } from '../../shared/geo';
import type { AlertKind, ClientMessage, LocTuple, Position, RideInfo, RidePhase, Rider, ServerMessage, VoiceConfig } from '../../shared/protocol';
import { LocationTracker } from '../modules/location/tracker';
import { NearbyLink } from '../modules/nearby/link';
import { LocalEncoder, LocalPlayer, localVoiceSupported } from '../modules/nearby/localVoice';
import { RideShell } from '../modules/power/rideShell';
import { ScreenWake } from '../modules/power/wakeLock';
import { RideSocket } from '../modules/ride/socket';
import { finishLog, flushLogs, recoverActive, restoreActive, saveActive } from '../modules/stats/logStore';
import { localDate, RideRecorder } from '../modules/stats/recorder';
import { CueDirector } from '../modules/voice/cueDirector';
import { speak, unlockSpeech, type Cue } from '../modules/voice/cues';
import { VoiceEngine } from '../modules/voice/engine';
import type { SfuApi, TracksResponse } from '../modules/voice/transports/sfu';
import { fetchFriends, fetchRoute, signOutSession } from '../modules/ride/api';
import { account, callPrompt, friends, nearbyPeers, openPlanner, reachedStops, route, summaryId, incomingAlert, isAndroidApp, isIos, link, locationError, me, meter, myPosition, notice, prefs, pttHeld, ride, riders, session, setAccount, setSession, stops, transmitting, voice, type Session } from './store';

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
let currentPhase: RidePhase | undefined;
let routeTimer: ReturnType<typeof setTimeout> | undefined;
let routeKey = '';
let nativeLocation: { remove(): Promise<void> } | undefined;
const wake = new ScreenWake();

export const send = (msg: ClientMessage) => {
  socket?.send(msg);
  // With the internet gone, the things riders need most still reach those in range.
  if (nearby && link.peek() !== 'live' && (msg.t === 'loc' || msg.t === 'alert' || msg.t === 'talk')) {
    nearby.sendControl({ id: session.peek()?.riderId, msg });
  }
};

/** Scanning radios cost battery, so the link starts only after the internet has clearly gone. */
const NEARBY_AFTER_MS = 6000;
const NEARBY_LINGER_MS = 30_000;

let nearby: NearbyLink | undefined;
let nearbyTimer: ReturnType<typeof setTimeout> | undefined;
let localEncoder: LocalEncoder | undefined;
const localPlayers = new Map<number, LocalPlayer>();

function onNearbyControl(json: unknown): void {
  const { id, msg } = json as { id: string; msg: ClientMessage };
  if (msg.t === 'loc') applyLocations([[id, msg.la, msg.lo, msg.sp, msg.hd, msg.ts]]);
  if (msg.t === 'talk') onMessage({ t: 'talk', id, on: msg.on });
  if (msg.t === 'alert') onMessage({ t: 'alert', id, kind: msg.kind, at: Date.now() });
}

function onNearbyAudio(sender: number, packet: Uint8Array): void {
  const out = engine?.localOutput;
  if (!out) return;
  let player = localPlayers.get(sender);
  if (!player) {
    player = new LocalPlayer(out.ctx, out.destination);
    localPlayers.set(sender, player);
  }
  player.push(packet);
}

async function startNearby(): Promise<void> {
  const s = session.peek();
  if (nearby || !s || !isAndroidApp() || prefs.peek().nearbyMode === 'off') return;
  const created = new NearbyLink(s.riderId, {
    onAudio: onNearbyAudio,
    onControl: onNearbyControl,
    onPeers: (count) => (nearbyPeers.value = count),
  });
  nearby = created;
  try {
    await created.start(s.code, account.peek()?.name ?? 'Rider');
    nearbyPeers.value = 0;
    if (localVoiceSupported() && engine) {
      localEncoder = new LocalEncoder((data) => created.sendAudio(data));
      engine.setLocalTap((samples) => localEncoder?.push(samples));
    }
  } catch (e) {
    console.warn('nearby start', e);
    nearby = undefined;
  }
}

function stopNearby(): void {
  engine?.setLocalTap(undefined);
  localEncoder?.close();
  localEncoder = undefined;
  localPlayers.forEach((p) => p.close());
  localPlayers.clear();
  void nearby?.stop();
  nearby = undefined;
  nearbyPeers.value = null;
}

function watchInternet(healthy: boolean): void {
  clearTimeout(nearbyTimer);
  if (!healthy && !nearby) nearbyTimer = setTimeout(() => void startNearby(), NEARBY_AFTER_MS);
  if (healthy && nearby) nearbyTimer = setTimeout(stopNearby, NEARBY_LINGER_MS);
}

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

const REACHED_M = 250;

function markReached(pos: Position): void {
  const done = reachedStops.peek();
  const fresh = stops.peek().filter((s) => !done.includes(s.id) && distanceM(pos, s) <= REACHED_M);
  if (fresh.length) reachedStops.value = [...done, ...fresh.map((s) => s.id)];
}

/** Only a started ride is recorded, so everyone's stats cover the same ride. */
function record(pos: Position, accuracyM: number | undefined, code: string): void {
  if (ride.peek()?.phase !== 'riding') return;
  markReached(pos);
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

/** Everything a ride's phase changes, in one place. It also runs for riders who arrive mid-ride. */
function enterPhase(next: RidePhase): void {
  const previous = currentPhase;
  if (next === previous) return;
  currentPhase = next;
  tracker?.setSaver(next === 'planning' || prefs.peek().batterySaver);

  if (next === 'riding') {
    if (previous === 'planning') {
      engine?.cue('ride-start');
      if (prefs.peek().spokenAlerts) speak('Ride started');
    }
    joinRideCall();
  }
  if (next === 'finished') void finishRide();
}

/** The Android app can start audio by itself. A browser needs one tap, so it asks. */
function joinRideCall(): void {
  if (engine) return;
  if (isAndroidApp()) void startVoice();
  else callPrompt.value = true;
}

async function finishRide(): Promise<void> {
  callPrompt.value = false;
  const log = recorder?.log;
  recorder = undefined;
  stopVoice('ride-end');
  tracker?.stop();
  if (log) await finishLog(log);
  else await recoverActive();
  summaryId.value = log?.id ?? '';
}

export const startRide = () => send({ t: 'ride.start' });
export const endRide = () => send({ t: 'ride.finish' });

let friendTimer: ReturnType<typeof setInterval> | undefined;
const FRIEND_POLL_MS = 60_000;

export function connect(s: Session): void {
  disconnect();
  link.value = 'connecting';
  void recoverActive(`${localDate(Date.now())}:${s.code}`);
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
    // Low power until a ride starts: precise tracking is for riding, not for waiting.
    true,
  );
  tracker.start();
  void refreshFriends();
  void flushLogs();
  // A request should show on the Friends tab during a ride too. Skipped while hidden, to save the radio.
  clearInterval(friendTimer);
  friendTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refreshFriends();
  }, FRIEND_POLL_MS);
  disposers.push(
    effect(() => {
      engine?.syncRiders(Object.values(riders.value));
    }),
    effect(planRoute),
    effect(() => {
      const next = ride.value?.phase;
      if (next) untracked(() => enterPhase(next));
    }),
    effect(() => {
      const healthy = link.value === 'live' && voice.value.status !== 'recovering';
      director?.setLink(healthy);
      untracked(() => watchInternet(healthy));
    }),
  );
}

export function disconnect(farewell?: Cue): void {
  clearInterval(friendTimer);
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
  currentPhase = undefined;
  callPrompt.value = false;
  summaryId.value = null;
  reachedStops.value = [];
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

export async function signOut(): Promise<void> {
  if (session.peek()) leaveRide();
  await signOutSession().catch(() => undefined); // Offline: the session still expires by itself.
  setAccount(null);
}

/** Must run inside a tap: browsers only start audio from a user gesture. */
export async function startVoice(): Promise<void> {
  const s = session.value;
  if (!s || engine) return;
  callPrompt.value = false;
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
  stopNearby();
  clearTimeout(nearbyTimer);
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
  const saver = prefs.value.batterySaver;
  untracked(() => tracker?.setSaver(saver || ride.value?.phase !== 'riding'));
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
