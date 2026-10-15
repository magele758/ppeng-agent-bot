import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsRoutineExpiration, routineTimezone } from './routine-form.ts';

test('expiration is available only for recurring form schedules', () => {
  for (const kind of ['cron', 'interval']) {
    assert.equal(supportsRoutineExpiration(kind), true);
  }
  for (const kind of ['once', 'event', '', 'unknown']) {
    assert.equal(supportsRoutineExpiration(kind), false);
  }
});

test('routine timezone falls back only when missing, preserving explicit values', () => {
  assert.equal(routineTimezone(undefined, 'Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(routineTimezone('America/New_York', 'Asia/Shanghai'), 'America/New_York');
  assert.equal(routineTimezone('', 'Asia/Shanghai'), '');
});
