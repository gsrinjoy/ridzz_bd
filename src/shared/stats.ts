/** [lat x1e5, lon x1e5, km/h, seconds since start]. Integers keep a full day to about 50 KB. */
export type TrackPoint = [la: number, lo: number, kmh: number, t: number];

export interface RideSummary {
  /** One log per ride per day: "2026-11-06:ABC234". */
  id: string;
  date: string;
  code: string;
  rideName: string;
  startedAt: number;
  endedAt: number;
  distanceM: number;
  movingS: number;
  stoppedS: number;
  /** Time with no GPS, such as tunnels, or an iPhone screen being locked. */
  gapS: number;
  topKmh: number;
}

export interface RideLog extends RideSummary {
  /** Seconds spent in each SPEED_BANDS band. */
  bands: number[];
  /** Per INTERVAL_S slice of the ride: [metres, seconds moving]. */
  intervals: [metres: number, seconds: number][];
  track: TrackPoint[];
}

export const INTERVAL_S = 300;
/** Lower bound of each band, in km/h. */
export const SPEED_BANDS = [0, 20, 40, 60, 80, 100];

export const avgMovingKmh = (s: RideSummary) => (s.movingS > 0 ? (s.distanceM / s.movingS) * 3.6 : 0);
export const avgOverallKmh = (s: RideSummary) => {
  const total = s.movingS + s.stoppedS;
  return total > 0 ? (s.distanceM / total) * 3.6 : 0;
};
