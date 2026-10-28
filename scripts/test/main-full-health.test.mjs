import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { decisive, headRunsFromActions, headRunsFromChecks, mergeDecision, resolveHeadSha } from '../ci/main-full-health.mjs';

const fail = { status: 'completed', conclusion: 'failure', headSha: 'red' };
const pass = { status: 'completed', conclusion: 'success', headSha: 'green' };

test('a red main blocks merge unless this head already passed full validation [AC:ci-fast-and-bihourly-gates#AC-12]', () => {
  assert.equal(mergeDecision([fail], []).ok, false);
  assert.equal(mergeDecision([pass], []).ok, true);
  assert.equal(mergeDecision([fail], [pass]).ok, true);
  assert.equal(mergeDecision([fail], headRunsFromChecks([{ name: 'Release gate / Main release gate', status: 'completed', conclusion: 'success' }], 'head')).ok, true);
  assert.equal(headRunsFromChecks([{ name: 'Quick gate', status: 'completed', conclusion: 'success' }], 'head').length, 0);
  assert.equal(decisive([{ status: 'completed', conclusion: 'cancelled' }, fail]).conclusion, 'failure');
  assert.equal(mergeDecision([], []).ok, false);
  const job = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs['main-health'];
  assert.equal(job.name, 'Main full health');
  assert.match(job.if, /pull_request/);
  assert.match(job.steps.map((step) => step.run ?? '').join('\n'), /main-full-health/);
});

test('manual Full validation still unblocks a red main when check-runs omit the gate [AC:ci-fast-and-bihourly-gates#AC-12]', () => {
  const red = { status: 'completed', conclusion: 'failure', headSha: 'main-red' };
  const manual = {
    name: 'Full validation',
    path: '.github/workflows/full-validation.yml',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'head',
    id: 1
  };
  const seen = headRunsFromActions([manual], 'head');
  assert.equal(seen[0].conclusion, 'success');
  assert.equal(mergeDecision([red], seen).ok, true);
  assert.equal(mergeDecision([red], []).ok, false);
  assert.equal(mergeDecision([red], headRunsFromActions([{ ...manual, conclusion: 'failure' }], 'head')).ok, false);
  assert.equal(mergeDecision([red], headRunsFromActions([{ ...manual, status: 'in_progress', conclusion: null }], 'head')).ok, false);
  assert.equal(headRunsFromActions([{ ...manual, head_sha: 'other' }], 'head').length, 0);
  assert.equal(headRunsFromActions([{ name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', head_sha: 'head' }], 'head').length, 0);
  const source = readFileSync(new URL('../ci/main-full-health.mjs', import.meta.url), 'utf8');
  assert.match(source, /workflows\/\$\{FULL_VALIDATION_WORKFLOW\}\/runs\?head_sha=/);
});

test('full health binds the pull request head, because Actions will not override GITHUB_SHA [AC:ci-fast-and-bihourly-gates#AC-12]', () => {
  assert.equal(resolveHeadSha({ PR_HEAD_SHA: 'head', GITHUB_SHA: 'merge' }), 'head');
  assert.equal(resolveHeadSha({ GITHUB_SHA: 'local' }), 'local');
  assert.equal(resolveHeadSha({}), '');
  const job = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs['main-health'];
  const step = job.steps.find((item) => String(item.run ?? '').includes('main-full-health'));
  assert.equal(step.env.PR_HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
  assert.equal(Object.hasOwn(step.env, 'GITHUB_SHA'), false);
});
