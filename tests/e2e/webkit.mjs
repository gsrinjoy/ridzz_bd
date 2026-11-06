// The Safari engine, at iPhone size. Playwright's WebKit is not an iPhone: it
// cannot exercise a real mic, lock screen, or Bluetooth. It does prove our code
// runs on WebKit, including the voice pipeline fed from a synthetic source.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { devices, webkit } from 'playwright-core';

const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = resolve(process.argv[2] ?? '.');
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(PORT), '--persist-to', mkdtempSync(join(tmpdir(), 'slipstream-'))], { stdio: 'ignore' });
for (let i = 0; i < 80 && !(await fetch(BASE).then((r) => r.ok).catch(() => false)); i++) await wait(500);

const assets = readdirSync('dist/assets');
const worklet = assets.find((f) => f.startsWith('worklet-'));
const wasm = assets.find((f) => f.endsWith('.wasm'));

try {
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 15'], permissions: ['geolocation'], geolocation: { latitude: 12.97, longitude: 77.59 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  check(true, 'loads on WebKit with an iPhone profile', await page.evaluate(() => navigator.userAgent.match(/iPhone OS [\d_]+/)?.[0] ?? ''));

  await signUp(page, 'Ira');
  await page.click('text=Plan a new ride');
  await page.waitForSelector('.topbar');
  check(true, 'creates a ride');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling');

  // The whole capture chain on WebKit's own audio and WASM engines.
  const dsp = await page.evaluate(async ({ worklet, wasm }) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    await ctx.audioWorklet.addModule(`/assets/${worklet}`);
    const bytes = await (await fetch(`/assets/${wasm}`)).arrayBuffer();
    const node = new AudioWorkletNode(ctx, 'slipstream-voice', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { wasm: bytes } });
    const seen = { meters: 0, level: -999, tx: 0 };
    node.port.onmessage = (e) => {
      if (e.data.type === 'meter') {
        seen.meters++;
        seen.level = Math.max(seen.level, e.data.level);
      }
      if (e.data.type === 'tx') seen.tx++;
    };
    node.port.postMessage({ type: 'meters', on: true });
    node.port.postMessage({ type: 'mode', mode: 'open' });
    const osc = ctx.createOscillator();
    osc.frequency.value = 220;
    osc.connect(node).connect(ctx.destination);
    osc.start();
    await new Promise((r) => setTimeout(r, 1500));
    osc.stop();
    return { ...seen, state: ctx.state, rate: ctx.sampleRate };
  }, { worklet, wasm });
  check(dsp.meters > 3 && dsp.level > -80, 'noise chain (RNNoise WASM in an AudioWorklet) runs on WebKit', JSON.stringify(dsp));

  const api = await page.evaluate(() => ({
    rtc: 'RTCPeerConnection' in window,
    sink: 'setSinkId' in AudioContext.prototype,
    wake: 'wakeLock' in navigator,
    speech: 'speechSynthesis' in window,
    sw: 'serviceWorker' in navigator,
    geo: 'geolocation' in navigator,
  }));
  check(api.rtc, 'WebRTC is available', JSON.stringify(api));

  await page.click('[role=tab]:has-text("Call")');
  check((await page.locator('text=Join the call').count()) > 0, 'call tab renders');
  await page.click('[role=tab]:has-text("Plan")');
  await page.fill('[aria-label="Search for a stop"]', 'https://maps.google.com/?q=12.7409,77.8253');
  check(await page.locator('.stop-index').first().waitFor({ timeout: 8000 }).then(() => true, () => false), 'adding a stop from a pasted Google Maps link works');
  await page.click('[role=tab]:has-text("Riders")');
  await page.click('text=Invite riders');
  check((await page.locator('.invite-qr svg').count()) === 1, 'invite card with QR renders');
  await page.screenshot({ path: `${outDir}/iphone-invite.png` });
  await page.click('[role=tab]:has-text("Friends")');
  check((await page.locator('.my-code').count()) === 1, 'friends panel renders');
  await page.click('[role=tab]:has-text("Settings")');
  await page.click('text=Ride mode (saves battery)');
  check((await page.locator('.ridemode').count()) === 1, 'ride mode opens');
  await page.click('.ridemode-foot .btn');
  await page.click('text=Leave ride');
  await page.waitForSelector('#code');
  await page.click('text=My rides and stats');
  check((await page.locator('.ride-stats').count()) === 1, 'stats screen renders');
  check(errors.length === 0, 'no uncaught script errors', errors.slice(0, 2).join(' | ').slice(0, 140));
  await browser.close();
} catch (e) {
  check(false, `crashed: ${e.message.slice(0, 200)}`);
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
