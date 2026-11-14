import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptDualModelHandoff } from '@ppeng/agent-loop';
import { SqliteStateStore } from '../dist/storage.js';
import { trajectoryHandoffGateFromMetadata } from '../dist/runtime/run-profile.js';
import { publicCatalogPayload, readModelCatalog, writeModelCatalog } from '../dist/model/provider-catalog.js';
import { resolveModelRoute } from '../dist/model/registry-router.js';
import { bindTurnKernelHost } from '../dist/runtime/l5-bindings.js';
import { createChatSession, createTaskSession } from '../dist/runtime/session-facade.js';
import { commitVersionedPlan, loadPlanState, savePlanState } from '../dist/tools/plan-tools.js';
import { mergePersistedCapabilityTiers } from '../dist/trajectory-handoff/persist.js';

function memStore() {
  const bag = new Map();
  return {
    getDaemonControl(key) { return bag.get(key); },
    setDaemonControl(key, value) { bag.set(key, value); },
  };
}

function catalog() {
  const store = memStore();
  writeModelCatalog(store, {
    providers: [
      {
        id: 'pinned',
        name: 'Pinned',
        kind: 'openai-compatible',
        baseUrl: 'https://pin.example/v1',
        apiKey: 'pin-key',
        models: [{ id: 'model-a', enabled: true }],
      },
      {
        id: 'other',
        name: 'Other',
        kind: 'openai-compatible',
        baseUrl: 'https://other.example/v1',
        apiKey: 'other-key',
        models: [{ id: 'model-b', enabled: true }],
      },
    ],
    defaultRef: { providerId: 'other', modelId: 'model-b' },
    fallbackRefs: [{ providerId: 'other', modelId: 'model-b' }],
    updatedAt: '2026-01-01T00:00:00.000Z',
    capabilityTiers: {
      enabled: false,
      enablementSource: 'explicit_off',
      roles: { plannerModel: 'pinned/model-a' },
    },
  });
  return store;
}

function session(pinnedSessionModel, roleModel) {
  return {
    id: 's-pin',
    metadata: {
      capabilityTiers: { enabled: true, roles: { plannerModel: roleModel } },
      handoffRole: 'planner',
      pinnedSessionModel,
      modelOverride: 'other/model-b',
    },
  };
}

const fallbackAdapter = {
  name: 'catalog-fallback',
  modelName: 'other/model-b',
  async runTurn() { return { stopReason: 'end', assistantParts: [] }; },
  async summarizeMessages() { return ''; },
};

test('catalog read-back keeps an explicit close and its role ref', () => {
  const store = catalog();
  const read = readModelCatalog(store);
  assert.equal(read.capabilityTiers.enablementSource, 'explicit_off');
  assert.equal(read.capabilityTiers.enabled, false);
  assert.equal(read.capabilityTiers.roles.plannerModel, 'pinned/model-a');
  const payload = publicCatalogPayload(store);
  assert.equal(payload.catalog.capabilityTiers.roles.plannerModel, 'pinned/model-a');
});

test('explicit close is not reopened by a parser-default rewrite [AC:trajectory-handoff-explicit#TH-3]', () => {
  const merged = mergePersistedCapabilityTiers(
    {
      enabled: false,
      enablementSource: 'explicit_off',
      roles: { plannerModel: 'pinned/model-a' },
      caps: { perTurn: 2, perSession: 4 },
    },
    { enablementSource: 'parser_default', enabled: true }
  );
  assert.equal(merged.enablementSource, 'explicit_off');
  assert.equal(merged.enabled, false);
  assert.equal(merged.roles.plannerModel, 'pinned/model-a');
  assert.equal(merged.caps.perTurn, 2);
});

test('resolveModelRoute uses the pinned session model and ignores fallback refs [AC:trajectory-handoff-explicit#TH-6]', () => {
  const store = catalog();
  const route = resolveModelRoute({
    store,
    session: session('pinned/model-a', 'missing/nope'),
    fallbackAdapter,
  });
  assert.equal(route.rolePinFailed, undefined);
  assert.equal(route.candidates.length, 1);
  assert.equal(route.candidates[0].modelName, 'pinned/model-a');
  assert.notEqual(route.candidates[0].modelName, 'other/model-b');
});

test('resolveModelRoute fails closed when the role model and the pin are both invalid [AC:trajectory-handoff-explicit#TH-7]', async () => {
  const store = catalog();
  const route = resolveModelRoute({
    store,
    session: session('missing/also', 'missing/nope'),
    fallbackAdapter,
  });
  assert.equal(route.rolePinFailed, true);
  assert.equal(route.candidates.length, 1);
  assert.equal(route.candidates[0].name, 'handoff-fail-closed');
  await assert.rejects(() => route.candidates[0].runTurn({}), /failed closed/);
});

test('bindTurnKernelHost resolveModelAdapter returns the pin, not modelOverride', () => {
  const store = catalog();
  store.db = { exec() {} };
  const host = bindTurnKernelHost({
    store,
    repoRoot: '/tmp/repo',
    stateDir: '/tmp/state',
    tools: [],
    modelAdapter: fallbackAdapter,
    promptBuilder: { buildSystemPrompt: async () => '', buildMemoryAppendix: () => '' },
  });
  const adapter = host.resolveModelAdapter(session('pinned/model-a', 'missing/nope'));
  assert.equal(adapter.modelName, 'pinned/model-a');
});

test('session create stores product tiers and does not enable a bare session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-session-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const host = {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {},
  };
  try {
    const closed = createChatSession(host, {
      title: 'closed',
      metadata: {
        capabilityTiers: {
          enabled: false,
          planner: { model: 'anthropic/claude' },
          caps: { perTurn: 2, perSession: 4 },
        },
      },
    });
    assert.equal(closed.metadata.capabilityTiers.enablementSource, 'explicit_off');
    assert.equal(closed.metadata.capabilityTiers.enabled, false);
    assert.equal(closed.metadata.capabilityTiers.roles.plannerModel, 'anthropic/claude');
    assert.equal(closed.metadata.capabilityTiers.caps.perTurn, 2);
    assert.equal(closed.metadata.capabilityTiers.caps.perSession, 4);

    const bare = createChatSession(host, { title: 'bare' });
    assert.notEqual(bare.metadata?.capabilityTiers?.enabled, true);

    const task = createTaskSession(host, {
      title: 'later',
      metadata: { handoffEnablement: { source: 'auto_policy' } },
    });
    assert.equal(task.session.metadata.capabilityTiers.enablementSource, 'auto_policy');
    assert.equal(task.session.metadata.capabilityTiers.enabled, false);
    assert.equal(task.session.metadata.autoRun, true);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitVersionedPlan does not let a stale writer replace the file [AC:trajectory-handoff-explicit#TH-8]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-plan-'));
  try {
    await savePlanState(dir, 's1', {
      analysis: 'unversioned',
      confirmed: false,
      steps: [{ title: 'old', status: 'pending' }],
    });
    const loaded = await loadPlanState(dir, 's1');
    assert.equal(loaded.version, undefined);
    const first = await commitVersionedPlan(
      dir,
      's1',
      { analysis: 'committed', confirmed: true, steps: [{ id: 's2', title: 'new', status: 'pending' }] },
      { expectedOldVersion: 0, newVersion: 1 }
    );
    assert.equal(first.ok, true);
    const clash = await commitVersionedPlan(
      dir,
      's1',
      { analysis: 'lost', confirmed: false, steps: [] },
      { expectedOldVersion: 0, newVersion: 2 }
    );
    assert.equal(clash.ok, false);
    assert.equal(clash.conflict, true);
    const after = await loadPlanState(dir, 's1');
    assert.equal(after.version, 1);
    assert.equal(after.analysis, 'committed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scripted handoff pack and the core gate export stay explicit', () => {
  const handoff = scriptDualModelHandoff();
  assert.equal(handoff.planVersion, 2);
  assert.equal(handoff.resumedStepId, 'step-new');
  assert.equal(handoff.skippedDuplicate, true);
  assert.equal(handoff.sameMachine, true);
  assert.equal(handoff.pack.toolPairs[0].name, 'read_file');
  assert.equal(handoff.pack.failureEvidence.stepId, 'step-old');
  assert.equal(trajectoryHandoffGateFromMetadata(undefined).enabled, false);
  assert.equal(trajectoryHandoffGateFromMetadata({ capabilityTiers: { enabled: true } }).enabled, true);
  assert.equal(trajectoryHandoffGateFromMetadata({
    capabilityTiers: { enabled: false, enablementSource: 'explicit_off' },
    trajectoryHandoffExplicit: true,
  }).enabled, false);
});
