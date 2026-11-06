const START_AFTER_MS = 6000;
const LINGER_MS = 30_000;

export interface LocalLinkControl {
  running(): boolean;
  start(): void;
  stop(): void;
}

/**
 * Decides when the local link runs: on after trouble has lasted a few seconds,
 * off only after things have stayed good for a while, so a brief blip never
 * tears the mesh down.
 *
 * Callers can report as often as they like. Only a real change restarts the
 * clock, because a GPS fix every second would otherwise push the start back for ever.
 */
export class LocalLinkWatch {
  private needed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly link: LocalLinkControl) {}

  update(needed: boolean): void {
    if (needed === this.needed) return;
    this.needed = needed;
    clearTimeout(this.timer);
    if (needed && !this.link.running()) this.timer = setTimeout(() => this.link.start(), START_AFTER_MS);
    if (!needed && this.link.running()) this.timer = setTimeout(() => this.link.stop(), LINGER_MS);
  }

  /** Forgets everything, so the next report counts as a change. */
  reset(): void {
    clearTimeout(this.timer);
    this.needed = false;
  }
}
