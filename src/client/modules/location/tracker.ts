import type { Position } from '../../../shared/protocol';
import { NORMAL, SAVER, shouldSend } from './policy';

export class LocationTracker {
  private watch: number | undefined;
  private lastSent: Position | undefined;

  constructor(
    private readonly onFix: (pos: Position, accuracyM?: number) => void,
    private readonly onSend: (pos: Position) => void,
    private readonly onError: (message: string | null) => void,
    public saver = false,
  ) {}

  /** One fix from any source: the browser, or the Android service once the screen is off. */
  accept(pos: Position, accuracyM?: number): void {
    this.onError(null);
    this.onFix(pos, accuracyM);
    if (shouldSend(this.lastSent, pos, this.saver ? SAVER : NORMAL)) {
      this.lastSent = pos;
      this.onSend(pos);
    }
  }

  start(): void {
    if (!('geolocation' in navigator)) return this.onError('This device has no location service');
    this.watch = navigator.geolocation.watchPosition(
      (p) =>
        this.accept(
          {
            la: p.coords.latitude,
            lo: p.coords.longitude,
            sp: Math.max(0, (p.coords.speed ?? 0) * 3.6),
            hd: p.coords.heading ?? -1,
            ts: p.timestamp,
          },
          p.coords.accuracy,
        ),
      (e) => this.onError(e.code === e.PERMISSION_DENIED ? 'Location is blocked. Allow it to appear on the map.' : 'Waiting for GPS'),
      { enableHighAccuracy: !this.saver, maximumAge: 3000, timeout: 30000 },
    );
  }

  /** Precision is fixed when a watch starts, so a change of mode has to restart it. */
  setSaver(saver: boolean): void {
    if (saver === this.saver) return;
    this.saver = saver;
    if (this.watch !== undefined) {
      this.stop();
      this.start();
    }
  }

  stop(): void {
    if (this.watch !== undefined) navigator.geolocation.clearWatch(this.watch);
    this.watch = undefined;
  }
}
