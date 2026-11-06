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
const as = (a) => ({ 'x-user': a.userId, 'x-user-token': a.token });

const home = await fetch(BASE);
check(home.ok && (await home.text()).includes('Slipstream'), 'the app is served', `HTTP ${home.status}`);
check((await fetch(`${BASE}/map-style.json`)).ok, 'the map style is served');
check((await fetch(`${BASE}/manifest.webmanifest`)).ok, 'the web app manifest is served');
const deep = await fetch(`${BASE}/r/ABC234`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
check(deep.ok && (await deep.text()).includes('id="app"'), 'invite links open the app');

const tiles = await api('/api/map/tiles.json');
check(tiles.status === 200 && !!tiles.data?.tiles, 'the map tile index works through the Worker');
const search = await api('/api/places/search?q=Nandi%20Hills');
check(search.data?.length > 0, 'place search works', search.data?.[0]?.name);
const route = await api('/api/route?coords=77.59,12.97;77.68,13.37');
check(route.data?.distanceM > 1000, 'road routing works', `${Math.round((route.data?.distanceM ?? 0) / 1000)} km`);
const short = await api(`/api/places/resolve?url=${encodeURIComponent('https://evil.example.com/x')}`);
check(short.status === 400, 'link expansion refuses other websites');

check((await api('/api/admin/overview')).status === 401, 'the owner API refuses no password');
check((await api('/api/admin/overview', { headers: { authorization: 'Bearer wrong' } })).status === 401, 'the owner API refuses a wrong password');
const over = await api('/api/admin/overview', { headers: owner });
check(over.status === 200, 'the owner API accepts the owner password', JSON.stringify(over.data?.services));

const a = (await api('/api/accounts', { method: 'POST', body: { name: 'LiveTest A' } })).data;
const b = (await api('/api/accounts', { method: 'POST', body: { name: 'LiveTest B' } })).data;
check(!!a?.token && !!b?.friendCode, 'accounts can be created');
const ride = (await api('/api/rides', { method: 'POST', headers: as(a), body: {} })).data;
check(/^[A-Z2-9]{6}$/.test(ride?.code ?? ''), 'a ride can be created', ride?.code);
const joined = (await api(`/api/rides/${ride.code}/join`, { method: 'POST', headers: as(b), body: {} })).data;
check(!!joined?.token, 'a second rider can join');
check((await api('/api/rides', { method: 'POST', body: {} })).status === 401, 'creating a ride needs an account');

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
const second = await open(wsUrl(joined));
await wait(800);
check(first.inbox.some((m) => m.t === 'state'), 'the live ride socket connects');
first.ws.send(JSON.stringify({ t: 'stop.add', stop: { name: 'Test', la: 12.9, lo: 77.6, kind: 'fuel' } }));
first.ws.send(JSON.stringify({ t: 'loc', la: 12.97, lo: 77.59, sp: 50, hd: 90, ts: Date.now() }));
first.ws.send('ping');
await wait(4000);
check(second.inbox.some((m) => m.t === 'stops' && m.stops.length === 1), 'a stop reaches the other rider live');
check(second.inbox.some((m) => m.t === 'locs'), 'location reaches the other rider in a batch');
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

await api(`/api/admin/rides/${ride.code}/end`, { method: 'POST', headers: owner, body: {} });
await wait(800);
check(second.inbox.some((m) => m.t === 'ended'), 'ending a ride reaches the riders');
for (const u of [a, b]) await api(`/api/admin/users/${u.userId}`, { method: 'DELETE', headers: owner });
const after = await api('/api/admin/overview', { headers: owner });
check(after.data?.users === over.data?.users && after.data?.rides === over.data?.rides, 'test data was removed', `${after.data?.users} users, ${after.data?.rides} rides`);
first.ws.close();
second.ws.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
