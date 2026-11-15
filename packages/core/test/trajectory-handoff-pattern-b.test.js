/**
 * Pattern B on independent Swarm only.
 * Default off. Knife-3 and knife-4 switches do not open it.
 * #516 still decides shared delivery. gate.ts is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { SwarmStore, createSwarmId, nowIso } from '../dist/swarm/store.js';
import { SqliteStateStore } from '../dist/storage.js';
import { applySessionEnablement } from '../dist/trajectory-handoff/persist.js';
import {
  admitSwarmHandoff,
  evaluateSwarmDelivery,
  kernelStateIsDeliverySuccess,
  trustedContextForSwarmRun,
} from '../dist/trajectory-handoff/swarm-entry.js';
import {
  admitPatternBIsolation,
  patternBInFlightDisposition,
  patternBNewAdmissionAllowed,
  patternBPersistedIsolation,
  readPatternBIsolationRecords,
  readPatternBIsolationSwitch,
  rememberPatternBIsolation,
  rollbackPatternBIsolation,
} from '../dist/trajectory-handoff/pattern-b-entry.js';
import {
  patternBArtifactVersion,
  patternBResumeDecision,
  patternBRollbackArtifacts,
  patternBSharedDelivery,
  runHostIntegration,
} from '../dist/trajectory-handoff/pattern-b-integrate.js';
import { resolvePatternBDispatch } from '../dist/trajectory-handoff/pattern-b-swarm.js';
import {
  DEFAULT_SESSION_CAP,
  DEFAULT_TURN_CAP,
  InMemoryParentBudgetLedger,
  assessSingleWorkerRecovery,
} from '@ppeng/agent-loop';
import {
  PATTERN_B_PRODUCTION_ENTRY,
  canonicalPath,
  clearHostBoundaries,
  createMemoryIntegrationStore,
  createMemoryLifecycleStore,
  denyPatternBTool,
  readHostBoundary,
} from '@ppeng/agent-loop/pattern-b';

const NOW = '2026-11-15T00:00:00.000Z';
const DEADLINE = '2026-11-15T02:00:00.000Z';
const LATE = '2026-11-15T03:00:00.000Z';

function passedReport(extra = {}) {
  return {
    passed: true,
    summary: 'verified',
    checks: [{ criterion: 'correct output', passed: true, evidence: ['read-1'] }],
    ...extra,
  };
}

function boundaryFor(run, task, role = 'implementer') {
  const planner = role !== 'implementer';
  return {
    hostEnforced: true,
    canonicalize: canonicalPath,
    boundaries: [{
      identity: { runId: run.id, workerId: task.id, taskScope: 'scope', planId: 'plan', planVersion: '3' },
      writableRoot: '/work/w1',
      role: planner ? 'planner' : 'executor',
      effectiveWrite: !planner,
    }],
    readOnlyMounts: [{ path: '/work/ro', kind: 'input' }],
    sharedTargets: [{ targetId: 'shared', path: '/shared', expectedVersion: 'v1' }],
  };
}

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pattern-b-'));
  const sqlite = new SqliteStateStore(join(dir, 'state.db'));
  return { store: new SwarmStore(sqlite.db), close: () => sqlite.db.close() };
}

function integrationHarness() {
  const calls = [];
  const store = createMemoryIntegrationStore({
    apply(record) { calls.push(record.integrationId); },
  }, { targets: { shared: 'v1' } });
  return { calls, store };
}

function auth(overrides = {}) {
  return {
    actor: { kind: 'host' },
    integrationId: 'int-1',
    runId: 'run',
    workerId: 'w1',
    planVersion: '3',
    taskScope: 'scope',
    artifactVersion: patternBArtifactVersion('artifact'),
    targetId: 'shared',
    expectedTargetVersion: 'v1',
    resultTargetVersion: 'v2',
    deadlineAt: DEADLINE,
    now: NOW,
    ...overrides,
  };
}

function seal(record) {
  return {
    planVersion: 3,
    verifiedPlanVersion: 3,
    taskScope: record.taskScope,
    verifiedTaskScope: record.taskScope,
    available: true,
    artifactVersion: record.artifactVersion,
    verifiedTargetVersion: record.resultTargetVersion,
    integrationId: record.integrationId,
    sealedAfterIntegration: true,
  };
}

test('production entry stays closed and the isolation switch defaults off', () => {
  assert.equal(PATTERN_B_PRODUCTION_ENTRY, 'closed');
  assert.deepEqual(readPatternBIsolationSwitch(undefined), { enabled: false, explicitOff: false });
  assert.equal(patternBNewAdmissionAllowed(undefined), false);
  assert.deepEqual(readPatternBIsolationSwitch(true), { enabled: true, explicitOff: false });
  assert.deepEqual(readPatternBIsolationSwitch({ enabled: true, explicitOff: true }), { enabled: false, explicitOff: true });
  assert.deepEqual(readPatternBIsolationSwitch({}), { enabled: false, explicitOff: true });
  assert.deepEqual(readPatternBIsolationSwitch([]), { enabled: false, explicitOff: true });
  assert.equal(admitPatternBIsolation({
    trusted: { source: 'independent_swarm', patternBEnabled: true, isolationTask: true, patternBHostEnforced: true, patternBCanonicalizer: true, entryEnabled: true, flywheelEntryEnabled: true },
    workerMetadata: { patternBEnabled: true, skipGate: true },
  }).open, true);
});

test('knife-3 and knife-4 switches do not open Pattern B, and flywheel stays out', () => {
  const independent = trustedContextForSwarmRun({ orchestrationRunId: undefined }, true, false, { enabled: true });
  assert.equal(admitSwarmHandoff({ trusted: independent, workerMetadata: { patternBEnabled: true } }).open, true);
  assert.equal(admitPatternBIsolation({ trusted: independent, workerMetadata: { isolationEnabled: true } }).reason, 'self_reported');
  const flywheel = trustedContextForSwarmRun({ orchestrationRunId: 'orch-1' }, true, false, { enabled: true });
  assert.equal(admitSwarmHandoff({ trusted: flywheel, workerMetadata: null }).source, 'flywheel');
  assert.equal(admitPatternBIsolation({
    trusted: { ...flywheel, patternBEnabled: true, isolationTask: true, patternBHostEnforced: true, patternBCanonicalizer: true },
    workerMetadata: null,
  }).reason, 'flywheel_orchestration');
  assert.equal(admitPatternBIsolation({ trusted: null, workerMetadata: { workerClaimsIsolation: true } }).reason, 'self_reported');
  assert.equal(admitPatternBIsolation({ trusted: null, workerMetadata: null }).reason, 'no_trusted_context');
  assert.equal(admitPatternBIsolation({
    trusted: { source: 'independent_swarm', patternBEnabled: true, isolationTask: false, patternBHostEnforced: true, patternBCanonicalizer: true },
    workerMetadata: null,
  }).reason, 'not_isolation_task');
  assert.equal(admitPatternBIsolation({
    trusted: { source: 'independent_swarm', patternBEnabled: true, isolationTask: true, patternBHostEnforced: false, patternBCanonicalizer: false },
    workerMetadata: null,
  }).reason, 'not_enforced');
});

test('rollback stops new admission and retains persisted isolation records', () => {
  const remembered = rememberPatternBIsolation(null, { runId: 'run-1', workerId: 'w1', persistedAt: NOW });
  assert.equal(remembered.ok, true);
  const rolled = rollbackPatternBIsolation('stop_new_admission');
  assert.equal(patternBNewAdmissionAllowed(rolled), false);
  assert.equal(patternBPersistedIsolation(remembered.records, 'run-1')?.unintegratedRetained, true);
  assert.equal(readPatternBIsolationRecords(remembered.records).ok, true);
  assert.equal(rememberPatternBIsolation({ bad: true }, { runId: 'run-1', persistedAt: NOW }).ok, false);
  assert.deepEqual(patternBRollbackArtifacts({ lifecycles: createMemoryLifecycleStore(), now: NOW }), {
    retained: [],
    deleted: [],
    copiedToShared: false,
  });
  const lifecycles = createMemoryLifecycleStore();
  const created = lifecycles.create({
    actor: { kind: 'host' }, runId: 'run-1', workerId: 'w1', taskScope: 'scope', writableRoot: '/work/w1', now: NOW,
  });
  assert.equal(created.ok, true);
  const retained = patternBRollbackArtifacts({ lifecycles, now: NOW });
  assert.equal(retained.copiedToShared, false);
  assert.deepEqual(retained.deleted, []);
  assert.equal(lifecycles.get(created.record.lifecycleId)?.phase, 'retained');
  assert.equal(patternBInFlightDisposition({
    storedSwitch: rolled, records: remembered.records, runId: 'run-1', now: NOW, authorization: null,
  }), 'needs_authorization');
  assert.equal(patternBInFlightDisposition({
    storedSwitch: rolled,
    records: remembered.records,
    runId: 'run-1',
    now: LATE,
    authorization: { runId: 'run-1', explicit: true, deadlineAt: DEADLINE },
  }), 'expired');
  assert.equal(patternBInFlightDisposition({
    storedSwitch: rollbackPatternBIsolation('cancel_in_flight'),
    records: remembered.records,
    runId: 'run-1',
    now: NOW,
  }), 'cancel');
});

test('host integration is idempotent, crash and expiry do not replay, and old evidence fails', () => {
  const fresh = integrationHarness();
  const input = auth();
  const committed = runHostIntegration(fresh.store, input);
  assert.equal(committed.ok, true);
  assert.deepEqual(fresh.calls, ['int-1']);
  assert.equal(runHostIntegration(fresh.store, input).ok, true);
  assert.deepEqual(fresh.calls, ['int-1']);
  const evidence = seal(committed.record);
  assert.equal(patternBSharedDelivery({
    report: passedReport(), kernelState: 'completed', evidence, gateInvoked: true, integration: committed.record,
  }).success, true);
  assert.equal(patternBSharedDelivery({
    report: passedReport(), kernelState: 'done', evidence: null, gateInvoked: true, integration: committed.record,
  }).reason, 'stale_evidence');
  assert.equal(patternBSharedDelivery({
    report: passedReport(), kernelState: 'done', evidence: { ...evidence, sealedAfterIntegration: false }, gateInvoked: true, integration: committed.record,
  }).reason, 'stale_evidence');
  assert.equal(patternBSharedDelivery({
    report: passedReport(), kernelState: 'done', evidence: { ...evidence, artifactVersion: 'spliced' }, gateInvoked: true, integration: committed.record,
  }).reason, 'stale_evidence');
  assert.equal(patternBSharedDelivery({
    report: passedReport(), kernelState: 'failed', evidence, gateInvoked: true, integration: committed.record,
  }).reason, 'kernel_not_delivery');
  assert.equal(evaluateSwarmDelivery({
    report: passedReport(), kernelState: 'done', evidence: null, gateInvoked: true,
  }).reason, 'missing_evidence');
  assert.equal(kernelStateIsDeliverySuccess('done'), false);

  const crashed = integrationHarness();
  const failed = runHostIntegration(crashed.store, input, { crash: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.record?.status, 'unknown');
  assert.equal(runHostIntegration(crashed.store, input).ok, false);
  assert.deepEqual(crashed.calls, ['int-1']);
  assert.equal(crashed.store.targetVersion('shared'), 'v1');

  const expired = integrationHarness();
  const late = runHostIntegration(expired.store, input, { commitAt: LATE });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
  assert.equal(expired.store.targetVersion('shared'), 'v1');
  assert.equal(patternBResumeDecision({
    previous: 'unknown', resumePolicy: 'no_blind_rerun', previousStepId: 'step-1', planSteps: ['step-1'], planChanged: false,
  }), 'blocked');
  assert.equal(patternBResumeDecision({
    previous: 'failed', resumePolicy: 'no_blind_rerun', previousStepId: 'step-1', planSteps: ['step-2'], planChanged: true,
  }), 'drop_step');
  assert.equal(patternBResumeDecision({
    previous: 'accepted', resumePolicy: 'explicit', previousStepId: 'step-1', planSteps: ['step-1'], planChanged: false,
  }), 'already_done');
});

test('isolation does not bypass parent budget caps or single-worker recovery', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 4);
  const refused = await ledger.debitAndGrant({
    parentRunId: 'parent-1',
    workerId: 'w1',
    hangAttemptId: 'hang-1',
    refillId: 'refill-1',
    requestedUnits: 1,
    waitDeadline: DEADLINE,
    now: NOW,
    timeoutTxnCommitted: false,
    stillAwaitingCoordinator: true,
    sessionHandoffs: DEFAULT_SESSION_CAP,
    turnHandoffs: 0,
    sessionCap: DEFAULT_SESSION_CAP,
    turnCap: DEFAULT_TURN_CAP,
    workerOriginalLocalCap: 2,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'session_cap');
  const turn = await ledger.debitAndGrant({
    parentRunId: 'parent-1',
    workerId: 'w1',
    hangAttemptId: 'hang-2',
    refillId: 'refill-2',
    requestedUnits: 1,
    waitDeadline: DEADLINE,
    now: NOW,
    timeoutTxnCommitted: false,
    stillAwaitingCoordinator: true,
    sessionHandoffs: 0,
    turnHandoffs: DEFAULT_TURN_CAP,
    sessionCap: DEFAULT_SESSION_CAP,
    turnCap: DEFAULT_TURN_CAP,
    workerOriginalLocalCap: 2,
  });
  assert.equal(turn.reason, 'turn_cap');
  const recovery = assessSingleWorkerRecovery({
    workerId: 'w1',
    peers: [{ workerId: 'w2', staleIfRestored: true }],
  });
  assert.equal(recovery.recover, 'affected_set');
  assert.deepEqual(recovery.workerIds, ['w1', 'w2']);
  const remembered = rememberPatternBIsolation(null, { runId: 'run-1', persistedAt: NOW });
  assert.equal(Object.hasOwn(remembered.records[0], 'budget'), false);
});

test('ordinary session auto policy is unchanged by a Pattern B claim', () => {
  const ordinary = { handoffEnablement: { source: 'auto_policy' }, capabilityTiers: { enablementSource: 'auto_policy', enabled: false } };
  const claimed = { ...ordinary, patternBEnabled: true, isolationEnabled: true };
  assert.deepEqual(applySessionEnablement(ordinary)?.capabilityTiers, applySessionEnablement(claimed)?.capabilityTiers);
  const stamped = applySessionEnablement({ patternBEnabled: true }, { persistAutoPolicy: true });
  assert.equal(stamped.capabilityTiers.enabled, false);
  assert.equal(stamped.capabilityTiers.enablementSource, 'auto_policy');
});

test('swarm isolation admits only an enforced independent task and completes through fresh evidence', async () => {
  clearHostBoundaries();
  const { store, close } = openStore();
  const sessions = [];
  const records = { value: null };
  const lifecycles = createMemoryLifecycleStore();
  const integrations = integrationHarness();
  let committed = null;
  const executor = new SwarmExecutor({
    store,
    listSessions: () => sessions,
    getSession: (id) => sessions.find((session) => session.id === id),
    createTeammateSession: ({ metadata }) => {
      const rec = { id: 'sess-isolated', status: 'completed', mode: 'teammate', metadata: { ...(metadata ?? {}) } };
      sessions.push(rec);
      return rec;
    },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => true,
    trustedHandoff: (run) => trustedContextForSwarmRun(run, true, false, { enabled: true }, {
      enabled: true,
      hostEnforced: true,
      canonicalizer: true,
      isolationTask: true,
    }),
    swarmHandoffEntryEnabled: true,
    flywheelHandoffEntryEnabled: true,
    patternB: {
      enabled: true,
      explicitOff: false,
      boundaryFor,
      readRecords: () => records.value,
      writeRecords: (value) => { records.value = value; },
      lifecycles,
      acceptDelivery: (session, report) => patternBSharedDelivery({
        report,
        kernelState: typeof session.metadata?.handoffState === 'string' ? session.metadata.handoffState : 'completed',
        evidence: report.handoffEvidence,
        gateInvoked: true,
        integration: committed?.record,
      }).success,
      now: () => NOW,
    },
    reviewTask: async () => passedReport(committed ? { handoffEvidence: seal(committed.record) } : {}),
  });
  const runId = createSwarmId('srun');
  const now = nowIso();
  store.createRun({
    id: runId, goal: 'isolated change', status: 'pending', strategy: 'pipeline',
    budget: { maxTeammates: 2, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
    qualityGate: ['correct output'], createdAt: now, updatedAt: now,
  });
  executor.startRun(runId, [{ title: 'Implement', requiredRole: 'implementer', capabilityTags: ['pattern-b-isolation'] }]);
  await executor.tick();
  const session = sessions[0];
  assert.equal(typeof session.metadata.patternBHostKey, 'string');
  assert.equal(denyPatternBTool(session, { name: 'write_file', access: 'write' }, { input: { path: '/work/w1/a.ts' } }), undefined);
  assert.match(String(denyPatternBTool(session, { name: 'bash', access: 'read' }, { input: { command: 'tee /shared/out' } })), /Shared integration/);
  const task = store.listTasks(runId)[0];
  committed = runHostIntegration(integrations.store, auth({
    runId,
    workerId: task.id,
    integrationId: `int-${task.id}`,
  }));
  assert.equal(committed.ok, true);
  await executor.tick();
  await executor.tick();
  assert.equal(store.listTasks(runId)[0].status, 'done');
  assert.equal(store.getRun(runId)?.status, 'completed');
  assert.equal(lifecycles.list().length, 1);
  assert.equal(patternBPersistedIsolation(records.value, runId)?.isolationEnabled, true);
  assert.ok(readHostBoundary(session.metadata.patternBHostKey));
  close();
  clearHostBoundaries();
});

test('missing enforcement fails closed and non-isolation work stays on the old path', async () => {
  clearHostBoundaries();
  const { store, close } = openStore();
  const sessions = [];
  const executor = new SwarmExecutor({
    store,
    listSessions: () => sessions,
    getSession: (id) => sessions.find((session) => session.id === id),
    createTeammateSession: ({ metadata }) => {
      const rec = { id: `sess-${sessions.length + 1}`, status: 'completed', mode: 'teammate', metadata: { ...(metadata ?? {}) } };
      sessions.push(rec);
      return rec;
    },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => true,
    trustedHandoff: (run) => trustedContextForSwarmRun(run, true, false),
    swarmHandoffEntryEnabled: true,
    patternB: { enabled: true, explicitOff: false },
    reviewTask: async () => passedReport(),
  });
  const runId = createSwarmId('srun');
  const now = nowIso();
  store.createRun({
    id: runId, goal: 'mixed', status: 'pending', strategy: 'pipeline',
    budget: { maxTeammates: 2, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
    qualityGate: ['correct output'], createdAt: now, updatedAt: now,
  });
  executor.startRun(runId, [
    { title: 'Unbounded', requiredRole: 'implementer', capabilityTags: ['pattern-b-isolation'] },
    { title: 'Ordinary', requiredRole: 'implementer', capabilityTags: [] },
  ]);
  await executor.tick();
  await executor.tick();
  const tasks = store.listTasks(runId);
  assert.equal(tasks.find((task) => task.title === 'Unbounded')?.status, 'failed');
  assert.equal(tasks.find((task) => task.title === 'Ordinary')?.status, 'done');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].metadata.patternBHostKey, undefined);
  const flywheel = resolvePatternBDispatch({
    run: { id: 'fly', orchestrationRunId: 'orch-1', strategy: 'pipeline' },
    task: { id: 'task-fly', requiredRole: 'implementer', capabilityTags: ['pattern-b-isolation'] },
    config: { enabled: true, explicitOff: false, boundaryFor },
    trusted: { source: 'flywheel', patternBEnabled: true },
    now: NOW,
  });
  assert.equal(flywheel.kind, 'inactive');
  const reviewer = resolvePatternBDispatch({
    run: { id: 'run-r', strategy: 'pipeline' },
    task: { id: 'task-r', requiredRole: 'reviewer', capabilityTags: ['pattern-b-isolation'] },
    config: { enabled: true, explicitOff: false, boundaryFor: (run, task) => boundaryFor(run, task, 'reviewer') },
    trusted: { source: 'independent_swarm', patternBEnabled: true },
    now: NOW,
  });
  assert.equal(reviewer.kind, 'admit');
  assert.equal(reviewer.metadata.patternBRole, 'planner');
  assert.match(String(denyPatternBTool(
    { metadata: reviewer.metadata },
    { name: 'write_file', access: 'write' },
    { input: { path: '/work/w1/a.ts' }, role: 'executor' },
  )), /Planner/);
  close();
  clearHostBoundaries();
});
