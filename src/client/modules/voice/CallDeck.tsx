import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { audioInputs, audioOutputs, selectInput, selectOutput, startVoice, stopVoice, testSpeaker, type AudioRoute, type RouteKind } from '../../app/session';
import { initial } from '../../app/format';
import { isIos, me, otherRiders, prefs, setPrefs, transmitting, voice } from '../../app/store';
import { AlertsPanel } from '../alerts/AlertsPanel';
import { Bluetooth, Headphones, Mic, MicOff, Music, Phone, PhoneOff, Speaker, SpeakerOff } from '../../ui/icons';
import type { TalkMode } from './dsp/chain';

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const ROUTE_ICON: Record<RouteKind, ComponentType> = {
  bluetooth: Bluetooth,
  wired: Headphones,
  speaker: Speaker,
  earpiece: Phone,
  other: Speaker,
};

function Quality({ rtt }: { rtt: number | null }) {
  const bars = rtt === null ? 0 : rtt < 120 ? 3 : rtt < 280 ? 2 : 1;
  const label = rtt === null ? 'Measuring link' : `${['', 'Weak', 'Good', 'Excellent'][bars]} link, ${rtt} ms`;
  return (
    <span class="quality" role="img" aria-label={label} title={label}>
      {[1, 2, 3].map((b) => <i key={b} class={b <= bars ? 'on' : ''} style={{ height: `${b * 5 + 3}px` }} />)}
    </span>
  );
}

function RoutePicker({ title, load, pick, empty }: { title: string; load: () => Promise<AudioRoute[] | null>; pick: (id: string) => Promise<void>; empty: string }) {
  const [routes, setRoutes] = useState<AudioRoute[] | null | undefined>(undefined);
  const refresh = () => void load().then(setRoutes).catch(() => setRoutes([]));

  useEffect(() => {
    refresh();
    // Picks up a helmet set that connects while this list is open.
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, []);

  if (routes === undefined) return null;
  return (
    <div class="routes">
      <span class="label">{title}</span>
      {routes === null || !routes.length ? (
        <span class="note">{empty}</span>
      ) : (
        routes.map((r) => {
          const Icon = ROUTE_ICON[r.kind];
          return (
            <button key={r.id} class={`route ${r.active ? 'active' : ''}`} aria-pressed={r.active} onClick={() => void pick(r.id).then(refresh)}>
              <Icon />
              <span>{r.label}</span>
            </button>
          );
        })
      )}
    </div>
  );
}

function RiderRow({ id, name, color, talking, online }: { id: string; name: string; color: string; talking: boolean; online: boolean }) {
  const volume = prefs.value.volumes[id] ?? 1;
  const set = (v: number) => setPrefs({ volumes: { ...prefs.value.volumes, [id]: v } });
  return (
    <div class="call-row">
      <span class={`avatar ${online ? '' : 'off'} ${talking ? 'talking' : ''}`} style={{ background: color }}>{initial(name)}</span>
      <span class="row-main">
        <div class="row-title">{name}</div>
        <div class="row-sub">{!online ? 'Not connected' : volume === 0 ? 'Muted for you only' : talking ? 'Talking' : 'In the call'}</div>
      </span>
      {!isIos() && <input type="range" min="0" max="1.5" step="0.05" value={volume} aria-label={`Volume for ${name}`} onInput={(e) => set(Number(e.currentTarget.value))} />}
      <button class="icon-btn" aria-label={volume === 0 ? `Unmute ${name} for you` : `Mute ${name} for you`} aria-pressed={volume === 0} onClick={() => set(volume === 0 ? 1 : 0)}>
        {volume === 0 ? <SpeakerOff /> : <Speaker />}
      </button>
    </div>
  );
}

let modeBeforeMute: TalkMode = 'vox';

export function CallDeck() {
  const v = voice.value;
  const [picker, setPicker] = useState<'output' | 'input' | null>(null);
  const [now, setNow] = useState(Date.now());
  const inCall = v.status === 'live' || v.status === 'recovering' || v.status === 'starting';

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!inCall) {
    return (
      <>
        <div class="call-idle">
          <span class="note">{v.status === 'blocked' ? 'The microphone is blocked. Allow it for this app, then try again.' : 'No one can hear you yet.'}</span>
          <button class="btn primary block" onClick={() => void startVoice()}><Phone /> Join the call</button>
        </div>
        <AlertsPanel />
      </>
    );
  }

  const muted = prefs.value.talkMode === 'mute';
  function toggleMute() {
    if (!muted) modeBeforeMute = prefs.value.talkMode;
    setPrefs({ talkMode: muted ? modeBeforeMute : 'mute' });
  }
  const toggle = (p: 'output' | 'input') => setPicker(picker === p ? null : p);
  const self = me.value;

  return (
    <>
      <div class="call-head">
        <span>
          <span class="call-title">Group call</span>
          <span class="note num"> {v.startedAt ? clock(now - v.startedAt) : '00:00'}</span>
        </span>
        <span class="call-link">
          <span class="note">{v.status === 'recovering' ? 'Reconnecting' : v.transport === 'mesh' ? 'Direct' : 'Relay'}</span>
          <Quality rtt={v.rttMs} />
        </span>
      </div>

      <div class="deck" role="toolbar" aria-label="Call controls">
        <button class={`deck-btn ${muted ? 'on-danger' : ''}`} aria-pressed={muted} onClick={toggleMute}>
          <span>{muted ? <MicOff /> : <Mic />}</span>{muted ? 'Unmute' : 'Mute'}
        </button>
        <button class="deck-btn" aria-expanded={picker === 'output'} onClick={() => toggle('output')}>
          <span><Speaker /></span>Speaker
        </button>
        <button class="deck-btn" aria-expanded={picker === 'input'} onClick={() => toggle('input')}>
          <span><Headphones /></span>Mic
        </button>
        <button class="deck-btn" onClick={testSpeaker}>
          <span><Music /></span>Test
        </button>
        <button class="deck-btn end" onClick={() => stopVoice('call-leave')}>
          <span><PhoneOff /></span>End
        </button>
      </div>

      {picker === 'output' && <RoutePicker title="Play sound through" load={audioOutputs} pick={selectOutput} empty="This phone chooses the speaker itself. On iPhone, use Control Center to pick your Bluetooth set." />}
      {picker === 'input' && <RoutePicker title="Pick up your voice from" load={audioInputs} pick={selectInput} empty="No other microphones found." />}

      {self && <RiderRowSelf name={self.name} color={self.color} air={transmitting.value} muted={muted} />}
      {otherRiders.value.map((r) => <RiderRow key={r.id} id={r.id} name={r.name} color={r.color} talking={r.talking} online={r.online} />)}

      <AlertsPanel />
    </>
  );
}

function RiderRowSelf({ name, color, air, muted }: { name: string; color: string; air: boolean; muted: boolean }) {
  return (
    <div class="call-row">
      <span class={`avatar ${air ? 'talking' : ''}`} style={{ background: color }}>{initial(name)}</span>
      <span class="row-main">
        <div class="row-title">{name} (you)</div>
        <div class="row-sub">{muted ? 'Muted' : air ? 'On air' : 'Listening'}</div>
      </span>
    </div>
  );
}
