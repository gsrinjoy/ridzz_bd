import { useEffect, useRef, useState } from 'preact/hooks';
import { distanceM, formatDistance } from '../../shared/geo';
import type { ComponentType } from 'preact';
import { FriendsPanel } from '../modules/friends/FriendsPanel';
import { InviteCard } from '../modules/friends/InviteCard';
import type { MapHandle } from '../modules/map/RideMap';
import { RidersPanel } from '../modules/riders/RidersPanel';
import { SettingsPanel } from '../modules/settings/SettingsPanel';
import { PlanPanel } from '../modules/stops/PlanPanel';
import { CallDeck } from '../modules/voice/CallDeck';
import { Crosshair, Group, Mic, MicOff, Moon, Navigate, Phone, Pin, Share, Sliders, UserPlus, Users } from '../ui/icons';
import { Detail } from '../modules/stats/StatsScreen';
import { leaveRide, startRide, startVoice } from './session';
import { isNativeApp, callPrompt, canControl, nearbyPeers, droppedPin, friends, hostName, nextStop, openPlanner, phase, ride, selectedStopId, summaryId, incomingAlert, isAndroidApp, isIos, link, locationError, mapReady, myPosition, otherRiders, pendingShare, prefs, pttHeld, rideMode, selectedRiderId, session, setPrefs, stops, transmitting, voice } from './store';

type Tab = 'call' | 'riders' | 'plan' | 'friends' | 'settings';

function LinkChip() {
  const l = link.value;
  const v = voice.value;
  const online = otherRiders.value.filter((r) => r.online).length + 1;
  const healthy = l === 'live' && v.status !== 'recovering';
  const peers = nearbyPeers.value;
  const text = peers !== null && !healthy ? `Nearby · ${peers}` : l === 'connecting' ? 'Connecting' : !healthy ? 'Reconnecting' : `${online} online`;
  return (
    <span class="chip num" role="status">
      <span class={`dot ${healthy ? 'live' : 'warn'}`} />
      {text}
      {healthy && v.rttMs !== null && ` · ${v.rttMs} ms`}
    </span>
  );
}

function InviteChip({ onOpen }: { onOpen: () => void }) {
  const code = session.value?.code ?? '';
  return (
    <button class="chip num" aria-label={`Invite riders to ride ${code}`} onClick={onOpen}>
      <Share /> Invite · {code}
    </button>
  );
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Replaces the invite chip while riding: the two things a rider glances for. */
function RideHud({ onOpen }: { onOpen: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const next = nextStop.value;
  const here = myPosition.value;
  const started = ride.value?.startedAt;
  return (
    <button class="chip hud num" aria-label="Open the ride plan" onClick={onOpen}>
      <span class="hud-time">{started ? clock(now - started) : '0:00'}</span>
      {next && <span class="hud-next">{next.name}{here ? ` · ${formatDistance(distanceM(here, next))}` : ''}</span>}
    </button>
  );
}

function StartBar() {
  if (canControl.value) {
    return (
      <div class="start-bar">
        <button class="btn primary block" onClick={startRide}><Navigate /> Start ride</button>
      </div>
    );
  }
  return <div class="start-bar waiting" role="status">Waiting for {hostName.value} to start the ride</div>;
}

/** Browsers refuse to start audio without a tap, so a started ride asks for exactly one. */
function CallPrompt() {
  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Ride started">
      <div class="sheet-card">
        <h2>Ride started</h2>
        <p class="note">Tap to join the group call.</p>
        <button class="btn primary block" onClick={() => void startVoice()}><Phone /> Join the call</button>
        <button class="btn block" onClick={() => (callPrompt.value = false)}>Not now</button>
      </div>
    </div>
  );
}

function RideSummary() {
  const id = summaryId.value;
  if (id) {
    return (
      <main class="ride-stats">
        <Detail id={id} onBack={() => leaveRide()} backLabel="Done" />
      </main>
    );
  }
  return (
    <main class="home">
      <div class="home-card">
        <h2 class="stats-title">Ride finished</h2>
        <p class="note">Nothing was recorded on this phone for this ride.</p>
        <button class="btn primary block" onClick={() => leaveRide()}>Done</button>
      </div>
    </main>
  );
}

function holdHandlers() {
  const up = () => (pttHeld.value = false);
  return {
    onPointerDown: () => (pttHeld.value = true),
    onPointerUp: up,
    onPointerLeave: up,
    onPointerCancel: up,
  };
}

function TalkBar() {
  const v = voice.value;
  const mode = prefs.value.talkMode;
  const air = transmitting.value;
  const talker = otherRiders.value.find((r) => r.talking);

  if (v.status === 'off' || v.status === 'blocked') {
    return (
      <div class="talkbar">
        {/* Before the ride starts, Start ride is the main action and this is optional. */}
        <button class={`btn block ${phase.value === 'planning' ? '' : 'primary'}`} onClick={() => void startVoice()}>
          <Phone /> {v.status === 'blocked' ? 'Allow the microphone, then tap' : 'Join the call'}
        </button>
      </div>
    );
  }

  const title = v.status === 'starting' ? 'Starting…'
    : v.status === 'recovering' ? 'Reconnecting…'
    : air ? 'On air'
    : talker ? `${talker.name} talking`
    : mode === 'mute' ? 'Muted'
    : mode === 'ptt' ? 'Hold to talk'
    : mode === 'open' ? 'Open mic'
    : 'Listening';
  const sub = v.status === 'recovering' ? 'Rejoins by itself' : mode === 'vox' ? 'Auto-talk on' : v.transport === 'mesh' ? 'Direct link' : 'Group voice';

  return (
    <>
      <div class="talkbar">
        <div class="talk-state">
          <span class={`lamp ${air ? 'air' : ''} ${mode === 'mute' ? 'muted' : ''}`}>{mode === 'mute' ? <MicOff /> : <Mic />}</span>
          <span style={{ minWidth: 0 }}>
            <div class="talk-title">{title}</div>
            <div class="talk-sub">{sub}</div>
          </span>
        </div>
        <div class="seg" role="group" aria-label="Talk mode">
          {([['vox', 'Auto'], ['ptt', 'Hold'], ['mute', 'Mute']] as const).map(([m, label]) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setPrefs({ talkMode: m })}>{label}</button>
          ))}
        </div>
      </div>
      {mode === 'ptt' && (
        <div class="hold-wrap">
          <button class={`hold ${pttHeld.value ? 'down' : ''}`} {...holdHandlers()}>{pttHeld.value ? 'Talking' : 'Hold to talk'}</button>
        </div>
      )}
    </>
  );
}

/** After this long untouched, ride mode goes fully black. */
const POCKET_AFTER_MS = 10_000;

function RideMode() {
  const air = transmitting.value;
  const mode = prefs.value.talkMode;
  const talker = otherRiders.value.find((r) => r.talking);
  const here = myPosition.value;
  const next = stops.value[0];
  const healthy = link.value === 'live' && voice.value.status === 'live';
  const hold = mode === 'ptt' ? holdHandlers() : {};
  const [pocket, setPocket] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Black pixels are off on OLED phones, so this is the closest a web app can get
  // to a locked screen: it stays open, so the call and GPS keep running.
  const wake = () => {
    setPocket(false);
    clearTimeout(idle.current);
    if (mode !== 'ptt') idle.current = setTimeout(() => setPocket(true), POCKET_AFTER_MS);
  };
  useEffect(() => {
    wake();
    return () => clearTimeout(idle.current);
  }, [mode]);

  if (pocket) return <button class="ridemode pocket" aria-label="Wake the screen" onClick={wake} />;

  return (
    <div class="ridemode" onPointerDown={wake}>
      <button class="ridemode-main" {...hold}>
        <span class={`ridemode-status ${air ? 'air' : ''}`}>
          {!healthy ? 'Reconnecting' : air ? 'On air' : mode === 'ptt' ? 'Hold to talk' : mode === 'mute' ? 'Muted' : 'Listening'}
        </span>
        <span class="ridemode-who">{talker ? `${talker.name} is talking` : ''}</span>
      </button>
      {isIos() && !isNativeApp() && (
        <p class="ridemode-tip">Don't lock the phone. This goes fully black by itself, and the call keeps running. For a pocket, triple-click the side button to start Guided Access, which turns touch off.</p>
      )}
      <div class="ridemode-foot">
        <span class="num">{next && here ? `${next.name} · ${formatDistance(distanceM(here, next))}` : `${otherRiders.value.filter((r) => r.online).length + 1} online`}</span>
        <button class="btn" onClick={() => (rideMode.value = false)}>Map</button>
      </div>
    </div>
  );
}

const ALERT_TEXT = { fuel: 'needs fuel', stop: 'wants to stop', regroup: 'says regroup', hazard: 'warns of a hazard', sos: 'needs help' } as const;

function AlertToast() {
  const a = incomingAlert.value;
  useEffect(() => {
    if (!a || a.kind === 'sos') return;
    const t = setTimeout(() => (incomingAlert.value = null), 6000);
    return () => clearTimeout(t);
  }, [a]);
  if (!a) return null;
  return (
    <button class={`alert-toast ${a.kind === 'sos' ? 'sos-toast' : ''}`} onClick={() => { selectedRiderId.value = a.id; incomingAlert.value = null; }}>
      {a.name} {ALERT_TEXT[a.kind]}
    </button>
  );
}

function Banner() {
  const v = voice.value;
  if (locationError.value) return <div class="banner" role="status">{locationError.value}</div>;
  if (!isNativeApp() && isIos() && v.status === 'live') {
    return <button class="banner" onClick={() => (rideMode.value = true)}>iPhone: don't lock the phone, it stops voice. Tap for Ride mode instead.</button>;
  }
  return null;
}

export function RideScreen() {
  const [tab, setTab] = useState<Tab | null>(pendingShare.value ? 'plan' : null);
  const [inviting, setInviting] = useState(false);
  const [MapView, setMapView] = useState<ComponentType<{ handle: { current: MapHandle | null } }> | null>(null);
  const handle = useRef<MapHandle | null>(null);

  // The map is the heaviest thing in the app, so it loads on demand and never in ride mode.
  useEffect(() => {
    if (rideMode.value || MapView) return;
    void import('../modules/map/RideMap').then((m) => setMapView(() => m.default));
  }, [rideMode.value]);

  useEffect(() => {
    if (selectedRiderId.value) setTab('riders');
  }, [selectedRiderId.value]);

  useEffect(() => {
    if (droppedPin.value || selectedStopId.value) setTab('plan');
  }, [droppedPin.value, selectedStopId.value]);

  useEffect(() => {
    if (!openPlanner.value) return;
    setTab('plan');
    openPlanner.value = false;
  }, [openPlanner.value]);

  // Once moving, the map is what matters, so panels get out of its way.
  useEffect(() => {
    if (phase.value === 'riding') setTab(null);
  }, [phase.value]);

  if (phase.value === 'finished') return <RideSummary />;
  if (rideMode.value) return <RideMode />;

  const toggle = (t: Tab) => setTab(tab === t ? null : t);
  const pending = friends.value.incoming.length + friends.value.invites.length;
  const tabs: [Tab, string, () => preact.JSX.Element, number?][] = [
    ['call', 'Call', Phone],
    ['riders', 'Riders', Users, otherRiders.value.length || undefined],
    ['plan', 'Plan', Pin, stops.value.length || undefined],
    ['friends', 'Friends', UserPlus, pending || undefined],
    ['settings', 'Settings', Sliders],
  ];

  return (
    <div class={`ride ${tab ? 'panel-open' : ''}`}>
      <div class="map-area">
        {MapView && <MapView handle={handle} />}
        {!mapReady.value && <div class="map-empty" role="status">Loading map…</div>}
        <div class="topbar">
          {phase.value === 'riding' ? <RideHud onOpen={() => setTab('plan')} /> : <InviteChip onOpen={() => { setTab('riders'); setInviting(true); }} />}
          <span class="spacer" />
          <LinkChip />
        </div>
        <AlertToast />
        <div class="fab-col">
          <button class="fab" aria-label="Ride mode" onClick={() => (rideMode.value = true)}><Moon /></button>
          <button class="fab" aria-label="Show everyone" onClick={() => handle.current?.fitAll()}><Group /></button>
          <button class="fab" aria-label="Centre on me" onClick={() => handle.current?.centerOnMe()}><Crosshair /></button>
        </div>
      </div>
      <div class="dock">
        <Banner />
        {phase.value === 'planning' && <StartBar />}
        <TalkBar />
        <nav class="tabs" role="tablist">
          {tabs.map(([id, label, Icon, count]) => (
            <button key={id} class="tab" role="tab" aria-selected={tab === id} onClick={() => toggle(id)}>
              <Icon />
              {label}
              {count !== undefined && <span class="badge num">{count}</span>}
            </button>
          ))}
        </nav>
        {tab && (
          <section class={`panel ${tab === 'plan' ? 'tall' : ''}`} role="tabpanel">
            {tab === 'call' && <CallDeck />}
            {tab === 'riders' && (
              <>
                <button class="btn block" aria-expanded={inviting} onClick={() => setInviting(!inviting)}><Share /> Invite riders</button>
                {inviting && session.value && <InviteCard code={session.value.code} />}
                <RidersPanel />
              </>
            )}
            {tab === 'plan' && <PlanPanel />}
            {tab === 'friends' && <FriendsPanel />}
            {tab === 'settings' && <SettingsPanel />}
          </section>
        )}
      </div>
      {callPrompt.value && <CallPrompt />}
    </div>
  );
}
