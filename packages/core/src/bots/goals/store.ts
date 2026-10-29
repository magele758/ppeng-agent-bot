import type { GoalSnapshot, GoalStore } from './types.js';

type GoalDb = { exec(sql: string): unknown; isTransaction?: boolean };

export const GOAL_INTAKE_BUSY_WAIT_MS = 100;

/** Short lock wait for turn-start writes. Restores the connection's 5s busy timeout. */
export function withSqliteBusyWait<T>(db: { exec(sql: string): unknown } | undefined, waitMs: number, fn: () => T): T {
  if (!db) return fn();
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(waitMs)}`);
  try {
    return fn();
  } finally {
    db.exec('PRAGMA busy_timeout = 5000');
  }
}

export function readGoalSnapshot(store: GoalStore, botId: string): GoalSnapshot {
  return store.getDaemonControl<GoalSnapshot>(`bot_goals:${botId}`) ?? { goals: [], executions: [], events: [], processed: [], fence: 0 };
}

function goalDb(store: GoalStore): GoalDb | undefined {
  return store.db as GoalDb | undefined;
}

function sqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errcode } = error as { code?: string; errcode?: number };
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'ERR_SQLITE_ERROR') {
    if (typeof errcode !== 'number') return code !== 'ERR_SQLITE_ERROR';
  }
  if (typeof errcode !== 'number') return false;
  const primary = errcode & 0xff;
  return primary === 5 || primary === 6;
}

function rollback(db: GoalDb, nested: boolean): void {
  try {
    if (nested) {
      db.exec('ROLLBACK TO bot_goal_mutation');
      db.exec('RELEASE bot_goal_mutation');
    } else {
      db.exec('ROLLBACK');
    }
  } catch {
    /* The failed statement may already have ended the transaction. */
  }
}

function mutateOnce<T>(store: GoalStore, botId: string, fn: (state: GoalSnapshot) => T): T {
  const db = goalDb(store);
  if (!db) {
    const state = readGoalSnapshot(store, botId);
    const result = fn(state);
    store.setDaemonControl(`bot_goals:${botId}`, state);
    return result;
  }
  const nested = db.isTransaction === true;
  db.exec(nested ? 'SAVEPOINT bot_goal_mutation' : 'BEGIN IMMEDIATE');
  try {
    const state = readGoalSnapshot(store, botId);
    const result = fn(state);
    store.setDaemonControl(`bot_goals:${botId}`, state);
    db.exec(nested ? 'RELEASE bot_goal_mutation' : 'COMMIT');
    return result;
  } catch (error) {
    rollback(db, nested);
    throw error;
  }
}

/** Write lock before the read, so a deferred snapshot cannot go stale. One restart if the lock still lands mid-write. A short busy wait skips that retry. */
export function mutateGoalSnapshot<T>(store: GoalStore, botId: string, fn: (state: GoalSnapshot) => T, options?: { busyWaitMs?: number }): T {
  if (options?.busyWaitMs !== undefined) {
    return withSqliteBusyWait(goalDb(store), options.busyWaitMs, () => mutateOnce(store, botId, fn));
  }
  try {
    return mutateOnce(store, botId, fn);
  } catch (error) {
    if (!sqliteBusy(error) || goalDb(store)?.isTransaction === true) throw error;
    return mutateOnce(store, botId, fn);
  }
}
