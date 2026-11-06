import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetState, periodKey, type Budget } from '../../src/shared/budgets';

const relay = BUDGETS.find((b) => b.metric === 'relay_gb') as Budget;
const rows = BUDGETS.find((b) => b.metric === 'rows_written') as Budget;

describe('free limit guard', () => {
  it('stays quiet well under the limit', () => {
    expect(budgetState(relay, 100)).toBe('ok');
  });
  it('warns at 70%', () => {
    expect(budgetState(relay, 699)).toBe('ok');
    expect(budgetState(relay, 700)).toBe('warning');
  });
  it('turns critical at 90%', () => {
    expect(budgetState(relay, 900)).toBe('critical');
  });
  it('locks at 95%, before the limit that costs money', () => {
    expect(budgetState(relay, 950)).toBe('locked');
  });
  it('never locks a meter that has no lock defined', () => {
    expect(budgetState(rows, 99_999)).toBe('critical');
  });
  it('locks every meter that could cost money', () => {
    for (const b of BUDGETS.filter((x) => x.billable)) expect(b.lock, b.metric).toBeTruthy();
  });
  it('resets by day and by month, in UTC', () => {
    const t = Date.UTC(2026, 10, 6, 23, 30);
    expect(periodKey('day', t)).toBe('2026-11-06');
    expect(periodKey('month', t)).toBe('2026-11');
  });
});
