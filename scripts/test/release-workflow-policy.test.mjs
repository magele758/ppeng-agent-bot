import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const needs = (job) => Array.isArray(job.needs) ? job.needs : [job.needs];

test('Playwright preserves other gate evidence and refuses flaky success', () => {
  const config = readFileSync(new URL('../../playwright.config.ts', import.meta.url), 'utf8');
  assert.match(config, /outputDir:\s*['"]test-results\/playwright['"]/);
  assert.match(config, /failOnFlakyTests:\s*true/);
});

test('npm and Docker publication require a successful release gate, including forced/dry runs', () => {
  const targets = [
    [workflow('publish-npm'), 'publish'],
    [workflow('docker-nightly'), 'push']
  ];
  for (const [doc, id] of targets) {
    const job = doc.jobs[id];
    assert.ok(needs(job).includes('release-gate'), `${id} must wait for the gate`);
    assert.match(job.if, /needs\.release-gate\.result == 'success'/);
    assert.doesNotMatch(job.if, /always\(|\|\||force|dry_run/);
    assert.notEqual(job['continue-on-error'], true);
    const gate = doc.jobs['release-gate'];
    assert.equal(gate.uses, './.github/workflows/release-gate.yml');
    assert.notEqual(gate['continue-on-error'], true);
    // Default checkout tests/publishes this workflow's SHA, not a moving branch.
    for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
      assert.equal(step.with?.ref, undefined);
    }
  }
  const docker = targets[1][0];
  assert.ok(needs(docker.jobs.push).includes('decide'));
  assert.ok(needs(docker.jobs.push).includes('build'));
  assert.match(docker.jobs.push.if, /needs\.decide\.outputs\.should_build == 'true'/);
  assert.match(docker.jobs.push.if, /needs\.build\.result == 'success'/);
  assert.match(docker.jobs.build.if, /github\.event_name == 'pull_request'/);
});

test('release gate retains deterministic test layers and does not tolerate failures', () => {
  const doc = workflow('release-gate');
  assert.deepEqual(needs(doc.jobs.gate).sort(), ['acceptance', 'compact-ab', 'crap', 'harness', 'mutation', 'remote-model-smoke', 'secrets-gate', 'tests']);
  assert.equal(doc.jobs.gate.if, 'always()');
  for (const job of Object.values(doc.jobs)) {
    assert.notEqual(job['continue-on-error'], true);
    for (const step of job.steps ?? []) assert.notEqual(step['continue-on-error'], true);
  }
  const runs = doc.jobs.tests.steps.map((step) => step.run).filter(Boolean);
  for (const script of ['build', 'test:formal', 'test:package', 'agent:eval:verify', 'test:regression', 'test:integration']) {
    assert.ok(runs.includes(`npm run ${script}`), `missing release layer: ${script}`);
  }
  // test:unit runs through the flaky-retry wrapper; e2e adds a JUnit reporter for the acceptance gate.
  assert.ok(runs.some((run) => run.startsWith('node scripts/ci/retry-failed-tests.mjs --script test:unit')), 'missing release layer: test:unit');
  assert.ok(runs.some((run) => run.startsWith('npm run test:e2e')), 'missing release layer: test:e2e');
  assert.ok(runs.some(run => run.startsWith('npm run agent:eval:fast -- --exit-on-fail')));
  const evidence = doc.jobs.tests.steps.find(
    (step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'release-test-evidence'
  );
  assert.equal(evidence?.if, 'always()');
  assert.match(evidence.with.path, /test-results\//);
  assert.match(evidence.with.path, /doc\/eval-results\//);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts.ci.includes('npm run agent:eval:fast -- --exit-on-fail'));
  assert.equal(readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim(), '22');
  for (const job of [doc.jobs.tests, doc.jobs.crap, doc.jobs.acceptance, workflow('publish-npm').jobs.publish]) {
    const node = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    assert.equal(node.with['node-version-file'], '.nvmrc');
  }
  const coverageRuns = doc.jobs.crap.steps.map((step) => step.run ?? '').join('\n');
  assert.match(coverageRuns, /vitest run/);
  assert.match(coverageRuns, /--coverage.enabled/);
  assert.match(coverageRuns, /crap-gate\.mjs/);
  assert.doesNotMatch(coverageRuns, /--update-baseline|\|\|\s*true/);
});

test('Docker images are loaded and smoke-tested as a pair before any push, with no rebuild on publication', () => {
  const jobs = workflow('docker-nightly').jobs;
  const steps = jobs.build.steps;
  const builds = steps.filter(step => step.uses?.startsWith('docker/build-push-action@'));
  assert.equal(builds.length, 2);
  for (const step of builds) { assert.equal(step.with.push, false); assert.equal(step.with.load, true); }
  const smoke = steps.findIndex(step => step.run?.includes('scripts/release/image-smoke.mjs'));
  assert.ok(smoke > steps.indexOf(builds[1]));
  assert.ok(!steps.some(step => step.run?.includes('docker push')));
  const push = jobs.push.steps.find(step => step.run?.includes('docker push'));
  assert.match(push.run, /image-smoke\.json/);
  assert.match(push.run, /test "\$image_id" = "\$loaded_id"/);
  assert.ok(!jobs.push.steps.some(step => step.uses?.startsWith('docker/build-push-action@')));
  assert.doesNotMatch(push.run, /docker build/);
  assert.ok(steps.some(step => step.if === 'always()' && step.uses?.startsWith('actions/upload-artifact@') && step.with.name === 'image-smoke-evidence'));
  assert.ok(steps.findIndex(step => step.run?.includes('docker save')) > smoke);
  assert.ok(jobs.push.steps.some(step => step.with?.name === 'nightly-images'));
  assert.ok(jobs.push.steps.some(step => step.with?.name === 'image-smoke-evidence'));
});

test('empirical quality workflow uses a frozen baseline and preserves evidence without tolerating failures', () => {
  const doc = workflow('harness-quality');
  assert.equal(doc.on.workflow_dispatch.inputs.baseline_ref.required, true);
  assert.equal(doc.on.pull_request_target, undefined);
  const steps = doc.jobs.compare.steps;
  assert.ok(steps.some(step => step.with?.ref === '${{ inputs.baseline_ref }}'));
  assert.ok(steps.some(step => step.run?.includes('agent:eval:compare')));
  for (const step of steps) assert.notEqual(step['continue-on-error'], true);
  assert.ok(steps.some(step => step.if === 'always()' && step.uses?.startsWith('actions/upload-artifact@')));
});

test('actual gate summary script accepts only success/success/success; failure, cancelled, skipped, unknown fail closed', {
  skip: process.platform === 'win32' ? 'Release gate shell runs on Ubuntu; bash contract tested on Unix' : false
}, () => {
  const step = workflow('release-gate').jobs.gate.steps.find((s) => s.env?.RESULTS);
  assert.ok(step?.run);
  assert.equal(step.env.RESULTS, '${{ toJSON(needs) }}');
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-contract-'));
  const states = ['success', 'failure', 'cancelled', 'skipped', ''];
  try {
    for (const tests of states) {
      for (const crap of states) {
        for (const acceptance of states) {
          const child = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
            env: sanitizeScriptEnv({
              ...process.env, RESULTS: JSON.stringify({ tests: {result: tests}, crap: {result: crap}, acceptance: {result: acceptance}, mutation: {result: 'success'}, 'secrets-gate': {result: 'success'}, harness: {result: 'failure'} }), GITHUB_STEP_SUMMARY: join(dir, 'summary.md')
            }),
            encoding: 'utf8', timeout: 5_000
          });
          assert.equal(child.error, undefined);
          assert.match(child.stdout, /Harness \(non-blocking\): failure/);
          assert.equal(child.status, tests === 'success' && crap === 'success' && acceptance === 'success' ? 0 : 1,
            `tests=${tests} crap=${crap} acceptance=${acceptance}: ${child.stderr}`);
        }
      }
    }
    assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /Harness \(non-blocking\): failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
