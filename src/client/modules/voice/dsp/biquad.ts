/** Second-order IIR section, transposed direct form II: stable when coefficients change between frames. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  setHighpass(fc: number, q: number, fs: number): void {
    const w = (2 * Math.PI * fc) / fs;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setLowpass(fc: number, q: number, fs: number): void {
    const w = (2 * Math.PI * fc) / fs;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** Peaking EQ, used as a gentle presence lift so consonants survive helmet speakers. */
  setPeak(fc: number, q: number, gainDb: number, fs: number): void {
    const a = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * fc) / fs;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha / a;
    this.b0 = (1 + alpha * a) / a0;
    this.b1 = (-2 * cos) / a0;
    this.b2 = (1 - alpha * a) / a0;
    this.a1 = this.b1;
    this.a2 = (1 - alpha / a) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Q values for a 4th-order Butterworth built from two biquads. */
export const BUTTERWORTH4_Q = [0.5412, 1.3066] as const;
