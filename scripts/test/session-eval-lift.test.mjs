import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretSessionLift } from '../agent-eval/lift.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function report(verdict, kind = 'live') {
  return { verdict, evaluationKind: kind };
}

test('a clean regression set is not a capability gain [AC:session-eval-lift#AC-3]', () => {
  assert.equal(interpretSessionLift(report('non_inferior'), report('non_inferior')).verdict, 'held');
  assert.equal(interpretSessionLift(report('improved'), report('non_inferior')).verdict, 'held');
  assert.equal(interpretSessionLift(report('non_inferior'), report('improved')).verdict, 'lift');
  assert.equal(interpretSessionLift(report('regressed'), report('improved')).verdict, 'decline');
  assert.equal(interpretSessionLift(report('non_inferior'), report('regressed')).verdict, 'decline');
  assert.equal(interpretSessionLift(report('inconclusive'), report('improved')).verdict, 'inconclusive');
  assert.equal(interpretSessionLift(report('non_inferior', 'simulation'), report('improved')).verdict, 'invalid');
});

test('lift command reads the two reports [AC:session-eval-lift#AC-3]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-eval-lift-'));
  try {
    const regression = join(dir, 'regression.json');
    const capability = join(dir, 'capability.json');
    const run = () => spawnSync(process.execPath, [
      'scripts/agent-eval/lift.mjs', '--regression', regression, '--capability', capability,
    ], { cwd: root, encoding: 'utf8' });
    writeFileSync(regression, JSON.stringify(report('non_inferior')));
    writeFileSync(capability, JSON.stringify(report('improved')));
    const lift = run();
    assert.equal(lift.status, 0, lift.stderr + lift.stdout);
    assert.match(lift.stdout, /verdict=lift/);
    writeFileSync(regression, JSON.stringify(report('inconclusive')));
    const inconclusive = run();
    assert.equal(inconclusive.status, 2, inconclusive.stderr + inconclusive.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const name of ['session-regression.json', 'session-capability.json']) {
    const experiment = JSON.parse(readFileSync(join(root, 'scripts/agent-eval/experiments', name), 'utf8'));
    assert.equal(experiment.baseline.daemonControl.tool_exposure_settings.mode, 'full');
    assert.equal(experiment.candidate.daemonControl.tool_exposure_settings.mode, 'full');
    assert.equal(experiment.policy.minCases, 30);
  }
});
