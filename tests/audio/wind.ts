/** Deterministic synthetic helmet wind: low-frequency turbulence, gusts, and occasional buffeting. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `harsh` adds broadband turbulence to 4 kHz, closer to an exposed mic at speed. */
export function windNoise(n: number, fs: number, seed: number, harsh = false): Float32Array {
  const r = mulberry32(seed);
  const white = () => r() * 2 - 1;
  const out = new Float32Array(n);
  const k = (fc: number) => 1 - Math.exp((-2 * Math.PI * fc) / fs);
  const kRumble = k(90);
  const kBody = k(420);
  const kHigh = k(4000);
  const kGust = k(1.6);
  const kBurstEnv = k(9);
  let rumble = 0;
  let rumble2 = 0;
  let body = 0;
  let high = 0;
  let gust = 0.6;
  let burst = 0;
  let burstTarget = 0;
  for (let i = 0; i < n; i++) {
    const w = white();
    rumble += (w - rumble) * kRumble;
    rumble2 += (rumble - rumble2) * kRumble;
    body += (w - body) * kBody;
    high += (w - high) * kHigh;
    gust += (0.35 + r() * 1.3 - gust) * kGust;
    if (i % 2400 === 0) burstTarget = r() < 0.12 ? 1 : 0;
    burst += (burstTarget - burst) * kBurstEnv;
    out[i] = gust * (rumble2 * 16 + body * 1.1 + (harsh ? high * 0.32 : 0)) + burst * w * 0.1;
  }
  return out;
}
