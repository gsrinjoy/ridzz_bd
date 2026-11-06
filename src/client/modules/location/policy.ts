import { distanceM } from '../../../shared/geo';
import type { Position } from '../../../shared/protocol';

export interface LocationPolicy {
  minIntervalMs: number;
  stationaryIntervalMs: number;
  heartbeatMs: number;
}

export const NORMAL: LocationPolicy = { minIntervalMs: 5_000, stationaryIntervalMs: 20_000, heartbeatMs: 60_000 };
export const SAVER: LocationPolicy = { minIntervalMs: 15_000, stationaryIntervalMs: 45_000, heartbeatMs: 120_000 };

const STATIONARY_KMH = 5;

/** Decides whether a GPS fix is worth waking the radio for. */
export function shouldSend(last: Position | undefined, now: Position, policy: LocationPolicy): boolean {
  if (!last) return true;
  const elapsed = now.ts - last.ts;
  if (elapsed >= policy.heartbeatMs) return true;
  const moving = now.sp >= STATIONARY_KMH;
  if (elapsed < (moving ? policy.minIntervalMs : policy.stationaryIntervalMs)) return false;

  const moved = distanceM(last, now);
  if (moved >= Math.max(20, (now.sp / 3.6) * 3)) return true;
  if (now.hd >= 0 && last.hd >= 0) {
    const turn = Math.abs(((now.hd - last.hd + 540) % 360) - 180);
    if (turn >= 25 && moved >= 10) return true;
  }
  return false;
}
