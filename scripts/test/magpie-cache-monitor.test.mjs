import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runMonitor } from '../monitoring/magpie-cache-monitor.mjs';

const hour = 3600000;
const at = Date.UTC(2026, 10, 19, 0);
function usage(time, pct) {
  return { time, provider: 'fixture', model: 'test-model', cached: pct * 100, input: 10000 };
}
const baseline = Array.from({length: 6}, (_, i) => usage(at + i * 1000, 90));
const rows = [...baseline, ...[30, 60, 90, 120].flatMap((n, i) =>
  [1, 2, 3].map(j => usage(at + n * 60000 + j, i < 2 ? 50 : 90)))];
const source = async ({startMs, endMs}) => ({
  records: rows.filter(row => row.time >= startMs && row.time < endMs),
  coverage: {sourceAvailable: true, incompleteIntervals: []},
});

test('publishes real aggregates, retains notices through restarts, and acknowledges only delivered IDs [AC:magpie-cache-monitor#AC-3] [AC:magpie-cache-monitor#AC-2]', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'magpie-monitor-'));
  t.after(() => rmSync(stateDir, {recursive:true, force:true}));
  const options = {stateDir, source, now: at + 1.7 * hour};
  const init = {from:at, to:at + hour / 2};
  const first = await runMonitor({...options, init});
  assert.equal(first.summary.sourceStatus, 'ok');
  assert.equal(first.pending.length, 1);
  assert.equal(first.pending[0].kind, 'degraded');
  assert.deepEqual((await runMonitor(options)).pending, first.pending);
  assert.deepEqual((await runMonitor({...options, init})).pending, first.pending);
  const saved = JSON.parse(readFileSync(join(stateDir, 'monitoring', 'magpie-cache-summary.json'), 'utf8'));
  assert.equal(saved.models[0].reference.ratio, 0.9);
  assert.equal(saved.models[0].window.requestHitRatio, 1);
  assert.ok(saved.lastValidAt && saved.checkedAt);
  await runMonitor({...options, ack:[first.pending[0].id]});
  assert.equal((await runMonitor(options)).pending.length, 0);
  const recovered = await runMonitor({...options, now:at + 2.7 * hour});
  assert.deepEqual(recovered.pending.map(e => e.kind), ['recovered']);
});

test('unavailable logs are visible, leave incidents open and preserve the previous valid observation [AC:magpie-cache-monitor#AC-3]', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'magpie-unavailable-'));
  t.after(() => rmSync(stateDir, {recursive:true, force:true}));
  const options = {stateDir, source, now:at + 1.7 * hour};
  const first = await runMonitor({...options, init:{from:at,to:at + hour / 2}});
  const result = await runMonitor({...options, now:at + 2.7 * hour, source:async () => {throw Error('unreadable proxy log');}});
  assert.equal(result.summary.sourceStatus, 'unavailable');
  assert.equal(result.summary.lastValidAt, first.summary.lastValidAt);
  assert.equal(result.summary.models[0].incidentOpen, true);
  assert.equal(result.pending.length, 1);
  const retried = await runMonitor({...options, now:at + 2.7 * hour});
  assert.ok(retried.pending.some(e => e.kind === 'recovered'), 'unreadable logs must be retried');
});

test('a repeat check cannot erase a data gap in the last closed window [AC:magpie-cache-monitor#AC-3]', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'magpie-incomplete-'));
  t.after(() => rmSync(stateDir, {recursive:true, force:true}));
  const withGap = async options => {
    const data = await source(options);
    const time = at + hour + 3000;
    if (time >= options.startMs && time < options.endMs) data.coverage.incompleteIntervals.push({startMs:time,endMs:time+1});
    return data;
  };
  const options = {stateDir, now:at + 1.7 * hour, source:withGap};
  const first = await runMonitor({...options, init:{from:at, to:at + hour / 2}});
  assert.equal(first.summary.sourceStatus, 'incomplete');
  assert.equal((await runMonitor(options)).summary.sourceStatus, 'incomplete');
  assert.equal((await runMonitor({...options, source:async () => {throw Error();}})).summary.sourceStatus, 'unavailable');
  assert.equal((await runMonitor(options)).summary.sourceStatus, 'incomplete');
});
