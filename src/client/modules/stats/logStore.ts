import type { RideLog } from '../../../shared/stats';
import { saveRideLog } from '../ride/api';

const ACTIVE = 'slipstream.ride.active';
const QUEUE = 'slipstream.ride.queue';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or private mode. The log still uploads when the ride ends.
  }
}

/** Written every few minutes, so a crash or a dead battery loses almost nothing. */
export const saveActive = (log: RideLog) => write(ACTIVE, log);

export function restoreActive(id: string): RideLog | undefined {
  const log = read<RideLog>(ACTIVE);
  return log?.id === id ? log : undefined;
}

/**
 * A rider can just close the app, and the checkpoint is then all that is left.
 * Anything that is not the ride in progress gets filed here, not overwritten.
 */
export async function recoverActive(keepId?: string): Promise<void> {
  const log = read<RideLog>(ACTIVE);
  if (log && log.id !== keepId) await finishLog(log);
}

/** One upload per ride. Logs finished offline wait here for the next chance. */
export async function finishLog(log: RideLog): Promise<void> {
  write(ACTIVE, null);
  if (log.distanceM === 0 && log.movingS === 0) return;
  write(QUEUE, [...(read<RideLog[]>(QUEUE) ?? []).filter((l) => l.id !== log.id), log]);
  await flushLogs();
}

export async function flushLogs(): Promise<void> {
  const queue = read<RideLog[]>(QUEUE) ?? [];
  const left: RideLog[] = [];
  for (const log of queue) {
    try {
      await saveRideLog(log);
    } catch {
      left.push(log);
    }
  }
  write(QUEUE, left.length ? left : null);
}
