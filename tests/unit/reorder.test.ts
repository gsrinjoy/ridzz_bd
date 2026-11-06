import { describe, expect, it } from 'vitest';
import { landingIndex, moved, slide } from '../../src/client/modules/stops/reorder';

const rows = [0, 60, 120, 180].map((top) => ({ top, height: 60 }));

describe('reordering stops', () => {
  it('moves an item either way and leaves the rest in order', () => {
    expect(moved(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moved(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moved(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('does not change the original list', () => {
    const list = ['a', 'b'];
    moved(list, 0, 1);
    expect(list).toEqual(['a', 'b']);
  });

  it('lands past each row whose middle was crossed', () => {
    expect(landingIndex(rows, 0, 30)).toBe(0);
    expect(landingIndex(rows, 0, 89)).toBe(0);
    expect(landingIndex(rows, 0, 91)).toBe(1);
    expect(landingIndex(rows, 0, 900)).toBe(3);
    expect(landingIndex(rows, 3, -900)).toBe(0);
    expect(landingIndex(rows, 2, 89)).toBe(1);
  });

  it('copes with one row being taller because it is open', () => {
    const open = [{ top: 0, height: 60 }, { top: 60, height: 200 }, { top: 260, height: 60 }];
    expect(landingIndex(open, 0, 150)).toBe(0);
    expect(landingIndex(open, 0, 170)).toBe(1);
  });

  it('slides only the rows between the start and the landing spot', () => {
    expect([0, 1, 2, 3].map((i) => slide(i, 0, 2, 60))).toEqual([0, -60, -60, 0]);
    expect([0, 1, 2, 3].map((i) => slide(i, 3, 1, 60))).toEqual([0, 60, 60, 0]);
    expect([0, 1, 2, 3].map((i) => slide(i, 1, 1, 60))).toEqual([0, 0, 0, 0]);
  });
});
