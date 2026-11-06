/**
 * Free allowances the app watches. Figures come from the providers' pricing pages
 * unless marked as our own cap. Usage is estimated from the app's own counters.
 */
export type Period = 'day' | 'month';
export type BudgetState = 'ok' | 'warning' | 'critical' | 'locked';

export interface Budget {
  metric: string;
  label: string;
  period: Period;
  limit: number;
  unit: string;
  /** What the app does at the lock line. Absent means it only warns. */
  lock?: string;
  /** Going over this one can cost money, rather than just stopping. */
  billable?: boolean;
}

export const BUDGETS: Budget[] = [
  { metric: 'relay_gb', label: 'Voice relay data', period: 'month', limit: 1000, unit: 'GB', lock: 'Voice switches to direct links', billable: true },
  { metric: 'google_search', label: 'Google search (own cap)', period: 'month', limit: 3000, unit: 'searches', lock: 'Search switches to the free service', billable: true },
  { metric: 'worker_requests', label: 'Worker requests', period: 'day', limit: 100_000, unit: 'requests', lock: 'New rides are refused until tomorrow' },
  { metric: 'do_requests', label: 'Durable Object requests', period: 'day', limit: 100_000, unit: 'requests', lock: 'New rides are refused until tomorrow' },
  { metric: 'rows_written', label: 'Database writes', period: 'day', limit: 100_000, unit: 'rows' },
  { metric: 'place_search', label: 'Free place search (own cap)', period: 'day', limit: 2000, unit: 'searches', lock: 'Search pauses until tomorrow' },
  { metric: 'routing', label: 'Free routing (own cap)', period: 'day', limit: 1000, unit: 'routes', lock: 'Routes show as straight lines until tomorrow' },
];

export const WARN_AT = 0.7;
export const CRITICAL_AT = 0.9;
export const LOCK_AT = 0.95;

export function budgetState(budget: Budget, used: number): BudgetState {
  const share = used / budget.limit;
  if (share >= LOCK_AT && budget.lock) return 'locked';
  if (share >= CRITICAL_AT) return 'critical';
  if (share >= WARN_AT) return 'warning';
  return 'ok';
}

export const periodKey = (period: Period, now: number) => new Date(now).toISOString().slice(0, period === 'day' ? 10 : 7);

export interface BudgetView extends Budget {
  used: number;
  state: BudgetState;
}
