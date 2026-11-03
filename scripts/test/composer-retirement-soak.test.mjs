import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { releaseFailures } from '../ci/release-results.mjs';
import { compareAcceptance } from '../ci/base-revision.mjs';

const workflow = () => parse(readFileSync('.github/workflows/release-gate.yml', 'utf8'));

test('retired drag acceptance retains its reason and exclusive browser suite is removed [AC:composer-drop-retirement-soak-isolation#AC-4]', () => {
  const spec = parse(readFileSync('acceptance/composer-drag-context.yaml', 'utf8'));
  assert.equal(spec.status, 'retired');
  assert.ok(spec.retiredReason);
  assert.equal(spec.criteria.length, 7);
  assert.equal(existsSync('e2e/composer-drag-context.spec.ts'), false);
  const prior = { ...spec, status: 'implemented' };
  assert.deepEqual(compareAcceptance([prior], [spec]), []);
  assert.ok(compareAcceptance([prior], [{ ...spec, retiredReason: '' }]).length);
  assert.ok(compareAcceptance([prior], [{ ...spec, criteria: spec.criteria.slice(1) }]).length);
  assert.ok(compareAcceptance([prior], [{ ...spec, criteria: spec.criteria.map(c => ({ ...c, then: 'weakened' })) }]).length);
});

test('HTTP soak performance runs independently with preserved evidence [AC:composer-drop-retirement-soak-isolation#AC-6]', () => {
  const { jobs } = workflow();
  const job = jobs['soak-performance'];
  assert.ok(job, 'independent performance job is required');
  assert.equal(job.needs, undefined);
  assert.ok(job.steps.some(step => step.run === 'pnpm run test:bot:soak:performance --profile github-actions'));
  assert.ok(job.steps.some(step => step.if === 'always()' && step.with?.path === 'test-results/soak-performance/'));
  assert.ok(jobs.gate.needs.includes('soak-performance'));
});

test('missing or failed performance evidence blocks the release [AC:composer-drop-retirement-soak-isolation#AC-7]', () => {
  const green = Object.fromEntries(['tests','unit','formal','sdk','crap','browser','acceptance','mutation','secrets-gate'].map(name => [name, { result: 'success' }]));
  assert.ok(releaseFailures(green).includes('soak-performance'));
  for (const result of [undefined, 'failure', 'cancelled', 'skipped']) {
    assert.ok(releaseFailures({ ...green, 'soak-performance': { result } }).includes('soak-performance'));
  }
  assert.deepEqual(releaseFailures({ ...green, 'soak-performance': { result: 'success' } }), []);
});

test('performance measurement refuses instrumentation and missing/slow samples without claiming full soak acceptance [AC:composer-drop-retirement-soak-isolation#AC-6] [AC:composer-drop-retirement-soak-isolation#AC-7]', async () => {
  const { performanceResult, performanceEnv } = await import('../bot-release/soak-performance.mjs');
  const report = { fixturePassed: true, status: 'completed', fullProtocol: false, latency: Object.fromEntries(['page','status','search','receive'].map(key => [key, { count: 34, p95Ms: 100 }])) };
  assert.equal(performanceResult(report).passed, true);
  assert.equal(performanceResult(report).fullSoakAccepted, false);
  assert.equal(performanceResult({ ...report, latency: { ...report.latency, receive: { count: 34, p95Ms: 501 } } }).passed, false);
  const remote = { ...report, latency: { ...report.latency, receive: { count: 34, p95Ms: 1481 } } };
  assert.equal(performanceResult(remote).passed, false);
  assert.equal(performanceResult(remote, 'github-actions').passed, true);
  assert.equal(performanceResult(remote, 'github-actions').profile, 'github-actions');
  assert.equal(performanceResult(remote, 'github-actions').checks.find(check => check.name === 'receive').thresholdMs, 8000);
  for (const name of ['page', 'status', 'search', 'receive']) {
    const at = { ...report, latency: { ...report.latency, [name]: { count: 34, p95Ms: 8000 } } };
    assert.equal(performanceResult(at, 'github-actions').passed, true);
    assert.equal(performanceResult({ ...at, latency: { ...at.latency, [name]: { count: 34, p95Ms: 8001 } } }, 'github-actions').passed, false);
  }
  assert.throws(() => performanceResult(report, 'unknown'), /profile/);
  assert.equal(performanceResult({ ...report, latency: {} }).passed, false);
  assert.equal(performanceResult({ ...report, fixturePassed: false }).passed, false);
  assert.equal(performanceResult({ ...report, status: 'running' }).passed, false);
  assert.equal(performanceEnv({ PATH: '/bin', NODE_V8_COVERAGE: '/tmp/coverage', NODE_OPTIONS: '--inspect' }).NODE_V8_COVERAGE, undefined);
  assert.equal(performanceEnv({ NODE_OPTIONS: '--inspect' }).NODE_OPTIONS, undefined);
});

test('core verification lanes remain mandatory without failure bypasses [AC:composer-drop-retirement-soak-isolation#AC-8]', () => {
  const { jobs } = workflow();
  for (const name of ['tests','unit','formal','sdk','browser','acceptance','mutation']) {
    assert.ok(jobs.gate.needs.includes(name));
    assert.notEqual(jobs[name]['continue-on-error'], true);
    assert.ok(releaseFailures({ [name]: { result: 'failure' } }).includes(name));
  }
});
