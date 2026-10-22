import test from 'node:test';
import assert from 'node:assert/strict';
import { runIndependentScenarios } from '../formal/independent-scenarios.mjs';

test('independent restart scenarios overlap in pairs while preserving every result in inventory order', async () => {
  const releases = [];
  const started = [];
  let active = 0, peak = 0;
  const pending = runIndependentScenarios([0, 1, 2, 3, 4], async item => {
    started.push(item);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => { releases[item] = resolve; });
    active--;
    return { item };
  });
  assert.deepEqual(started, [0, 1]);
  releases[1]();
  releases[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3]);
  releases[3]();
  releases[2]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases[4]();
  assert.deepEqual(await pending, [0, 1, 2, 3, 4].map(item => ({ item })));
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('an infrastructure failure waits for its independent peer cleanup and propagates without retry', async () => {
  let release;
  let cleaned = false;
  const failure = new Error('startup failed');
  const started = [];
  const pending = runIndependentScenarios([0, 1, 2], async item => {
    started.push(item);
    if (item === 0) throw failure;
    await new Promise(resolve => { release = resolve; });
    cleaned = true;
  });
  const rejected = assert.rejects(pending, error => error === failure && cleaned);
  assert.deepEqual(started, [0, 1]);
  release();
  await rejected;
  assert.deepEqual(started, [0, 1]);
});
