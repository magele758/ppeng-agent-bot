import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { directoryHasFile, missingRequiredArtifacts } from '../ci/require-nonempty-artifacts.mjs';

const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const script = fileURLToPath(new URL('../ci/require-nonempty-artifacts.mjs', import.meta.url));
const REQUIRED = {
  unit: ['${{ runner.temp }}/validation/unit', '${{ runner.temp }}/validation/unit/results'],
  sdk: ['${{ runner.temp }}/validation/sdk', '${{ runner.temp }}/validation/sdk/results'],
  formal: [
    '${{ runner.temp }}/validation/formal',
    '${{ runner.temp }}/validation/formal/results',
    'coverage/formal/pairing/',
    'coverage/formal/lifecycle/',
    'coverage/formal/restart/',
    'coverage/formal/concurrency/',
  ],
};

function norm(path) {
  return String(path).trim().replace(/\\/g, '/').replace(/\/+$/, '')
    .replaceAll('${{ runner.temp }}', '$RUNNER_TEMP')
    .replaceAll('${{runner.temp}}', '$RUNNER_TEMP');
}

function condition(step) {
  const raw = String(step.if ?? 'success()').trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
  if (raw === 'always()') return 'always';
  if (raw === 'success()') return 'success';
  if (raw === 'failure()') return 'failure';
  return 'other';
}

function runs(step, priorFailed) {
  const kind = condition(step);
  if (kind === 'always') return true;
  if (kind === 'success') return !priorFailed;
  if (kind === 'failure') return priorFailed;
  return false;
}

function isUpload(step) {
  return String(step.uses ?? '').startsWith('actions/upload-artifact');
}

function uploadPaths(step) {
  return String(step.with?.path ?? '').split('\n').map(part => norm(part)).filter(Boolean);
}

function checkerPaths(step) {
  const run = String(step.run ?? '');
  if (!run.includes('require-nonempty-artifacts.mjs')) return null;
  const tokens = run.split(/\s+/).flatMap(token => {
    const cleaned = token.replace(/\\$/, '').replace(/^['"]|['"]$/g, '');
    return cleaned && cleaned !== '\\' ? [norm(cleaned)] : [];
  });
  const start = tokens.findIndex(token => token.includes('require-nonempty-artifacts.mjs'));
  return tokens.slice(start + 1);
}

function laneSignalFailures(steps, { reviewDrift, hasFile }) {
  const failed = [];
  let priorFailed = false;
  for (const step of steps) {
    if (!runs(step, priorFailed)) continue;
    const name = step.name ?? step.uses ?? 'step';
    const run = String(step.run ?? '');
    if (reviewDrift && run.includes('reviewed-verification-inputs.mjs')) {
      if (step['continue-on-error'] === true) continue;
      failed.push({ name, reason: 'review-drift' });
      priorFailed = true;
      continue;
    }
    if (isUpload(step) && (step.with?.['if-no-files-found'] ?? 'warn') === 'error') {
      const missing = uploadPaths(step).filter(path => !hasFile(path));
      if (missing.length) {
        failed.push({ name, reason: 'missing-artifact', missing });
        priorFailed = true;
        continue;
      }
    }
    const paths = checkerPaths(step);
    if (!paths) continue;
    const missing = missingRequiredArtifacts(paths, hasFile);
    if (!missing.length || step['continue-on-error'] === true) continue;
    failed.push({ name, reason: 'missing-artifact', missing });
    priorFailed = true;
  }
  return failed;
}

function preflightLanes() {
  return ['release-gate', 'formal-only'].flatMap(name => Object.values(workflow(name).jobs))
    .map(job => job.steps)
    .filter(steps => steps?.some(step => String(step.run ?? '').includes('reviewed-verification-inputs.mjs')));
}

function laneById(id) {
  const required = REQUIRED[id].map(norm);
  const matches = preflightLanes().filter(steps => {
    const paths = new Set(steps.filter(isUpload).flatMap(uploadPaths));
    return required.every(path => paths.has(path));
  });
  assert.equal(matches.length, 1, id);
  return matches[0];
}

test('review drift fails the lane once, without a missing-directory failure [AC:ci-review-drift-signal#AC-1]', () => {
  assert.equal(preflightLanes().length, 3);
  for (const id of ['unit', 'sdk', 'formal']) {
    const failed = laneSignalFailures(laneById(id), { reviewDrift: true, hasFile: () => false });
    assert.deepEqual(failed.map(item => item.reason), ['review-drift'], id);
  }
});

test('a successful lane that writes none of its required results still fails [AC:ci-review-drift-signal#AC-2]', () => {
  for (const id of ['unit', 'sdk', 'formal']) {
    const steps = laneById(id);
    const driftNames = new Set(laneSignalFailures(steps, { reviewDrift: true, hasFile: () => false }).map(item => item.name));
    for (const required of REQUIRED[id]) {
      const failed = laneSignalFailures(steps, {
        reviewDrift: false,
        hasFile: path => path !== norm(required),
      });
      const quiet = failed.filter(item => item.reason === 'missing-artifact' && !driftNames.has(item.name));
      assert.ok(quiet.length > 0, `${id} missing ${required}`);
    }
    assert.deepEqual(laneSignalFailures(steps, { reviewDrift: false, hasFile: () => true }), [], id);
  }
  const formal = laneById('formal');
  const reusePath = norm('${{ runner.temp }}/verification-evidence/');
  assert.ok(formal.some(step => isUpload(step) && uploadPaths(step).includes(reusePath)));
  assert.deepEqual(laneSignalFailures(formal, {
    reviewDrift: false,
    hasFile: path => path !== reusePath,
  }), []);

  const root = mkdtempSync(join(tmpdir(), 'lane-artifacts-'));
  try {
    const empty = join(root, 'empty');
    const full = join(root, 'full');
    const blank = join(root, 'blank.txt');
    mkdirSync(empty);
    mkdirSync(join(full, 'nested'), { recursive: true });
    writeFileSync(join(full, 'nested', 'result.xml'), '<testsuite></testsuite>');
    writeFileSync(blank, '');
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const partial = run([empty, full]);
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /empty/);
    assert.doesNotMatch(partial.stderr, /\/full$/m);
    assert.equal(run([full]).status, 0);
    assert.equal(run([blank]).status, 0);
    assert.equal(run([join(root, 'missing')]).status, 1);
    assert.equal(run([]).status, 1);
    assert.equal(directoryHasFile(full), true);
    assert.equal(directoryHasFile(empty), false);
    assert.equal(directoryHasFile(blank), true);
    assert.deepEqual(missingRequiredArtifacts([full, empty], directoryHasFile), [empty]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
