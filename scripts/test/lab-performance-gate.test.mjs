import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { checkScenario, runScenarios, formatSummary } from '../lab-performance/gate.mjs';

const spec = [{name: 'wait', max: 10, unit: 'ms'}, {name: 'rewrites', max: 0, unit: 'writes'}];
const healthy = [{name: 'wait', value: 10}, {name: 'rewrites', value: 0}];

test('sustained slowdown relative to the reference produces an early warning before the hard limit [AC:lab-performance-regression-gate#AC-3]', () => {
  const measured = value => checkScenario('startup', [{name:'latency', max:100, unit:'ms', reference:30}], [{name:'latency', value}]);
  assert.equal(measured(45).metrics[0].warning, false);
  const slower = measured(55);
  assert.equal(slower.passed, true);
  assert.equal(slower.metrics[0].warning, true);
  assert.match(formatSummary({revision:'abc', passed:true, scenarios:[slower]}), /WARN/);
  assert.equal(measured(101).passed, false);
  assert.equal(checkScenario('startup', [{name:'latency', max:100, unit:'ms', reference:null}], [{name:'latency', value:5}]).passed, false);
});

test('fails a regression and reports the actual value beside its budget [AC:lab-performance-regression-gate#AC-3]', () => {
  assert.equal(checkScenario('idle', spec, healthy).passed, true);
  const result = checkScenario('idle', spec, [healthy[0], {name: 'rewrites', value: 94}]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.metrics.find(row => !row.passed), {name: 'rewrites', value: 94, max: 0, unit: 'writes', passed: false});
  assert.match(formatSummary({revision:'abcdef', passed:false, scenarios:[result]}), /rewrites.*94.*0/);
});

test('incomplete, nonnumeric, duplicate, or unknown measurements cannot pass [AC:lab-performance-regression-gate#AC-3]', () => {
  for (const invalid of [[], [healthy[0]], [...healthy, healthy[0]], [...healthy, {name:'other', value:0}],
    ...[NaN, Infinity, -1, null, '0'].map(value => [healthy[0], {name:'rewrites', value}])]) {
    assert.equal(checkScenario('idle', spec, invalid).passed, false);
  }
});

test('one failed fixture leaves diagnostic results for independent scenarios [AC:lab-performance-regression-gate#AC-3]', async () => {
  const report = await runScenarios('abcdef', [
    {name:'broken', budgets:spec, measure:async () => { throw Error('Missing fixture'); }},
    {name:'idle', budgets:spec, measure:async () => healthy},
  ]);
  assert.equal(report.passed, false);
  assert.equal(report.revision, 'abcdef');
  assert.match(report.scenarios[0].error, /Missing fixture/);
  assert.equal(report.scenarios[1].passed, true);
});

test('empty suites, malformed ceilings and failures without an Error object fail closed [AC:lab-performance-regression-gate#AC-3]', async () => {
  assert.equal((await runScenarios('abcdef', [])).passed, false);
  assert.equal(checkScenario('idle', [], []).passed, false);
  for (const max of [null, undefined, '10', -5, Infinity, NaN]) {
    assert.equal(checkScenario('idle', [{name:'rewrites', max, unit:'writes'}], [healthy[1]]).passed, false);
  }
  const report = await runScenarios('abcdef', [
    {name:'broken', budgets:spec, measure:async () => { throw null; }},
    {name:'idle', budgets:spec, measure:async () => healthy},
  ]);
  assert.equal(report.scenarios[0].error, 'null');
  assert.equal(report.scenarios[1].passed, true);
});

const yaml = path => parse(readFileSync(new URL('../../' + path, import.meta.url), 'utf8'));
test('protected PR check and scheduled full verification run the same benchmark and retain its report [AC:lab-performance-regression-gate#AC-3]', () => {
  const ci = yaml('.github/workflows/ci.yml');
  const full = yaml('.github/workflows/full-validation.yml');
  const release = yaml('.github/workflows/release-gate.yml');
  assert.ok(full.on.schedule.length);
  assert.equal(full.jobs.full.uses, './.github/workflows/release-gate.yml');
  assert.ok(release.jobs.gate.needs.includes('browser'));
  assert.equal(ci.jobs['main-health'].name, 'Main full health');
  assert.match(ci.jobs['main-health'].if, /pull_request/);
  for (const job of [ci.jobs['main-health'], release.jobs.browser]) {
    const step = job.steps.find(s => s.uses === './.github/actions/lab-performance');
    assert.ok(step, 'benchmark must be on the blocking execution path');
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(job['continue-on-error'], undefined);
  }
  const action = yaml('.github/actions/lab-performance/action.yml');
  assert.ok(action.runs.steps.some(s => s.run === 'timeout --kill-after=10s 3m node scripts/lab-performance/run.mjs' && !s['continue-on-error']));
  assert.ok(action.runs.steps.some(s => s.run?.includes('bot-opening-draft.test.ts') && !s['continue-on-error']));
  const upload = action.runs.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with['if-no-files-found'], 'error');
});
