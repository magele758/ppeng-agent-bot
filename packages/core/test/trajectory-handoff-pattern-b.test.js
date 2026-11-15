/**
 * Pattern B on independent Swarm, and on a host-qualified flywheel implement task.
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
  patternBImplementTask,
  patternBInFlightDisposition,
  patternBNewAdmissionAllowed,
  patternBPersistedIsolation,
  readPatternBIsolationRecords,
  readPatternBIsolationSwitch,
  rememberPatternBIsolation,
  rollbackPatternBIsolation,
} from '../dist/trajectory-handoff/pattern-b-entry.js';
import {
  patternBAcceptDelivery,
  patternBArtifactVersion,
  patternBIntegrationId,
  patternBResumeDecision,
  patternBRollbackArtifacts,
  patternBSharedDelivery,
  patternBStoredIntegration,
  runHostIntegration,
} from '../dist/trajectory-handoff/pattern-b-integrate.js';
import { patternBHostBoundary, resolvePatternBDispatch } from '../dist/trajectory-handoff/pattern-b-swarm.js';
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
  createFileIntegrationStore,
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

test('knife-3 and knife-4 switches do not open Pattern B, and unqualified flywheel stays out', () => {
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
  const qualified = {
    ...flywheel,
    patternBEnabled: true,
    isolationTask: true,
    patternBHostEnforced: true,
    patternBCanonicalizer: true,
    flywheelImplement: true,
  };
  assert.equal(admitPatternBIsolation({ trusted: qualified, workerMetadata: { skipGate: true } }).source, 'flywheel');
  assert.equal(admitPatternBIsolation({
    trusted: { ...qualified, patternBHostEnforced: false, patternBCanonicalizer: false },
  }).reason, 'not_enforced');
  assert.equal(admitPatternBIsolation({ trusted: { ...qualified, patternBExplicitOff: true } }).reason, 'explicit_off');
  assert.equal(admitPatternBIsolation({
    trusted: { ...flywheel, flywheelImplement: true, isolationTask: true, patternBEnabled: false },
    workerMetadata: { flywheelImplement: true, writableSharedTarget: true },
  }).reason, 'flywheel_orchestration');
  assert.equal(admitPatternBIsolation({
    trusted: { ...qualified, flywheelImplement: false, flywheelPlanner: true },
  }).source, 'flywheel');
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
  assert.equal(flywheel.kind, 'admit');
  assert.equal(flywheel.metadata.patternBRole, 'executor');
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

function flywheelRun() {
  return { id: 'fly', orchestrationRunId: 'orch-1', strategy: 'pipeline' };
}

function flywheelTask(role, tagged = true) {
  return {
    id: role === 'implementer' ? 'w1' : role,
    requiredRole: role,
    capabilityTags: tagged ? ['pattern-b-isolation'] : [],
  };
}

function flywheelBoundary(run, task) {
  const registry = patternBHostBoundary({
    runId: run.id,
    workerId: task.id,
    taskScope: 'implement',
    writableRoot: '/work/w1',
    sharedRoot: '/shared',
    implement: task.requiredRole === 'implementer',
  });
  if (!registry) return undefined;
  registry.boundaries.push({
    identity: { runId: run.id, workerId: 'w2', taskScope: 'other' },
    writableRoot: '/work/w2',
    role: 'executor',
    effectiveWrite: true,
  });
  return registry;
}

function flywheelDispatch(role, config) {
  return resolvePatternBDispatch({
    run: flywheelRun(),
    task: flywheelTask(role, config.tagged !== false),
    config: {
      enabled: config.enabled !== false,
      explicitOff: config.explicitOff === true,
      ...(config.boundary === false ? {} : { boundaryFor: flywheelBoundary }),
    },
    trusted: { source: 'flywheel', patternBEnabled: true },
    now: NOW,
  });
}

function workspaceHarness() {
  const calls = [];
  const store = createMemoryIntegrationStore({
    apply(record) { calls.push(record.integrationId); },
  }, { targets: { shared: 'workspace' } });
  return { calls, store };
}

function flywheelAuth(overrides = {}) {
  return auth({
    integrationId: 'int-fly',
    runId: 'fly',
    workerId: 'w1',
    taskScope: 'implement',
    expectedTargetVersion: 'workspace',
    ...overrides,
  });
}

test('qualified flywheel implement is isolated only by the independent switch', () => {
  clearHostBoundaries();
  assert.equal(PATTERN_B_PRODUCTION_ENTRY, 'closed');
  assert.deepEqual(patternBImplementTask('Ship', false), { title: 'Ship', requiredRole: 'implementer' });
  assert.deepEqual(patternBImplementTask('Ship', true), {
    title: 'Ship',
    requiredRole: 'implementer',
    capabilityTags: ['pattern-b-isolation'],
  });
  assert.equal(patternBHostBoundary({
    runId: 'fly', workerId: 'w1', taskScope: 'implement', writableRoot: 'relative', sharedRoot: '/repo', implement: true,
  }), undefined);
  assert.equal(patternBHostBoundary({
    runId: 'fly', workerId: 'w1', taskScope: 'implement', writableRoot: '/repo/state/w1', sharedRoot: '/repo', implement: true,
  }), undefined);
  assert.equal(flywheelDispatch('implementer', { enabled: false }).kind, 'inactive');
  assert.equal(flywheelDispatch('implementer', { explicitOff: true }).kind, 'inactive');
  assert.equal(flywheelDispatch('implementer', { tagged: false }).kind, 'inactive');
  const missing = flywheelDispatch('implementer', { boundary: false });
  assert.equal(missing.kind, 'fail_closed');
  assert.equal(missing.reason, 'not_enforced');
  const admitted = flywheelDispatch('implementer', {});
  assert.equal(admitted.kind, 'admit');
  assert.equal(admitted.metadata.patternBRole, 'executor');
  const session = { metadata: admitted.metadata };
  const write = { name: 'write_file', access: 'write' };
  assert.equal(denyPatternBTool(session, write, { input: { path: '/work/w1/a.ts' } }), undefined);
  assert.match(String(denyPatternBTool(session, write, { input: { path: '/work/w2/file.ts' } })), /Another worker/);
  assert.match(String(denyPatternBTool(session, write, { input: { path: '/shared/out.ts' } })), /Read-only mounts|Shared integration/);
  assert.match(String(denyPatternBTool(session, write, { input: { path: '/shared/out.js' } })), /Read-only mounts|Shared integration/);
  assert.ok(denyPatternBTool(session, write, { input: { path: '/shared-evil/out.ts' } }));
  assert.match(String(denyPatternBTool(session, { name: 'bash', access: 'read' }, { input: { command: 'mv /work/w1/a.ts /shared/out.ts' } })), /Read-only mounts|Shared integration/);
  assert.match(String(denyPatternBTool(session, write, {
    input: { path: '/work/w1/a.ts' }, workerClaimsSkipGate: true, workerClaimsSharedWrite: true,
  })), /self-report/);
  for (const role of ['planner', 'researcher', 'reviewer']) {
    const planned = flywheelDispatch(role, {});
    assert.equal(planned.kind, 'admit', role);
    assert.equal(planned.metadata.patternBRole, 'planner', role);
    const gated = { metadata: planned.metadata };
    assert.match(String(denyPatternBTool(gated, write, { input: { path: '/work/w1/package.json' } })), /Planner/, role);
    assert.match(String(denyPatternBTool(gated, { name: 'bash', access: 'read' }, { input: { command: 'npm install left-pad' } })), /Planner|outside/, role);
    assert.match(String(denyPatternBTool(gated, { name: 'cleanup_workspace' }, { input: { path: '/work/w1' } })), /host-controlled/, role);
  }
  clearHostBoundaries();
});

test('flywheel host integration does not replay, overwrite, or accept stale evidence', () => {
  const fresh = workspaceHarness();
  const input = flywheelAuth();
  const committed = runHostIntegration(fresh.store, input);
  assert.equal(committed.ok, true);
  assert.deepEqual(fresh.calls, ['int-fly']);
  assert.equal(runHostIntegration(fresh.store, input).ok, true);
  assert.deepEqual(fresh.calls, ['int-fly']);
  const evidence = seal(committed.record);
  assert.equal(patternBSharedDelivery({
    report: passedReport(), kernelState: 'completed', evidence, gateInvoked: true, integration: committed.record,
  }).success, true);
  assert.equal(patternBSharedDelivery({
    report: passedReport(), kernelState: 'done', evidence: null, gateInvoked: true, integration: committed.record,
  }).reason, 'stale_evidence');
  assert.equal(patternBSharedDelivery({
    report: passedReport(), kernelState: 'done', evidence: { ...evidence, artifactVersion: 'spliced' }, gateInvoked: true, integration: committed.record,
  }).reason, 'stale_evidence');
  for (const kernelState of ['failed', 'cancelled', 'timed_out']) {
    assert.equal(patternBSharedDelivery({
      report: passedReport(), kernelState, evidence, gateInvoked: true, integration: committed.record,
    }).reason, 'kernel_not_delivery', kernelState);
  }
  assert.equal(kernelStateIsDeliverySuccess('done'), false);
  assert.equal(patternBAcceptDelivery({
    metadata: { patternBHostKey: 'host-key', handoffState: 'done' },
    report: passedReport(),
    integration: committed.record,
  }), false);
  assert.equal(patternBAcceptDelivery({
    metadata: { patternBHostKey: 'host-key', handoffState: 'completed' },
    report: passedReport({ handoffEvidence: evidence }),
    integration: committed.record,
  }), true);
  assert.equal(patternBAcceptDelivery({
    metadata: { patternBHostKey: 'host-key', patternBRunId: 'fly', patternBWorkerId: 'w1' },
    report: passedReport({ handoffEvidence: evidence }),
    integration: patternBStoredIntegration(fresh.store, { patternBRunId: 'fly', patternBWorkerId: 'missing' }),
  }), false);

  const raced = workspaceHarness();
  assert.equal(runHostIntegration(raced.store, flywheelAuth({ integrationId: 'int-a', workerId: 'w1' })).ok, true);
  const loser = runHostIntegration(raced.store, flywheelAuth({ integrationId: 'int-b', workerId: 'w2' }));
  assert.equal(loser.ok, false);
  assert.equal(loser.reason, 'target_moved');
  assert.deepEqual(raced.calls, ['int-a']);

  const crashed = workspaceHarness();
  const failed = runHostIntegration(crashed.store, flywheelAuth(), { crash: true });
  assert.equal(failed.record?.status, 'unknown');
  assert.equal(runHostIntegration(crashed.store, flywheelAuth()).ok, false);
  assert.deepEqual(crashed.calls, ['int-fly']);
  const bypass = crashed.store.authorize(flywheelAuth({ integrationId: 'int-new' }));
  assert.equal(bypass.ok, false);
  assert.equal(bypass.reason, 'in_flight');

  const expired = workspaceHarness();
  const late = runHostIntegration(expired.store, flywheelAuth(), { commitAt: LATE });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
  assert.notEqual(expired.store.get('int-fly')?.status, 'accepted');
  assert.equal(expired.store.targetVersion('shared'), 'workspace');
});

test('flywheel integration records survive restart and rollback does not delete them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pattern-b-file-'));
  const file = join(dir, 'integrations.json');
  const input = flywheelAuth();
  const opened = createFileIntegrationStore(file, { apply() {} }, { targets: { shared: 'workspace' } });
  assert.equal(opened.authorize(input).ok, true);
  const reopened = createFileIntegrationStore(file, { apply() {} }, { targets: { shared: 'workspace' } });
  assert.equal(reopened.get(input.integrationId)?.status, 'authorized');
  const late = runHostIntegration(reopened, { ...input, now: LATE });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
  assert.equal(reopened.get(input.integrationId)?.status, 'expired');
  const remembered = rememberPatternBIsolation(null, { runId: 'fly', workerId: 'w1', persistedAt: NOW });
  const rolled = rollbackPatternBIsolation('stop_new_admission');
  assert.equal(patternBNewAdmissionAllowed(rolled), false);
  assert.equal(patternBPersistedIsolation(remembered.records, 'fly')?.unintegratedRetained, true);
  assert.equal(patternBInFlightDisposition({
    storedSwitch: rolled,
    records: remembered.records,
    runId: 'fly',
    now: LATE,
    authorization: { runId: 'fly', explicit: true, deadlineAt: DEADLINE },
  }), 'expired');
});

test('flywheel implement execution integrates only through an authorized host seal', async () => {
  clearHostBoundaries();
  const { store, close } = openStore();
  const sessions = [];
  const records = { value: null };
  const lifecycles = createMemoryLifecycleStore();
  const integrations = workspaceHarness();
  let committed = null;
  const executor = new SwarmExecutor({
    store,
    listSessions: () => sessions,
    getSession: (id) => sessions.find((session) => session.id === id),
    createTeammateSession: ({ metadata }) => {
      const rec = { id: 'sess-fly', status: 'completed', mode: 'teammate', metadata: { ...(metadata ?? {}) } };
      sessions.push(rec);
      return rec;
    },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => true,
    trustedHandoff: (run) => trustedContextForSwarmRun(run, true, false, { enabled: true }, { enabled: true }),
    swarmHandoffEntryEnabled: true,
    flywheelHandoffEntryEnabled: true,
    patternB: {
      enabled: true,
      explicitOff: false,
      boundaryFor: flywheelBoundary,
      readRecords: () => records.value,
      writeRecords: (value) => { records.value = value; },
      lifecycles,
      acceptDelivery: (session, report) => patternBAcceptDelivery({
        metadata: session.metadata,
        report,
        integration: patternBStoredIntegration(integrations.store, session.metadata),
      }),
      now: () => NOW,
    },
    reviewTask: async () => passedReport(committed ? { handoffEvidence: seal(committed.record) } : {}),
  });
  const runId = createSwarmId('srun');
  const now = nowIso();
  store.createRun({
    id: runId, orchestrationRunId: 'orch-fly', goal: 'flywheel implement', status: 'pending', strategy: 'pipeline',
    budget: { maxTeammates: 2, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
    qualityGate: ['correct output'], createdAt: now, updatedAt: now,
  });
  executor.startRun(runId, [{ title: 'Implement', requiredRole: 'implementer', capabilityTags: ['pattern-b-isolation'] }]);
  await executor.tick();
  const session = sessions[0];
  assert.equal(typeof session.metadata.patternBHostKey, 'string');
  assert.equal(denyPatternBTool(session, { name: 'write_file', access: 'write' }, { input: { path: '/work/w1/a.ts' } }), undefined);
  assert.match(String(denyPatternBTool(session, { name: 'write_file', access: 'write' }, { input: { path: '/work/w2/file.ts' } })), /Another worker/);
  assert.notEqual(store.listTasks(runId)[0].status, 'done');
  assert.equal(patternBAcceptDelivery({
    metadata: session.metadata,
    report: passedReport(),
    integration: undefined,
  }), false);
  const task = store.listTasks(runId)[0];
  committed = runHostIntegration(integrations.store, flywheelAuth({
    integrationId: patternBIntegrationId(runId, task.id),
    runId,
    workerId: task.id,
  }));
  assert.equal(committed.ok, true);
  assert.equal(patternBStoredIntegration(integrations.store, session.metadata)?.status, 'accepted');
  await executor.tick();
  await executor.tick();
  assert.equal(store.listTasks(runId)[0].status, 'done');
  assert.equal(store.getRun(runId)?.status, 'completed');
  assert.equal(patternBPersistedIsolation(records.value, runId)?.isolationEnabled, true);
  close();
  clearHostBoundaries();
});
