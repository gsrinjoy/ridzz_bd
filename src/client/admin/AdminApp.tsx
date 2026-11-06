import { useEffect, useState } from 'preact/hooks';
import { directionsUrl } from '../../shared/mapsLink';
import type { AdminOverview, AdminRide, AdminUser } from '../../shared/protocol';
import type { BudgetView } from '../../shared/budgets';
import { avgMovingKmh, type RideSummary } from '../../shared/stats';
import { ago, initial } from '../app/format';
import { Logo } from '../ui/icons';

const KEY = 'slipstream.owner';
// Slow on purpose: the portal's own requests count against the same free limits.
const REFRESH_MS = 30_000;

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
      const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: value }) });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!data.token) throw new Error(data.error ?? 'Could not sign in');
      try {
        sessionStorage.setItem(KEY, data.token);
      } catch {
        // Then it lasts until this page closes.
      }
      onDone(data.token);
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

function OwnerPassword({ token, onChanged }: { token: string; onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState('');

  async function submit(e: Event) {
    e.preventDefault();
    setMessage('');
    try {
      await api(token, 'password', { method: 'POST', body: JSON.stringify({ current, next }) });
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not change it');
    }
  }

  return (
    <details class="admin-card owner-password">
      <summary>Change owner password</summary>
      <form onSubmit={(e) => void submit(e)}>
        <input class="field" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current owner password" value={current} onInput={(e) => setCurrent(e.currentTarget.value)} />
        <input class="field" type="password" autoComplete="new-password" placeholder="New password, 8 or more characters" aria-label="New owner password" value={next} onInput={(e) => setNext(e.currentTarget.value)} />
        <button class="btn primary" disabled={!current || next.length < 8}>Change password</button>
        {message && <p class="error" role="alert">{message}</p>}
        <p class="note">You will sign in again afterwards. If you ever forget it, set a new ADMIN_TOKEN with Wrangler and sign in with that.</p>
      </form>
    </details>
  );
}

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div class="stat-card"><span class="label">{label}</span><b class="num">{value}</b></div>
);

const Service = ({ name, on, off }: { name: string; on: boolean; off: string }) => (
  <div class="service"><span class={`dot ${on ? 'live' : 'warn'}`} /><span><b>{name}</b><div class="note">{on ? 'Configured' : off}</div></span></div>
);

const STATE_TEXT = { ok: 'OK', warning: 'Approaching limit', critical: 'Nearly at limit', locked: 'Locked to stay free' } as const;

const amount = (b: BudgetView) => (b.unit === 'GB' ? b.used.toFixed(2) : Math.round(b.used).toLocaleString());

function FreeLimits({ budgets, overview, act }: { budgets: BudgetView[]; overview: AdminOverview; act: (path: string, body?: unknown) => void }) {
  const worst = budgets.filter((b) => b.state !== 'ok');
  return (
    <section class="admin-card limits">
      <header class="admin-card-head">
        <div>
          <b>Free limits</b>
          <div class="note">Estimated from the app's own counters. Exact figures are in the Cloudflare dashboard.</div>
        </div>
        <button class="btn" onClick={() => { if (confirm(overview.relayForcedOff ? 'Turn the voice relay back on?' : 'Move all calls to free direct links? These can fail on some mobile networks.')) act('voice-relay', { on: overview.relayForcedOff }); }}>
          {overview.relayForcedOff ? 'Turn relay on' : 'Turn relay off'}
        </button>
      </header>
      <p class="note limit-mode">{overview.policy.relay ? 'Calls use the voice relay.' : 'Calls use free direct links.'}{overview.policy.eco ? ' Eco mode is on: location updates are slower to stretch a daily limit.' : ''}</p>
      {worst.map((b) => (
        <p key={b.metric} class={`limit-alert ${b.state}`} role="alert">
          <b>{b.label}: {STATE_TEXT[b.state]}.</b>{b.lock ? ` At 95%: ${b.lock.toLowerCase()}.` : ''}
        </p>
      ))}
      {budgets.map((b) => {
        const share = Math.min(100, (b.used / b.limit) * 100);
        return (
          <div key={b.metric} class="limit">
            <div class="limit-row">
              <span>{b.label}{b.billable ? ' *' : ''}</span>
              <span class="note num">{amount(b)} / {b.limit.toLocaleString()} {b.unit} per {b.period}</span>
            </div>
            <div class="limit-track" role="img" aria-label={`${b.label}: ${share.toFixed(0)} percent used, ${STATE_TEXT[b.state]}`}>
              <i class={b.state} style={{ width: `${Math.max(share, 0.5)}%` }} />
            </div>
          </div>
        );
      })}
      <p class="note">* Going past these could cost money, so the app locks them at 95%. The others simply stop at the limit.</p>
    </section>
  );
}

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
          <div class="row-title">{user.name}{user.blocked ? ' (blocked)' : ''}{user.approved ? '' : ' (waiting for approval)'}</div>
          <div class="row-sub num">{user.email} · {user.friendCode} · {user.friends} friends · {user.ridesLogged} rides · seen {ago(user.lastSeen)}</div>
        </span>
      </div>
      <div class="admin-actions">
        {!user.approved && <button class="btn primary" onClick={() => act(`users/${user.id}/approve`)}>Approve</button>}
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

      {overview && overview.pendingUsers > 0 && (
        <p class="pending-banner" role="alert">
          <b>{overview.pendingUsers} waiting for approval.</b> Only approve people you know.
        </p>
      )}

      {overview && (
        <>
          <div class="stat-grid">
            <Stat label="Riders online" value={overview.ridersOnline} />
            <Stat label="Live rides" value={overview.liveRides} />
            <Stat label="All rides" value={overview.rides} />
            <Stat label="Users" value={overview.users} />
            <Stat label="Pending" value={overview.pendingUsers} />
            <Stat label="Blocked" value={overview.blockedUsers} />
            <Stat label="Friendships" value={overview.friendships} />
          </div>
          <div class="service-grid">
            <Service name="Voice relay" on={overview.services.voiceRelay} off="Direct links only" />
            <Service name="TURN" on={overview.services.turn} off="Some networks may fail" />
            <Service name="Mappls" on={overview.services.mappls} off="Using the backup map" />
          </div>
          <FreeLimits budgets={overview.budgets} overview={overview} act={act} />
        </>
      )}

      <OwnerPassword token={token} onChanged={() => { sessionStorage.removeItem(KEY); setToken(''); }} />

      <div class="seg admin-tabs" role="group" aria-label="View">
        <button aria-pressed={view === 'rides'} onClick={() => setView('rides')}>Rides ({rides.length})</button>
        <button aria-pressed={view === 'users'} onClick={() => setView('users')}>Users ({users.length}){overview?.pendingUsers ? ` · ${overview.pendingUsers} new` : ''}</button>
      </div>

      {view === 'rides' && (rides.length ? rides.map((r) => <RideCard key={r.code} ride={r} act={act} />) : <p class="note">No rides right now.</p>)}
      {view === 'users' && <section class="admin-card">{[...users].sort((a, b) => Number(a.approved) - Number(b.approved)).map((u) => <UserRow key={u.id} user={u} token={token} act={act} remove={remove} />)}</section>}
    </main>
  );
}
