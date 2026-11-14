/**
 * Knife 3 #516: real Swarm completion and resume paths.
 * Kernel states are not delivery success. gate.ts is not the thing under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { SwarmStore, createSwarmId, nowIso } from '../dist/swarm/store.js';
import { SqliteStateStore } from '../dist/storage.js';
import { qualityPassed } from '../dist/quality/gate.js';
import {
  evaluateSwarmDelivery,
  kernelStateIsDeliverySuccess,
  trustedContextForSwarmRun,
} from '../dist/trajectory-handoff/swarm-entry.js';

const NON_SUCCESS = ['answered', 'capped', 'failed', 'cancelled', 'timed_out', 'awaiting_coordinator'];

function passedReport(extra = {}) {
  return {
    passed: true,
    summary: 'verified',
    checks: [{ criterion: 'correct output', passed: true, evidence: ['read-1'] }],
    ...extra,
  };
}

function boundEvidence(overrides = {}) {
  return {
    planVersion: 3,
    verifiedPlanVersion: 3,
    taskScope: 'task-1',
    verifiedTaskScope: 'task-1',
    available: true,
    ...overrides,
  };
}

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'k3-gate-'));
  const sqlite = new SqliteStateStore(join(dir, 'state.db'));
  return { store: new SwarmStore(sqlite.db), close: () => sqlite.db.close() };
}

async function completeSwarmTask({ handoffState, report, omitReview = false, entry = true }) {
  const { store, close } = openStore();
  const sessions = [];
  let reviews = 0;
  const executor = new SwarmExecutor({
    store,
    listSessions: () => sessions,
    getSession: (id) => sessions.find((session) => session.id === id),
    createTeammateSession: ({ metadata }) => {
      const rec = {
        id: `sess_${sessions.length + 1}`,
        status: 'completed',
        mode: 'teammate',
        metadata: {
          ...(metadata ?? {}),
          ...(handoffState ? { handoffState } : {}),
        },
      };
      sessions.push(rec);
      return rec;
    },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => true,
    trustedHandoff: entry ? ((run) => trustedContextForSwarmRun(run, true, false)) : undefined,
    swarmHandoffEntryEnabled: entry,
    ...(omitReview ? {} : {
      reviewTask: async () => {
        reviews += 1;
        return report;
      },
    }),
  });
  const runId = createSwarmId('srun');
  const now = nowIso();
  store.createRun({
    id: runId,
    goal: 'ship the change',
    status: 'pending',
    strategy: 'pipeline',
    budget: { maxTeammates: 2, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
    qualityGate: ['correct output'],
    createdAt: now,
    updatedAt: now,
  });
  executor.startRun(runId, [{ title: 'Implement', requiredRole: 'implementer' }]);
  await executor.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await executor.tick();
  await executor.tick();
  const task = store.listTasks(runId)[0];
  const run = store.getRun(runId);
  close();
  return { task, run, reviews, sessions };
}

test('kernel states including done are not delivery success by themselves', () => {
  for (const state of [...NON_SUCCESS, 'done', 'executor_write', 'planner_readonly']) {
    assert.equal(kernelStateIsDeliverySuccess(state), false);
  }
  assert.equal(evaluateSwarmDelivery({
    report: passedReport(),
    kernelState: 'done',
    evidence: null,
    gateInvoked: true,
  }).reason, 'missing_evidence');
  assert.equal(evaluateSwarmDelivery({
    report: passedReport(),
    kernelState: 'done',
    evidence: boundEvidence(),
    gateInvoked: false,
  }).reason, 'gate_not_invoked');
});

test('D1 missing, unavailable, and stale evidence fail the real swarm completion', async () => {
  const missing = await completeSwarmTask({ handoffState: 'done', report: passedReport() });
  assert.equal(missing.task.status, 'failed');
  assert.equal(missing.reviews, 1);
  assert.notEqual(missing.run.status, 'completed');

  const unavailable = await completeSwarmTask({
    handoffState: 'done',
    report: passedReport({ handoffEvidence: boundEvidence({ available: false }) }),
  });
  assert.equal(unavailable.task.status, 'failed');

  const stale = await completeSwarmTask({
    handoffState: 'executor_write',
    report: passedReport({ handoffEvidence: boundEvidence({ verifiedPlanVersion: 2 }) }),
  });
  assert.equal(stale.task.status, 'failed');
  assert.equal(qualityPassed(passedReport()), true);
});

test('D2 resume then complete still runs the quality gate and can pass with bound evidence', async () => {
  const result = await completeSwarmTask({
    handoffState: 'done',
    report: passedReport({ handoffEvidence: boundEvidence() }),
  });
  assert.equal(result.reviews, 1);
  assert.equal(result.task.status, 'done');
  assert.equal(result.run.status, 'completed');
  assert.equal(kernelStateIsDeliverySuccess('done'), false);
});

test('D3 non-success kernel states never become delivery success on the swarm path', async () => {
  for (const state of NON_SUCCESS) {
    const result = await completeSwarmTask({
      handoffState: state,
      report: passedReport({ handoffEvidence: boundEvidence() }),
    });
    assert.equal(result.task.status, 'failed', state);
    assert.equal(result.reviews, 1, state);
    assert.notEqual(result.run.status, 'completed', state);
  }
  const bareDone = await completeSwarmTask({ handoffState: 'done', report: passedReport() });
  assert.equal(bareDone.task.status, 'failed');
});

test('D4 a missing reviewer fails the in-progress task', async () => {
  const missing = await completeSwarmTask({
    handoffState: 'executor_write',
    omitReview: true,
  });
  assert.equal(missing.reviews, 0);
  assert.equal(missing.task.status, 'failed');
  assert.notEqual(missing.run.status, 'completed');
});

test('D6 evidence must match the verified plan version and task scope', async () => {
  const wrongScope = await completeSwarmTask({
    handoffState: 'done',
    report: passedReport({ handoffEvidence: boundEvidence({ verifiedTaskScope: 'task-old' }) }),
  });
  assert.equal(wrongScope.task.status, 'failed');
  const blankScope = await completeSwarmTask({
    handoffState: 'done',
    report: passedReport({ handoffEvidence: boundEvidence({ taskScope: '   ', verifiedTaskScope: '   ' }) }),
  });
  assert.equal(blankScope.task.status, 'failed');
  const fresh = await completeSwarmTask({
    handoffState: 'executor_write',
    report: passedReport({ handoffEvidence: boundEvidence({ planVersion: 8, verifiedPlanVersion: 8, taskScope: 'recover-1', verifiedTaskScope: 'recover-1' }) }),
  });
  assert.equal(fresh.task.status, 'done');
});

test('an active handoff without a delivery claim still uses the quality gate', async () => {
  const active = await completeSwarmTask({ handoffState: 'planner_readonly', report: passedReport() });
  assert.equal(active.task.status, 'done');
  assert.equal(active.reviews, 1);
  const closed = await completeSwarmTask({ handoffState: null, report: passedReport(), entry: false });
  assert.equal(closed.task.status, 'done');
  assert.equal(closed.sessions[0].metadata.handoffState, undefined);
});

test('a failing quality report does not pass just because evidence is fresh', async () => {
  const report = passedReport({
    handoffEvidence: boundEvidence(),
    passed: false,
    checks: [{ criterion: 'correct output', passed: false, evidence: ['read-1'] }],
  });
  const result = await completeSwarmTask({ handoffState: 'done', report });
  assert.equal(result.task.status, 'failed');
  assert.equal(qualityPassed(report), false);
});
