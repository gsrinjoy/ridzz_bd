export interface VoxConfig {
  /** Speech probability needed to open the gate. 0..1 */
  openProbability: number;
  /** Probability that keeps an open gate alive. */
  holdProbability: number;
  /** Consecutive speech frames needed to open. */
  attackFrames: number;
  /** How long the gate stays open after the last speech frame. */
  hangoverFrames: number;
  /** Extra hold at full wind, when speech is masked and the votes turn unreliable. */
  windHoldFrames: number;
  /** Speech must sit this far above the tracked noise floor. */
  marginDb: number;
  /** Pitch periodicity needed to open. Wind stays below this; voiced speech does not. */
  voicingMin: number;
  /** How fast the noise floor climbs, in dB per frame. A steady drone is absorbed in a few seconds. */
  floorRise: number;
}

export const DEFAULT_VOX: VoxConfig = {
  openProbability: 0.15,
  holdProbability: 0.2,
  attackFrames: 3,
  hangoverFrames: 60,
  windHoldFrames: 90,
  marginDb: 3,
  voicingMin: 0.4,
  floorRise: 0.1,
};

/**
 * Hands-free "auto push-to-talk".
 *
 * Loudness cannot drive this: wind is louder than speech, so an energy gate
 * sits open at speed. Pitch cannot do it alone either: engines and horns are
 * periodic. So the gate needs three votes: the denoiser's speech probability,
 * pitch periodicity, and rising above a noise floor that absorbs anything steady.
 */
export class VoxGate {
  isOpen = false;
  private run = 0;
  private hold = 0;
  private floorDb = -60;

  constructor(public config: VoxConfig = DEFAULT_VOX) {}

  /** Advance one 10 ms frame. Returns true while audio should be sent. */
  update(probability: number, levelDb: number, wind: number, voicing: number): boolean {
    const c = this.config;
    // Floor falls fast and rises slowly so that it follows the noise, not the voice.
    this.floorDb += levelDb < this.floorDb ? (levelDb - this.floorDb) * 0.2 : c.floorRise;

    // Staying open must pass this too. Otherwise a constant engine drone, which
    // is periodic and looks like a voice, latches the gate open for the whole ride.
    const aboveNoise = levelDb > this.floorDb + c.marginDb;
    const speech = probability >= c.openProbability && voicing >= c.voicingMin && aboveNoise;

    if (this.isOpen) {
      if (aboveNoise && probability >= c.holdProbability && voicing >= c.voicingMin * 0.8) {
        this.hold = c.hangoverFrames + Math.round(c.windHoldFrames * wind);
      } else if (--this.hold <= 0) {
        this.isOpen = false;
        this.run = 0;
      }
    } else {
      this.run = speech ? this.run + 1 : 0;
      if (this.run >= c.attackFrames) {
        this.isOpen = true;
        this.hold = c.hangoverFrames + Math.round(c.windHoldFrames * wind);
      }
    }
    return this.isOpen;
  }

  reset(): void {
    this.isOpen = false;
    this.run = 0;
    this.hold = 0;
  }
}
