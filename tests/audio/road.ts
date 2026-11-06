import { mulberry32, windNoise } from './wind';

const lowpass = (fc: number, fs: number) => 1 - Math.exp((-2 * Math.PI * fc) / fs);

/**
 * A four-stroke engine: harmonics of the firing rate over exhaust noise.
 * This is the hard case for a pitch detector, because it really is periodic and
 * its firing rate often sits inside the range of a human voice.
 */
export function engineNoise(n: number, fs: number, seed: number, rpm: number, cylinders: number): Float32Array {
  const r = mulberry32(seed);
  const firing = (rpm / 60) * (cylinders / 2);
  const harmonics = 24;
  const phase = Array.from({ length: harmonics }, () => r() * 2 * Math.PI);
  const out = new Float32Array(n);
  const kExhaust = lowpass(1500, fs);
  const kDrift = lowpass(0.5, fs);
  let exhaust = 0;
  let drift = 0;
  let cycle = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    exhaust += (w - exhaust) * kExhaust;
    drift += ((r() * 2 - 1) * 0.06 - drift) * kDrift * 40; // throttle wander
    cycle += (2 * Math.PI * firing * (1 + drift)) / fs;
    let s = 0;
    for (let h = 1; h <= harmonics; h++) s += Math.sin(cycle * h + (phase[h - 1] as number)) / h ** 0.8;
    out[i] = s * 0.2 + exhaust * 0.5;
  }
  return out;
}

/** Tyre roar, passing vehicles, and horns, which are tonal and arrive with no warning. */
export function trafficNoise(n: number, fs: number, seed: number): Float32Array {
  const r = mulberry32(seed);
  const out = new Float32Array(n);
  const kRoar = lowpass(1800, fs);
  const kLow = lowpass(250, fs);
  let roar = 0;
  let low = 0;
  let pass = 0;
  let passTarget = 0.3;
  let hornLeft = 0;
  let hornA = 420;
  let hornB = 510;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    roar += (w - roar) * kRoar;
    low += (w - low) * kLow;
    if (i % Math.floor(fs * 1.5) === 0) passTarget = 0.2 + r() * 1.2;
    pass += (passTarget - pass) * lowpass(1.2, fs);
    if (hornLeft <= 0 && r() < 0.25 / fs) {
      hornLeft = Math.floor(fs * (0.3 + r() * 0.9));
      hornA = 380 + r() * 120;
      hornB = hornA * 1.21;
    }
    let horn = 0;
    if (hornLeft > 0) {
      hornLeft--;
      t += 1 / fs;
      for (let h = 1; h <= 6; h++) horn += (Math.sin(2 * Math.PI * hornA * h * t) + Math.sin(2 * Math.PI * hornB * h * t)) / h;
    }
    out[i] = (roar - low) * 0.7 * pass + low * 0.4 * pass + horn * 0.35;
  }
  return out;
}

export type NoiseName = 'single-3k' | 'twin-5k' | 'four-7k' | 'traffic' | 'ride-mix';

export const ROAD_NOISES: { name: NoiseName; label: string; snrDb: number; speed: number }[] = [
  { name: 'single-3k', label: 'Single cylinder, 3000 rpm', snrDb: 0, speed: 60 },
  { name: 'twin-5k', label: 'Twin, 5000 rpm', snrDb: 0, speed: 90 },
  { name: 'four-7k', label: 'Inline four, 7000 rpm', snrDb: 0, speed: 110 },
  { name: 'traffic', label: 'City traffic with horns', snrDb: 0, speed: 40 },
  { name: 'ride-mix', label: 'Highway: wind + twin + traffic', snrDb: -6, speed: 100 },
];

export function roadNoise(name: NoiseName, n: number, fs: number, seed: number): Float32Array {
  switch (name) {
    case 'single-3k':
      return engineNoise(n, fs, seed, 3000, 1);
    case 'twin-5k':
      return engineNoise(n, fs, seed, 5000, 2);
    case 'four-7k':
      return engineNoise(n, fs, seed, 7000, 4);
    case 'traffic':
      return trafficNoise(n, fs, seed);
    case 'ride-mix': {
      const wind = windNoise(n, fs, seed, true);
      const engine = engineNoise(n, fs, seed + 1, 5000, 2);
      const traffic = trafficNoise(n, fs, seed + 2);
      return wind.map((v, i) => v + (engine[i] as number) * 0.35 + (traffic[i] as number) * 0.3);
    }
  }
}
