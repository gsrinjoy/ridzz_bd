import { distanceM } from '../../../shared/geo';
import type { Position } from '../../../shared/protocol';
import { INTERVAL_S, SPEED_BANDS, type RideLog, type TrackPoint } from '../../../shared/stats';

const MOVING_KMH = 5;
/** Longer than this without a fix counts as a gap, not as riding. */
const GAP_S = 60;
const MAX_PLAUSIBLE_KMH = 250;
const MAX_ACCURACY_M = 50;
/** With GPS reporting no speed, the bike must leave this radius to count as moving. */
const PARKED_RADIUS_M = 25;
const TRACK_EVERY_S = 30;
const TRACK_EVERY_M = 300;
const TRACK_TURN_DEG = 30;
const MAX_TRACK_POINTS = 3000;

export const localDate = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const turned = (a: number, b: number) => (a >= 0 && b >= 0 ? Math.abs(((a - b + 540) % 360) - 180) : 0);

/**
 * Builds a day's ride from fixes the app already receives, so it adds no GPS
 * use and no network traffic. Memory stays flat however long the ride runs.
 */
export class RideRecorder {
  readonly log: RideLog;
  private last: Position | undefined;
  private lastStored: Position | undefined;
  private lastKmh = 0;
  private anchor: Position | undefined;

  constructor(code: string, rideName: string, startedAt: number, restored?: RideLog) {
    this.log = restored ?? {
      id: `${localDate(startedAt)}:${code}`,
      date: localDate(startedAt),
      code,
      rideName,
      startedAt,
      endedAt: startedAt,
      distanceM: 0,
      movingS: 0,
      stoppedS: 0,
      gapS: 0,
      topKmh: 0,
      bands: SPEED_BANDS.map(() => 0),
      intervals: [],
      track: [],
    };
  }

  add(pos: Position, accuracyM = 0): void {
    if (accuracyM > MAX_ACCURACY_M) return;
    const last = this.last;
    if (!last) {
      this.last = this.anchor = pos;
      this.store(pos, pos.sp);
      return;
    }
    const dt = (pos.ts - last.ts) / 1000;
    if (dt <= 0) return;
    const moved = distanceM(last, pos);
    const implied = (moved / dt) * 3.6;
    // A multipath jump: throw this fix away and keep measuring from the good one.
    if (implied > MAX_PLAUSIBLE_KMH) return;

    const log = this.log;
    this.last = pos;
    log.endedAt = pos.ts;

    if (dt > GAP_S) {
      log.gapS += dt;
      log.distanceM += moved; // The road between is unknown, but the bike did cover it.
      this.store(pos, pos.sp);
      return;
    }

    // Speed worked out from parked GPS jitter looks like riding, so it needs proof of leaving.
    const leftAnchor = distanceM(this.anchor ?? last, pos) >= PARKED_RADIUS_M;
    const kmh = pos.sp > 0 ? pos.sp : leftAnchor ? implied : 0;
    if (kmh >= MOVING_KMH) this.anchor = pos;
    const band = SPEED_BANDS.findLastIndex((low) => kmh >= low);
    log.bands[band] = (log.bands[band] ?? 0) + dt;

    if (kmh >= MOVING_KMH) {
      log.movingS += dt;
      log.distanceM += moved;
      const slice = Math.floor((pos.ts - log.startedAt) / 1000 / INTERVAL_S);
      while (log.intervals.length <= slice) log.intervals.push([0, 0]);
      const interval = log.intervals[slice] as [number, number];
      interval[0] += moved;
      interval[1] += dt;
      // Two readings must agree, so a one-fix spike cannot become the top speed.
      if (Math.abs(kmh - this.lastKmh) < 25) log.topKmh = Math.max(log.topKmh, Math.min(kmh, this.lastKmh));
    } else {
      log.stoppedS += dt; // Parked GPS wanders; none of it is distance.
    }
    this.lastKmh = kmh;

    const stored = this.lastStored;
    if (
      !stored ||
      (pos.ts - stored.ts) / 1000 >= TRACK_EVERY_S ||
      distanceM(stored, pos) >= TRACK_EVERY_M ||
      (turned(stored.hd, pos.hd) >= TRACK_TURN_DEG && distanceM(stored, pos) >= 30)
    ) {
      if (kmh >= MOVING_KMH || !stored || (pos.ts - stored.ts) / 1000 >= 300) this.store(pos, kmh);
    }
  }

  private store(pos: Position, kmh: number): void {
    const { track, startedAt } = this.log;
    this.lastStored = pos;
    const point: TrackPoint = [Math.round(pos.la * 1e5), Math.round(pos.lo * 1e5), Math.round(kmh), Math.round((pos.ts - startedAt) / 1000)];
    track.push(point);
    // Thinning by half keeps the shape and caps memory on very long days.
    if (track.length > MAX_TRACK_POINTS) this.log.track = track.filter((_, i) => i % 2 === 0);
  }
}
