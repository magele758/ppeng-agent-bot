import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanTools, loadPlanState, savePlanState, commitVersionedPlan } from '../dist/tools/plan-tools.js';

function context(dir, metadata) {
  return { stateDir: dir, session: { id: 's1', metadata } };
}

function tools() {
  return Object.fromEntries(createPlanTools().map((tool) => [tool.name, tool]));
}

test('handoff plan tools require a version and do not rerun a side effect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-tools-'));
  const plan = tools();
  const on = context(dir, { capabilityTiers: { enabled: true } });
  try {
    const missing = await plan.submit_plan.execute(on, { analysis: 'a', steps: ['one', 'two'] });
    assert.equal(missing.ok, false);
    assert.equal(await loadPlanState(dir, 's1'), null);

    const submitted = await plan.submit_plan.execute(on, {
      analysis: 'ship',
      steps: ['one', 'two'],
      expected_old_version: 0,
    });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.metadata.handoffPlanAccepted, true);
    assert.equal(submitted.metadata.planVersion, 1);

    const stale = await plan.submit_plan.execute(on, {
      analysis: 'lost',
      steps: ['x', 'y'],
      expected_old_version: 0,
    });
    assert.equal(stale.ok, false);
    assert.equal((await loadPlanState(dir, 's1')).analysis, 'ship');

    const confirmed = await plan.request_confirmation.execute(on, { expected_old_version: 1 });
    assert.equal(confirmed.ok, true);
    const started = await plan.start_step.execute(on, {
      step_index: 1,
      expected_old_version: 2,
      dedupe_id: 'job',
      attempt_id: 'a1',
      side_effect: true,
    });
    assert.equal(started.ok, true);
    assert.equal((await loadPlanState(dir, 's1')).version, 3);

    const duplicate = await plan.start_step.execute(on, {
      step_index: 1,
      expected_old_version: 2,
      dedupe_id: 'job',
      attempt_id: 'a1',
      side_effect: true,
    });
    assert.equal(duplicate.ok, true);
    assert.match(duplicate.content, /already applied/);
    assert.equal((await loadPlanState(dir, 's1')).version, 3);

    const failed = await plan.fail_step.execute(on, {
      step_index: 1,
      error: 'boom',
      expected_old_version: 3,
    });
    assert.equal(failed.ok, true);
    const skipped = await plan.start_step.execute(on, {
      step_index: 1,
      expected_old_version: 4,
      dedupe_id: 'job',
      attempt_id: 'a2',
    });
    assert.equal(skipped.ok, true);
    assert.match(skipped.content, /side effect already applied/);
    assert.equal((await loadPlanState(dir, 's1')).steps[0].status, 'failed');

    const retried = await plan.start_step.execute(on, {
      step_index: 1,
      expected_old_version: 4,
      dedupe_id: 'job',
      attempt_id: 'a3',
      resume_policy: 'retry_idempotent',
    });
    assert.equal(retried.ok, true);
    assert.equal((await loadPlanState(dir, 's1')).steps[0].status, 'in_progress');

    await assert.rejects(
      () => savePlanState(dir, 's1', { analysis: 'wipe', confirmed: false, steps: [] }),
      /versioned plan/
    );
    assert.equal((await loadPlanState(dir, 's1')).analysis, 'ship');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff off still writes an unversioned plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-tools-off-'));
  const plan = tools();
  try {
    const saved = await plan.submit_plan.execute(context(dir, {}), {
      analysis: 'legacy',
      steps: ['one', 'two'],
    });
    assert.equal(saved.ok, true);
    const loaded = await loadPlanState(dir, 's1');
    assert.equal(loaded.version, undefined);
    assert.equal(loaded.analysis, 'legacy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping versioned commits let only one writer win', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-tools-race-'));
  try {
    await savePlanState(dir, 's1', { analysis: 'base', confirmed: false, steps: [{ title: 'a', status: 'pending' }] });
    const next = { analysis: 'next', confirmed: true, steps: [{ title: 'b', status: 'pending' }] };
    const [left, right] = await Promise.all([
      commitVersionedPlan(dir, 's1', { ...next, analysis: 'left' }, { expectedOldVersion: 0, newVersion: 1 }),
      commitVersionedPlan(dir, 's1', { ...next, analysis: 'right' }, { expectedOldVersion: 0, newVersion: 1 }),
    ]);
    const wins = [left, right].filter((item) => item.ok);
    assert.equal(wins.length, 1);
    const loaded = await loadPlanState(dir, 's1');
    assert.equal(loaded.version, 1);
    assert.ok(loaded.analysis === 'left' || loaded.analysis === 'right');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
