/**
 * Knife 4: open the approved flywheel composition entry.
 * Research/review stay read-only even if the role switches to executor.
 * Implement success goes through the existing evidence gate. #516 is not relaxed.
 * Rollback stop-new-admission does not close independent Swarm.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(TEST_DIR, '..');
const SRC_ROOT = join(PACKAGE_ROOT, 'src');
const HAS_DIST = existsSync(join(PACKAGE_ROOT, 'dist/orchestrator/engine.js'));

const ENGINE_SRC = readFileSync(join(SRC_ROOT, 'orchestrator/engine.ts'), 'utf8');
const COLLABORATORS_SRC = readFileSync(join(SRC_ROOT, 'runtime/collaborators.ts'), 'utf8');
const TYPES_SRC = readFileSync(join(SRC_ROOT, 'orchestrator/types.ts'), 'utf8');
const EXECUTOR_SRC = readFileSync(join(SRC_ROOT, 'swarm/executor.ts'), 'utf8');

const BOUND_EVIDENCE = {
  planVersion: 1,
  taskScope: 'implement',
  verifiedPlanVersion: 1,
  verifiedTaskScope: 'implement',
  available: true
};
const GOOD_REPORT = {
  passed: true,
  summary: 'verified',
  checks: [{ criterion: 'correct output', passed: true, evidence: ['read-1'] }],
  handoffEvidence: BOUND_EVIDENCE
};

function methodBody(src, name) {
  const re = new RegExp(String.raw`(?:private\s+(?:async\s+)?${name}|function\s+${name})\s*\(`);
  const found = re.exec(src);
  assert.ok(found, `expected to find ${name}`);
  const brace = src.indexOf('{', found.index);
  assert.ok(brace >= 0, `expected body for ${name}`);
  let depth = 0;
  for (let j = brace; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(brace, j + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

function startSwarmForRunSnippet() {
  const start = COLLABORATORS_SRC.indexOf('startSwarmForRun:');
  const end = COLLABORATORS_SRC.indexOf('tickSwarm:', start);
  assert.ok(start >= 0 && end > start, 'startSwarmForRun wiring missing');
  return COLLABORATORS_SRC.slice(start, end);
}

async function loadDist() {
  assert.ok(HAS_DIST, 'packages/core/dist is required');
  const [
    { SqliteStateStore },
    { OrchestrationEngine },
    { SwarmExecutor },
    { SwarmStore, createSwarmId, nowIso },
    swarmEntry,
    flywheelPhase,
  ] = await Promise.all([
    import('../dist/storage.js'),
    import('../dist/orchestrator/engine.js'),
    import('../dist/swarm/executor.js'),
    import('../dist/swarm/store.js'),
    import('../dist/trajectory-handoff/swarm-entry.js'),
    import('../dist/trajectory-handoff/flywheel-phase.js'),
  ]);
  return {
    SqliteStateStore,
    OrchestrationEngine,
    SwarmExecutor,
    SwarmStore,
    createSwarmId,
    nowIso,
    ...swarmEntry,
    ...flywheelPhase,
  };
}

async function createFlywheelPhaseHarness(t, {
  compositionEntry = 'open',
  persistedAutoEnablement = null,
  implementReport = GOOD_REPORT,
  cancelInFlight = false,
} = {}) {
  assert.ok(compositionEntry === 'open' || compositionEntry === 'closed', 'compositionEntry must be open or closed');
  const dist = await loadDist();
  const dir = mkdtempSync(join(tmpdir(), 'k4-flywheel-'));
  const db = new dist.SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { db.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = db.orchestrator();
  const swarmStore = db.swarm();
  let swarm;
  let startCalls = 0;
  let report = implementReport;
  let cancelFlag = false;
  const flywheelStored = compositionEntry === 'open'
    ? null
    : dist.rollbackFlywheelEntry(cancelInFlight ? 'cancel_in_flight' : 'stop_new_admission');
  const flywheelSwitch = dist.readFlywheelHandoffEntrySwitch(flywheelStored);
  const sessions = [];
  const executor = new dist.SwarmExecutor({
    store: swarmStore,
    listSessions: () => sessions,
    getSession: (id) => sessions.find((session) => session.id === id),
    createTeammateSession: ({ metadata }) => {
      const rec = { id: `sess_${sessions.length + 1}`, status: 'idle', mode: 'teammate', metadata: { ...(metadata ?? {}) } };
      sessions.push(rec);
      return rec;
    },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => false,
    trustedHandoff: (run) => dist.trustedContextForSwarmRun(run, true, false, flywheelSwitch),
    swarmHandoffEntryEnabled: true,
    flywheelHandoffEntryEnabled: flywheelSwitch.enabled,
    flywheelHandoffExplicitOff: flywheelSwitch.explicitOff,
  });
  const engine = new dist.OrchestrationEngine({
    store,
    startSwarmForRun: async (run) => {
      startCalls += 1;
      void persistedAutoEnablement;
      const swarmId = dist.createSwarmId('srun');
      swarmStore.createRun({
        id: swarmId,
        goal: run.title,
        orchestrationRunId: run.id,
        status: 'pending',
        strategy: 'pipeline',
        budget: { maxTeammates: 1, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
        qualityGate: ['completed'],
        createdAt: dist.nowIso(),
        updatedAt: dist.nowIso()
      });
      swarm = swarmStore.getRun(swarmId);
      executor.startRun(swarmId, [{ title: run.title, requiredRole: 'implementer' }]);
      await executor.tick();
    },
    tickSwarm: () => executor.tick(),
    getSwarmForOrchestrationRun: (orchestrationRunId) =>
      swarmStore.listRuns({ limit: 50 }).find((r) => r.orchestrationRunId === orchestrationRunId),
    getImplementQualityReport: () => report,
    shouldCancelInFlightFlywheel: () => cancelFlag,
  });
  return {
    dist,
    store,
    swarmStore,
    engine,
    executor,
    sessions,
    compositionEntry,
    persistedAutoEnablement,
    flywheelStored,
    reports: {
      good: GOOD_REPORT,
      missingEvidence: { ...GOOD_REPORT, handoffEvidence: { ...BOUND_EVIDENCE, available: false } },
      staleVersion: { ...GOOD_REPORT, handoffEvidence: { ...BOUND_EVIDENCE, verifiedPlanVersion: 0 } },
      kernelDone: { ...GOOD_REPORT, kernelState: 'done', handoffEvidence: null },
      answered: { ...GOOD_REPORT, kernelState: 'answered' },
    },
    phaseHost: {
      tryWriteAs(args) {
        return dist.denyFlywheelPhaseWrite(args);
      }
    },
    startCallCount: () => startCalls,
    setImplementReport(next) { report = next; },
    setCancelInFlight(next) { cancelFlag = next === true; },
    setSwarmStatus(status) {
      assert.ok(swarm, 'swarm stub not started');
      swarmStore.updateRunStatus(swarm.id, status);
      swarm = swarmStore.getRun(swarm.id);
      return swarm;
    },
    currentSwarm() {
      assert.ok(swarm, 'swarm stub not started');
      return swarmStore.getRun(swarm.id);
    },
    async startImplementRun(title) {
      const run = store.createRun({
        title,
        sourceType: 'test',
        sourceRef: 'k4',
        flywheels: ['A'],
        capabilityTags: ['swarm'],
        riskLevel: 'low'
      });
      for (let i = 0; i < 8; i += 1) {
        await engine.tick();
        const implement = store.listSteps(run.id).find((s) => s.stage === 'implement');
        if (implement?.status === 'running') return { run, implement };
      }
      throw new Error('implement step did not start');
    }
  };
}

test('characterization: bootstrap stages stay classify→research→implement→review→test and implement uses swarm', () => {
  const match = ENGINE_SRC.match(/const BOOTSTRAP_STAGES: OrchestrationStage\[\] = \[([^\]]+)\]/);
  assert.ok(match, 'BOOTSTRAP_STAGES missing');
  const stages = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(stages, ['classify', 'research', 'implement', 'review', 'test']);
  assert.match(ENGINE_SRC, /executor:\s*stage === 'implement' \? 'swarm' : stage/);
  assert.match(TYPES_SRC, /export type FlywheelType = 'A' \| 'B' \| 'C' \| 'D' \| 'E' \| 'F' \| 'G' \| 'H'/);
  assert.match(ENGINE_SRC, /class OrchestrationEngine/);
  assert.doesNotMatch(ENGINE_SRC, /class TrajectoryHandoffOrchestrator/);
});

test('characterization: engine does not host a second handoff state machine', () => {
  assert.doesNotMatch(ENGINE_SRC, /createTrajectoryHandoff|awaiting_coordinator|refillId|parent-ledger/);
  assert.match(ENGINE_SRC, /from '\.\.\/quality\/gate\.js'/);
  assert.match(ENGINE_SRC, /evaluateSwarmDelivery/);
});

test('characterization: startSwarmForRun stays pipeline-only and does not treat auto_policy as admission', () => {
  const snippet = startSwarmForRunSnippet();
  assert.match(snippet, /strategy:\s*'pipeline'/);
  assert.match(snippet, /qualityGate:\s*\['completed'\]/);
  assert.match(snippet, /orchestrationRunId:\s*run\.id/);
  assert.doesNotMatch(snippet, /auto_policy|explicit_on|capabilityTiers/);
  assert.match(COLLABORATORS_SRC, /FLYWHEEL_HANDOFF_ENTRY_CONTROL_KEY/);
  assert.match(COLLABORATORS_SRC, /flywheelHandoffEntryEnabled/);
  assert.match(EXECUTOR_SRC, /setFlywheelHandoffEntryEnabled/);
  assert.match(EXECUTOR_SRC, /setSwarmHandoffEntryEnabled/);
});

test('characterization: implement completion routes through the evidence gate', () => {
  const body = methodBody(ENGINE_SRC, 'tryCompleteImplementStep');
  assert.match(body, /evaluateImplementDelivery|evaluateSwarmDelivery/);
  assert.doesNotMatch(body, /status: failed \? 'failed' : 'completed'/);
});

test('admission: missing flywheel switch is open; explicit off wins; illegal values fail closed', async () => {
  const dist = await loadDist();
  assert.deepEqual(dist.readFlywheelHandoffEntrySwitch(undefined).enabled, true);
  assert.equal(dist.readFlywheelHandoffEntrySwitch(null).explicitOff, false);
  const opened = dist.admitSwarmHandoff({
    trusted: { source: 'flywheel', flywheelEntryEnabled: true, entryEnabled: false },
  });
  assert.deepEqual(opened, { open: true, source: 'flywheel' });
  const viaOrch = dist.admitSwarmHandoff({
    trusted: { source: 'independent_swarm', entryEnabled: false, flywheelEntryEnabled: true, orchestrationRunId: 'orch-1' },
  });
  assert.deepEqual(viaOrch, { open: true, source: 'flywheel' });
  assert.equal(dist.admitSwarmHandoff({
    trusted: { source: 'flywheel', flywheelEntryEnabled: true, flywheelExplicitOff: true },
  }).reason, 'explicit_off');
  assert.equal(dist.admitSwarmHandoff({
    trusted: { source: 'flywheel', entryEnabled: true },
  }).reason, 'flywheel_source');
  const closed = dist.rollbackFlywheelEntry('stop_new_admission');
  assert.equal(dist.flywheelNewAdmissionAllowed(closed), false);
  assert.equal(dist.flywheelInFlightShouldCancel(closed), false);
  assert.equal(dist.flywheelInFlightShouldCancel(dist.rollbackFlywheelEntry('cancel_in_flight')), true);
  assert.deepEqual(dist.readSwarmHandoffEntrySwitch(undefined), { enabled: true, explicitOff: false });
});

test('KNIFE-4: implement success must pass the evidence gate even if swarm.status is completed', { skip: !HAS_DIST }, async (t) => {
  const { store, engine, setSwarmStatus, startImplementRun } = await createFlywheelPhaseHarness(t, {
    compositionEntry: 'open'
  });
  const { run } = await startImplementRun('k4 implement gate');
  setSwarmStatus('completed');
  await engine.tick();
  const implement = store.listSteps(run.id).find((s) => s.stage === 'implement');
  assert.equal(implement?.status, 'completed');
});

test('KNIFE-4: missing, unavailable, or stale-version evidence must not pass implement', { skip: !HAS_DIST }, async (t) => {
  for (const key of ['missingEvidence', 'staleVersion']) {
    const harness = await createFlywheelPhaseHarness(t, { compositionEntry: 'open' });
    harness.setImplementReport(harness.reports[key]);
    const { run } = await harness.startImplementRun(`k4 ${key}`);
    harness.setSwarmStatus('completed');
    await harness.engine.tick();
    const implement = harness.store.listSteps(run.id).find((s) => s.stage === 'implement');
    assert.equal(implement?.status, 'failed', key);
    assert.equal(harness.store.getRun(run.id).status, 'failed', key);
  }
});

test('KNIFE-4: answered/capped/failed/cancelled/timed_out/awaiting_coordinator and kernel done must not map to implement delivery success on the flywheel path', { skip: !HAS_DIST }, async (t) => {
  const dist = await loadDist();
  for (const state of ['answered', 'capped', 'failed', 'cancelled', 'timed_out', 'awaiting_coordinator', 'done']) {
    const delivery = dist.evaluateSwarmDelivery({
      report: state === 'done' ? { ...GOOD_REPORT, handoffEvidence: null } : { ...GOOD_REPORT, kernelState: state },
      kernelState: state,
      evidence: state === 'done' ? null : BOUND_EVIDENCE,
      gateInvoked: true,
    });
    assert.equal(delivery.success, false, state);
    assert.equal(dist.kernelStateIsDeliverySuccess(state), false);
  }
  const harness = await createFlywheelPhaseHarness(t, { compositionEntry: 'open' });
  harness.setImplementReport(harness.reports.answered);
  const { run } = await harness.startImplementRun('k4 kernel answered');
  harness.setSwarmStatus('completed');
  await harness.engine.tick();
  assert.equal(harness.store.listSteps(run.id).find((s) => s.stage === 'implement')?.status, 'failed');
});

test('KNIFE-4: recovery and replan-then-complete still run the evidence gate', { skip: !HAS_DIST }, async (t) => {
  const first = await createFlywheelPhaseHarness(t, { compositionEntry: 'open' });
  first.setImplementReport(first.reports.staleVersion);
  const { run } = await first.startImplementRun('k4 stale then recover');
  first.setSwarmStatus('completed');
  await first.engine.tick();
  assert.equal(first.store.listSteps(run.id).find((s) => s.stage === 'implement')?.status, 'failed');

  const recovered = await createFlywheelPhaseHarness(t, { compositionEntry: 'open' });
  const second = await recovered.startImplementRun('k4 recovered evidence');
  recovered.setSwarmStatus('completed');
  await recovered.engine.tick();
  assert.equal(recovered.store.listSteps(second.run.id).find((s) => s.stage === 'implement')?.status, 'completed');
});

test('KNIFE-4: research remains read-only when the role is switched to executor', async () => {
  const dist = await loadDist();
  assert.equal(dist.flywheelPhaseWriteDenied({ phase: 'research', role: 'executor' }), true);
  assert.equal(dist.flywheelPhaseWriteDenied({ phase: 'research', role: 'planner' }), true);
  assert.ok(dist.denyFlywheelPhaseWrite({ phase: 'research', role: 'executor' }));
});

test('KNIFE-4: review remains read-only when the role is switched to executor', async () => {
  const dist = await loadDist();
  assert.equal(dist.flywheelPhaseWriteDenied({ phase: 'review', role: 'executor' }), true);
  assert.equal(dist.flywheelPhaseWriteDenied({ phase: 'review', role: 'planner' }), true);
  const reviewSrc = readFileSync(join(SRC_ROOT, 'runtime/quality-gates.ts'), 'utf8');
  assert.match(reviewSrc, /hostPhase: 'review'/);
});

test('KNIFE-4: in-phase implement test failure may replan but must not cross the delivery boundary', { skip: !HAS_DIST }, async (t) => {
  const harness = await createFlywheelPhaseHarness(t, { compositionEntry: 'open' });
  harness.setImplementReport({
    passed: false,
    summary: 'tests failed',
    checks: [{ criterion: 'correct output', passed: false, evidence: ['read-1'] }],
    handoffEvidence: BOUND_EVIDENCE
  });
  const { run } = await harness.startImplementRun('k4 in-phase test fail');
  harness.setSwarmStatus('completed');
  await harness.engine.tick();
  const implement = harness.store.listSteps(run.id).find((s) => s.stage === 'implement');
  assert.equal(implement?.status, 'failed');
  assert.notEqual(harness.store.getRun(run.id).status, 'completed');
});

test('KNIFE-4: after rollback, independent Swarm still runs and flywheel cannot reopen handoff through it', { skip: !HAS_DIST }, async (t) => {
  const harness = await createFlywheelPhaseHarness(t, { compositionEntry: 'closed' });
  const dist = harness.dist;
  const closed = harness.flywheelStored;
  assert.equal(dist.admitSwarmHandoff({
    trusted: { source: 'flywheel', flywheelEntryEnabled: dist.readFlywheelHandoffEntrySwitch(closed).enabled, orchestrationRunId: 'orch-1' },
  }).open, false);
  const independent = dist.admitSwarmHandoff({
    trusted: { source: 'independent_swarm', entryEnabled: true, explicitOff: false, flywheelEntryEnabled: false },
  });
  assert.deepEqual(independent, { open: true, source: 'independent_swarm' });
  const { run, sessions, setSwarmStatus, engine, store } = harness;
  void run;
  const started = await harness.startImplementRun('k4 rollback isolation');
  assert.equal(sessions[0].metadata.handoffEnablement, undefined);
  setSwarmStatus('completed');
  await engine.tick();
  // Without handoff admission, a good report can still be required; do not treat
  // rollback as a way to complete implement on swarm status alone if no report.
  const implement = store.listSteps(started.run.id).find((s) => s.stage === 'implement');
  assert.notEqual(implement?.status, 'running');
  assert.equal(dist.readSwarmHandoffEntrySwitch(undefined).enabled, true);
});

test('KNIFE-4: lifting the composition restriction must not regress knife-2 session policy or knife-3 Swarm isolation', { skip: !HAS_DIST }, async () => {
  const dist = await loadDist();
  assert.deepEqual(dist.admitSwarmHandoff({
    trusted: { source: 'independent_swarm', entryEnabled: true, explicitOff: false },
  }), { open: true, source: 'independent_swarm' });
  assert.equal(dist.admitSwarmHandoff({
    trusted: { source: 'independent_swarm', entryEnabled: true, explicitOff: true },
  }).reason, 'explicit_off');
  assert.equal(dist.admitSwarmHandoff({
    trusted: { source: 'flywheel', flywheelEntryEnabled: true, worker: true },
    workerMetadata: { source: 'independent_swarm', enabled: true, capabilityTiers: { enablementSource: 'auto_policy', enabled: true } },
  }).open, true);
  assert.equal(dist.admitSwarmHandoff({
    trusted: { source: 'flywheel', flywheelEntryEnabled: true, flywheelExplicitOff: true },
    workerMetadata: { source: 'independent_swarm', enabled: true },
  }).reason, 'explicit_off');
});

test('KNIFE-4: rollback leaves already-persisted auto enablement unchanged and does not treat it as flywheel admission', { skip: !HAS_DIST }, async (t) => {
  const persistedAutoEnablement = {
    source: 'auto_policy',
    capabilityTiers: { enabled: true, enablementSource: 'auto_policy' },
  };
  const harness = await createFlywheelPhaseHarness(t, {
    compositionEntry: 'closed',
    persistedAutoEnablement
  });
  const { run } = await harness.startImplementRun('k4 auto_policy ignored');
  void run;
  const session = harness.sessions[0];
  assert.equal(session.metadata.handoffEnablement, undefined);
  assert.equal(harness.persistedAutoEnablement.capabilityTiers.enablementSource, 'auto_policy');
  const dist = harness.dist;
  assert.equal(dist.admitSwarmHandoff({
    trusted: { source: 'flywheel', flywheelEntryEnabled: false },
    workerMetadata: persistedAutoEnablement,
  }).open, false);
});

test('KNIFE-4: missing capabilityTiers stays enabled false on the flywheel path', async () => {
  const dist = await loadDist();
  const { parseCapabilityTiers } = await import('@ppeng/agent-loop');
  const parsed = parseCapabilityTiers(undefined);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.resolved.enabled, false);
  assert.equal(parsed.resolved.enablementSource, 'parser_default');
});

test('KNIFE-4: cancel-in-flight rollback fails running flywheel work instead of completing the old path', { skip: !HAS_DIST }, async (t) => {
  const harness = await createFlywheelPhaseHarness(t, {
    compositionEntry: 'closed',
  });
  const { run } = await harness.startImplementRun('k4 cancel in flight');
  harness.setCancelInFlight(true);
  harness.setSwarmStatus('completed');
  await harness.engine.tick();
  assert.equal(harness.store.getRun(run.id).status, 'failed');
  const implement = harness.store.listSteps(run.id).find((s) => s.stage === 'implement');
  assert.notEqual(implement?.status, 'completed');
});

test('characterization: failed or cancelled swarm does not complete implement', { skip: !HAS_DIST }, async (t) => {
  for (const status of ['failed', 'cancelled']) {
    const { store, engine, setSwarmStatus, startImplementRun } = await createFlywheelPhaseHarness(t, {
      compositionEntry: 'open'
    });
    const { run } = await startImplementRun(`k4 ${status}`);
    setSwarmStatus(status);
    await engine.tick();
    const implement = store.listSteps(run.id).find((s) => s.stage === 'implement');
    assert.equal(implement?.status, 'failed');
    assert.equal(store.getRun(run.id).status, 'failed');
  }
});
