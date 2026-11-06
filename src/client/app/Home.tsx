import { useState } from 'preact/hooks';
import { RIDER_COLORS } from '../../shared/protocol';
import { FriendsPanel } from '../modules/friends/FriendsPanel';
import { StatsScreen } from '../modules/stats/StatsScreen';
import { createRide, ensureAccount, joinRide } from '../modules/ride/api';
import { Logo } from '../ui/icons';
import { connect } from './session';
import { account, notice, openPlanner, session, setSession, type Session } from './store';

export function Home({ invite }: { invite: string | null }) {
  const [name, setName] = useState(account.value?.name ?? '');
  const [color, setColor] = useState(account.value?.color ?? (RIDER_COLORS[0] as string));
  const [code, setCode] = useState(invite ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState(false);

  const ready = name.trim().length > 0;

  async function enter(action: () => Promise<Session>) {
    setBusy(true);
    setError('');
    notice.value = null;
    try {
      await ensureAccount(name.trim(), color);
      setSession(await action());
      if (session.value) connect(session.value);
      history.replaceState(null, '', '/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (stats) return <StatsScreen onClose={() => setStats(false)} />;

  return (
    <main class="home">
      <div class="home-card">
        <div class="mark">
          <Logo />
          <h1>Slipstream</h1>
        </div>
        <p class="tagline">
          Talk through the wind. <b>See the whole pack.</b>
        </p>

        {notice.value && <p class="banner" role="status">{notice.value}</p>}

        <div class="group">
          <label class="label" for="name">Your name</label>
          <input id="name" class="field" value={name} maxLength={24} autoComplete="nickname" placeholder="What the group calls you" onInput={(e) => setName(e.currentTarget.value)} />
          <div class="swatches" role="group" aria-label="Your map colour">
            {RIDER_COLORS.map((c) => (
              <button key={c} class="swatch" aria-pressed={c === color} aria-label={`Colour ${c}`} onClick={() => setColor(c)}><i style={{ background: c }} /></button>
            ))}
          </div>
        </div>

        <div class="group">
          <label class="label" for="code">Ride code</label>
          <input id="code" class="field code" value={code} maxLength={6} autoCapitalize="characters" autoComplete="off" placeholder="······" onInput={(e) => setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
          <button class="btn primary block" disabled={!ready || code.length !== 6 || busy} onClick={() => enter(() => joinRide(code))}>
            Join ride
          </button>
        </div>

        <div class="divider">or</div>

        <button class="btn block" disabled={!ready || busy} onClick={() => { openPlanner.value = true; void enter(createRide); }}>
          Plan a new ride
        </button>
        {error && <p class="error" role="alert">{error}</p>}

        {account.value && <button class="btn block" onClick={() => setStats(true)}>My rides and stats</button>}

        {account.value && (
          <div class="group">
            <span class="label">Friends</span>
            <FriendsPanel onJoin={(c) => void enter(() => joinRide(c))} />
          </div>
        )}
      </div>
    </main>
  );
}
