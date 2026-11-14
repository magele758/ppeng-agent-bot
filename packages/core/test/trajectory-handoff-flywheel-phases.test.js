/**
 * Knife-4 PREP skeleton for flywheel composition acceptance.
 *
 * Baseline: c67112bc5de284d3806bc399cf7289458021044f
 * Production flywheel composition entry stays CLOSED.
 * Do not hook flywheel sources. Do not rename the Orchestrator.
 * Do not edit gate.ts / verifier / swarm executor production wiring.
 *
 * Runnable now: source characterizations of the closed tip, plus runtime
 * characterizations when packages/core/dist exists.
 * test.skip cases wait for knife-3 acceptance and knife-4 implementation;
 * they must not be treated as passing acceptance.
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

const GOOD_REPORT = {
  passed: true,
  summary: 'verified',
  checks: [{ criterion: 'correct output', passed: true, evidence: ['read-1'] }]
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

async function createFlywheelPhaseHarness(t, { compositionEntry = 'closed' } = {}) {
  assert.equal(compositionEntry, 'closed', 'prep harness must keep the composition entry closed');
  assert.ok(HAS_DIST, 'packages/core/dist is required for runtime characterizations');
  const { SqliteStateStore } = await import('../dist/storage.js');
  const { OrchestrationEngine } = await import('../dist/orchestrator/engine.js');
  const dir = mkdtempSync(join(tmpdir(), 'k4-flywheel-prep-'));
  const db = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { db.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = db.orchestrator();
  let swarm;
  let startCalls = 0;
  const engine = new OrchestrationEngine({
    store,
    startSwarmForRun: async (run) => {
      startCalls += 1;
      // Test double only: does not attach handoff enablement or a trusted source.
      swarm = {
        id: `swarm-stub-${run.id}`,
        status: 'running',
        orchestrationRunId: run.id,
        compositionEntry,
        handoffEnabled: false
      };
    },
    getSwarmForOrchestrationRun: (orchestrationRunId) => (
      swarm && swarm.orchestrationRunId === orchestrationRunId ? swarm : undefined
    )
  });
  return {
    store,
    engine,
    compositionEntry,
    reports: {
      good: GOOD_REPORT,
      missingEvidence: {
        ...GOOD_REPORT,
        checks: [{ criterion: 'correct output', passed: true, evidence: ['missing'] }]
      },
      staleVersion: {
        ...GOOD_REPORT,
        checks: [{ criterion: 'correct output', passed: true, evidence: ['read-old-plan'] }]
      },
      kernelDoneShaped: {
        passed: true,
        summary: 'kernel done',
        checks: [{ criterion: 'done', passed: true, evidence: ['kernel:done'] }]
      }
    },
    phaseHost: {
      tryWriteAs(_args) {
        throw new Error('phase permission host is a stub until knife-4 implementation');
      }
    },
    startCallCount: () => startCalls,
    setSwarmStatus(status) {
      assert.ok(swarm, 'swarm stub not started');
      swarm.status = status;
      return swarm;
    },
    async startImplementRun(title) {
      const run = store.createRun({
        title,
        sourceType: 'test',
        sourceRef: 'k4-prep',
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
});

test('characterization: engine does not host a second handoff state machine', () => {
  assert.doesNotMatch(ENGINE_SRC, /trajectory-handoff|createTrajectoryHandoff|awaiting_coordinator|refillId/);
  assert.match(ENGINE_SRC, /from '\.\.\/quality\/gate\.js'/);
});

test('characterization: production flywheel startSwarmForRun does not attach handoff enablement or a trusted source', () => {
  const snippet = startSwarmForRunSnippet();
  assert.match(snippet, /strategy:\s*'pipeline'/);
  assert.match(snippet, /qualityGate:\s*\['completed'\]/);
  assert.match(snippet, /orchestrationRunId:\s*run\.id/);
  assert.doesNotMatch(snippet, /trajectoryHandoff|handoffEnabled|trustedSource|capabilityTiers|explicit_on/);
});

test('characterization (gap): tryCompleteImplementStep completes on swarm completed without qualityPassed', () => {
  const body = methodBody(ENGINE_SRC, 'tryCompleteImplementStep');
  assert.match(body, /TERMINAL_SWARM/);
  assert.match(body, /swarm\.status === 'failed' \|\| swarm\.status === 'cancelled'/);
  assert.doesNotMatch(body, /qualityPassed|validateQualityReport/);
  const advance = methodBody(ENGINE_SRC, 'advanceRun');
  assert.match(advance, /if \(!qualityPassed\(result\)\)/);
});

test('characterization: failed or cancelled swarm does not complete implement', { skip: !HAS_DIST }, async (t) => {
  for (const status of ['failed', 'cancelled']) {
    const { store, engine, setSwarmStatus, startImplementRun } = await createFlywheelPhaseHarness(t, {
      compositionEntry: 'closed'
    });
    const { run } = await startImplementRun(`k4-prep ${status}`);
    setSwarmStatus(status);
    await engine.tick();
    const implement = store.listSteps(run.id).find((s) => s.stage === 'implement');
    assert.equal(implement?.status, 'failed');
    assert.equal(store.getRun(run.id).status, 'failed');
  }
});

test('characterization (gap, runtime): implement is marked completed when swarm completes, even without a quality report', { skip: !HAS_DIST }, async (t) => {
  const { store, engine, setSwarmStatus, startImplementRun } = await createFlywheelPhaseHarness(t, {
    compositionEntry: 'closed'
  });
  const { run } = await startImplementRun('k4-prep gap completed');
  setSwarmStatus('completed');
  await engine.tick();
  const implement = store.listSteps(run.id).find((s) => s.stage === 'implement');
  assert.equal(implement?.status, 'completed', 'current tip gap: swarm completed alone finishes implement');
  assert.match(implement?.outputArtifact ?? '', /^swarm:/);
});

test.skip('KNIFE-4: implement success must pass the evidence gate even if swarm.status is completed', async () => {
  // Flip the gap characterization above once knife-4 implementation routes the
  // implement success exit through qualityPassed / validateQualityReport.
  // Evidence must bind the verified version and task scope.
});

test.skip('KNIFE-4: missing, unavailable, or stale-version evidence must not pass implement', async () => {
  // Pair with reports.missingEvidence / reports.staleVersion on the implement exit.
});

test.skip('KNIFE-4: answered/capped/failed/cancelled/timed_out/awaiting_coordinator and kernel done must not map to implement delivery success on the flywheel path', async () => {
  // Keep acceptance/delivery-mapping.yaml DM-1..DM-9; re-check the flywheel exit.
  // Do not loosen gate.ts to make this pass.
});

test.skip('KNIFE-4: recovery and replan-then-complete still run the evidence gate', async () => {
  // Waits for knife-3 real call/recovery paths, then knife-4 composition wiring.
});

test.skip('KNIFE-4: research remains read-only when the role is switched to executor', async () => {
  // Fill phaseHost.tryWriteAs({ phase: 'research', role: 'executor' }).
  // Reuse adapter / tool-entry intersection; do not invent a second permission system.
});

test.skip('KNIFE-4: review remains read-only when the role is switched to executor', async () => {
  // Same host as research; planner-layer model; stage permissions still intersect.
});

test.skip('KNIFE-4: in-phase implement test failure may replan but must not cross the delivery boundary', async () => {
  // Stage-local replan only; delivery success still requires the evidence gate.
});

test.skip('KNIFE-4: after rollback, independent Swarm still runs and flywheel cannot reopen handoff through it', async () => {
  // Use the test-double compositionEntry:'closed' harness, not a production
  // closed-entry primitive. Independent Swarm fixtures belong to knife-3.
});

test.skip('KNIFE-4: lifting the composition restriction must not regress knife-2 session policy or knife-3 Swarm isolation', async () => {
  // Pointer only until knife-2 and knife-3 land their final enablement and entry tests.
});
