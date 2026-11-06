import { describe, expect, it } from 'vitest';
import { localDate, RideRecorder } from '../../src/client/modules/stats/recorder';
import type { Position } from '../../src/shared/protocol';
import { avgMovingKmh, avgOverallKmh, SPEED_BANDS } from '../../src/shared/stats';

const START = new Date(2026, 10, 6, 9, 0, 0).getTime();
const M_PER_DEG = 111_195;

/** Rides north at a steady speed, one fix every `stepS` seconds. */
function ride(r: RideRecorder, from: { ts: number; la: number }, kmh: number, seconds: number, stepS = 2) {
  let { ts, la } = from;
  for (let t = 0; t < seconds; t += stepS) {
    ts += stepS * 1000;
    la += (kmh / 3.6) * stepS / M_PER_DEG;
    r.add(fix(la, kmh, ts));
  }
  return { ts, la };
}
const fix = (la: number, sp: number, ts: number, hd = 0): Position => ({ la, lo: 77, sp, hd, ts });

describe('ride recorder', () => {
  const start = () => {
    const r = new RideRecorder('ABC234', 'Sunday', START);
    r.add(fix(12, 0, START));
    return r;
  };

  it('measures distance, time and average speed', () => {
    const r = start();
    ride(r, { ts: START, la: 12 }, 60, 600);
    expect(r.log.distanceM).toBeGreaterThan(9900);
    expect(r.log.distanceM).toBeLessThan(10100);
    expect(r.log.movingS).toBe(600);
    expect(avgMovingKmh(r.log)).toBeCloseTo(60, 0);
  });

  it('separates stopped time and keeps it out of moving average', () => {
    const r = start();
    const at = ride(r, { ts: START, la: 12 }, 60, 600);
    const after = ride(r, at, 0, 600);
    expect(r.log.stoppedS).toBe(600);
    expect(avgMovingKmh(r.log)).toBeCloseTo(60, 0);
    expect(avgOverallKmh(r.log)).toBeCloseTo(30, 0);
    expect(after.ts).toBeGreaterThan(at.ts);
  });

  it('does not count parked GPS wander as distance', () => {
    const r = start();
    for (let i = 1; i <= 300; i++) r.add(fix(12 + (i % 2 ? 0.00004 : -0.00004), 0, START + i * 2000));
    expect(r.log.distanceM).toBe(0);
    expect(r.log.stoppedS).toBe(600);
  });

  it('ignores a multipath jump and carries on from the last good fix', () => {
    const r = start();
    const at = ride(r, { ts: START, la: 12 }, 60, 60);
    const before = r.log.distanceM;
    r.add(fix(13, 60, at.ts + 2000)); // 111 km in 2 s
    ride(r, at, 60, 60);
    expect(r.log.distanceM).toBeGreaterThan(before);
    expect(r.log.distanceM).toBeLessThan(2100);
  });

  it('skips inaccurate fixes', () => {
    const r = start();
    r.add(fix(12.01, 60, START + 2000), 120);
    expect(r.log.distanceM).toBe(0);
  });

  it('treats a long silence as a gap, not as stopped or moving time', () => {
    const r = start();
    const at = ride(r, { ts: START, la: 12 }, 60, 60);
    r.add(fix(at.la + 0.018, 60, at.ts + 120_000)); // a tunnel, 2 km later
    expect(r.log.gapS).toBe(120);
    expect(r.log.movingS).toBe(60);
    expect(r.log.distanceM).toBeGreaterThan(2900);
  });

  it('does not let a single spike set the top speed', () => {
    const r = start();
    const at = ride(r, { ts: START, la: 12 }, 80, 60);
    r.add(fix(at.la + 0.0005, 190, at.ts + 2000));
    ride(r, { ts: at.ts + 2000, la: at.la + 0.0005 }, 80, 60);
    expect(r.log.topKmh).toBe(80);
  });

  it('fills the speed bands', () => {
    const r = start();
    ride(r, { ts: START, la: 12 }, 45, 300);
    expect(r.log.bands[SPEED_BANDS.indexOf(40)]).toBe(300);
  });

  it('logs 5-minute speed intervals', () => {
    const r = start();
    const at = ride(r, { ts: START, la: 12 }, 40, 300);
    ride(r, at, 80, 300);
    expect(r.log.intervals).toHaveLength(3);
    const [m, s] = r.log.intervals[1] as [number, number];
    expect((m / s) * 3.6).toBeCloseTo(80, 0);
  });

  it('stays within its memory cap on an absurdly long ride', () => {
    const r = start();
    ride(r, { ts: START, la: 12 }, 60, 36 * 3600, 10);
    expect(r.log.track.length).toBeLessThanOrEqual(3000);
    expect(JSON.stringify(r.log.track).length).toBeLessThan(110_000);
  });

  it('keeps an 8-hour ride small', () => {
    const r = start();
    ride(r, { ts: START, la: 12 }, 70, 8 * 3600, 2);
    expect(JSON.stringify(r.log).length).toBeLessThan(60_000);
  });

  it('resumes a restored log for the same day', () => {
    const r = start();
    ride(r, { ts: START, la: 12 }, 60, 60);
    const restored = new RideRecorder('ABC234', 'Sunday', START, JSON.parse(JSON.stringify(r.log)));
    expect(restored.log.distanceM).toBe(r.log.distanceM);
    expect(restored.log.id).toBe(`${localDate(START)}:ABC234`);
  });
});
