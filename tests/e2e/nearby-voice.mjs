// The local voice path on real WebCodecs: speech-like audio through the real Opus
// encoder, the real packet format, and the real player. The radio itself is the
// one part skipped, so this cannot replace a test on two phones.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const PORT = 5199;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60 && !(await fetch(`http://localhost:${PORT}`).then((r) => r.ok).catch(() => false)); i++) await wait(500);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}`);
const result = await page.evaluate(async () => {
  const { LocalEncoder, LocalPlayer, localVoiceSupported } = await import('/src/client/modules/nearby/localVoice.ts');
  const { decode, encode } = await import('/src/client/modules/nearby/packets.ts');
  if (!localVoiceSupported()) return { supported: false };

  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.connect(ctx.destination);

  const player = new LocalPlayer(ctx, analyser);
  let packets = 0;
  let bytes = 0;
  const encoder = new LocalEncoder((data) => {
    packets++;
    bytes += data.length;
    const onAir = encode({ kind: 1, hops: 0, sender: 1, seq: packets & 0xffff, body: data });
    player.push(decode(onAir).body);
  });

  const peaks = [];
  const FRAME = 480;
  for (let f = 0; f < 150; f++) {
    const samples = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 300 * (f * FRAME + i)) / 48000);
    encoder.push(samples);
    await new Promise((r) => setTimeout(r, 10));
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    peaks.push(Math.max(...data.map(Math.abs)));
  }
  await new Promise((r) => setTimeout(r, 300));
  return { supported: true, packets, bytesPerPacket: Math.round(bytes / Math.max(1, packets)), peak: Math.max(...peaks) };
});
console.log(JSON.stringify(result));
const ok = result.supported && result.packets > 20 && result.peak > 0.05;
console.log(ok ? 'PASS  voice survives encode, packet, decode and playback' : 'FAIL  local voice path');
await browser.close();
server.kill();
process.exit(ok ? 0 : 1);
