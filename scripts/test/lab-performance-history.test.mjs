import assert from 'node:assert/strict';
import test from 'node:test';
import { historyTickTimes, runIdleHistory } from '../lab-performance/idle-history.mjs';

test('settled Bot histories incur no full-record reads or writes during measured scheduler ticks [AC:lab-performance-regression-gate#AC-1]', async () => {
  const actual = await runIdleHistory();
  const expected = [
    'history.goal.fullReads', 'history.goal.writes', 'history.goal.tickMedianMs', 'history.goal.tickMaxMs',
    'history.daydream.fullReads', 'history.daydream.writes', 'history.daydream.tickMedianMs', 'history.daydream.tickMaxMs'
  ];
  assert.deepEqual(actual.map(metric => metric.name), expected);
  for (const { name, value } of actual) {
    assert.ok(Number.isFinite(value), name);
    if (name.endsWith('Ms')) assert.ok(value > 0, name);
    else assert.equal(value, 0, name);
  }
});

test('steady slowdowns and isolated stalls retain distinct timings from all measured ticks [AC:lab-performance-regression-gate#AC-1]', () => {
  assert.deepEqual(historyTickTimes([180, 22, 11]), {tickMedianMs: 22, tickMaxMs: 180});
  assert.deepEqual(historyTickTimes([13, 97, 92]), {tickMedianMs: 92, tickMaxMs: 97});
  for (const missing of [[12, 14], [3, , 5], [4, NaN, 6]]) assert.throws(() => historyTickTimes(missing));
});
