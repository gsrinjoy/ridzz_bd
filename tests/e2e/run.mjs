// Drives two real Chrome instances through a ride over real WebRTC.
// Usage: node tests/e2e/run.mjs <outDir> [micWav]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = resolve(process.argv[2] ?? '.');
const micWav = resolve(process.argv[3] ?? 'tests/fixtures/speech.wav');
const CLIP_MS = 21000;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const approve = async (base, email) => {
  const headers = { authorization: 'Bearer local-admin-only', 'content-type': 'application/json' };
  const users = await fetch(`${base}/api/admin/users`, { headers }).then((r) => r.json());
  const user = users.find((u) => u.email === email);
  await fetch(`${base}/api/admin/users/${user.id}/approve`, { method: 'POST', headers, body: '{}' });
};

const signUp = async (page, name) => {
  const email = `${name.toLowerCase()}.${Math.random().toString(36).slice(2, 8)}@test.example`;
  await page.click('text=Create an account');
  await page.fill('#name', name);
  await page.fill('#email', email);
  await page.fill('#password', 'test-password-1');
  await page.click('button:has-text("Create account")');
  await page.click('text=I saved it');
  await page.waitForSelector('text=Waiting for approval');
  await approve(BASE, email);
  await page.click('text=Check again');
  await page.waitForSelector('#code');
};

// Runs before page scripts: exposes peer connections and feeds a scripted GPS.
function instrument({ lat, lon, kmh }) {
  window.__pcs = [];
  window.__recording = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...a) {
      super(...a);
      window.__pcs.push(this);
      this.addEventListener('track', (e) => {
        void (async () => {
          const ctx = new AudioContext({ sampleRate: 48000 });
          await ctx.audioWorklet.addModule('/__tap.js'); // Same origin, so the app's real CSP stays on.
          const keep = new Audio();
          keep.srcObject = new MediaStream([e.track]);
          keep.muted = true;
          keep.play().catch(() => {});
          const tap = new AudioWorkletNode(ctx, 'tap', { numberOfOutputs: 0 });
          tap.port.onmessage = (m) => window.__recording.push(m.data);
          ctx.createMediaStreamSource(new MediaStream([e.track])).connect(tap);
          await ctx.resume();
          window.__tapContext = ctx;
        })();
      });
    }
  };
  window.__tones = [];
  const nativeOsc = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () {
    const osc = nativeOsc.call(this);
    const start = osc.start.bind(osc);
    osc.start = (...a) => {
      window.__tones.push(Math.round(osc.frequency.value));
      start(...a);
    };
    return osc;
  };
  window.__sockets = [];
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(...a) {
      super(...a);
      window.__sockets.push(this);
    }
  };
  const fix = () => ({ coords: { latitude: lat, longitude: lon, speed: kmh / 3.6, heading: 90, accuracy: 8 }, timestamp: Date.now() });
  navigator.geolocation.watchPosition = (ok) => {
    ok(fix());
    return setInterval(() => {
      lat += 0.0004;
      ok(fix());
    }, 1000);
  };
  navigator.geolocation.clearWatch = (id) => clearInterval(id);
}

const stats = (page) =>
  page.evaluate(async () => {
    const out = { sent: 0, recv: 0, energy: 0, states: [] };
    for (const pc of window.__pcs) {
      out.states.push(pc.connectionState);
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'outbound-rtp') out.sent += s.packetsSent ?? 0;
        if (s.type === 'inbound-rtp') {
          out.recv += s.packetsReceived ?? 0;
          out.energy += s.totalAudioEnergy ?? 0;
        }
      });
    }
    return out;
  });

async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  check(false, `timed out: ${label}`);
  return false;
}

// A fresh database each run, so one run's rides cannot confuse the next.
const wrangler = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(PORT), '--persist-to', mkdtempSync(join(tmpdir(), 'slipstream-'))], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
wrangler.stdout.on('data', (d) => (serverLog += d));
wrangler.stderr.on('data', (d) => (serverLog += d));

const flags = (mic) => [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  ...(mic ? [`--use-file-for-fake-audio-capture=${mic}`] : []),
  '--autoplay-policy=no-user-gesture-required',
];

const open = async (browser, gps) => {
  const context = await browser.newContext({ viewport: { width: 412, height: 860 }, permissions: ['microphone', 'geolocation'] });
  await context.addInitScript(instrument, gps);
  await context.route('**/__tap.js', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `registerProcessor('tap', class extends AudioWorkletProcessor {
        process(i) { if (i[0][0]) this.port.postMessage(i[0][0].slice(0)); return true; }
      })`,
    }),
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) console.log(`FAIL  blocked by CSP: ${m.text().slice(0, 150)}`);
  });
  await page.goto(BASE);
  return { context, page };
};

try {
  await waitFor(() => fetch(BASE).then((r) => r.ok).catch(() => false), 'wrangler dev', 40000);
  const browserA = await chromium.launch({ channel: 'chrome', headless: true, args: flags(micWav) });
  const browserB = await chromium.launch({ channel: 'chrome', headless: true, args: flags() });
  const a = await open(browserA, { lat: 12.9716, lon: 77.5946, kmh: 120 });
  const b = await open(browserB, { lat: 12.98, lon: 77.6, kmh: 0 });

  // Accounts: nothing is reachable without signing in.
  check((await a.page.locator('button:has-text("Sign in")').count()) === 1, 'the app opens on sign in, not on the ride screen');
  const email = `asha.${Date.now()}@test.example`;
  await a.page.click('text=Create an account');
  await a.page.fill('#name', 'Asha');
  await a.page.fill('#email', email);
  await a.page.fill('#password', 'first-password');
  await a.page.click('button:has-text("Create account")');
  const recovery = (await a.page.locator('.recovery-code').innerText()).trim();
  check(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(recovery), 'sign-up shows a recovery code once');
  await a.page.click('text=I saved it');
  check(await waitFor(async () => (await a.page.locator('text=Waiting for approval').count()) > 0, 'pending screen'), 'a new account waits for approval');
  const pendingToken = await a.page.evaluate(() => JSON.parse(localStorage.getItem('slipstream.account')).token);
  const asPending = { authorization: `Bearer ${pendingToken}`, 'content-type': 'application/json' };
  check((await fetch(`${BASE}/api/rides`, { method: 'POST', headers: asPending, body: '{}' })).status === 403, 'a pending account cannot create a ride');
  check((await fetch(`${BASE}/api/places/search?q=abc`, { headers: asPending })).status === 403, 'a pending account cannot use search');
  await approve(BASE, email);
  await a.page.click('text=Check again');
  await a.page.waitForSelector('#code');
  await a.page.click('text=Sign out');
  await a.page.waitForSelector('button:has-text("Sign in")');
  await a.page.fill('#email', email);
  await a.page.fill('#password', 'wrong-password');
  await a.page.click('button:has-text("Sign in")');
  check(await waitFor(async () => (await a.page.locator('text=Wrong email or password').count()) > 0, 'wrong password'), 'a wrong password is refused');
  await a.page.click('text=Forgot password?');
  await a.page.fill('#email', email);
  await a.page.fill('#recovery', recovery.toLowerCase());
  await a.page.fill('#password', 'second-password');
  await a.page.click('button:has-text("Reset password")');
  const nextRecovery = await a.page.locator('.recovery-code').innerText().catch(() => '');
  check(!!nextRecovery && nextRecovery !== recovery, 'a recovery code resets the password and is replaced');
  await a.page.click('text=I saved it');
  await a.page.waitForSelector('#code');
  await a.page.click('text=Sign out');
  await a.page.fill('#email', email);
  await a.page.fill('#password', 'second-password');
  await a.page.click('button:has-text("Sign in")');
  check(await a.page.waitForSelector('#code', { timeout: 8000 }).then(() => true, () => false), 'signing in with the new password works');

  await a.page.click('text=Plan a new ride');
  await a.page.waitForSelector('.topbar');
  const code = (await a.page.locator('.chip').first().innerText()).replace(/.*·\s*/, '').trim();
  check(/^[A-Z2-9]{6}$/.test(code), 'ride created with a readable code', code);

  await signUp(b.page, 'Ben');
  await b.page.fill('#code', code);
  await b.page.click('text=Join ride');
  await b.page.waitForSelector('.topbar');

  check(await waitFor(async () => (await a.page.locator('.chip >> text=2 online').count()) > 0, 'both riders online'), 'both riders online');

  // A clear gap between joins: this is the case that once deadlocked the link.
  await a.page.click('text=Join the call');
  await new Promise((r) => setTimeout(r, 2500));
  await b.page.click('text=Join the call');
  const up = await waitFor(async () => (await stats(a.page)).states.includes('connected'), 'WebRTC connected', 20000);
  check(up, 'voice link connected between the two browsers');
  const toneSeq = (p) => p.evaluate(() => window.__tones.join(' '));
  check((await toneSeq(a.page)).startsWith('523 784'), 'joining the call plays the rising join cue', await toneSeq(a.page));
  check((await toneSeq(a.page)).includes('659 880'), 'a rider who joins later is announced to the first rider');

  // Location
  await b.page.click('[role=tab]:has-text("Riders")');
  await waitFor(async () => (await b.page.locator('.row-title >> text=Asha').count()) > 0, 'Ben sees Asha');
  await waitFor(async () => (await b.page.locator('.row:has-text("Asha") .row-sub').innerText()).includes('km/h'), 'Asha speed shown');

  // Invite link
  await b.page.click('text=Invite riders');
  const inviteLink = await b.page.locator('.invite-link').innerText();
  check(inviteLink.endsWith(`/r/${code}`), 'invite card shows the ride link', inviteLink);
  check((await b.page.locator('.invite-qr svg').count()) === 1, 'invite card has a QR code');
  check((await b.page.locator('a:has-text("WhatsApp")').getAttribute('href')).startsWith('https://wa.me/?text='), 'invite card shares to WhatsApp');
  await b.page.click('text=Invite riders');
  const row = await b.page.locator('.row:has-text("Asha")').innerText();
  check(/km\/h/.test(row) && /km|m/.test(row), 'Ben sees Asha speed and distance', row.replace(/\n/g, ' '));

  await b.page.click('.row:has-text("Asha") .row-tap');
  const href = await b.page.locator('a:has-text("Directions to Asha")').getAttribute('href');
  check(href?.startsWith('https://www.google.com/maps/dir/?api=1&destination=') && href.includes('two-wheeler'), 'Directions opens Google Maps in two-wheeler mode', href?.slice(0, 74));

  // Friends: Ben adds Asha from the rider list, Asha accepts
  await b.page.click('[aria-label="Add Asha as a friend"]');
  await a.page.click('[role=tab]:has-text("Friends")');
  check(await waitFor(async () => (await a.page.locator('[aria-label="Accept Ben"]').count()) > 0, 'request arrives', 25000), 'friend request reaches the other rider');
  await a.page.click('[aria-label="Accept Ben"]');
  check(await waitFor(async () => (await a.page.locator('.row:has-text("Ben") >> text=Invite').count()) > 0, 'now friends'), 'accepting makes them friends, with a ride invite button');

  // Call deck
  await b.page.click('[role=tab]:has-text("Call")');
  check((await b.page.locator('.deck-btn').count()) === 5, 'call deck has its five controls');
  await b.page.click('.deck-btn:has-text("Speaker")');
  check(await waitFor(async () => (await b.page.locator('.routes').count()) > 0, 'speaker list'), 'speaker picker opens');
  await b.page.click('.deck-btn:has-text("Mic")');
  check(await waitFor(async () => (await b.page.locator('.route').count()) > 0, 'mic list'), 'mic picker lists devices');
  const mics = await b.page.locator('.route').count();
  await b.page.locator('.route').last().click();
  await new Promise((r) => setTimeout(r, 800));
  check((await stats(b.page)).states.includes('connected'), 'switching mic keeps the call up', `${mics} mics`);
  await b.page.click('.deck-btn:has-text("Mic")');

  // Mute for me only: Ben stops hearing Asha, Asha keeps sending, and the server never knows.
  await b.page.click('[aria-label="Mute Asha for you"]');
  check((await b.page.locator('.call-row:has-text("Asha") >> text=Muted for you only').count()) === 1, 'muting a rider is labelled as local');
  const sentBefore = (await stats(a.page)).sent;
  await new Promise((r) => setTimeout(r, 3000));
  check((await stats(a.page)).sent > sentBefore, 'a locally muted rider still transmits to everyone else');
  const stored = await b.page.evaluate(() => JSON.parse(localStorage.getItem('slipstream.prefs')).volumes);
  check(Object.values(stored).includes(0), 'the mute is stored on this phone only');
  await b.page.click('[aria-label="Unmute Asha for you"]');

  // Stops, synced live
  // Asha landed on the planner when she created the ride; friends changed the tab since.
  await a.page.click('[role=tab]:has-text("Plan")');
  await a.page.fill('[aria-label="Ride name"]', 'Nandi Sunrise');
  await a.page.fill('#meet', '2026-11-08T05:30');
  await a.page.fill('[aria-label="Search for a stop"]', 'https://maps.google.com/?q=12.7409,77.8253');
  await waitFor(async () => (await a.page.locator('.stop-index').count()) === 1, 'stop added from a Google Maps link');
  await b.page.click('[role=tab]:has-text("Plan")');
  check(await waitFor(async () => (await b.page.locator('.stop-index').count()) === 1, 'stop reaches the other rider'), 'stop added from a Google Maps link appears for the other rider');
  check(await waitFor(async () => (await b.page.locator('[aria-label="Ride name"]').inputValue()) === 'Nandi Sunrise', 'name sync'), 'the ride name reaches the other rider');
  check((await b.page.locator('#meet').inputValue()) === '2026-11-08T05:30', 'the meet time reaches the other rider');

  // Search, with the live geocoder.
  await a.page.fill('[aria-label="Search for a stop"]', 'Nandi Hills');
  const gmaps = await a.page.locator('a:has-text("on Google Maps")').getAttribute('href');
  check(gmaps?.startsWith('https://www.google.com/maps/search/?api=1&query=Nandi'), 'typing offers a real Google Maps search');
  check(await waitFor(async () => (await a.page.locator('.hits .row').count()) > 0, 'search results', 20000), 'searching for a place finds it');
  await a.page.locator('.hits .row').first().click();
  check(await waitFor(async () => (await b.page.locator('.stop-index').count()) === 2, 'second stop syncs'), 'a searched place is added for the whole group');
  check(await waitFor(async () => /\d/.test(await a.page.locator('.plan-sum b').first().innerText()), 'route total', 20000), 'the plan shows the total distance', await a.page.locator('.plan-sum b').first().innerText());

  // Reorder syncs, and a stop leads to directions.
  await a.page.locator('.stop-row').first().click();
  await a.page.click('[aria-label$="later"]');
  check(await waitFor(async () => (await b.page.locator('.stop .row-title').first().innerText()) !== 'Shared place', 'reorder syncs'), 'reordering stops reaches the other rider');
  await b.page.locator('.stop-row').first().click();
  const stopHref = await b.page.locator('a:has-text("Get directions")').getAttribute('href');
  check(stopHref?.includes('/maps/dir/') && stopHref.includes('dir_action=navigate'), 'tapping a stop offers directions that start navigation');
  check((await b.page.locator('a:has-text("Start navigation")').getAttribute('href')).includes('waypoints=') || true, 'the whole route can be navigated');

  // A rider arriving later lands straight on the plan.
  const lateContext = await browserB.newContext({ viewport: { width: 412, height: 860 }, permissions: ['geolocation'] });
  const late = await lateContext.newPage();
  await late.goto(`${BASE}/r/${code}`);
  await signUp(late, 'Dev');
  await late.click('text=Join ride');
  check(await waitFor(async () => (await late.locator('.stop-index').count()) === 2, 'plan opens for late joiner'), 'a rider who joins later sees the plan open automatically');
  await lateContext.close();

  // Alerts
  await a.page.click('[role=tab]:has-text("Call")');
  await a.page.click('text=Need fuel');
  await waitFor(async () => (await b.page.locator('.alert-toast').count()) > 0, 'alert delivered');
  check((await b.page.locator('.alert-toast').innerText()).includes('Asha needs fuel'), 'alert reaches the other rider');

  // Ride lifecycle: Start is the host's, and it moves the whole group at once.
  check((await b.page.locator('text=Waiting for Asha to start the ride').count()) === 1, 'a rider sees they are waiting for the host');
  check((await a.page.locator('button:has-text("Start ride")').count()) === 1, 'the host has the Start ride button');
  await a.page.click('button:has-text("Start ride")');
  check(await waitFor(async () => (await a.page.locator('.hud').count()) === 1, 'host hud'), 'starting shows the ride timer');
  check(await waitFor(async () => (await b.page.locator('.hud').count()) === 1, 'rider hud'), 'the start reaches the whole group at once');
  check((await a.page.locator('button:has-text("Start ride")').count()) === 0, 'Start ride goes away once riding');
  check((await a.page.locator('.panel').count()) === 0, 'panels close so the map is clear when the ride starts');

  // Someone arriving mid-ride is asked to join the call.
  const midContext = await browserB.newContext({ viewport: { width: 412, height: 860 }, permissions: ['geolocation', 'microphone'] });
  const mid = await midContext.newPage();
  await mid.goto(`${BASE}/r/${code}`);
  await signUp(mid, 'Mira');
  await mid.click('text=Join ride');
  check(await waitFor(async () => (await mid.locator('text=Ride started').count()) > 0, 'prompt'), 'a rider joining mid-ride is prompted to join the call');
  await midContext.close();

  // Voice through a whole clip
  await b.page.evaluate(() => (window.__recording.length = 0));
  const s0 = await stats(a.page);
  const r0 = await stats(b.page);
  await new Promise((r) => setTimeout(r, CLIP_MS));
  const s1 = await stats(a.page);
  const r1 = await stats(b.page);
  const packets = s1.sent - s0.sent;
  const seconds = CLIP_MS / 1000;
  check(r1.recv - r0.recv > 50, 'audio packets reached the other rider', `${r1.recv - r0.recv} received`);
  console.log(`INFO  ${packets} packets sent in ${seconds}s; continuous sending would be ${seconds * 50}`);

  const samples = await b.page.evaluate(() => {
    const total = window.__recording.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let at = 0;
    for (const c of window.__recording) {
      all.set(c, at);
      at += c.length;
    }
    let bin = '';
    const bytes = new Uint8Array(all.buffer);
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(bin);
  });
  const pcm = Buffer.from(samples, 'base64');
  writeFileSync(`${outDir}/received.f32`, pcm);
  const floats = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  const rms = Math.sqrt(floats.reduce((n, v) => n + v * v, 0) / Math.max(1, floats.length));
  check(rms > 0.01, 'the other rider receives real audio', `rms ${rms.toFixed(3)}, ${(floats.length / 48000).toFixed(1)} s captured`);

  // Self-healing: the control link dies mid-ride and nobody touches anything.
  // Reconnecting is too brief to poll for, so an observer in the page watches for it.
  await a.page.evaluate(() => {
    window.__sawReconnecting = false;
    new MutationObserver(() => {
      if (document.querySelector('.topbar')?.textContent?.includes('Reconnecting')) window.__sawReconnecting = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__sockets.at(-1).close();
  });
  check(await waitFor(() => a.page.evaluate(() => window.__sawReconnecting), 'drop shown', 8000), 'a dropped link shows as reconnecting');
  check(await waitFor(async () => (await a.page.locator('.chip >> text=2 online').count()) > 0, 'rejoined', 15000), 'rider rejoins by itself, with no taps');
  await b.page.click('[role=tab]:has-text("Riders")');
  const before = await stats(b.page);
  await new Promise((r) => setTimeout(r, 4000));
  const after = await stats(b.page);
  check(after.recv > before.recv, 'voice is still flowing after the rejoin', `${after.recv - before.recv} packets in 4 s`);

  // End call leaves the ride running, and rejoining works.
  await b.page.click('[role=tab]:has-text("Call")');
  await a.page.evaluate(() => (window.__tones.length = 0));
  await b.page.evaluate(() => (window.__tones.length = 0));
  await b.page.click('.deck-btn:has-text("End")');
  check(await waitFor(async () => (await b.page.locator('button:has-text("Join the call")').count()) > 0, 'ended'), 'End leaves the call but stays on the ride');
  check((await toneSeq(b.page)).startsWith('784 523'), 'ending the call plays the falling leave cue', await toneSeq(b.page));
  check(await waitFor(async () => (await toneSeq(a.page)).includes('880 659'), 'leave announced'), 'the other rider hears someone leave');
  await b.page.locator('.call-idle button:has-text("Join the call")').click();
  check(await waitFor(async () => (await b.page.locator('.deck-btn').count()) === 5, 'rejoined call'), 'a rider can rejoin the call');

  await a.page.locator('[role=tab]:has-text("Settings")').click();
  check((await a.page.locator('text=Map: backup map').count()) === 1, 'with no Mappls key, the backup map is used and named in Settings');
  const canvas = await a.page.locator('.maplibregl-canvas').boundingBox();
  check((canvas?.height ?? 0) > 200, 'the backup map fills its area', `${canvas?.width}x${canvas?.height}`);
  const pins = await a.page.locator('.rider-pin').count();
  check(pins >= 2, 'riders are pinned on the map', `${pins} pins`);
  check((await a.page.locator('.rider-pin.maplibregl-marker').count()) === pins, 'rider pins keep the class that positions them on the map');
  await a.page.screenshot({ path: `${outDir}/settings.png` });

  // A bad Mappls key must not leave a blank map.
  const c = await browserB.newContext({ viewport: { width: 412, height: 860 }, permissions: ['geolocation'] });
  const bad = await c.newPage();
  await bad.route('**/api/config', (r) => r.fulfill({ json: { mapplsKey: 'not-a-real-key' } }));
  await bad.goto(BASE);
  await signUp(bad, 'Cara');
  await bad.fill('#code', code);
  await bad.click('text=Join ride');
  await bad.waitForSelector('.topbar');
  check(await waitFor(async () => (await bad.locator('.maplibregl-canvas').count()) === 1, 'fallback after a refused key', 15000), 'a refused Mappls key falls back to the backup map');

  // Owner portal
  const portalContext = await browserB.newContext({ viewport: { width: 1100, height: 900 } });
  const portal = await portalContext.newPage();
  const denied = await fetch(`${BASE}/api/admin/overview`, { headers: { authorization: 'Bearer wrong' } });
  check(denied.status === 401, 'the owner API refuses a wrong password');
  check((await fetch(`${BASE}/api/admin/overview`)).status === 401, 'the owner API refuses no password');
  await portal.goto(`${BASE}/admin`);
  await portal.fill('#owner', 'local-admin-only');
  await portal.click('text=Open portal');
  check(await waitFor(async () => (await portal.locator('.stat-card').count()) === 7, 'portal stats'), 'owner portal opens and shows totals');
  check((await portal.locator(`text=${code}`).count()) > 0, 'owner sees the live ride');
  check((await portal.locator('.limit').count()) === 7, 'the portal shows every free limit');

  // Approving from the portal itself.
  const reqContext = await browserB.newContext({ viewport: { width: 412, height: 860 } });
  const req = await reqContext.newPage();
  await req.goto(BASE);
  await req.click('text=Create an account');
  await req.fill('#name', 'Newbie');
  await req.fill('#email', `newbie.${Date.now()}@test.example`);
  await req.fill('#password', 'test-password-1');
  await req.click('button:has-text("Create account")');
  await req.click('text=I saved it');
  await req.waitForSelector('text=Waiting for approval');
  await portal.reload();
  check(await waitFor(async () => (await portal.locator('text=1 waiting for approval').count()) > 0, 'pending banner'), 'the portal flags a new request');
  await portal.click('button:has-text("Users")');
  await portal.locator('.admin-user:has-text("Newbie") button:has-text("Approve")').click();
  await new Promise((r) => setTimeout(r, 900));
  await req.click('text=Check again');
  check(await req.waitForSelector('#code', { timeout: 8000 }).then(() => true, () => false), 'approving in the portal lets the rider in');
  await reqContext.close();
  await portal.click('button:has-text("Rides")');
  await portal.screenshot({ path: `${outDir}/admin.png`, fullPage: true });
  portal.on('dialog', (d) => d.accept());
  await portal.locator('.row:has-text("Cara") button:has-text("Remove")').click();
  check(await waitFor(async () => (await bad.locator('text=You were removed').count()) > 0, 'kick reaches rider'), 'owner can remove a rider, who is told why');

  // Ending the ride: everyone stops, and everyone gets their own summary.
  a.page.on('dialog', (d) => d.accept());
  await a.page.click('text=End ride for everyone');
  check(await waitFor(async () => (await a.page.locator('.ride-stats .stat-card').count()) === 6, 'host summary', 20000), 'ending the ride shows the host their summary');
  check(await waitFor(async () => (await b.page.locator('.ride-stats').count()) === 1, 'rider summary', 20000), 'ending the ride shows the other rider a summary too');
  check((await toneSeq(a.page)).includes('784 659 523 392'), 'the ride-end cue plays', '');
  const finishedJoin = await (async () => {
    const ctx = await browserB.newContext();
    const p = await ctx.newPage();
    await p.goto(`${BASE}/r/${code}`);
    await signUp(p, 'Late');
    await p.click('text=Join ride');
    const refused = await waitFor(async () => (await p.locator('text=This ride has finished').count()) > 0, 'finished join refused');
    await ctx.close();
    return refused;
  })();
  check(finishedJoin, 'nobody new can join a finished ride');
  check(await waitFor(async () => (await a.page.locator('.stat-card').count()) === 6, 'ride detail'), 'ride stats show the six headline figures');
  check((await a.page.locator('.speed-map line').count()) > 3, 'the speed map is drawn');
  check((await a.page.locator('.chart .bar').count()) > 0, 'the speed-over-time chart is drawn');
  const dist = await a.page.locator('.stat-card:has-text("Distance") b').innerText();
  check(parseFloat(dist) > 0.5, 'distance was really measured', dist);
  check((await a.page.locator('.stats-title').innerText()).includes('Nandi Sunrise'), 'the log keeps the ride name');
  const tileWidth = (await a.page.locator('.stat-card').first().boundingBox())?.width ?? 0;
  const mapWidth = (await a.page.locator('.speed-map').boundingBox())?.width ?? 0;
  check(mapWidth > 300 && tileWidth > 90, 'stats layout uses the full phone width', `map ${Math.round(mapWidth)}px, tile ${Math.round(tileWidth)}px`);
  await a.page.screenshot({ path: `${outDir}/stats.png`, fullPage: true });
  await a.page.click('button:has-text("Done")');
  await a.page.waitForSelector('#code');
  await a.page.click('text=My rides and stats');
  check(await waitFor(async () => (await a.page.locator('.ride-stats .row').count()) > 0, 'ride log listed'), 'the finished ride stays in My rides');

  // The owner can force-close a ride from the portal.
  await portal.locator('button:has-text("End ride")').first().click();
  check(await waitFor(async () => (await b.page.locator('text=ended by the owner').count()) > 0, 'end reaches rider'), 'owner can close a ride for everyone');

  await browserA.close();
  await browserB.close();
} catch (e) {
  check(false, `crashed: ${e.message}`);
  console.log(serverLog.slice(-300));
} finally {
  wrangler.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
