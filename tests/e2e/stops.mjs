// Rearranging and removing stops: a real touch drag on Chromium, a pointer drag on
// the Safari engine, each rider's change reaching the other.
// Playwright's WebKit is not an iPhone, so a finger on real iOS is still unproven here.
// Usage: node tests/e2e/stops.mjs <outDir>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, devices, webkit } from 'playwright-core';

const PORT = 8804;
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = resolve(process.argv[2] ?? '.');
const ADMIN = /ADMIN_TOKEN=(.*)/.exec(readFileSync('.dev.vars', 'utf8'))[1].trim().replace(/^"|"$/g, '');
const owner = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const names = (page) => page.locator('.stop .row-title').allInnerTexts();
const sameAs = async (page, expected, ms = 6000) => {
  const end = Date.now() + ms;
  let got;
  while (Date.now() < end) {
    got = await names(page);
    if (got.join() === expected.join()) return true;
    await wait(100);
  }
  console.log(`  saw ${got}`);
  return false;
};

async function signIn(page, name) {
  const email = `${name.toLowerCase()}.${Date.now()}@test.example`;
  await page.goto(BASE);
  await page.click('text=Create an account');
  await page.fill('#name', name);
  await page.fill('#email', email);
  await page.fill('#password', 'test-password-1');
  await page.click('button:has-text("Create account")');
  await page.click('text=I saved it');
  await page.waitForSelector('text=Waiting for approval');
  const users = await fetch(`${BASE}/api/admin/users`, { headers: owner }).then((r) => r.json());
  await fetch(`${BASE}/api/admin/users/${users.find((u) => u.email === email).id}/approve`, { method: 'POST', headers: owner, body: '{}' });
  await page.click('text=Check again');
  await page.waitForSelector('#code');
}

async function addStop(page, name, i) {
  await page.fill('[aria-label="Search for a stop"]', `https://www.google.com/maps/place/${name}/@12.${70 + i},77.8253,15z`);
  await page.waitForFunction((n) => [...document.querySelectorAll('.stop .row-title')].some((e) => e.textContent === n), name, { timeout: 8000 });
}

/** The tab toggles, and a ride with a plan opens on it, so only tap when it is closed. */
const openPlan = async (page) => {
  await wait(600);
  if (!(await page.locator('[aria-label="Search for a stop"]').isVisible())) await page.click('[role=tab]:has-text("Plan")');
  await page.waitForSelector('[aria-label="Search for a stop"]');
};

/** Scrolling while measuring would leave the other point stale, so measure both at one moment. */
const grips = async (page, first, second) => {
  await page.locator('.timeline').evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await wait(150);
  const at = async (n) => {
    const b = await page.locator(`.stop:nth-child(${n}) .stop-grip`).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  return [await at(first), await at(second)];
};

/** A real finger: touch events through the browser's input pipeline, not a mouse. */
async function touchDrag(page, cdp, from, to) {
  const point = (p) => [{ x: p.x, y: p.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point({ x: from.x, y: from.y + ((to.y - from.y) * i) / 12 }) });
    await wait(16);
  }
  return () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const wrangler = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(PORT), '--persist-to', mkdtempSync(join(tmpdir(), 'stops-'))], { stdio: 'ignore', detached: true });
const browsers = [];
try {
  for (let i = 0; i < 80 && !(await fetch(BASE).then((r) => r.ok, () => false)); i++) await wait(500);

  const android = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const iphone = await webkit.launch();
  browsers.push(android, iphone);
  const aCtx = await android.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, permissions: ['geolocation'] });
  const a = await aCtx.newPage();
  const bCtx = await iphone.newContext({ ...devices['iPhone 13'] });
  const b = await bCtx.newPage();
  const cdp = await aCtx.newCDPSession(a);

  await signIn(a, 'Asha');
  await a.click('text=Plan a new ride');
  await a.waitForSelector('.topbar');
  const code = (await a.locator('.chip').first().innerText()).replace(/.*·\s*/, '').trim();
  await signIn(b, 'Ben');
  await b.fill('#code', code);
  await b.click('text=Join ride');
  await b.waitForSelector('.topbar');

  await openPlan(a);
  const plan = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  for (const [i, n] of plan.entries()) await addStop(a, n, i);
  await openPlan(b);
  check(await sameAs(b, plan), 'four stops reach the other rider');

  check((await a.locator('.stop-grip').count()) === 4, 'every stop has a drag handle, with nothing to expand first');
  check((await a.locator('.stop-remove').count()) === 4, 'every stop has a remove button, with nothing to expand first');
  check((await a.evaluate(() => document.documentElement.scrollWidth > innerWidth)) === false, 'nothing overflows at phone width');

  // A real finger on Chromium, held mid-drag so the screen can be looked at.
  const [from, to] = await grips(a, 4, 1);
  const release = await touchDrag(a, cdp, from, { x: to.x, y: to.y - 12 });
  await wait(250);
  await a.screenshot({ path: `${outDir}/stops-dragging.png` });
  await release();
  const afterTouch = ['Delta', 'Alpha', 'Bravo', 'Charlie'];
  check(await sameAs(a, afterTouch, 1000), 'dragging with a finger moves the stop');
  check(await sameAs(b, afterTouch), 'the new order reaches the other rider');

  // A short drag that crosses nothing changes nothing.
  const [still] = await grips(a, 2, 2);
  await (await touchDrag(a, cdp, still, { x: still.x, y: still.y + 8 }))();
  await wait(400);
  check(await sameAs(b, afterTouch, 500), 'a tiny drag leaves the order alone');

  // The other way, from the Safari engine.
  const [start, end] = await grips(b, 1, 3);
  await b.mouse.move(start.x, start.y);
  await b.mouse.down();
  await b.mouse.move(start.x, (start.y + end.y) / 2, { steps: 6 });
  await b.mouse.move(end.x, end.y + 12, { steps: 6 });
  await b.mouse.up();
  const afterWebkit = ['Alpha', 'Bravo', 'Delta', 'Charlie'];
  check(await sameAs(b, afterWebkit), 'dragging on the Safari engine moves the stop');
  check(await sameAs(a, afterWebkit), 'and it reaches the Android rider');

  // Tapping a stop still works alongside all this.
  await a.locator('.stop-row').nth(1).click();
  await a.waitForSelector('a:has-text("Get directions")');
  check((await a.locator('.stop-tools [aria-label^="Move"]').count()) === 2, 'an opened stop keeps its up and down buttons');
  await a.click('[aria-label="Move Bravo later"]');
  const afterArrows = ['Alpha', 'Delta', 'Bravo', 'Charlie'];
  check(await sameAs(b, afterArrows), 'the up and down buttons still work');
  await a.locator('.stop-row').nth(2).click();

  // Removing takes two taps, so a stray one cannot change the plan for the group.
  await a.click('[aria-label="Remove Delta"]');
  await wait(300);
  check((await names(b)).length === 4, 'one tap on remove only asks');
  await a.locator('.stop-line').nth(1).scrollIntoViewIfNeeded();
  await a.screenshot({ path: `${outDir}/stops-armed.png` });
  await wait(3200);
  check((await a.locator('.stop-remove.armed').count()) === 0, 'the question goes away if not answered');
  await a.click('[aria-label="Remove Delta"]');
  await a.click('[aria-label="Tap again to remove Delta"]');
  const afterRemove = ['Alpha', 'Bravo', 'Charlie'];
  check(await sameAs(a, afterRemove, 1000), 'a second tap removes the stop');
  check(await sameAs(b, afterRemove), 'the stop disappears for the other rider');

  // From the Safari engine too.
  await b.click('[aria-label="Remove Alpha"]');
  await b.click('[aria-label="Tap again to remove Alpha"]');
  check(await sameAs(a, ['Bravo', 'Charlie']), 'a stop removed on the Safari engine goes for everyone');

  await a.reload();
  await a.waitForSelector('.topbar');
  await openPlan(a);
  check(await sameAs(a, ['Bravo', 'Charlie']), 'the result survives a reload, so the server really has it');
  await a.screenshot({ path: `${outDir}/stops-final.png` });

  // A long plan: the row has to reach a place that is scrolled out of sight.
  const more = ['Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November'];
  for (const [i, n] of more.entries()) await addStop(a, n, i + 10);
  await a.locator('.stop:last-child').evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await wait(200);
  const tabs = await a.locator('[role=tablist]').boundingBox();
  const firstHidden = (await a.locator('.stop:first-child').boundingBox()).y < tabs.y + tabs.height;
  const long = await a.locator('.stop:last-child .stop-grip').boundingBox();
  const panelTop = await a.locator('[role=tab]:has-text("Plan")').boundingBox();
  const hold = await touchDrag(a, cdp, { x: long.x + 17, y: long.y + 30 }, { x: long.x + 17, y: panelTop.y + panelTop.height + 20 });
  await wait(2500); // Held at the edge, the panel keeps scrolling.
  await hold();
  await wait(300);
  const order = await names(a);
  check(firstHidden, 'the first stop really was scrolled out of sight');
  check(order[0] === 'November', 'holding at the edge scrolls the panel, so the last stop can reach the top', order.join(' '));
  check(await sameAs(b, order), 'and the long reorder reaches the other rider');
  await a.screenshot({ path: `${outDir}/stops-long.png` });

  // Every stop type on every screen, and no tab hiding anything by squeezing it to nothing.
  const collapsed = () => a.evaluate(() =>
    [...document.querySelectorAll('.panel > *')]
      .filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height < 1 && el.scrollHeight > 1)
      .map((el) => el.className || el.tagName));
  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720], [900, 600], [390, 844], [360, 640]]) {
    await a.setViewportSize({ width, height });
    await wait(300);
    const chips = await a.evaluate(() => {
      const box = document.querySelector('.kinds').getBoundingClientRect();
      const all = [...document.querySelectorAll('.kind')].map((c) => c.getBoundingClientRect());
      return { height: Math.round(box.height), whole: all.filter((c) => c.height >= 30 && c.left >= box.left - 1 && c.right <= box.right + 1).length, all: all.length };
    });
    check(chips.height >= 40 && chips.whole === chips.all, `all stop types show at ${width}x${height}`, `${chips.whole}/${chips.all}, ${chips.height}px tall`);
    for (const tab of ['Call', 'Riders', 'Friends', 'Settings', 'Plan']) {
      await a.click(`[role=tab]:has-text("${tab}")`);
      await wait(120);
      const gone = await collapsed();
      if (gone.length) check(false, `nothing squeezed away on ${tab} at ${width}x${height}`, gone.join(', '));
    }
    if (width === 1440) await a.screenshot({ path: `${outDir}/stops-desktop.png` });
  }
} catch (e) {
  check(false, `crashed: ${String(e.message).replace(/\s+/g, ' ').slice(0, 260)}`);
} finally {
  for (const b of browsers) await b.close().catch(() => undefined);
  try {
    process.kill(-wrangler.pid);
  } catch {
    // Already gone.
  }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
