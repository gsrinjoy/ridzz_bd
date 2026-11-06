// Runs the real APK on a booted emulator and asks Android what actually happened.
// Needs: wrangler dev on 8792, the APK built with APP_URL=http://localhost:8792.
import { execFileSync, spawn } from 'node:child_process';

const PKG = 'app.slipstream.rider';
const PORT = 8792;
const CDP = 9333;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8' }).trim();
const shell = (cmd) => adb('shell', cmd);
const grep = (text, re) => text.split('\n').filter((l) => re.test(l)).map((l) => l.trim());

const server = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(PORT)], { stdio: 'ignore' });
for (let i = 0; i < 80 && !(await fetch(`http://127.0.0.1:${PORT}`).then((r) => r.ok).catch(() => false)); i++) await wait(500);

/** Android WebViews expose page targets only, so this speaks the debug protocol directly. */
async function attach() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
  const target = targets.find((t) => t.webSocketDebuggerUrl);
  if (!target) throw new Error(`no debuggable page: ${JSON.stringify(targets).slice(0, 160)}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('could not open the WebView debug socket'));
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  };
  const send = (method, params) =>
    new Promise((res) => {
      waiting.set(++id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (fn, arg) => {
    const expression = `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    // userGesture so that starting audio behaves as it does from a real tap.
    const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page error');
    return result.result.value;
  };
  return {
    title: target.title,
    evaluate,
    close: () => ws.close(),
    fill: (selector, value) =>
      evaluate(({ selector, value }) => {
        const el = document.querySelector(selector);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, { selector, value }),
    clickText: (text) =>
      evaluate((text) => {
        const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text));
        if (!el) throw new Error(`no button: ${text}`);
        el.click();
      }, text),
    click: (selector) => evaluate((selector) => document.querySelector(selector).click(), selector),
    waitFor: async (selector, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await evaluate((s) => !!document.querySelector(s), selector)) return true;
        await wait(250);
      }
      throw new Error(`timed out waiting for ${selector}`);
    },
  };
}

async function signUpOn(page) {
  await page.waitFor('#email');
  await page.clickText('Create an account');
  await page.waitFor('#name');
  await page.fill('#name', 'Dev');
  const email = `dev.${Date.now()}@test.example`;
  await page.fill('#email', email);
  await page.fill('#password', 'test-password-1');
  await page.clickText('Create account');
  await page.waitFor('.recovery-code');
  await page.clickText('I saved it');
  const headers = { authorization: 'Bearer local-admin-only', 'content-type': 'application/json' };
  const users = await fetch(`http://127.0.0.1:${PORT}/api/admin/users`, { headers }).then((r) => r.json());
  await fetch(`http://127.0.0.1:${PORT}/api/admin/users/${users.find((u) => u.email === email).id}/approve`, { method: 'POST', headers, body: '{}' });
  await page.clickText('Check again');
  await page.waitFor('#code');
}

function memoryMb() {
  // The app process plus the WebView's sandboxed renderer, which holds the page.
  const pids = grep(shell('ps -A -o PID,NAME'), new RegExp(`${PKG}|sandboxed_process`)).map((l) => l.split(/\s+/)[0]);
  let total = 0;
  const parts = [];
  for (const pid of pids) {
    const m = shell(`dumpsys meminfo ${pid}`).match(/TOTAL PSS:\s+(\d+)/) ?? shell(`dumpsys meminfo ${pid}`).match(/TOTAL\s+(\d+)/);
    if (m) {
      const mb = Math.round(Number(m[1]) / 1024);
      total += mb;
      parts.push(mb);
    }
  }
  return { total, parts };
}

try {
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  adb('emu', 'geo', 'fix', '77.5946', '12.9716');
  // First run, with nothing granted: Android itself must ask.
  shell(`pm clear ${PKG}`);
  shell('logcat -c');
  shell(`am start -n ${PKG}/.MainActivity`);
  await wait(8000);
  {
    const pid0 = shell(`pidof ${PKG}`);
    adb('forward', '--remove-all');
    adb('forward', `tcp:${CDP}`, `localabstract:webview_devtools_remote_${pid0}`);
    const fresh = await attach();
    await signUpOn(fresh);
    await fresh.clickText('Plan a new ride');
    await fresh.waitFor('.topbar');
    await wait(1500);
    // Answers each prompt as a rider would, noting what Android asked for.
    const asked = [];
    const answer = async () => {
      for (let i = 0; i < 10; i++) {
        const screen = shell('uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml');
        if (!/permissioncontroller/.test(screen)) return;
        const question = screen.match(/text="([^"]*(?:Allow|allow)[^"]*\?)"/)?.[1];
        if (question) asked.push(question.replace(/&lt;[^&]*&gt;/g, ''));
        const match = screen.match(/text="(?:Allow|While using the app|Only this time)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!match) return;
        const [, x1, y1, x2, y2] = match.map(Number);
        shell(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`);
        await wait(1800);
      }
    };
    await answer();
    check(asked.length > 0, 'a fresh install asks for permission', asked[0]?.slice(0, 70));
    await fresh.clickText('Join the call');
    await wait(3000);
    await answer();
    await wait(2000);
    await answer();
    console.log('INFO  Android asked:', asked.map((q) => q.slice(0, 44)).join(' | '));
    check(asked.some((q) => /nearby/i.test(q)), 'joining the call asks for Nearby devices, while the rider can answer');
    fresh.close();
  }

  // Then a clean install with permissions in place, for everything else.
  shell(`pm clear ${PKG}`);
  for (const p of ['RECORD_AUDIO', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'POST_NOTIFICATIONS', 'BLUETOOTH_CONNECT', 'BLUETOOTH_ADVERTISE', 'BLUETOOTH_SCAN', 'NEARBY_WIFI_DEVICES']) {
    shell(`pm grant ${PKG} android.permission.${p}`);
  }
  shell('logcat -c');
  shell(`am start -n ${PKG}/.MainActivity`);
  await wait(9000);
  const pid = shell(`pidof ${PKG}`);
  check(!!pid, 'the app launches and stays running', `pid ${pid}`);

  adb('forward', '--remove-all');
  adb('forward', `tcp:${CDP}`, `localabstract:webview_devtools_remote_${pid}`);
  const page = await attach();
  check(!!page, 'attached to the app WebView', page.title);

  const platform = await page.evaluate(() => window.Capacitor?.getPlatform?.());
  check(platform === 'android', 'the native bridge is present', platform);
  check(await page.evaluate(() => !!window.Capacitor?.isPluginAvailable?.('RideShell')), 'the RideShell plugin is registered');

  await signUpOn(page);
  await page.clickText('Plan a new ride');
  await page.waitFor('.topbar');

  // The Android app needs no tap: starting the ride joins the call by itself.
  await page.clickText('Start ride');
  await wait(7000);
  check(await page.evaluate(() => !document.querySelector('.sheet')), 'Android joins the call with no prompt when the ride starts');
  check(await page.evaluate(() => !!document.querySelector('.hud')), 'the ride timer is running');

  // Nearby, against real Google Play services on the device.
  const nearbyInfo = await page.evaluate(async () => {
    const webcodecs = 'AudioEncoder' in window && (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })).supported;
    const plugin = window.Capacitor.Plugins.NearbyLink;
    try {
      await plugin.start({ code: 'TEST22', name: 'Dev' });
      await plugin.stop();
      return { webcodecs, started: true };
    } catch (e) {
      return { webcodecs, started: false, error: String(e.message ?? e) };
    }
  });
  check(await page.evaluate(() => !!window.Capacitor?.isPluginAvailable?.('NearbyLink')), 'the NearbyLink plugin is registered');
  const prepared = await page.evaluate(() => window.Capacitor.Plugins.NearbyLink.prepare());
  check(prepared.granted === true, 'Nearby permission is settled before the internet is ever lost');
  check(nearbyInfo.webcodecs === true, 'the Android WebView can encode Opus for local voice');
  check(nearbyInfo.started, 'Nearby starts on real Google Play services', nearbyInfo.error ?? 'advertising and discovery started');

  const services = shell(`dumpsys activity services ${PKG}`);
  check(/RideService/.test(services), 'RideService is running');
  check(/isForeground=true/.test(services), 'it runs as a foreground service');
  check(/slipstream:ride/.test(shell('dumpsys power')), 'the CPU wake lock is held');
  check(/app\.slipstream\.rider/.test(shell('dumpsys notification --noredact')), 'the ride notification is showing');

  const routes = await page.evaluate(() => window.Capacitor.Plugins.RideShell.listRoutes());
  check(routes.routes?.length > 0, 'native audio routes are listed', routes.routes?.map((r) => `${r.label}[${r.kind}]`).join(', '));
  const speaker = routes.routes?.find((r) => r.kind === 'speaker');
  if (speaker) {
    await page.evaluate((id) => window.Capacitor.Plugins.RideShell.setRoute({ id }), speaker.id);
    const after = await page.evaluate(() => window.Capacitor.Plugins.RideShell.listRoutes());
    check(after.routes.find((r) => r.kind === 'speaker')?.active === true, 'switching to the speaker takes effect');
  }
  check(/MODE_IN_COMMUNICATION|mode=3|mode: 3|IN_COMMUNICATION/.test(shell('dumpsys audio')), 'the phone is in voice-call audio mode');

  // Native GPS must reach the page, because the browser's stops in the background.
  await page.evaluate(() => {
    window.__fixes = 0;
    window.Capacitor.Plugins.RideShell.addListener('location', () => window.__fixes++);
  });
  for (let i = 0; i < 6; i++) {
    adb('emu', 'geo', 'fix', String(77.5946 + i * 0.001), '12.9716');
    await wait(2500);
  }
  const fixes = await page.evaluate(() => window.__fixes);
  check(fixes > 0, 'native GPS fixes reach the app', `${fixes} fixes`);

  const foreground = memoryMb();
  console.log(`INFO  memory with screen on and map loaded: ${foreground.total} MB (${foreground.parts.join(' + ')})`);

  await page.click('[aria-label="Ride mode"]');
  await wait(2500);
  const rideMode = memoryMb();
  console.log(`INFO  memory in ride mode, map freed: ${rideMode.total} MB (${rideMode.parts.join(' + ')})`);

  // The test that matters: phone in the pocket.
  await page.evaluate(() => {
    window.__ticks = 0;
    setInterval(() => window.__ticks++, 1000);
  });
  shell('input keyevent KEYCODE_HOME');
  await wait(1000);
  shell('input keyevent KEYCODE_SLEEP');
  await wait(1500);
  check(/mWakefulness=Asleep|mWakefulness=Dozing/.test(shell('dumpsys power')), 'the screen is off');
  for (let i = 0; i < 4; i++) {
    adb('emu', 'geo', 'fix', String(77.6 + i * 0.001), '12.98');
    await wait(5000);
  }
  const pocket = await page.evaluate(() => ({ ticks: window.__ticks, fixes: window.__fixes, online: document.visibilityState }));
  // What Android really allows while hidden: L = location, M = microphone.
  const processes = shell(`dumpsys activity processes ${PKG}`);
  const capability = processes.match(/curCapability=([A-Z-]+)/)?.[1] ?? '';
  check(capability.includes('M'), 'Android keeps microphone access with the screen off', capability);
  check(capability.includes('L'), 'Android keeps location access with the screen off', capability);
  const recording = grep(shell('dumpsys audio'), /AudioRecordingConfiguration|session:|silenced/).filter((l) => /package:.*rider|silenced/i.test(l));
  const silenced = recording.some((l) => /silenced:true/i.test(l));
  check(!silenced, 'the audio system is not silencing the mic', recording[0]?.slice(0, 110) ?? 'no recording rows');
  const running = shell(`dumpsys activity services ${PKG}`);
  check(/isForeground=true/.test(running), 'the service is still foreground in the pocket');
  console.log('INFO ', grep(running, /isForeground|types=/)[0]?.slice(0, 110));
  check(pocket.ticks >= 12, 'the app keeps running with the screen off', `${pocket.ticks} ticks in ~21 s`);
  check(pocket.fixes > fixes, 'GPS keeps arriving with the screen off', `${pocket.fixes - fixes} more fixes`);
  check(shell(`pidof ${PKG}`) === pid, 'Android did not kill the process');
  const pocketMem = memoryMb();
  console.log(`INFO  memory in the pocket: ${pocketMem.total} MB (${pocketMem.parts.join(' + ')})`);

  shell('input keyevent KEYCODE_WAKEUP');
  await wait(1200);
  shell(`am start -n ${PKG}/.MainActivity`);
  await wait(2000);

  // Sharing a place from Google Maps into the app.
  shell(`am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'https://maps.google.com/?q=12.74,77.82' -n ${PKG}/.MainActivity`);
  await wait(3000);
  check(shell(`pidof ${PKG}`) === pid, 'handling a shared link does not crash the app');

  const crashes = grep(shell('logcat -d -b crash'), new RegExp(PKG));
  check(crashes.length === 0, 'no crashes in the Android log', crashes[0]?.slice(0, 120));
  page.close();
} catch (e) {
  check(false, `crashed: ${String(e.message).slice(0, 240)}`);
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
