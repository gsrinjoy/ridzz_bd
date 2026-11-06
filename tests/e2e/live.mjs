// Smoke test against a deployed site. Cleans up after itself.
// Usage: OWNER=<admin password> node tests/e2e/live.mjs <url>
const BASE = process.argv[2];
const OWNER = process.env.OWNER;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
const api = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const owner = { authorization: `Bearer ${OWNER}` };
const as = (a) => ({ authorization: `Bearer ${a.token}` });
const email = (n) => `${n}.${Date.now()}@test.example`;

const home = await fetch(BASE);
check(home.ok && (await home.text()).includes('Slipstream'), 'the app is served', `HTTP ${home.status}`);
check((await fetch(`${BASE}/map-style.json`)).ok, 'the map style is served');
check((await fetch(`${BASE}/manifest.webmanifest`)).ok, 'the web app manifest is served');
const deep = await fetch(`${BASE}/r/ABC234`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
check(deep.ok && (await deep.text()).includes('id="app"'), 'invite links open the app');

const tiles = await api('/api/map/tiles.json');
check(tiles.status === 200 && !!tiles.data?.tiles, 'the map tile index works through the Worker');
const headers0 = home.headers;
check(/frame-ancestors 'none'/.test(headers0.get('content-security-policy') ?? ''), 'the app sends a Content Security Policy');
check(/max-age/.test(headers0.get('strict-transport-security') ?? ''), 'the app enforces HTTPS');
check(headers0.get('x-frame-options') === 'DENY', 'the app cannot be framed');
check((await api('/api/places/search?q=Nandi')).status === 401, 'search needs a signed-in rider');
check((await api('/api/route?coords=77.59,12.97;77.68,13.37')).status === 401, 'routing needs a signed-in rider');
check((await api('/api/rides', { method: 'POST', body: {} })).status === 401, 'creating a ride needs a signed-in rider');
check((await api('/api/rides/ABC234/join', { method: 'POST', body: {} })).status === 401, 'joining a ride needs a signed-in rider');
check((await api('/api/friends')).status === 401, 'friends need a signed-in rider');
check((await api('/api/config')).status === 401, 'the map key is not public');
check((await api('/api/stats')).status === 401, 'stats need a signed-in rider');
check((await api('/api/friends', { headers: { authorization: 'Bearer forged-token' } })).status === 401, 'a forged session is refused');

check((await api('/api/admin/overview')).status === 401, 'the owner API refuses no password');
check((await api('/api/admin/overview', { headers: { authorization: 'Bearer wrong' } })).status === 401, 'the owner API refuses a wrong password');
const over = await api('/api/admin/overview', { headers: owner });
check(over.status === 200, 'the owner API accepts the owner password', JSON.stringify(over.data?.services));
check(over.data?.budgets?.length === 7, 'the free limit meters are live', over.data?.budgets?.map((b) => `${b.metric}:${Math.round(b.used)}`).join(' '));

const emailA = email('a');
const weak = await api('/api/auth/register', { method: 'POST', body: { name: 'X', email: email('w'), password: 'short' } });
check(weak.status === 400, 'a weak password is refused', weak.data?.error);
const madeA = await api('/api/auth/register', { method: 'POST', body: { name: 'LiveTest A', email: emailA, password: 'live-password-1' } });
check(madeA.status === 200 && !!madeA.data?.recoveryCode, 'an account can be registered', `HTTP ${madeA.status}`);
const a = madeA.data?.account;
check(a?.approved === false, 'a new account starts unapproved');
check((await api('/api/rides', { method: 'POST', headers: as(a), body: {} })).status === 403, 'an unapproved account cannot create a ride');
check((await api('/api/friends', { headers: as(a) })).status === 403, 'an unapproved account cannot use the API');
check((await api('/api/auth/me', { headers: as(a) })).data?.approved === false, 'an unapproved account can check its status');
const b = (await api('/api/auth/register', { method: 'POST', body: { name: 'LiveTest B', email: email('b'), password: 'live-password-2' } })).data?.account;
for (const u of [a, b]) await api(`/api/admin/users/${u.userId}/approve`, { method: 'POST', headers: owner, body: {} });
check((await api('/api/friends', { headers: as(a) })).status === 200, 'once approved, the account works');
check((await api('/api/auth/register', { method: 'POST', body: { name: 'Y', email: emailA, password: 'live-password-3' } })).status === 409, 'an email cannot register twice');
check((await api('/api/auth/login', { method: 'POST', body: { email: emailA, password: 'nope-nope-nope' } })).status === 401, 'a wrong password is refused');
const signedIn = await api('/api/auth/login', { method: 'POST', body: { email: emailA, password: 'live-password-1' } });
check(signedIn.status === 200, 'the right password signs in', `HTTP ${signedIn.status}`);
const second = signedIn.data;
check((await api('/api/friends', { headers: as(second) })).status === 200, 'a session opens the API');
await api('/api/auth/logout', { method: 'POST', headers: as(second), body: {} });
check((await api('/api/friends', { headers: as(second) })).status === 401, 'signing out ends that session at once');
const lockEmail = email('lock');
await api('/api/auth/register', { method: 'POST', body: { name: 'Lock', email: lockEmail, password: 'live-password-9' } });
let lastStatus = 0;
for (let i = 0; i < 6; i++) lastStatus = (await api('/api/auth/login', { method: 'POST', body: { email: lockEmail, password: 'guess-guess-guess' } })).status;
check(lastStatus === 429, 'repeated wrong passwords lock the account for a while');

const search = await api('/api/places/search?q=Nandi%20Hills', { headers: as(a) });
check(search.data?.length > 0, 'place search works', search.data?.[0]?.name);
const route = await api('/api/route?coords=77.59,12.97;77.68,13.37', { headers: as(a) });
check(route.data?.distanceM > 1000, 'road routing works', `${Math.round((route.data?.distanceM ?? 0) / 1000)} km`);
const short = await api(`/api/places/resolve?url=${encodeURIComponent('https://evil.example.com/x')}`, { headers: as(a) });
check(short.status === 400, 'link expansion refuses other websites');
const ride = (await api('/api/rides', { method: 'POST', headers: as(a), body: {} })).data;
check(/^[A-Z2-9]{6}$/.test(ride?.code ?? ''), 'a ride can be created', ride?.code);
const joined = (await api(`/api/rides/${ride.code}/join`, { method: 'POST', headers: as(b), body: {} })).data;
check(!!joined?.token, 'a second rider can join');

const wsUrl = (j) => `${BASE.replace('https', 'wss')}/api/rides/${ride.code}/ws?rider=${j.riderId}&token=${j.token}`;
const open = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  const inbox = [];
  ws.onmessage = (e) => inbox.push(e.data === 'pong' ? 'pong' : JSON.parse(e.data));
  ws.onopen = () => res({ ws, inbox });
  ws.onerror = () => rej(new Error('socket failed'));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const first = await open(wsUrl(ride));
const riderTwo = await open(wsUrl(joined));
await wait(800);
check(first.inbox.some((m) => m.t === 'state'), 'the live ride socket connects');
first.ws.send(JSON.stringify({ t: 'stop.add', stop: { name: 'Test', la: 12.9, lo: 77.6, kind: 'fuel' } }));
first.ws.send(JSON.stringify({ t: 'loc', la: 12.97, lo: 77.59, sp: 50, hd: 90, ts: Date.now() }));
first.ws.send('ping');
await wait(4000);
check(riderTwo.inbox.some((m) => m.t === 'stops' && m.stops.length === 1), 'a stop reaches the other rider live');
check(riderTwo.inbox.some((m) => m.t === 'locs'), 'location reaches the other rider in a batch');
check(first.inbox.includes('pong'), 'keepalive is answered');

const headers = { 'x-rider': ride.riderId, 'x-token': ride.token };
const config = await api(`/api/rides/${ride.code}/voice/config`, { headers });
check(config.status === 200, 'voice config is served', `mode ${config.data?.mode}`);

const friend = await api('/api/friends/request', { method: 'POST', headers: as(a), body: { target: b.friendCode } });
check(friend.data?.status === 'sent', 'friend requests work');

const log = { id: `2026-11-06:${ride.code}`, date: '2026-11-06', code: ride.code, rideName: 'Live test', startedAt: 1, endedAt: 2, distanceM: 1000, movingS: 60, stoppedS: 0, gapS: 0, topKmh: 60, bands: [0, 0, 0, 60, 0, 0], intervals: [[1000, 60]], track: [] };
check((await api('/api/stats', { method: 'POST', headers: as(a), body: log })).status === 200, 'ride stats are saved');
check((await api('/api/stats', { headers: as(a) })).data?.length === 1, 'ride stats are listed for their rider');
check((await api('/api/stats', { headers: as(b) })).data?.length === 0, "riders cannot see each other's stats");

first.ws.send(JSON.stringify({ t: 'ride.start' }));
await wait(900);
check(riderTwo.inbox.some((m) => m.t === 'ride' && m.ride.phase === 'riding'), 'starting the ride reaches the group');
riderTwo.ws.send(JSON.stringify({ t: 'ride.finish' }));
await wait(600);
check(!riderTwo.inbox.some((m) => m.t === 'ride' && m.ride.phase === 'finished'), 'only the host can end the ride while online');
first.ws.send(JSON.stringify({ t: 'ride.finish' }));
await wait(900);
check(riderTwo.inbox.some((m) => m.t === 'ride' && m.ride.phase === 'finished'), 'the host ending the ride reaches the group');

await api(`/api/admin/rides/${ride.code}/end`, { method: 'POST', headers: owner, body: {} });
await wait(800);
check(riderTwo.inbox.some((m) => m.t === 'ended'), 'the owner closing a ride reaches the riders');
const users = (await api('/api/admin/users', { headers: owner })).data ?? [];
for (const u of users.filter((x) => /@test\.example$/.test(x.email))) await api(`/api/admin/users/${u.id}`, { method: 'DELETE', headers: owner });
const after = await api('/api/admin/overview', { headers: owner });
check(after.data?.users === over.data?.users && after.data?.rides === over.data?.rides, 'test data was removed', `${after.data?.users} users, ${after.data?.rides} rides`);
first.ws.close();
riderTwo.ws.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
