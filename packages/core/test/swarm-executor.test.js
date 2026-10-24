import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { SwarmStore } from '../dist/swarm/store.js';
import { SqliteStateStore } from '../dist/storage.js';
import { createSwarmId, nowIso } from '../dist/swarm/store.js';

test('SwarmExecutor: startRun seeds tasks and tick claims pipeline task', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'swarm-exec-'));
  const sqlite = new SqliteStateStore(join(stateDir, 'state.db'));
  const store = new SwarmStore(sqlite.db);
  const sessions = [];
  const messages = new Map();

  const executor = new SwarmExecutor({
    store,
    listSessions: () => sessions,
    getSession: (id) => sessions.find((s) => s.id === id),
    createTeammateSession: ({ name, role, prompt, metadata }) => {
      const rec = {
        id: `sess_${sessions.length + 1}`,
        agentId: role,
        status: 'idle',
        mode: 'task',
        metadata: metadata ?? {}
      };
      sessions.push(rec);
      messages.set(rec.id, []);
      return rec;
    },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: (sid) => {
      const s = sessions.find((x) => x.id === sid);
      if (!s) return false;
      if (s.status === 'completed') return true;
      if (s.status !== 'idle') return false;
      return (messages.get(sid) ?? []).some((m) => m.role === 'assistant' || m.role === 'tool');
    }
  });

  const runId = createSwarmId('srun');
  store.createRun({
    id: runId,
    goal: 'test goal',
    status: 'pending',
    strategy: 'pipeline',
    budget: { maxTeammates: 2, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
    qualityGate: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  const started = executor.startRun(runId, [{ title: 'Do work', requiredRole: 'implementer' }]);
  assert.ok(started);
  assert.equal(started.status, 'running');

  await executor.tick();
  const tasks = store.listTasks(runId);
  assert.equal(tasks.length, 1);
  assert.ok(['in_progress', 'done', 'review'].includes(tasks[0].status));
  sqlite.db.close();
});

test('SwarmExecutor: idle teammate without output does not mark task done', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'swarm-idle-'));
  const sqlite = new SqliteStateStore(join(stateDir, 'state.db'));
  const store = new SwarmStore(sqlite.db);
  const sessions = [];

  const executor = new SwarmExecutor({
    store,
    listSessions: () => sessions,
    getSession: (id) => sessions.find((s) => s.id === id),
    createTeammateSession: () => {
      const rec = { id: 'sess_idle', agentId: 'general', status: 'idle', mode: 'teammate', metadata: {} };
      sessions.push(rec);
      return rec;
    },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => false
  });

  const runId = createSwarmId('srun');
  store.createRun({
    id: runId,
    goal: 'idle race',
    status: 'running',
    strategy: 'pipeline',
    budget: { maxTeammates: 2, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
    qualityGate: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  const taskId = createSwarmId('stask');
  store.createTask({
    id: taskId,
    swarmRunId: runId,
    title: 'Wait for run',
    status: 'in_progress',
    requiredRole: 'implementer',
    capabilityTags: [],
    acceptanceCriteria: [],
    artifacts: ['session:sess_idle'],
    blockedBy: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  await executor.tick();
  assert.equal(store.listTasks(runId)[0].status, 'in_progress');

  sqlite.db.close();
});

test('SwarmExecutor: an unfinished idle teammate keeps its maxTeammates slot', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'swarm-quota-'));
  const sqlite = new SqliteStateStore(join(stateDir, 'state.db'));
  const store = new SwarmStore(sqlite.db);
  const sessions = [];
  const runId = createSwarmId('srun');
  const executor = new SwarmExecutor({
    store,
    listSessions: () => sessions,
    getSession: (id) => sessions.find((s) => s.id === id),
    createTeammateSession: () => {
      const rec = { id: `sess_${sessions.length + 1}`, agentId: 'general', status: 'idle', mode: 'teammate', metadata: { swarmRunId: runId } };
      sessions.push(rec);
      return rec;
    },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => false
  });
  store.createRun({
    id: runId, goal: 'quota', status: 'running', strategy: 'pipeline',
    budget: { maxTeammates: 1, maxTurnsPerAgent: 5, maxDurationMs: 60_000 },
    qualityGate: [], createdAt: nowIso(), updatedAt: nowIso()
  });
  for (const title of ['First', 'Second']) {
    store.createTask({
      id: createSwarmId('stask'), swarmRunId: runId, title, status: 'pending', requiredRole: 'implementer',
      capabilityTags: [], acceptanceCriteria: [], artifacts: [], blockedBy: [], createdAt: nowIso(), updatedAt: nowIso()
    });
  }
  await executor.tick();
  await executor.tick();
  const tasks = store.listTasks(runId);
  assert.equal(tasks.filter((task) => task.status === 'in_progress').length, 1);
  assert.equal(tasks.filter((task) => task.status === 'pending').length, 1);
  assert.equal(sessions.length, 1);
  sqlite.db.close();
});
