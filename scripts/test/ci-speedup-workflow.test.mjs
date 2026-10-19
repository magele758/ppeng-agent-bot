import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { releaseFailures } from '../ci/release-results.mjs';
const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

test('a PR revision has one full trigger while main and manual gates remain available [AC:ci-gate-speedup#AC-1]', () => {
  const doc = workflow('ci');
  assert.deepEqual(doc.on.push.branches, ['main']);
  assert.ok(Object.hasOwn(doc.on, 'pull_request'));
  assert.ok(Object.hasOwn(doc.on, 'workflow_dispatch'));
});

test('browser/API checks start independently of long verification and mutation checkouts [AC:ci-gate-speedup#AC-4]', () => {
  const jobs = workflow('release-gate').jobs;
  assert.ok(jobs.browser, 'browser regression is still trapped behind long process checks');
  assert.equal(jobs.browser.needs, undefined);
  assert.notEqual(jobs.browser['runs-on'], undefined);
  const browser = jobs.browser.steps.map(s => s.run ?? '').join('\n');
  assert.match(browser, /test:e2e/);
  assert.doesNotMatch(browser, /test:formal|test:concurrency|test:unit/);
});

test('functional and coverage results come from one unit execution, with explicit plain performance verification [AC:ci-gate-speedup#AC-5]', () => {
  const jobs = workflow('release-gate').jobs;
  const all = Object.values(jobs).flatMap(j => j.steps ?? []).map(s => s.run ?? '');
  assert.equal(all.filter(s => s.includes('retry-failed-tests.mjs --script test:unit')).length, 1);
  assert.ok(all.some(s => s.includes('ci-unit-performance')), 'the stricter uninstrumented performance contract must remain');
});

test('all verification layers retain required results without cancelled-run always jobs [AC:ci-gate-speedup#AC-6] [AC:ci-gate-speedup#AC-7]', () => {
  const jobs = workflow('release-gate').jobs;
  assert.notEqual(jobs.gate.if, 'always()');
  assert.match(jobs.gate.if, /!cancelled\(\)/);
  assert.ok(jobs.gate.needs.includes('browser'));
  assert.ok(jobs.gate.needs.includes('mutation'));
  for (const job of Object.values(jobs)) {
    assert.notEqual(job['continue-on-error'], true);
    for (const step of job.steps ?? []) assert.notEqual(step['continue-on-error'], true);
  }
});

test('branch protection audit requires the complete aggregate gate [AC:ci-gate-speedup#AC-8]', () => {
  const otherwiseGreen=Object.fromEntries(['tests','crap','acceptance','mutation','secrets-gate'].map(name=>[name,{result:'success'}]));
  assert.ok(releaseFailures(otherwiseGreen).includes('browser'), 'missing browser evidence must fail the complete gate');
  assert.ok(releaseFailures({...otherwiseGreen,browser:{result:'failure'}}).includes('browser'));
  const source = readFileSync(new URL('../ci/gate-health-lib.mjs', import.meta.url), 'utf8');
  assert.match(source, /Main release gate/);
  const doc = readFileSync(new URL('../../doc/CI_GATE_SPEEDUP_PROPOSAL.md', import.meta.url), 'utf8');
  assert.match(doc, /分支保护/);
});

test('baseline measurements are manual only and cannot replace a PR required gate [AC:ci-gate-speedup#AC-9]', () => {
  const doc=workflow('ci');
  assert.equal(doc.on.workflow_dispatch.inputs.benchmark_baseline.type,'boolean');
  assert.match(doc.jobs['benchmark-baseline'].if,/github.event_name == 'workflow_dispatch'/);
  assert.notEqual(doc.jobs['benchmark-baseline'].name,'Release gate');
  assert.match(doc.jobs['release-gate'].if,/benchmark_baseline/);
});
test('runner-local evidence paths are evaluated at step scope [AC:ci-gate-speedup#AC-4]',()=>{
  const job=workflow('release-gate').jobs.crap;
  assert.doesNotMatch(JSON.stringify(job.env??{}),/runner\./,'runner context is not available in job env');
  for(const name of ['Unit tests with V8 coverage','Formal invariants + MockLLM E2E'])assert.match(job.steps.find(s=>s.name===name).env?.CI_VERIFICATION_EVIDENCE_DIR??'',/runner.temp/);
});
test('all reviewed verification inputs are checked before expensive unit execution [AC:ci-gate-speedup#AC-6]',()=>{
  const steps=workflow('release-gate').jobs.crap.steps;
  const preflight=steps.findIndex(s=>(s.run??'').includes('reviewed-verification-inputs.mjs'));
  assert.ok(preflight>=0&&preflight<steps.findIndex(s=>s.name==='Unit tests with V8 coverage'));
});
