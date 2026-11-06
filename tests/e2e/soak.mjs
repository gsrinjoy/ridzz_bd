// Holds a real call open and watches for drift: dropped audio, growing memory, reconnects.
// Usage: OWNER=<admin password> MINUTES=20 node tests/e2e/soak.mjs <url>
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.argv[2];
const MINUTES = Number(process.env.MINUTES ?? 20);
const owner = { authorization: `Bearer ${process.env.OWNER}`, 'content-type': 'application/json' };
const admin = (path, init) => fetch(`${BASE}/api/admin/${path}`, { headers: owner, ...init }).then((r) => r.json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flags = (file) => ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(file ? [`--use-file-for-fake-audio-capture=${file}`] : []), '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'];

function instrument() {
  window.__pcs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...a) {
      super(...a);
      window.__pcs.push(this);
    }
  };
  let lat = 12.97;
  navigator.geolocation.watchPosition = (ok) => setInterval(() => {
    lat += 0.0002;
    ok({ coords: { latitude: lat, longitude: 77.59, speed: 16, heading: 0, accuracy: 8 }, timestamp: Date.now() });
  }, 1000);
}

async function rider(browser, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone', 'geolocation'] });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const email = `${name.toLowerCase()}.${Date.now()}@test.example`;
  await page.goto(BASE);
  await page.click('text=Create an account');
  await page.fill('#name', name);
  await page.fill('#email', email);
  await page.fill('#password', 'test-password-1');
  await page.click('button:has-text("Create account")');
  await page.click('text=I saved it');
  await page.waitForSelector('text=Waiting for approval');
  const users = await admin('users');
  await admin(`users/${users.find((u) => u.email === email).id}/approve`, { method: 'POST', body: '{}' });
  await page.click('text=Check again');
  await page.waitForSelector('#code');
  return page;
}

const sample = (p) =>
  p.evaluate(async () => {
    let recv = 0;
    let sent = 0;
    let live = 0;
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'connected') live++;
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp') recv += s.packetsReceived ?? 0;
        if (s.type === 'outbound-rtp') sent += s.packetsSent ?? 0;
      });
    }
    return { recv, sent, live, pcs: window.__pcs.length, heapMb: Math.round(performance.memory.usedJSHeapSize / 1048576) };
  });

await admin('clear-lockouts', { method: 'POST', body: '{}' });
const a0 = await chromium.launch({ channel: 'chrome', headless: true, args: flags(resolve('tests/fixtures/speech.wav')) });
const b0 = await chromium.launch({ channel: 'chrome', headless: true, args: flags() });
let fail = 0;
try {
  const a = await rider(a0, 'SoakA');
  const b = await rider(b0, 'SoakB');
  await a.click('text=Plan a new ride');
  await a.waitForSelector('.topbar');
  const { code } = await a.evaluate(() => JSON.parse(localStorage.getItem('slipstream.session')));
  await b.fill('#code', code);
  await b.click('text=Join ride');
  await b.waitForSelector('.topbar');
  await a.click('button:has-text("Start ride")');
  await a.locator('.sheet button:has-text("Join the call")').click();
  await b.locator('.sheet button:has-text("Join the call")').click();
  await wait(30000);
  const first = await sample(b);
  console.log(`start: ${JSON.stringify(first)}`);
  let last = first;
  const end = Date.now() + MINUTES * 60_000;
  while (Date.now() < end) {
    await wait(60_000);
    const now = await sample(b);
    const gained = now.recv - last.recv;
    const minute = Math.round((MINUTES * 60_000 - (end - Date.now())) / 60_000);
    console.log(`min ${minute}: +${gained} packets, ${now.live} link, ${now.pcs} connections made, heap ${now.heapMb} MB`);
    if (gained < 500) fail++;
    last = now;
  }
  console.log(`end: heap ${first.heapMb} -> ${last.heapMb} MB, reconnects ${last.pcs - first.pcs}, quiet minutes ${fail}`);
} catch (e) {
  fail++;
  console.log('crashed', String(e.message).slice(0, 200));
} finally {
  await a0.close();
  await b0.close();
  const users = await admin('users');
  for (const u of users.filter((x) => /@test\.example$/.test(x.email))) await admin(`users/${u.id}`, { method: 'DELETE' });
  const rides = await admin('rides');
  for (const r of rides.filter((x) => x.riders.every((p) => /^Soak/.test(p.name)))) await admin(`rides/${r.code}/end`, { method: 'POST', body: '{}' });
}
console.log(fail ? `FAIL  ${fail} problem minutes` : 'PASS  call held steady');
process.exit(fail ? 1 : 0);
