import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { SwarmStore, createSwarmId, nowIso } from '../dist/swarm/store.js';
import { SqliteStateStore } from '../dist/storage.js';
import { AutonomousScheduler } from '../dist/services/autonomous-scheduler.js';

test('Swarm pipeline: dispatch enqueues wake, scheduler runs session, task becomes done', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'swarm-sched-'));
  const sqlite = new SqliteStateStore(join(stateDir, 'state.db'));
  const swarmStore = new SwarmStore(sqlite.db);

  sqlite.upsertAgent({
    id: 'general',
    name: 'general',
    role: 'assistant',
    instructions: 'test',
    capabilities: ['teammate']
  });

  const runSessionCalls = [];

  const executor = new SwarmExecutor({
    store: swarmStore,
    reviewTask: async () => ({ passed: true, summary: "test evaluator", checks: [{ criterion: "Ship feature", passed: true, evidence: ["fixture-inspection"] }] }),
    listSessions: () => sqlite.listSessions(),
    getSession: (id) => sqlite.getSession(id),
    createTeammateSession: ({ name, role, prompt, background, metadata }) => {
      const session = sqlite.createSession({
        title: `Teammate ${name}`,
        mode: 'teammate',
        agentId: 'general',
        background: background ?? true,
        metadata: metadata ?? {}
      });
      sqlite.appendMessage(session.id, 'user', [{ type: 'text', text: prompt }]);
      return session;
    },
    runSession: async (sid) => {
      runSessionCalls.push(sid);
      sqlite.updateSession(sid, { status: 'completed' });
    },
    enqueueSchedulerWake: (sid, reason) => sqlite.enqueueSchedulerWake(sid, reason),
    sessionTeammateFinished: (sid) => {
      const session = sqlite.getSession(sid);
      if (!session) return false;
      if (session.status === 'completed') return true;
      if (session.status !== 'idle') return false;
      return sqlite.listMessages(sid).some((m) => m.role === 'assistant' || m.role === 'tool');
    }
  });

  const scheduler = new AutonomousScheduler({
    store: sqlite,
    runSession: async (sid) => {
      runSessionCalls.push(sid);
      sqlite.updateSession(sid, { status: 'completed' });
    }
  });

  const runId = createSwarmId('srun');
  swarmStore.createRun({
    id: runId,
    goal: 'integration goal',
    status: 'pending',
    strategy: 'pipeline',
    budget: { maxTeammates: 2, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
    qualityGate: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  executor.startRun(runId, [{ title: 'Ship feature', requiredRole: 'implementer' }]);

  await executor.tick();
  const taskAfterDispatch = swarmStore.listTasks(runId)[0];
  assert.equal(taskAfterDispatch.status, 'in_progress');
  assert.ok(taskAfterDispatch.artifacts.some((a) => a.startsWith('session:')));

  await scheduler.tick();
  assert.ok(runSessionCalls.length >= 1, 'scheduler should run teammate session');

  await executor.tick();
  const taskFinal = swarmStore.listTasks(runId)[0];
  assert.equal(taskFinal.status, 'done');
  assert.equal(swarmStore.getRun(runId).status, 'completed');

  sqlite.db.close();
});
