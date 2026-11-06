import { Biquad } from './biquad';

const DECIMATE = 6; // 48 kHz -> 8 kHz
const WINDOW = 160; // 20 ms at 8 kHz
const MIN_LAG = 20; // 400 Hz
const MAX_LAG = 100; // 80 Hz
const HISTORY = WINDOW + MAX_LAG;

/**
 * Periodicity score for the current frame, 0..1.
 *
 * Voiced speech repeats at its pitch period; wind is turbulent and does not.
 * That makes this the cheapest reliable way to tell them apart, and it still
 * works after the high-pass because pitch survives in the harmonics.
 */
export class VoicingDetector {
  private readonly aa = [new Biquad(), new Biquad()];
  private readonly history = new Float32Array(HISTORY);

  constructor(sampleRate = 48000) {
    this.aa[0]?.setLowpass(3000, 0.5412, sampleRate);
    this.aa[1]?.setLowpass(3000, 1.3066, sampleRate);
  }

  process(frame: Float32Array): number {
    const [a, b] = this.aa as [Biquad, Biquad];
    const h = this.history;
    const fresh = Math.floor(frame.length / DECIMATE);
    h.copyWithin(0, fresh);
    let w = HISTORY - fresh;
    for (let i = 0; i < frame.length; i++) {
      const y = b.process(a.process(frame[i] as number));
      if (i % DECIMATE === 0) h[w++] = y;
    }

    const start = HISTORY - WINDOW;
    let e0 = 1e-6;
    for (let i = start; i < HISTORY; i++) e0 += (h[i] as number) ** 2;

    // Energy of the lagged window, updated incrementally across lags.
    let eL = 1e-6;
    for (let i = start - MIN_LAG; i < HISTORY - MIN_LAG; i++) eL += (h[i] as number) ** 2;

    let best = 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let dot = 0;
      for (let i = start; i < HISTORY; i++) dot += (h[i] as number) * (h[i - lag] as number);
      const score = dot / Math.sqrt(e0 * eL);
      if (score > best) best = score;
      const out = h[HISTORY - lag - 1] as number;
      const inn = h[start - lag - 1] ?? 0;
      eL += inn * inn - out * out;
      if (eL < 1e-6) eL = 1e-6;
    }
    return best;
  }
}
