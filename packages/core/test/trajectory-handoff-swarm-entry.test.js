/**
 * Knife 3: approved independent Swarm entry, fail-closed sources, explicit off.
 * Flywheel stays closed. Worker metadata cannot open the entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { SwarmStore, createSwarmId, nowIso } from '../dist/swarm/store.js';
import { SqliteStateStore } from '../dist/storage.js';
import {
  admitSwarmHandoff,
  readSwarmHandoffEntrySwitch,
  SWARM_HANDOFF_ENTRY_CONTROL_KEY,
  trustedContextForSwarmRun,
} from '../dist/trajectory-handoff/swarm-entry.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'k3-entry-'));
  const sqlite = new SqliteStateStore(join(dir, 'state.db'));
  return { sqlite, store: new SwarmStore(sqlite.db), close: () => sqlite.db.close() };
}

function budget() {
  return { maxTeammates: 2, maxTurnsPerAgent: 5, maxDurationMs: 60_000 };
}

function seedRun(store, overrides = {}) {
  const id = overrides.id ?? createSwarmId('srun');
  const now = nowIso();
  store.createRun({
    id,
    goal: 'independent work',
    status: 'pending',
    strategy: 'pipeline',
    budget: budget(),
    qualityGate: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  });
  return id;
}

function host(store, options = {}) {
  const sessions = [];
  const executor = new SwarmExecutor({
    store,
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
    trustedHandoff: options.trustedHandoff === null
      ? undefined
      : (run) => trustedContextForSwarmRun(run, options.entryEnabled !== false, options.explicitOff === true),
    swarmHandoffEntryEnabled: options.entryEnabled !== false,
    swarmHandoffExplicitOff: options.explicitOff === true,
  });
  return { executor, sessions };
}

test('exact independent_swarm opens; missing, unknown, and inexact sources stay closed', () => {
  const opened = admitSwarmHandoff({
    trusted: { source: 'independent_swarm', entryEnabled: true, explicitOff: false, orchestrationRunId: null },
    workerMetadata: { source: 'flywheel', enabled: false },
  });
  assert.deepEqual(opened, { open: true, source: 'independent_swarm' });

  assert.equal(admitSwarmHandoff({ trusted: null, workerMetadata: { source: 'independent_swarm', enabled: true } }).reason, 'no_trusted_context');
  assert.equal(admitSwarmHandoff({ trusted: { entryEnabled: true }, workerMetadata: null }).reason, 'source_not_admitted');
  for (const source of ['', 'Independent_Swarm', ' independent_swarm ', 'INDEPENDENT_SWARM', 1, ['independent_swarm'], { kind: 'independent_swarm' }, 'flywheelish']) {
    assert.equal(
      admitSwarmHandoff({ trusted: { source, entryEnabled: true, explicitOff: false }, workerMetadata: null }).reason,
      'source_not_admitted',
      `source ${JSON.stringify(source)} must not default to independent_swarm`,
    );
  }
  assert.equal(admitSwarmHandoff({
    trusted: { source: 'flywheel', entryEnabled: true, orchestrationRunId: null },
  }).reason, 'flywheel_source');
  assert.equal(admitSwarmHandoff({
    trusted: { source: 'independent_swarm', entryEnabled: true, orchestrationRunId: 'orch-1' },
  }).reason, 'flywheel_orchestration');
  assert.equal(admitSwarmHandoff({
    trusted: { entryEnabled: true, orchestrationRunId: 'orch-1' },
  }).reason, 'flywheel_orchestration');
});

test('explicit off wins over an enabled independent_swarm claim', () => {
  const closed = admitSwarmHandoff({
    trusted: { source: 'independent_swarm', entryEnabled: true, explicitOff: true },
    workerMetadata: { trajectoryHandoff: 'on', source: 'independent_swarm' },
  });
  assert.equal(closed.reason, 'explicit_off');
  assert.equal(admitSwarmHandoff({
    trusted: { source: 'independent_swarm', entryEnabled: false, explicitOff: false },
  }).reason, 'swarm_entry_closed');
});

test('host switch: missing opens, explicit off closes, illegal values fail closed', () => {
  assert.deepEqual(readSwarmHandoffEntrySwitch(undefined), { enabled: true, explicitOff: false });
  assert.deepEqual(readSwarmHandoffEntrySwitch(null), { enabled: true, explicitOff: false });
  assert.deepEqual(readSwarmHandoffEntrySwitch(true), { enabled: true, explicitOff: false });
  assert.deepEqual(readSwarmHandoffEntrySwitch('on'), { enabled: true, explicitOff: false });
  assert.deepEqual(readSwarmHandoffEntrySwitch({ enabled: true }), { enabled: true, explicitOff: false });
  for (const stored of [false, 'off', 'explicit_off', { enabled: false }, { explicitOff: true }, { enabled: true, source: 'explicit_off' }, { enabled: true, explicitOff: true }, 'Independent_Swarm', 1, [], {}]) {
    const decision = readSwarmHandoffEntrySwitch(stored);
    assert.equal(decision.enabled, false, JSON.stringify(stored));
    assert.equal(decision.explicitOff, true, JSON.stringify(stored));
  }
});

test('persisted explicit off closes the runtime collaborator switch', () => {
  const { sqlite, close } = fixture();
  try {
    sqlite.setDaemonControl(SWARM_HANDOFF_ENTRY_CONTROL_KEY, { source: 'explicit_off', enabled: true });
    assert.deepEqual(readSwarmHandoffEntrySwitch(sqlite.getDaemonControl(SWARM_HANDOFF_ENTRY_CONTROL_KEY)), {
      enabled: false,
      explicitOff: true,
    });
    sqlite.setDaemonControl(SWARM_HANDOFF_ENTRY_CONTROL_KEY, null);
  } finally {
    close();
  }
});

test('live independent swarm dispatch stamps host handoff metadata', async () => {
  const { store, close } = fixture();
  try {
    const { executor, sessions } = host(store);
    const runId = seedRun(store);
    executor.startRun(runId, [{ title: 'Do work', requiredRole: 'implementer' }]);
    await executor.tick();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].metadata.handoffEnablement.source, 'explicit_on');
    assert.equal(sessions[0].metadata.capabilityTiers.enabled, true);
    assert.equal(typeof sessions[0].metadata.handoffState, 'string');
    assert.equal(sessions[0].metadata.source, undefined);
  } finally {
    close();
  }
});

test('flywheel orchestration id does not enable handoff on the shared executor', async () => {
  const { store, close } = fixture();
  try {
    const { executor, sessions } = host(store);
    const runId = seedRun(store, { orchestrationRunId: 'flywheel-implement-1', status: 'pending' });
    const trusted = trustedContextForSwarmRun(store.getRun(runId), true, false);
    assert.equal(trusted.source, 'flywheel');
    executor.startRun(runId, [{ title: 'Implement', requiredRole: 'implementer' }]);
    await executor.tick();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].metadata.handoffEnablement, undefined);
    assert.equal(sessions[0].metadata.handoffState, undefined);
    assert.deepEqual(
      Object.keys(sessions[0].metadata).sort(),
      ['autoRun', 'swarmRunId', 'swarmTaskId'],
    );
  } finally {
    close();
  }
});

test('worker-writable metadata cannot open a closed entry', async () => {
  const { store, close } = fixture();
  try {
    const sessions = [];
    const executor = new SwarmExecutor({
      store,
      listSessions: () => sessions,
      getSession: (id) => sessions.find((session) => session.id === id),
      createTeammateSession: ({ metadata }) => {
        const claimed = { ...(metadata ?? {}), source: 'independent_swarm', trajectoryHandoff: 'on', enabled: true };
        const rec = { id: 'worker', status: 'idle', metadata: claimed };
        sessions.push(rec);
        return rec;
      },
      runSession: async () => {},
      enqueueSchedulerWake: () => {},
      sessionTeammateFinished: () => false,
    });
    const runId = seedRun(store);
    executor.startRun(runId, [{ title: 'Self report', requiredRole: 'implementer' }]);
    await executor.tick();
    assert.equal(sessions[0].metadata.handoffEnablement, undefined);
    assert.equal(admitSwarmHandoff({ trusted: null, workerMetadata: sessions[0].metadata }).open, false);
  } finally {
    close();
  }
});

test('explicit off and the runtime switch stop new admission without rewriting ordinary sessions', async () => {
  const { store, close } = fixture();
  try {
    const ordinary = { id: 'chat-1', status: 'idle', metadata: { handoffEnablement: { source: 'auto_policy' }, capabilityTiers: { enablementSource: 'auto_policy', enabled: false } } };
    const { executor, sessions } = host(store, { entryEnabled: true });
    sessions.push(ordinary);
    executor.setSwarmHandoffEntryEnabled(false);
    const runId = seedRun(store);
    executor.startRun(runId, [{ title: 'After close', requiredRole: 'implementer' }]);
    await executor.tick();
    const dispatched = sessions.find((session) => session.id !== 'chat-1');
    assert.ok(dispatched);
    assert.equal(dispatched.metadata.handoffEnablement, undefined);
    assert.equal(ordinary.metadata.handoffEnablement.source, 'auto_policy');
    assert.equal(ordinary.metadata.capabilityTiers.enablementSource, 'auto_policy');
    executor.setSwarmHandoffEntryEnabled(true);
    const reopened = seedRun(store);
    executor.startRun(reopened, [{ title: 'After reopen', requiredRole: 'implementer' }]);
    await executor.tick();
    const again = sessions.find((session) => session.metadata.swarmRunId === reopened);
    assert.equal(again.metadata.handoffEnablement.source, 'explicit_on');
    assert.equal(ordinary.metadata.handoffEnablement.source, 'auto_policy');
  } finally {
    close();
  }
});

test('trusted explicit off wins even when the entry switch is on', async () => {
  const { store, close } = fixture();
  try {
    const { executor, sessions } = host(store, { entryEnabled: true, explicitOff: true });
    const runId = seedRun(store);
    executor.startRun(runId, [{ title: 'Off wins', requiredRole: 'implementer' }]);
    await executor.tick();
    assert.equal(sessions[0].metadata.handoffState, undefined);
  } finally {
    close();
  }
});

test('non-pipeline strategies still fail closed and do not admit handoff', async () => {
  const { store, close } = fixture();
  try {
    for (const strategy of ['parallel-review', 'best-of-n', 'debate', 'research-implement-review']) {
      const { executor, sessions } = host(store, { entryEnabled: true });
      const runId = seedRun(store, { strategy, status: 'running' });
      await executor.tick();
      assert.equal(store.getRun(runId).status, 'failed', strategy);
      assert.equal(sessions.length, 0, strategy);
    }
  } finally {
    close();
  }
});
