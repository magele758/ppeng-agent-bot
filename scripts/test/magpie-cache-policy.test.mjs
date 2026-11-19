import assert from 'node:assert/strict';
import test from 'node:test';
import { createCacheBaseline, evaluateCacheWindows } from '../monitoring/magpie-cache-policy.mjs';

const windowMs = 3600000;
const from = Date.UTC(2026, 10, 19);
const to = from + windowMs;
const start = i => to + i * windowMs;
function samples(i, ratio, { provider = 'one', model = 'large', requests = 5, input = 4000 } = {}) {
  return Array.from({ length: requests }, (_, n) => ({
    time: start(i) + n * 1000, provider, model, input, cached: Math.round(input * ratio),
  }));
}
const baseline = createCacheBaseline(samples(-1, 0.90), { from, to });
const evaluate = (records, i, extra = {}) => evaluateCacheWindows(records, { baseline, windowMs, now: start(i), ...extra });

test('weights tokens, distinguishes hit requests and includes only the fixed reference interval [AC:magpie-cache-monitor#AC-2]', () => {
  const measured = createCacheBaseline([
    ...samples(-1, 1, { requests: 1, input: 20000 }), ...samples(-1, 0, { requests: 4, input: 1000 }),
    ...samples(-2, 1), ...samples(0, 0),
  ], { from, to }).models[0];
  assert.equal(measured.requests, 5);
  assert.equal(measured.ratio, 20000 / 24000);
  assert.equal(measured.requestHitRatio, 1 / 5);
});

test('two closed, adequate, independent windows produce one incident with both samples and reference [AC:magpie-cache-monitor#AC-2]', () => {
  const records = [...samples(0, 0.8), ...samples(1, 0.7)];
  const first = evaluate(records, 1);
  assert.equal(first.events.length, 0);
  assert.equal(first.models[0].status, 'watching');
  assert.equal(first.state.cursor, start(1));
  const second = evaluate(samples(1, 0.7), 2, { state: first.state });
  assert.equal(second.events.length, 1);
  const alert = second.events[0];
  assert.equal(alert.kind, 'degraded');
  assert.equal(alert.reference.ratio, 0.9);
  assert.equal(alert.previousWindow.ratio, 0.8);
  assert.equal(alert.window.ratio, 0.7);
  assert.equal(alert.window.requests, 5);
  assert.equal(alert.window.input, 20000);
  assert.equal(alert.window.to, start(2));
  assert.equal(second.models[0].lastValidAt, start(1) + 4000);
  const replay = evaluate(records, 2, { state: JSON.parse(JSON.stringify(second.state)) });
  assert.deepEqual(replay.events, []);
  assert.deepEqual(replay.state, second.state);
  assert.equal(evaluate(records, 2).events[0].id, alert.id);
});

test('two half-hour batches six hours apart can warn while genuine idle or undersized intervals neither confirm nor retract [AC:magpie-cache-monitor#AC-2]', () => {
  const half = windowMs / 2;
  const policy = { windowMs: half };
  const first = evaluateCacheWindows(samples(0, 0.6), { baseline, ...policy, now: to + half });
  assert.equal(first.models[0].window.to - first.models[0].window.from, half);
  const quiet = evaluateCacheWindows([
    ...samples(2, 1, { requests: 2, input: 20000 }), ...samples(3, 1, { requests: 10, input: 999 }),
  ], { baseline, ...policy, state: first.state, now: start(6) });
  assert.deepEqual(quiet.events, []);
  assert.equal(quiet.models[0].status, 'insufficient');
  const result = evaluateCacheWindows(samples(6, 0.65), { baseline, ...policy, state: quiet.state, now: start(6) + half });
  assert.deepEqual(result.events.map(e => e.kind), ['degraded']);
  assert.equal(result.events[0].previousWindow.from, to);
  assert.equal(result.events[0].window.from, start(6));
});

test('a known source gap or more than 24h between qualified windows interrupts decline evidence [AC:magpie-cache-monitor#AC-2]', () => {
  for (const between of [[], samples(1, 0)]) {
    const result = evaluate([...samples(0, 0), ...between, ...samples(2, 0)], 3, {
      coverageGaps: [{ from: start(1) + 1000, to: start(1) + 2000 }],
    });
    assert.deepEqual(result.events, []);
    assert.equal(result.models[0].status, 'watching');
  }
  const expired = evaluate([...samples(0, 0), ...samples(25, 0)], 26);
  assert.deepEqual(expired.events, []);
  const onBoundary = evaluate([...samples(0, 0), ...samples(24, 0)], 25);
  assert.equal(onBoundary.events.length, 1);
});

test('a source gap noticed before a window closes survives restart and a missing window never hides the model reference [AC:magpie-cache-monitor#AC-2]', () => {
  const first = evaluateCacheWindows(samples(0, 0.4), { baseline, windowMs, now: start(1)+2000,
    coverageGaps: [{ from: start(1), to: start(1)+1000 }] });
  const later = evaluate([...samples(1, 0.4), ...samples(2, 0.4)], 3, { state: JSON.parse(JSON.stringify(first.state)) });
  assert.deepEqual(later.events, []);
  assert.equal(later.models[0].status, 'watching');
  const waiting = evaluate([], 0);
  assert.equal(waiting.models[0].reference.ratio, .9);
  assert.equal(waiting.models[0].window, null);
});

test('an open incident survives missing observations and requires two consecutive recovery windows inside the hysteresis band [AC:magpie-cache-monitor#AC-2]', () => {
  const incident = evaluate([...samples(0, 0.4), ...samples(1, 0.6)], 2);
  const quiet = evaluate([], 7, { state: incident.state });
  assert.equal(quiet.models[0].status, 'insufficient');
  assert.equal(quiet.models[0].incidentOpen, true);
  assert.equal(quiet.models[0].lastValidAt, start(1) + 4000);
  const records = [...samples(7, 0.85), ...samples(8, 0.84), ...samples(9, 0.85), ...samples(10, 0.9), ...samples(11, 1)];
  const result = evaluate(records, 12, { state: quiet.state });
  assert.deepEqual(result.events.map(event => [event.kind, event.window.from]), [['recovered', start(10)]]);
  assert.equal(result.models[0].incidentOpen, false);
  assert.equal(result.models[0].status, 'healthy');
});

test('a new provider and model can learn their own non-overlapping post-optimization reference [AC:magpie-cache-monitor#AC-2]', () => {
  const newRoute = { provider: 'two', model: 'large' };
  const newModel = { provider: 'one', model: 'small' };
  const records = [
    ...samples(0, 1, { ...newRoute, requests: 2 }), ...samples(1, 1, { ...newRoute, requests: 3 }),
    ...samples(2, 0.7, newRoute), ...samples(3, 0.7, newRoute),
    ...samples(0, 0.2, newModel), ...samples(1, 0.2, newModel), ...samples(2, 0.2, newModel), ...samples(3, 0.2, newModel),
  ];
  const result = evaluate(records, 4);
  assert.deepEqual(result.events.map(e => [e.provider, e.model, e.kind]), [['two', 'large', 'degraded']]);
  assert.equal(result.events[0].reference.from, start(0));
  assert.equal(result.events[0].reference.to, start(2));
  assert.equal(result.events[0].reference.requests, 5);
  assert.equal(result.events[0].previousWindow.from, start(2));
});

test('a stable healthy improvement raises the comparison level and a later decline freezes it [AC:magpie-cache-monitor#AC-2]', () => {
  const original = createCacheBaseline(samples(-1, 0.53), { from, to });
  const result = evaluate([.90, .91, .89, .70, .70, .73, .87, .89].flatMap((ratio, i) => samples(i, ratio)), 8, { baseline: original });
  assert.deepEqual(result.events.map(e => [e.kind, e.window.from]), [['degraded', start(4)], ['recovered', start(7)]]);
  assert.ok(Math.abs(result.events[0].reference.ratio - .90) < 1e-9);
  assert.equal(result.events[0].reference.requests, 15);
  assert.equal(result.events[0].reference.to, start(3));
  assert.deepEqual(result.events[1].reference, result.events[0].reference);
});
