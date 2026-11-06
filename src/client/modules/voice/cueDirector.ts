import type { Cue } from './cues';

/** Below this, a drop has healed before anyone would notice, so it stays silent. */
export const LINK_QUIET_MS = 2000;
/** A soft reminder that the link is still down, spaced wide enough not to nag. */
export const LINK_REPEAT_MS = 15_000;
/** How long a rider who vanished gets to come back before anyone is told. */
export const RIDER_GRACE_MS = 5000;
/** Several riders arriving together make one sound, not a burst. */
export const RIDER_GAP_MS = 1500;

/**
 * Decides which status sounds are worth playing. Bad timing is what turns cues
 * into noise, so this keeps every rule in one place: a cellular blip, or a
 * rider passing under a bridge, should make no sound at all.
 */
export class CueDirector {
  private linkDown = false;
  private announced = false;
  private linkTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRiderCue = -Infinity;
  private readonly leaving = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly play: (cue: Cue) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private riderCue(cue: Cue): void {
    if (this.now() - this.lastRiderCue < RIDER_GAP_MS) return;
    this.lastRiderCue = this.now();
    this.play(cue);
  }

  riderJoined(id: string): void {
    const pending = this.leaving.get(id);
    if (pending !== undefined) {
      // Back inside the grace period: as far as anyone can tell, they never left.
      clearTimeout(pending);
      this.leaving.delete(id);
      return;
    }
    this.riderCue('rider-join');
  }

  /** `abrupt` means the link died; they may well return. Pressing End is final. */
  riderLeft(id: string, abrupt: boolean): void {
    if (!abrupt) return this.riderCue('rider-leave');
    if (this.leaving.has(id)) return;
    this.leaving.set(
      id,
      setTimeout(() => {
        this.leaving.delete(id);
        this.riderCue('rider-leave');
      }, RIDER_GRACE_MS),
    );
  }

  setLink(healthy: boolean): void {
    if (healthy === !this.linkDown) return;
    this.linkDown = !healthy;
    clearTimeout(this.linkTimer);
    if (healthy) {
      if (this.announced) this.play('reconnected');
      this.announced = false;
      return;
    }
    const remind = () => {
      this.announced = true;
      this.play('reconnecting');
      this.linkTimer = setTimeout(remind, LINK_REPEAT_MS);
    };
    this.linkTimer = setTimeout(remind, LINK_QUIET_MS);
  }

  destroy(): void {
    clearTimeout(this.linkTimer);
    this.leaving.forEach((t) => clearTimeout(t));
    this.leaving.clear();
  }
}
