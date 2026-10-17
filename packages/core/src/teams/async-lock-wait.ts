import { setTimeout as delay } from 'node:timers/promises';

/** Sleep slices used by a bounded async lock wait. Never blocks the main thread. */
export const LOCK_WAIT_SLICES_MS = [5, 10, 20, 40, 80] as const;

export interface AsyncLockWait {
  /** Milliseconds already spent waiting. */
  elapsed(): number;
  /** True once the budget is exhausted. */
  expired(): boolean;
  /** Next backoff slice. Resolves; does not use Atomics.wait. */
  pause(): Promise<void>;
}

/** Wall-clock wait with capped exponential backoff. Total time stays within `budgetMs`. */
export function startAsyncLockWait(budgetMs: number, now: () => number = Date.now): AsyncLockWait {
  const started = now();
  let step = 0;
  const elapsed = () => now() - started;
  return {
    elapsed,
    expired: () => elapsed() > budgetMs,
    pause: async () => {
      const slice = LOCK_WAIT_SLICES_MS[Math.min(step, LOCK_WAIT_SLICES_MS.length - 1)] ?? LOCK_WAIT_SLICES_MS[0];
      step += 1;
      const remaining = budgetMs - elapsed();
      if (remaining <= 0) return;
      await delay(Math.min(slice, remaining));
    }
  };
}
