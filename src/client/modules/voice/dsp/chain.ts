import { Biquad, BUTTERWORTH4_Q } from './biquad';
import { VoicingDetector } from './voicing';
import { DEFAULT_VOX, VoxGate, type VoxConfig } from './voxGate';

export const SAMPLE_RATE = 48000;
export const FRAME = 480; // RNNoise's fixed 10 ms frame.

/** Removes noise in place from a frame scaled to the int16 range; returns speech probability 0..1. */
export interface Denoiser {
  process(frame: Float32Array): number;
  destroy?(): void;
}

/**
 * How much filtered-but-not-denoised signal is blended back in. Pure model
 * output removes more noise but takes speech cues with it: on speech in
 * simulated 120 km/h wind, Whisper word errors fell from 65% to about 33% with
 * this blend, while SDR had claimed the pure output was better.
 * More is kept above the crossover, where consonants live and wind is weakest.
 */
export const DEFAULT_DRY_MIX = 0.3;
export const DEFAULT_DRY_MIX_HIGH = 0.8;
export const DEFAULT_CROSSOVER_HZ = 1500;

/** Stronger removes more noise and risks more of the voice. Which is right depends on the helmet. */
export type NoiseFilter = 'light' | 'balanced' | 'strong';
export const NOISE_FILTERS: Record<NoiseFilter, [low: number, high: number]> = {
  light: [0.6, 0.9],
  balanced: [DEFAULT_DRY_MIX, DEFAULT_DRY_MIX_HIGH],
  strong: [0.1, 0.5],
};

export type TalkMode = 'vox' | 'open' | 'ptt' | 'mute';

export interface ChainOptions {
  vox?: Partial<VoxConfig>;
  /** Frames of look-behind so the gate can open before the first syllable. */
  lookbehindFrames?: number;
  minCutoffHz?: number;
  maxCutoffHz?: number;
  /** Skip AGC, presence and limiter. Used to measure the denoising on its own. */
  raw?: boolean;
  /** Share of the high-passed signal blended back in below the crossover. See DEFAULT_DRY_MIX. */
  dryMix?: number;
  /** The same share above the crossover, where consonants live and wind is weakest. */
  dryMixHigh?: number;
  crossoverHz?: number;
}

export interface FrameResult {
  /** True while this frame should go on the air. */
  transmit: boolean;
  probability: number;
  voicing: number;
  /** 0..1 estimate of how much of the input is wind. */
  wind: number;
  levelDb: number;
  cutoffHz: number;
}

const db = (power: number) => 10 * Math.log10(power + 1e-12);

const KNEE = 0.7;
const HEADROOM = 0.28;

/** Untouched below the knee, then saturates smoothly under full scale so peaks never hard-clip. */
function limit(y: number): number {
  const a = Math.abs(y);
  if (a <= KNEE) return y;
  return Math.sign(y) * (KNEE + HEADROOM * Math.tanh((a - KNEE) / HEADROOM));
}

/**
 * Capture chain, in order:
 *   adaptive high-pass -> neural denoise -> pitch check -> look-behind delay -> VOX gate
 *   -> speech AGC -> presence lift -> limiter
 *
 * The high-pass runs first because wind energy is concentrated at low
 * frequencies. Removing it cheaply keeps the denoiser from being swamped.
 */
export class VoiceChain {
  mode: TalkMode = 'vox';
  pttHeld = false;
  /** GPS speed feeds in as a noise prior: faster means windier, before the mic proves it. */
  speedKmh = 0;

  private readonly hp = [new Biquad(), new Biquad()];
  private readonly windLp = new Biquad();
  private readonly presence = new Biquad();
  private readonly gate: VoxGate;
  private readonly voicing = new VoicingDetector(SAMPLE_RATE);
  private readonly raw: boolean;
  private readonly ring: Float32Array[];
  private readonly dryRing: Float32Array[];
  private dryMix: number;
  private dryMixHigh: number;
  private readonly split = new Biquad();
  private ringPos = 0;
  private dryPos = 0;
  private readonly minCutoff: number;
  private readonly maxCutoff: number;
  private cutoff: number;
  private windSmooth = 0;
  private gain = 1;
  private envelope = 0;

  constructor(
    private readonly denoiser: Denoiser,
    options: ChainOptions = {},
  ) {
    this.gate = new VoxGate({ ...DEFAULT_VOX, ...options.vox });
    this.raw = options.raw ?? false;
    this.minCutoff = options.minCutoffHz ?? 100;
    this.maxCutoff = options.maxCutoffHz ?? 300;
    this.cutoff = this.minCutoff;
    const frames = Math.max(1, options.lookbehindFrames ?? 6);
    this.ring = Array.from({ length: frames }, () => new Float32Array(FRAME));
    this.dryRing = Array.from({ length: frames + 1 }, () => new Float32Array(FRAME));
    this.dryMix = options.dryMix ?? DEFAULT_DRY_MIX;
    this.dryMixHigh = options.dryMixHigh ?? DEFAULT_DRY_MIX_HIGH;
    this.split.setHighpass(options.crossoverHz ?? DEFAULT_CROSSOVER_HZ, 0.707, SAMPLE_RATE);
    this.windLp.setLowpass(250, 0.707, SAMPLE_RATE);
    this.presence.setPeak(2800, 0.9, 3, SAMPLE_RATE);
    this.applyCutoff();
  }

  setNoiseFilter(filter: NoiseFilter): void {
    [this.dryMix, this.dryMixHigh] = NOISE_FILTERS[filter];
  }

  setVox(config: Partial<VoxConfig>): void {
    Object.assign(this.gate.config, config);
  }

  private applyCutoff(): void {
    this.hp.forEach((f, i) => f.setHighpass(this.cutoff, BUTTERWORTH4_Q[i] ?? 0.707, SAMPLE_RATE));
  }

  /** Processes one frame of float samples in -1..1, writing the result to `out`. */
  process(input: Float32Array, out: Float32Array): FrameResult {
    const [hp0, hp1] = this.hp as [Biquad, Biquad];
    const scratch = this.ring[this.ringPos] as Float32Array;

    // Pass 1: measure wind on the raw signal, then high-pass into the int16 scale.
    let total = 1e-9;
    let low = 1e-9;
    for (let i = 0; i < FRAME; i++) {
      const x = input[i] as number;
      const l = this.windLp.process(x);
      total += x * x;
      low += l * l;
      scratch[i] = hp1.process(hp0.process(x)) * 32768;
    }

    const lowShare = low / total;
    const rawDb = db(total / FRAME);
    // Below about -55 dBFS there is no wind worth reacting to, whatever the ratio says.
    const windNow = lowShare * Math.min(1, Math.max(0, (rawDb + 55) / 25));
    const speedPrior = Math.min(1, this.speedKmh / 110) * 0.6;
    const target = Math.max(windNow, speedPrior);
    // Attack fast for gusts, release slowly so the filter does not pump.
    this.windSmooth += (target - this.windSmooth) * (target > this.windSmooth ? 0.25 : 0.01);

    const cutoff = this.minCutoff + (this.maxCutoff - this.minCutoff) * this.windSmooth;
    if (Math.abs(cutoff - this.cutoff) > 4) {
      this.cutoff = cutoff;
      this.applyCutoff();
    }

    // Pass 2: denoise, gate. The ring delays audio so the gate acts on the past.
    const dryPos = this.dryPos;
    const dry = this.dryRing[dryPos] as Float32Array;
    dry.set(scratch);
    this.dryPos = (dryPos + 1) % this.dryRing.length;
    const probability = this.denoiser.process(scratch);
    let power = 1e-9;
    for (let i = 0; i < FRAME; i++) {
      const s = (scratch[i] as number) / 32768;
      power += s * s;
    }
    const levelDb = db(power / FRAME);
    const voicing = this.voicing.process(dry); // Before the model, which can smear pitch.
    const voxOpen = this.gate.update(probability, levelDb, this.windSmooth, voicing);
    const transmit =
      this.mode === 'open' || (this.mode === 'vox' && voxOpen) || (this.mode === 'ptt' && this.pttHeld);

    this.ringPos = (this.ringPos + 1) % this.ring.length;
    const delayed = this.ring[this.ringPos] as Float32Array;
    // The model itself lags one frame, so the matching dry frame is the oldest in its ring.
    const delayedDry = this.dryRing[this.dryPos] as Float32Array;
    // Blend on the difference signal, so the two bands sum back without a crossover notch.
    const dryLow = this.dryMix;
    const dryExtra = this.dryMixHigh - dryLow;
    for (let i = 0; i < FRAME; i++) {
      const wet = delayed[i] as number;
      const diff = (delayedDry[i] as number) - wet;
      delayed[i] = wet + dryLow * diff + dryExtra * this.split.process(diff);
    }

    // Pass 3: level and tone on the delayed audio, only when it will be heard.
    if (!transmit) {
      out.fill(0);
    } else if (this.raw) {
      for (let i = 0; i < FRAME; i++) out[i] = (delayed[i] as number) / 32768;
    } else {
      for (let i = 0; i < FRAME; i++) {
        const s = (delayed[i] as number) / 32768;
        const a = Math.abs(s);
        this.envelope += (a - this.envelope) * (a > this.envelope ? 0.01 : 0.0005);
        const want = Math.min(8, Math.max(0.5, 0.18 / (this.envelope + 1e-4)));
        this.gain += (want - this.gain) * 0.0008;
        const y = this.presence.process(s * this.gain);
        out[i] = limit(y);
      }
    }
    return { transmit, probability, voicing, wind: this.windSmooth, levelDb, cutoffHz: this.cutoff };
  }

  destroy(): void {
    this.denoiser.destroy?.();
  }
}
