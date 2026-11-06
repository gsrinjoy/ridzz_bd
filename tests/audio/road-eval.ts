/** Speech and noise-alone runs through engine and traffic noise. Usage: vite-node tests/audio/road-eval.ts <outDir> */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Biquad } from '../../src/client/modules/voice/dsp/biquad';
import { FRAME, SAMPLE_RATE, VoiceChain, type ChainOptions } from '../../src/client/modules/voice/dsp/chain';
import { createRnnoise } from '../../src/client/modules/voice/dsp/rnnoise';
import { ROAD_NOISES, roadNoise, type NoiseName } from './road';
import { windNoise } from './wind';
import { readWav, writeWav } from './wav';

const outDir = process.argv[2] as string;
mkdirSync(outDir, { recursive: true });
const wasm = new WebAssembly.Module(readFileSync('node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm'));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

function to16k(x: Float32Array): Float32Array {
  const lp = [new Biquad(), new Biquad()];
  lp[0]!.setLowpass(7000, 0.5412, SAMPLE_RATE);
  lp[1]!.setLowpass(7000, 1.3066, SAMPLE_RATE);
  const y = new Float32Array(Math.ceil(x.length / 3));
  let peak = 1e-6;
  x.forEach((v, i) => {
    const f = lp[1]!.process(lp[0]!.process(v));
    if (i % 3 === 0) {
      y[i / 3] = f;
      peak = Math.max(peak, Math.abs(f));
    }
  });
  const g = Math.min(1, 0.95 / peak);
  return y.map((v) => v * g);
}

const grid: Record<string, ChainOptions> = { chain: {} };

const speech = readWav('tests/fixtures/speech.wav');
const n = Math.floor(speech.length / FRAME) * FRAME;
const clean = speech.subarray(0, n);
const speechRms = rms(clean.filter((v) => Math.abs(v) > 0.01));
const f = new Float32Array(FRAME);
writeWav(`${outDir}/ref.wav`, to16k(clean), 16000);
const truth: boolean[] = [];
for (let i = 0; i < n / FRAME; i++) truth.push(rms(clean.subarray(i * FRAME, (i + 1) * FRAME)) > 0.012);
const gate: Record<string, { falseOpen: number; quiet: number; caught: number; speech: number; talks: number }> = {};

const cases: { name: string; snrDb: number; speed: number; make: (seed: number) => Float32Array }[] = [
  ...ROAD_NOISES.map((r) => ({ ...r, make: (seed: number) => roadNoise(r.name as NoiseName, n, SAMPLE_RATE, seed) })),
  { name: 'wind-120', snrDb: -12, speed: 120, make: (seed: number) => windNoise(n, SAMPLE_RATE, seed) },
  { name: 'windH-80', snrDb: -4, speed: 80, make: (seed: number) => windNoise(n, SAMPLE_RATE, seed, true) },
];

for (const { name, snrDb, speed, make } of cases) {
  for (const seed of [7, 21]) {
    const noise = make(seed);
    const scale = (speechRms / rms(noise)) * 10 ** (-snrDb / 20);
    const alone = noise.map((v) => v * scale);
    const noisy = alone.map((v, i) => v + (clean[i] as number));
    writeWav(`${outDir}/${name}_${seed}_raw.wav`, to16k(noisy), 16000);
    for (const [config, o] of Object.entries(grid)) {
      const g = (gate[`${name}|${config}`] ??= { falseOpen: 0, quiet: 0, caught: 0, speech: 0, talks: 0 });
      const c = new VoiceChain(createRnnoise(wasm), o);
      c.speedKmh = speed;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i += FRAME) {
        const r = c.process(noisy.subarray(i, i + FRAME), f);
        out.set(f, i);
        if (truth[i / FRAME]) {
          g.speech++;
          if (r.transmit) g.caught++;
        }
      }
      writeWav(`${outDir}/${name}_${seed}_${config}.wav`, to16k(out), 16000);
      const w = new VoiceChain(createRnnoise(wasm), o);
      w.speedKmh = speed;
      let was = false;
      for (let i = 0; i < n; i += FRAME) {
        const on = w.process(alone.subarray(i, i + FRAME), f).transmit;
        g.quiet++;
        if (on) g.falseOpen++;
        if (on && !was) g.talks++;
        was = on;
      }
    }
  }
}
writeFileSync(`${outDir}/gate.json`, JSON.stringify(gate));

const bench = new VoiceChain(createRnnoise(wasm));
bench.mode = 'open';
const frame = clean.slice(SAMPLE_RATE, SAMPLE_RATE + FRAME);
for (let i = 0; i < 1500; i++) bench.process(frame, f);
const t0 = performance.now();
for (let i = 0; i < 3000; i++) bench.process(frame, f);
const us = ((performance.now() - t0) / 3000) * 1000;
console.log(`whole capture chain: ${us.toFixed(0)} us per 10 ms frame, ${(us / 100).toFixed(2)}% of one core on this Mac`);
