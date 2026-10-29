import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateGoalSnapshot } from '../src/bots/goals/store.ts';
import type { GoalSnapshot, GoalStore } from '../src/bots/goals/types.ts';

function emptySnapshot(): GoalSnapshot {
  return { goals: [], executions: [], events: [], processed: [], fence: 0 };
}

function locked(): Error {
  const error = new Error('database is locked') as Error & { errcode: number };
  error.errcode = 5;
  return error;
}

function lockedStore(): { store: GoalStore; begins: number; sql: string[] } {
  const sql: string[] = [];
  let begins = 0;
  const store: GoalStore = {
    getDaemonControl: () => emptySnapshot(),
    setDaemonControl: () => {},
    db: {
      exec(statement: string) {
        sql.push(statement);
        if (statement === 'BEGIN IMMEDIATE') {
          begins += 1;
          throw locked();
        }
      },
    },
  };
  return {
    store,
    get begins() { return begins; },
    sql,
  };
}

test('short busy wait does not retry a locked snapshot write [AC:goal-intake-hot-path#AC-2]', () => {
  const lockedOnce = lockedStore();
  assert.throws(
    () => mutateGoalSnapshot(lockedOnce.store, 'bot-a', (state) => state, { busyWaitMs: 100 }),
    (error: unknown) => error instanceof Error && error.message === 'database is locked',
  );
  assert.equal(lockedOnce.begins, 1);
  assert.deepEqual(lockedOnce.sql.slice(0, 2), ['PRAGMA busy_timeout = 100', 'BEGIN IMMEDIATE']);
  assert.equal(lockedOnce.sql.at(-1), 'PRAGMA busy_timeout = 5000');

  const retried = lockedStore();
  assert.throws(
    () => mutateGoalSnapshot(retried.store, 'bot-a', (state) => state),
    (error: unknown) => error instanceof Error && error.message === 'database is locked',
  );
  assert.equal(retried.begins, 2);
  assert.equal(retried.sql.filter((statement) => statement.startsWith('PRAGMA busy_timeout')).length, 0);
});
