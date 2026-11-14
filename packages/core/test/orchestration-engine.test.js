import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrchestrationEngine } from '../dist/orchestrator/engine.js';
import { OrchestratorStore } from '../dist/orchestrator/store.js';
import { SwarmStore, createSwarmId, nowIso } from '../dist/swarm/store.js';
import { SqliteStateStore } from '../dist/storage.js';

const BOUND_EVIDENCE = {
  planVersion: 1,
  taskScope: 'implement',
  verifiedPlanVersion: 1,
  verifiedTaskScope: 'implement',
  available: true
};
const GOOD_IMPLEMENT_REPORT = {
  passed: true,
  summary: 'verified',
  checks: [{ criterion: 'correct output', passed: true, evidence: ['read-1'] }],
  handoffEvidence: BOUND_EVIDENCE
};

test('OrchestrationEngine: implement step stays running until swarm is terminal', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'orch-engine-'));
  const sqlite = new SqliteStateStore(join(stateDir, 'state.db'));
  const orchStore = new OrchestratorStore(sqlite.db);
  const swarmStore = new SwarmStore(sqlite.db);

  const run = orchStore.createRun({
    title: 'Orchestrated feature',
    sourceType: 'test',
    sourceRef: 'item-1',
    flywheels: ['D'],
    capabilityTags: ['runtime'],
    riskLevel: 'low'
  });

  let linkedSwarmId;

  const engine = new OrchestrationEngine({
    store: orchStore,
    startSwarmForRun: async (orchRun) => {
      linkedSwarmId = createSwarmId('srun');
      swarmStore.createRun({
        id: linkedSwarmId,
        goal: orchRun.title,
        orchestrationRunId: orchRun.id,
        status: 'running',
        strategy: 'pipeline',
        budget: { maxTeammates: 1, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
        qualityGate: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    },
    getSwarmForOrchestrationRun: (orchId) =>
      swarmStore.listRuns({ limit: 50 }).find((r) => r.orchestrationRunId === orchId)
  });

  for (let i = 0; i < 8; i += 1) {
    await engine.tick();
    const implement = orchStore.listSteps(run.id).find((s) => s.stage === 'implement');
    if (implement?.status === 'running') break;
  }

  const implementRunning = orchStore.listSteps(run.id).find((s) => s.stage === 'implement');
  assert.equal(implementRunning?.status, 'running');
  assert.ok(linkedSwarmId);

  await engine.tick();
  assert.equal(
    orchStore.listSteps(run.id).find((s) => s.stage === 'implement')?.status,
    'running',
    'implement should not complete while swarm is still running'
  );

  swarmStore.updateRunStatus(linkedSwarmId, 'completed');
  await engine.tick();

  const implementBlocked = orchStore.listSteps(run.id).find((s) => s.stage === 'implement');
  assert.equal(implementBlocked?.status, 'failed', 'implement must not complete without the evidence gate');
  assert.equal(orchStore.getRun(run.id).status, 'failed');
  assert.match(implementBlocked?.outputArtifact ?? '', /gate_not_invoked|swarm:/);

  sqlite.db.close();
});

test('OrchestrationEngine: research step runs pipeline and records artifact', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'orch-research-'));
  const sqlite = new SqliteStateStore(join(stateDir, 'state.db'));
  const orchStore = new OrchestratorStore(sqlite.db);

  const run = orchStore.createRun({
    title: 'Research topic',
    sourceType: 'test',
    sourceRef: 'ref-1',
    flywheels: ['A'],
    capabilityTags: ['deepresearch'],
    riskLevel: 'low'
  });

  const engine = new OrchestrationEngine({
    store: orchStore,
    runResearch: async (r) => `research:mock:${r.id}`
  });

  for (let i = 0; i < 6; i += 1) {
    await engine.tick();
    const research = orchStore.listSteps(run.id).find((s) => s.stage === 'research');
    if (research?.status === 'completed') break;
  }

  const research = orchStore.listSteps(run.id).find((s) => s.stage === 'research');
  assert.equal(research?.status, 'completed');
  assert.match(research?.outputArtifact ?? '', /^research:mock:/);

  sqlite.db.close();
});


test('OrchestrationEngine: implement succeeds only after the evidence gate passes', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'orch-engine-gate-'));
  const sqlite = new SqliteStateStore(join(stateDir, 'state.db'));
  const orchStore = new OrchestratorStore(sqlite.db);
  const swarmStore = new SwarmStore(sqlite.db);

  const run = orchStore.createRun({
    title: 'Orchestrated feature with evidence',
    sourceType: 'test',
    sourceRef: 'item-gate',
    flywheels: ['D'],
    capabilityTags: ['runtime'],
    riskLevel: 'low'
  });

  let linkedSwarmId;
  const engine = new OrchestrationEngine({
    store: orchStore,
    startSwarmForRun: async (orchRun) => {
      linkedSwarmId = createSwarmId('srun');
      swarmStore.createRun({
        id: linkedSwarmId,
        goal: orchRun.title,
        orchestrationRunId: orchRun.id,
        status: 'running',
        strategy: 'pipeline',
        budget: { maxTeammates: 1, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
        qualityGate: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    },
    getSwarmForOrchestrationRun: (orchId) =>
      swarmStore.listRuns({ limit: 50 }).find((r) => r.orchestrationRunId === orchId),
    getImplementQualityReport: () => GOOD_IMPLEMENT_REPORT
  });

  for (let i = 0; i < 8; i += 1) {
    await engine.tick();
    const implement = orchStore.listSteps(run.id).find((s) => s.stage === 'implement');
    if (implement?.status === 'running') break;
  }

  swarmStore.updateRunStatus(linkedSwarmId, 'completed');
  await engine.tick();
  const implementDone = orchStore.listSteps(run.id).find((s) => s.stage === 'implement');
  assert.equal(implementDone?.status, 'completed');
  assert.match(implementDone?.outputArtifact ?? '', /^swarm:/);
  assert.equal(orchStore.getRun(run.id).status, 'running');
  sqlite.db.close();
});
