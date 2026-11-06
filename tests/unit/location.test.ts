import { describe, expect, it } from 'vitest';
import { NORMAL, SAVER, shouldSend } from '../../src/client/modules/location/policy';
import type { Position } from '../../src/shared/protocol';

const fix = (o: Partial<Position> = {}): Position => ({ la: 12, lo: 77, sp: 60, hd: 90, ts: 0, ...o });
const NORTH_100M = 0.0009;

describe('location policy', () => {
  it('always sends the first fix', () => {
    expect(shouldSend(undefined, fix(), NORMAL)).toBe(true);
  });
  it('holds back fixes inside the minimum interval', () => {
    expect(shouldSend(fix(), fix({ ts: 2000, la: 12 + NORTH_100M }), NORMAL)).toBe(false);
  });
  it('sends when moving far enough after the interval', () => {
    expect(shouldSend(fix(), fix({ ts: 6000, la: 12 + NORTH_100M }), NORMAL)).toBe(true);
  });
  it('keeps quiet while parked, apart from the heartbeat', () => {
    expect(shouldSend(fix({ sp: 0 }), fix({ sp: 0, ts: 30_000 }), NORMAL)).toBe(false);
    expect(shouldSend(fix({ sp: 0 }), fix({ sp: 0, ts: 61_000 }), NORMAL)).toBe(true);
  });
  it('reports a sharp turn even with little distance covered', () => {
    expect(shouldSend(fix({ sp: 20, hd: 0 }), fix({ sp: 20, hd: 60, ts: 6000, la: 12.00015 }), NORMAL)).toBe(true);
  });
  it('handles heading wrap across north', () => {
    expect(shouldSend(fix({ sp: 20, hd: 350 }), fix({ sp: 20, hd: 5, ts: 6000, la: 12.00015 }), NORMAL)).toBe(false);
  });
  it('sends less often in battery saver', () => {
    expect(shouldSend(fix(), fix({ ts: 6000, la: 12 + NORTH_100M }), SAVER)).toBe(false);
    expect(shouldSend(fix(), fix({ ts: 16_000, la: 12 + NORTH_100M }), SAVER)).toBe(true);
  });
});
