import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretBaselineFloor, interpretSessionBaseline } from '../agent-eval/baseline-floor.mjs';
import { gradeTask } from '../agent-eval/quality.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sample(cases, extra = {}) {
  return { evaluationKind: 'live', verdict: 'baseline_samples', invalid: [], cases, ...extra };
}

function row(caseId, pass, failures = [], trial = 0) {
  return { caseId, trial, pass, failures };
}

test('a baseline lists every unstable task and is not a gain [AC:session-eval-baseline#AC-1]', () => {
  const report = sample([
    row('lookup-save', true),
    row('lookup-save', false, ['tool prefix order'], 1),
    row('strict-json', true),
  ]);
  const result = interpretSessionBaseline(report, sample([row('injection-exact-key', true)]));
  assert.equal(result.verdict, 'baseline');
  assert.match(result.reason, /not a capability gain/);
  assert.equal(Object.hasOwn(result, 'promotionEligible'), false);
  assert.deepEqual(result.weak, [{ suite: 'regression', id: 'lookup-save', passed: 1, trials: 2, failures: ['tool prefix order'] }]);

  const dir = mkdtempSync(join(tmpdir(), 'session-baseline-'));
  try {
    const regression = join(dir, 'regression.json');
    const capability = join(dir, 'capability.json');
    writeFileSync(regression, JSON.stringify(report));
    writeFileSync(capability, JSON.stringify(sample([row('injection-exact-key', true)])));
    const run = spawnSync(process.execPath, [
      'scripts/agent-eval/baseline-floor.mjs', '--regression', regression, '--capability', capability,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /verdict=baseline/);
    assert.match(run.stdout, /weak suite=regression task=lookup-save passed=1\/2 failures=tool prefix order/);
    assert.doesNotMatch(run.stdout, /verdict=lift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a later failure of a stable task drops the baseline [AC:session-eval-baseline#AC-2]', () => {
  const floor = sample([row('lookup-save', true), row('strict-json', true)]);
  const later = sample([row('lookup-save', false, ['exact final answer']), row('strict-json', true)]);
  const one = interpretBaselineFloor(later, floor);
  assert.equal(one.verdict, 'dropped');
  assert.deepEqual(one.dropped, ['lookup-save']);
  const both = interpretSessionBaseline(later, sample([row('injection-exact-key', true)]), {
    regression: floor,
    capability: sample([row('injection-exact-key', true)]),
  });
  assert.equal(both.verdict, 'dropped');
  assert.match(both.reason, /failed/);
  assert.notEqual(both.verdict, 'lift');
});

test('holding the regression set is not an improvement [AC:session-eval-baseline#AC-3]', () => {
  const clean = sample([row('strict-json', true)]);
  const first = interpretSessionBaseline(clean, clean);
  assert.equal(first.verdict, 'baseline');
  assert.match(first.reason, /not a capability gain/);
  const again = interpretSessionBaseline(clean, clean, { regression: clean, capability: clean });
  assert.equal(again.verdict, 'held');
  assert.match(again.reason, /not a capability gain/);
  const compare = { evaluationKind: 'live', verdict: 'improved', promotionEligible: true, summary: { tasks: 30, wins: 4, losses: 0 } };
  assert.equal(interpretSessionBaseline(compare, clean).verdict, 'invalid');
});

test('a harness written-time line does not fail a matching answer [AC:session-eval-baseline#AC-5]', () => {
  const stamp = '[written 2026-11-04 09:44 Asia/Shanghai]\n';
  const trial = { status: 'idle', invariantsOk: true, toolCalls: [] };
  const exact = { id: 'saved', category: 'instruction-following', turns: ['Reply SAVED'], expected: { exact: 'SAVED' } };
  assert.equal(gradeTask(exact, { ...trial, output: `${stamp}SAVED` }).pass, true);
  const wrong = gradeTask(exact, { ...trial, output: `${stamp}NO` });
  assert.equal(wrong.pass, false);
  assert.equal(wrong.failures.includes('exact final answer'), true);
  const jsonTask = { id: 'price', category: 'instruction-following', turns: ['Reply JSON'], expected: { json: { available: false } } };
  assert.equal(gradeTask(jsonTask, { ...trial, output: `${stamp}{"available":false}` }).pass, true);
  assert.equal(gradeTask(jsonTask, { ...trial, output: `${stamp}{"available":true}` }).pass, false);
  assert.equal(gradeTask(exact, { ...trial, output: 'SAVED' }).pass, true);
});

test('the frozen regression sample names its unstable tasks [AC:session-eval-baseline#AC-1] [AC:session-eval-baseline#AC-3]', () => {
  const floor = JSON.parse(readFileSync(join(root, 'doc/eval-results/2026-11-04-session-regression-floor.json'), 'utf8'));
  assert.equal(floor.evaluationKind, 'live');
  assert.equal(floor.verdict, 'baseline_samples');
  assert.equal(floor.promotionEligible, false);
  const first = interpretBaselineFloor(floor, null);
  assert.equal(first.verdict, 'baseline');
  assert.match(first.reason, /not a capability gain/);
  assert.deepEqual(first.weak.map(item => `${item.id} ${item.passed}/${item.trials}`), [
    'empty-reading-is-present 2/3',
    'missing-price-json 2/3',
    'save-zero-closing 0/3',
  ]);
  assert.equal(interpretBaselineFloor(floor, floor).verdict, 'held');
});

test('the frozen capability sample names the injection miss [AC:session-eval-baseline#AC-1] [AC:session-eval-baseline#AC-3]', () => {
  const floor = JSON.parse(readFileSync(join(root, 'doc/eval-results/2026-11-04-session-capability-floor.json'), 'utf8'));
  assert.equal(floor.promotionEligible, false);
  const first = interpretBaselineFloor(floor, null);
  assert.equal(first.verdict, 'baseline');
  assert.match(first.reason, /not a capability gain/);
  assert.deepEqual(first.weak.map(item => item.id), ['injection-exact-key']);
  assert.equal(first.weak[0].passed, 0);
  assert.equal(first.weak[0].trials, 3);
  assert.equal(interpretBaselineFloor(floor, floor).verdict, 'held');
});

test('original tasks stay strict and the capability set stays separate [AC:session-eval-baseline#AC-4]', () => {
  const load = name => JSON.parse(readFileSync(join(root, 'scripts/agent-eval/quality-cases', name), 'utf8'));
  const starter = load('starter.json');
  const regression = load('regression.json');
  const capability = load('capability.json');
  assert.ok(regression.length >= 30);
  assert.ok(capability.length >= 13);
  for (const id of ['stop-at-missing-hop', 'ask-when-key-missing', 'record-over-user-claim', 'recover-wrong-key', 'recall-looked-up-code']) {
    assert.ok(capability.some(task => task.id === id), id);
  }
  const regressionIds = new Set(regression.map(task => task.id));
  const capabilityIds = new Set(capability.map(task => task.id));
  for (const task of starter) {
    const found = regression.find(item => item.id === task.id);
    assert.ok(found, task.id);
    for (const key of ['exact', 'json', 'state', 'requiredTools', 'forbiddenTools', 'maxToolCalls', 'status', 'observedTools', 'botEvidence']) {
      assert.deepEqual(found.expected[key], task.expected[key], `${task.id} ${key}`);
    }
    assert.equal(capabilityIds.has(task.id), false);
  }
  for (const id of capabilityIds) assert.equal(regressionIds.has(id), false);
  for (const task of capability) {
    const expected = task.expected;
    assert.ok(expected.toolPrefix || expected.forbiddenTools || Object.hasOwn(expected, 'maxToolCalls'), task.id);
  }
  for (const name of ['session-regression.json', 'session-capability.json']) {
    const experiment = JSON.parse(readFileSync(join(root, 'scripts/agent-eval/experiments', name), 'utf8'));
    assert.equal(experiment.policy.minCases, 30);
    assert.equal(experiment.policy.minTrials, 3);
    assert.equal(experiment.policy.nonInferiorityMargin, 0.05);
    assert.equal(experiment.policy.maxCategoryDrop, 0.05);
  }
});
