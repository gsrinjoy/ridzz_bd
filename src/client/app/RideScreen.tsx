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
import { Crosshair, Group, Mic, MicOff, Moon, Phone, Pin, Share, Sliders, UserPlus, Users } from '../ui/icons';
import { startVoice } from './session';
import { droppedPin, friends, openPlanner, selectedStopId, incomingAlert, isAndroidApp, isIos, link, locationError, mapReady, myPosition, otherRiders, pendingShare, prefs, pttHeld, rideMode, selectedRiderId, session, setPrefs, stops, transmitting, voice } from './store';

type Tab = 'call' | 'riders' | 'plan' | 'friends' | 'settings';

function LinkChip() {
  const l = link.value;
  const v = voice.value;
  const online = otherRiders.value.filter((r) => r.online).length + 1;
  const healthy = l === 'live' && v.status !== 'recovering';
  const text = l === 'connecting' ? 'Connecting' : !healthy ? 'Reconnecting' : `${online} online`;
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
        <button class="btn primary block" onClick={() => void startVoice()}>
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

function RideMode() {
  const air = transmitting.value;
  const mode = prefs.value.talkMode;
  const talker = otherRiders.value.find((r) => r.talking);
  const here = myPosition.value;
  const next = stops.value[0];
  const healthy = link.value === 'live' && voice.value.status === 'live';
  const hold = mode === 'ptt' ? holdHandlers() : {};
  return (
    <div class="ridemode">
      <button class="ridemode-main" {...hold}>
        <span class={`ridemode-status ${air ? 'air' : ''}`}>
          {!healthy ? 'Reconnecting' : air ? 'On air' : mode === 'ptt' ? 'Hold to talk' : mode === 'mute' ? 'Muted' : 'Listening'}
        </span>
        <span class="ridemode-who">{talker ? `${talker.name} is talking` : ''}</span>
      </button>
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
  if (!isAndroidApp() && isIos() && v.status === 'live') {
    return <div class="banner" role="status">iPhone: keep this screen open. Locking it stops voice and location.</div>;
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
          <InviteChip onOpen={() => { setTab('riders'); setInviting(true); }} />
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
    </div>
  );
}
