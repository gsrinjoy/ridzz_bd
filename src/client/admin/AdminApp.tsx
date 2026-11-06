import { useEffect, useState } from 'preact/hooks';
import { directionsUrl } from '../../shared/mapsLink';
import type { AdminOverview, AdminRide, AdminUser } from '../../shared/protocol';
import { avgMovingKmh, type RideSummary } from '../../shared/stats';
import { ago, initial } from '../app/format';
import { Logo } from '../ui/icons';

const KEY = 'slipstream.owner';
const REFRESH_MS = 5000;

function savedToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), { status: res.status });
  return data;
}

function Login({ onDone }: { onDone: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  async function submit(e: Event) {
    e.preventDefault();
    try {
      await api(value, 'overview');
      try {
        sessionStorage.setItem(KEY, value);
      } catch {
        // Then it lasts until this page closes.
      }
      onDone(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    }
  }
  return (
    <main class="home">
      <form class="home-card" onSubmit={submit}>
        <div class="mark"><Logo /><h1>Owner</h1></div>
        <label class="label" for="owner">Owner password</label>
        <input id="owner" class="field" type="password" autoComplete="current-password" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
        <button class="btn primary block" disabled={!value}>Open portal</button>
        {error && <p class="error" role="alert">{error}</p>}
      </form>
    </main>
  );
}

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div class="stat-card"><span class="label">{label}</span><b class="num">{value}</b></div>
);

const Service = ({ name, on, off }: { name: string; on: boolean; off: string }) => (
  <div class="service"><span class={`dot ${on ? 'live' : 'warn'}`} /><span><b>{name}</b><div class="note">{on ? 'Configured' : off}</div></span></div>
);

function RideCard({ ride, act }: { ride: AdminRide; act: (path: string, body?: unknown) => void }) {
  const online = ride.riders.filter((r) => r.online).length;
  return (
    <section class="admin-card">
      <header class="admin-card-head">
        <div>
          <b>{ride.name}</b>
          <div class="note num">{ride.code} · {ride.phase} · {online}/{ride.riders.length} online · {ride.stops} stops · active {ago(ride.lastActive)}</div>
        </div>
        <button class="btn danger" onClick={() => { if (confirm(`End "${ride.name}" for everyone and delete its data?`)) act(`rides/${ride.code}/end`); }}>End ride</button>
      </header>
      {ride.riders.map((r) => (
        <div key={r.id} class="row">
          <span class={`avatar ${r.online ? '' : 'off'}`} style={{ background: r.color }}>{initial(r.name)}</span>
          <span class="row-main">
            <div class="row-title">{r.name}</div>
            <div class="row-sub num">{r.online ? (r.inCall ? 'In call' : 'Online') : `Seen ${ago(r.lastSeen)}`}{r.pos ? ` · ${Math.round(r.pos.sp)} km/h` : ''}</div>
          </span>
          {r.pos && <a class="btn" href={directionsUrl(r.pos)} target="_blank" rel="noopener">Map</a>}
          <button class="btn" onClick={() => { if (confirm(`Remove ${r.name} from this ride?`)) act(`rides/${ride.code}/kick`, { riderId: r.id }); }}>Remove</button>
        </div>
      ))}
    </section>
  );
}

function UserRow({ user, token, act, remove }: { user: AdminUser; token: string; act: (path: string, body?: unknown) => void; remove: (id: string) => void }) {
  const [logs, setLogs] = useState<RideSummary[] | null>(null);
  const [temporary, setTemporary] = useState('');

  async function reset() {
    if (!confirm(`Reset ${user.name}'s password? They will be signed out everywhere.`)) return;
    const { temporary: value } = await api<{ temporary: string }>(token, `users/${user.id}/reset-password`, { method: 'POST', body: '{}' });
    setTemporary(value);
  }

  return (
    <div class="admin-user">
      <div class="row">
        <span class={`avatar ${user.blocked ? 'off' : ''}`} style={{ background: user.color }}>{initial(user.name)}</span>
        <span class="row-main">
          <div class="row-title">{user.name}{user.blocked ? ' (blocked)' : ''}</div>
          <div class="row-sub num">{user.email} · {user.friendCode} · {user.friends} friends · {user.ridesLogged} rides · seen {ago(user.lastSeen)}</div>
        </span>
      </div>
      <div class="admin-actions">
        <button class="btn" onClick={() => void api<RideSummary[]>(token, `users/${user.id}/stats`).then(setLogs)}>Rides</button>
        <button class="btn" onClick={() => void reset()}>Reset password</button>
        <button class="btn" onClick={() => act(`users/${user.id}/block`, { blocked: !user.blocked })}>{user.blocked ? 'Unblock' : 'Block'}</button>
        <button class="btn danger" onClick={() => { if (confirm(`Delete ${user.name} permanently?`)) remove(user.id); }}>Delete</button>
      </div>
      {temporary && <p class="note">Temporary password, shown once: <b class="num">{temporary}</b></p>}
      {logs && (logs.length ? logs.map((l) => (
        <div key={l.id} class="note num">{l.date} · {l.rideName} · {(l.distanceM / 1000).toFixed(1)} km · {Math.round(avgMovingKmh(l))} km/h avg · {Math.round(l.topKmh)} km/h top</div>
      )) : <p class="note">No rides logged.</p>)}
    </div>
  );
}

type View = 'rides' | 'users';

export function AdminApp() {
  const [token, setToken] = useState(savedToken);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [rides, setRides] = useState<AdminRide[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [view, setView] = useState<View>('rides');
  const [error, setError] = useState('');

  async function load() {
    try {
      const [o, r, u] = await Promise.all([api<AdminOverview>(token, 'overview'), api<AdminRide[]>(token, 'rides'), api<AdminUser[]>(token, 'users')]);
      setOverview(o);
      setRides(r);
      setUsers(u);
      setError('');
    } catch (e) {
      if ((e as { status?: number }).status === 401) setToken('');
      else setError(e instanceof Error ? e.message : 'Could not load');
    }
  }

  useEffect(() => {
    if (!token) return;
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [token]);

  if (!token) return <Login onDone={setToken} />;

  const act = (path: string, body?: unknown) =>
    void api(token, path, { method: 'POST', body: JSON.stringify(body ?? {}) }).then(load).catch((e: Error) => setError(e.message));
  const remove = (id: string) =>
    void api(token, `users/${id}`, { method: 'DELETE' }).then(load).catch((e: Error) => setError(e.message));

  return (
    <main class="admin">
      <header class="admin-top">
        <div class="mark"><Logo /><h1>Owner portal</h1></div>
        <button class="btn" onClick={() => { sessionStorage.removeItem(KEY); setToken(''); }}>Sign out</button>
      </header>
      {error && <p class="error" role="alert">{error}</p>}

      {overview && (
        <>
          <div class="stat-grid">
            <Stat label="Riders online" value={overview.ridersOnline} />
            <Stat label="Live rides" value={overview.liveRides} />
            <Stat label="All rides" value={overview.rides} />
            <Stat label="Users" value={overview.users} />
            <Stat label="Blocked" value={overview.blockedUsers} />
            <Stat label="Friendships" value={overview.friendships} />
          </div>
          <div class="service-grid">
            <Service name="Voice relay" on={overview.services.voiceRelay} off="Direct links only" />
            <Service name="TURN" on={overview.services.turn} off="Some networks may fail" />
            <Service name="Mappls" on={overview.services.mappls} off="Using the backup map" />
          </div>
        </>
      )}

      <div class="seg admin-tabs" role="group" aria-label="View">
        <button aria-pressed={view === 'rides'} onClick={() => setView('rides')}>Rides ({rides.length})</button>
        <button aria-pressed={view === 'users'} onClick={() => setView('users')}>Users ({users.length})</button>
      </div>

      {view === 'rides' && (rides.length ? rides.map((r) => <RideCard key={r.code} ride={r} act={act} />) : <p class="note">No rides right now.</p>)}
      {view === 'users' && <section class="admin-card">{users.map((u) => <UserRow key={u.id} user={u} token={token} act={act} remove={remove} />)}</section>}
    </main>
  );
}
