// A real call on the deployed site, through the real voice relay and real map.
// Usage: OWNER=<admin password> node tests/e2e/live-call.mjs <url> <outDir> [mic.wav]
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.argv[2];
const outDir = resolve(process.argv[3] ?? '.');
const mic = resolve(process.argv[4] ?? 'tests/fixtures/speech.wav');
const OWNER = process.env.OWNER;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const owner = { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' };
const admin = (path, init) => fetch(`${BASE}/api/admin/${path}`, { headers: owner, ...init }).then((r) => r.json());

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
          await ctx.audioWorklet.addModule('/__tap.js');
          const keep = new Audio();
          keep.srcObject = new MediaStream([e.track]);
          keep.muted = true;
          keep.play().catch(() => {});
          const tap = new AudioWorkletNode(ctx, 'tap', { numberOfOutputs: 0 });
          tap.port.onmessage = (m) => window.__recording.push(m.data);
          ctx.createMediaStreamSource(new MediaStream([e.track])).connect(tap);
          await ctx.resume();
        })();
      });
    }
  };
  const fix = () => ({ coords: { latitude: lat, longitude: lon, speed: kmh / 3.6, heading: 90, accuracy: 8 }, timestamp: Date.now() });
  navigator.geolocation.watchPosition = (ok) => {
    ok(fix());
    return setInterval(() => {
      lat += 0.0002;
      ok(fix());
    }, 1000);
  };
  navigator.geolocation.clearWatch = (id) => clearInterval(id);
}

const stats = (page) =>
  page.evaluate(async () => {
    const out = { sent: 0, recv: 0, states: [], candidate: '', rtt: null };
    for (const pc of window.__pcs) {
      out.states.push(pc.connectionState);
      const all = await pc.getStats();
      all.forEach((s) => {
        if (s.type === 'outbound-rtp') out.sent += s.packetsSent ?? 0;
        if (s.type === 'inbound-rtp') out.recv += s.packetsReceived ?? 0;
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
          out.rtt = Math.round((s.currentRoundTripTime ?? 0) * 1000);
          const remote = all.get(s.remoteCandidateId);
          out.candidate = `${remote?.candidateType} ${remote?.address ?? ''}`;
        }
      });
    }
    return out;
  });

async function open(browser, name, gps) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone', 'geolocation'] });
  await context.addInitScript(instrument, gps);
  await context.route('**/__tap.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: `registerProcessor('tap', class extends AudioWorkletProcessor { process(i) { if (i[0][0]) this.port.postMessage(i[0][0].slice(0)); return true; } })` }),
  );
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|SFU|voice start|voice sig/i.test(t)) console.log(`  [${name} ${m.type()}] ${t.slice(0, 190)}`);
  });
  page.on('pageerror', (e) => console.log(`  [${name} error] ${e.message.slice(0, 190)}`));
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

const flags = (file) => ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(file ? [`--use-file-for-fake-audio-capture=${file}`] : []), '--autoplay-policy=no-user-gesture-required'];
const browserA = await chromium.launch({ channel: 'chrome', headless: true, args: flags(mic) });
const browserB = await chromium.launch({ channel: 'chrome', headless: true, args: flags() });
try {
  const a = await open(browserA, 'LiveAsha', { lat: 12.9716, lon: 77.5946, kmh: 60 });
  const b = await open(browserB, 'LiveBen', { lat: 12.99, lon: 77.61, kmh: 40 });
  await a.click('text=Plan a new ride');
  await a.waitForSelector('.topbar');
  const { code } = await a.evaluate(() => JSON.parse(localStorage.getItem('slipstream.session')));
  await b.fill('#code', code);
  await b.click('text=Join ride');
  await b.waitForSelector('.topbar');

  // Voice through the relay
  await a.click('button:has-text("Start ride")');
  await a.locator('.sheet button:has-text("Join the call")').click({ timeout: 8000 });
  await b.locator('.sheet button:has-text("Join the call")').click({ timeout: 15000 });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(500);
    const [sa, sb] = [await stats(a), await stats(b)];
    up = sa.states.includes('connected') && sb.states.includes('connected') && sb.recv > 5;
  }
  const sa = await stats(a);
  const sb = await stats(b);
  check(sa.states.includes('connected'), 'rider A connects to the relay', `${sa.candidate}, rtt ${sa.rtt} ms`);
  check(sb.states.includes('connected'), 'rider B connects to the relay', `${sb.candidate}, rtt ${sb.rtt} ms`);
  check(sa.states.length === 1 && sb.states.length === 1, 'each rider uses one connection, the relay fans out', `${sa.states.length} and ${sb.states.length}`);
  await b.evaluate(() => (window.__recording.length = 0));
  const before = await stats(b);
  const senderBefore = await stats(a);
  await wait(15000);
  const after = await stats(b);
  const senderAfter = await stats(a);
  console.log(`INFO  sender A sent ${senderAfter.sent - senderBefore.sent}, total ${senderAfter.sent}; B received total ${after.recv}; A received total ${senderAfter.recv}`);
  console.log('INFO  transceivers A:', await a.evaluate(() => window.__pcs[0].getTransceivers().map((t) => `${t.mid}:${t.direction}/${t.currentDirection}`).join(' ')), '| B:', await b.evaluate(() => window.__pcs[0].getTransceivers().map((t) => `${t.mid}:${t.direction}/${t.currentDirection}`).join(' ')));
  console.log('INFO  voice published A->B view:', await b.evaluate(() => document.querySelector('.talk-title')?.textContent ?? ''), '| A status:', await a.evaluate(() => document.querySelector('.talk-title')?.textContent ?? ''));
  check(after.recv - before.recv > 100, 'voice packets reach the other rider through the relay', `${after.recv - before.recv} in 15 s`);
  const rms = await b.evaluate(() => {
    let sum = 0;
    let n = 0;
    for (const c of window.__recording) for (const v of c) {
      sum += v * v;
      n++;
    }
    return { rms: Math.sqrt(sum / Math.max(1, n)), seconds: n / 48000 };
  });
  check(rms.rms > 0.01, 'real audio arrives through the relay', `rms ${rms.rms.toFixed(3)}, ${rms.seconds.toFixed(1)} s`);
  check(senderAfter.recv > 50, 'audio flows in both directions', `A received ${senderAfter.recv}`);
  console.log('INFO  A screen:', (await a.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 110));

  // Failover: the relay goes away mid-call, as it would at the free limit.
  const relay = (on) => admin('voice-relay', { method: 'POST', body: JSON.stringify({ on }) });
  await relay(false);
  await wait(9000);
  await b.evaluate(() => (window.__recording.length = 0));
  const openPcs = (p) => p.evaluate(() => window.__pcs.filter((x) => x.connectionState === 'connected').length);
  const direct = await stats(b);
  await wait(10000);
  const directAfter = await stats(b);
  const directAudio = await b.evaluate(() => {
    let sum = 0;
    let n = 0;
    for (const c of window.__recording) for (const v of c) {
      sum += v * v;
      n++;
    }
    return Math.sqrt(sum / Math.max(1, n));
  });
  check(directAfter.candidate && !directAfter.candidate.includes('141.101'), 'the live call moved off the relay to a direct link', directAfter.candidate);
  check(directAfter.recv - direct.recv > 100, 'voice keeps flowing after the failover, with no taps', `${directAfter.recv - direct.recv} packets in 10 s`);
  check(directAudio > 0.01, 'real audio arrives over the direct link', `rms ${directAudio.toFixed(3)}, ${await openPcs(b)} link open`);
  await relay(true);
  await wait(9000);
  const backOn = await stats(b);
  await wait(6000);
  const backOnAfter = await stats(b);
  check(backOnAfter.recv > backOn.recv, 'the call moves back to the relay when it returns', backOnAfter.candidate);

  // Mappls
  await a.click('[role=tab]:has-text("Settings")');
  await wait(800);
  const mapText = await a.locator('.note:has-text("Map:")').innerText().catch(() => 'no map note');
  check(/Map: Mappls/.test(mapText), 'Mappls is the active map', mapText);
  await a.click('[role=tab][aria-selected=true]');
  await wait(9000);
  await a.screenshot({ path: `${outDir}/live-map.png` });
  console.log('INFO  map elements:', await a.evaluate(() => JSON.stringify({ canvases: document.querySelectorAll('#ride-map canvas').length, mapplsGlobal: !!window.mappls, pins: document.querySelectorAll('.rider-pin').length })));
} catch (e) {
  check(false, `crashed: ${String(e.message).replace(/\s+/g, ' ').slice(0, 300)}`);
  for (const b of [browserA, browserB]) {
    for (const c of b.contexts()) {
      for (const p of c.pages()) console.log('INFO  screen:', (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 200));
    }
  }
} finally {
  await admin('voice-relay', { method: 'POST', body: JSON.stringify({ on: true }) }); // Never leave it off.
  await browserA.close();
  await browserB.close();
  const users = await admin('users');
  for (const u of users.filter((x) => /@test\.example$/.test(x.email))) await admin(`users/${u.id}`, { method: 'DELETE' });
  const rides = await admin('rides');
  for (const r of rides.filter((x) => x.riders.every((p) => /^Live/.test(p.name)))) await admin(`rides/${r.code}/end`, { method: 'POST', body: '{}' });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
