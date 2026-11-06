// Walks every rider screen at several phone sizes and reports layout faults.
// Usage: node tests/e2e/ui-audit.mjs <outDir>
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = resolve(process.argv[2] ?? '.');
const SIZES = [[320, 568], [360, 740], [390, 844], [412, 915]];
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function audit() {
  const MIN_TAP = 40; // Runs in the page, so it cannot reach outer constants.
  const faults = [];
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  if (document.documentElement.scrollWidth > vw) faults.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
  const seen = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
  };
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().slice(0, 28);
  const pageScrolls = document.documentElement.scrollHeight > vh + 1;
  const scrollable = (el) => {
    if (pageScrolls) return true;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p);
      if (/auto|scroll/.test(o.overflowY + o.overflowX) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('button, a.btn, a.icon-btn, input:not([type=range]):not([type=checkbox])')) {
    if (!seen(el)) continue;
    const r = el.getBoundingClientRect();
    if (el.closest('.maplibregl-ctrl')) continue;
    if (r.height < MIN_TAP || (r.width < MIN_TAP && !el.classList.contains('swatch'))) faults.push(`small tap target: "${name(el)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (!scrollable(el) && (r.right > vw + 1 || r.left < -1)) faults.push(`off screen sideways: "${name(el)}"`);
    if (!scrollable(el) && r.bottom > vh + 1) faults.push(`below the fold, unreachable: "${name(el)}"`);
  }
  // A panel scrolls up and down, never sideways: nothing may stick out of it.
  for (const panel of document.querySelectorAll('.panel')) {
    const edge = panel.getBoundingClientRect().right;
    if (panel.scrollWidth > panel.clientWidth + 1) faults.push(`panel is wider than the screen (${panel.scrollWidth} > ${panel.clientWidth})`);
    for (const el of panel.querySelectorAll('*')) {
      if (seen(el) && el.getBoundingClientRect().right > edge + 1 && !el.closest('.kinds')) {
        faults.push(`sticks out of panel: "${name(el)}"`);
        break;
      }
    }
  }
  // Text that no ellipsis was meant to cut.
  for (const el of document.querySelectorAll('button, .label, .chip, .deck-btn, .tab, .stat-card b, .note')) {
    if (!seen(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis') faults.push(`clipped text: "${name(el)}" ${el.scrollWidth}>${el.clientWidth}`);
  }
  // Floating controls must not sit on top of each other.
  const floats = [...document.querySelectorAll('.topbar .chip, .fab, .alert-toast')].filter(seen).map((el) => [el, el.getBoundingClientRect()]);
  for (let i = 0; i < floats.length; i++) {
    for (let j = i + 1; j < floats.length; j++) {
      const [a, ra] = floats[i];
      const [b, rb] = floats[j];
      if (ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom) faults.push(`overlap: "${name(a)}" and "${name(b)}"`);
    }
  }
  const dock = document.querySelector('.dock')?.getBoundingClientRect();
  if (dock) for (const [el, r] of floats) if (r.bottom > dock.top + 1 && el.classList.contains('fab')) faults.push(`button under the dock: "${name(el)}"`);
  const map = document.querySelector('.map-area')?.getBoundingClientRect();
  if (map && map.height < 120) faults.push(`map squeezed to ${Math.round(map.height)}px`);
  return [...new Set(faults)];
}

const server = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(PORT), '--persist-to', mkdtempSync(join(tmpdir(), 'slipstream-'))], { stdio: 'ignore' });
for (let i = 0; i < 80 && !(await fetch(BASE).then((r) => r.ok).catch(() => false)); i++) await wait(500);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
let total = 0;

for (const [width, height] of SIZES) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: ['geolocation', 'microphone'], geolocation: { latitude: 12.9716, longitude: 77.5946 } });
  await context.route('https://tiles.openfreemap.org/**', (r) => r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const step = async (label, shoot = false) => {
    await wait(350);
    const faults = await page.evaluate(audit);
    for (const f of faults) console.log(`${width}px  ${label.padEnd(14)} ${f}`);
    total += faults.length;
    if (shoot) await page.screenshot({ path: `${outDir}/${width}-${label}.png` });
  };

  await page.goto(BASE);
  await step('sign-in', true);
  await page.tap('text=Create an account');
  await step('register', true);
  await page.tap('text=Back to sign in');
  await page.tap('text=Forgot password?');
  await step('recover', true);
  await page.tap('text=Back to sign in');
  await signUp(page, 'Srinjoy');
  await step('home', true);
  await page.tap('text=Plan a new ride');
  await page.waitForSelector('.topbar');

  const { code } = await page.evaluate(() => JSON.parse(localStorage.getItem('slipstream.session')));
  const friends = [['Asha', '#2BD9C5', 12.9921, 77.6101, 78], ['Benjamin Fernandes', '#F5D90A', 12.9502, 77.6312, 64], ['Cara', '#FF4D8D', 13.0102, 77.5703, 0]];
  const sockets = [];
  for (const [name, color, la, lo, sp] of friends) {
    const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
    // A made-up address per seeded rider, as the sign-up limit counts per network.
    const { account: a } = await post('/api/auth/register', { name, color, email: `${Math.random().toString(36).slice(2)}@test.example`, password: 'test-password-1' }, { 'cf-connecting-ip': `10.0.0.${Math.floor(Math.random() * 250)}` });
    await post(`/api/admin/users/${a.userId}/approve`, {}, { authorization: 'Bearer local-admin-only' });
    const j = await post(`/api/rides/${code}/join`, {}, { authorization: `Bearer ${a.token}` });
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/rides/${code}/ws?rider=${j.riderId}&token=${j.token}`);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ t: 'loc', la, lo, sp, hd: 90, ts: Date.now() }));
    ws.send(JSON.stringify({ t: 'voice', pub: { sessionId: 'x', trackName: 'y' } }));
    if (name === 'Asha') ws.send(JSON.stringify({ t: 'talk', on: true }));
    if (name === 'Cara') {
      ws.send(JSON.stringify({ t: 'stop.add', stop: { name: 'Indian Oil Petrol Pump, Hoskote Main Road', la: 13.07, lo: 77.79, kind: 'fuel' } }));
      ws.send(JSON.stringify({ t: 'stop.add', stop: { name: 'Nandi Hills viewpoint', la: 13.3702, lo: 77.6835, kind: 'view' } }));
    }
    sockets.push(ws);
  }
  await wait(3500);
  await step('ride', true);
  await page.tap('.talkbar button');
  await wait(1200);
  await step('in-call', true);
  await page.tap('[role=tab]:has-text("Call")');
  await step('call', true);
  await page.tap('.deck-btn:has-text("Speaker")');
  await step('call-speaker', true);
  await page.tap('[role=tab]:has-text("Riders")');
  await step('riders', true);
  await page.tap('text=Invite riders');
  await step('invite', true);
  await page.tap('text=Invite riders');
  await page.locator('.row-tap').first().tap();
  await step('rider-detail', true);
  await page.tap('[role=tab]:has-text("Plan")');
  await step('stops', true);
  await page.tap('[role=tab]:has-text("Friends")');
  await step('friends', true);
  await page.tap('[role=tab]:has-text("Settings")');
  await step('settings', true);
  await page.tap('[aria-pressed="false"]:has-text("Hold")').catch(() => undefined);
  await page.tap('text=Ride mode (saves battery)');
  await step('ride-mode', true);
  await page.tap('.ridemode-foot .btn');
  await page.tap('[role=tab]:has-text("Plan")').catch(() => undefined);
  await page.tap('button:has-text("Start ride")');
  await wait(900);
  await step('riding', true);
  await page.tap('[role=tab]:has-text("Settings")');
  await step('riding-settings', true);
  await page.tap('text=Leave ride');
  await page.waitForSelector('#code');
  await wait(500);
  await step('home-after', true);
  await page.tap('text=My rides and stats');
  await step('my-rides', true);
  if (errors.length) console.log(`${width}px  script errors: ${errors.join(' | ').slice(0, 200)}`);
  sockets.forEach((s) => s.close());
  await context.close();
}

await browser.close();
server.kill();
console.log(total ? `\n${total} layout fault(s)` : '\nNo layout faults');
process.exit(0);
