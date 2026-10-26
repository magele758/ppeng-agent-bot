import test from 'node:test';
import assert from 'node:assert/strict';
import { startBloubClock } from './bloub-motion.ts';

test('Bloub clock stops drawing and scheduling after disposal [AC:bot-bloub-dynamic#AC-3]', () => {
  let callback: (ms: number) => void = () => {};
  let requests = 0; let cancelled = 0; const samples: number[] = [];
  const stop = startBloubClock(t => samples.push(t), { request: cb => { callback = cb; return ++requests; }, cancel: id => { cancelled = id; } });
  callback(1000); assert.deepEqual(samples, [1]); assert.equal(requests, 2);
  stop(); assert.equal(cancelled, 2);
  callback(2000); assert.deepEqual(samples, [1]); assert.equal(requests, 2);
});
