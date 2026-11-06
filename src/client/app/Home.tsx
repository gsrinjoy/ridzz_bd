import { useState } from 'preact/hooks';
import { FriendsPanel } from '../modules/friends/FriendsPanel';
import { createRide, joinRide } from '../modules/ride/api';
import { StatsScreen } from '../modules/stats/StatsScreen';
import { Logo } from '../ui/icons';
import { initial } from './format';
import { connect, signOut } from './session';
import { account, notice, openPlanner, session, setSession, type Session } from './store';

export function Home({ invite }: { invite: string | null }) {
  const [code, setCode] = useState(invite ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState(false);
  const a = account.value;

  async function enter(action: () => Promise<Session>) {
    setBusy(true);
    setError('');
    notice.value = null;
    try {
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
        <div class="home-top">
          <div class="mark">
            <Logo />
            <h1>Slipstream</h1>
          </div>
          <button class="btn quiet" onClick={() => void signOut()}>Sign out</button>
        </div>
        {a && (
          <div class="whoami">
            <span class="avatar" style={{ background: a.color }}>{initial(a.name)}</span>
            <span class="row-main"><div class="row-title">{a.name}</div><div class="row-sub">Ready to ride</div></span>
          </div>
        )}
        {notice.value && <p class="banner" role="status">{notice.value}</p>}

        <div class="group">
          <label class="label" for="code">Ride code</label>
          <input id="code" class="field code" value={code} maxLength={6} autoCapitalize="characters" autoComplete="off" placeholder="······" onInput={(e) => setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
          <button class="btn primary block" disabled={code.length !== 6 || busy} onClick={() => enter(() => joinRide(code))}>
            Join ride
          </button>
        </div>

        <div class="divider">or</div>

        <button class="btn block" disabled={busy} onClick={() => { openPlanner.value = true; void enter(createRide); }}>
          Plan a new ride
        </button>
        {error && <p class="error" role="alert">{error}</p>}

        <button class="btn block" onClick={() => setStats(true)}>My rides and stats</button>

        <div class="group">
          <span class="label">Friends</span>
          <FriendsPanel onJoin={(c) => void enter(() => joinRide(c))} />
        </div>
      </div>
    </main>
  );
}
