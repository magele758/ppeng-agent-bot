import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffRuntimeEnabled, parseCapabilityTiers, trajectoryHandoffGateFromMetadata } from '@ppeng/agent-loop';
import { SqliteStateStore } from '../dist/storage.js';
import { createChatSession, createTaskSession } from '../dist/runtime/session-facade.js';
import { forkSession } from '../dist/session/session-fork.js';
import { readModelCatalog, writeModelCatalog } from '../dist/model/provider-catalog.js';
import { resolvePinnedRoleAdapter } from '../dist/model/role-pinning.js';

function openStore(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  return { dir, store };
}

function closeStore(dir, store) {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
}

function facadeHost(store) {
  return {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {},
  };
}

function pinCatalog() {
  const opened = openStore('knife2-pin-');
  writeModelCatalog(opened.store, {
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'test-key',
        models: [
          { id: 'primary-model', enabled: true },
          { id: 'other-model', enabled: true },
        ],
      },
    ],
    defaultRef: { providerId: 'openai', modelId: 'other-model' },
    fallbackRefs: [{ providerId: 'openai', modelId: 'other-model' }],
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return { ...opened, catalog: readModelCatalog(opened.store) };
}

test('bare chat and task creates persist auto policy with enabled false', () => {
  const { dir, store } = openStore('knife2-create-');
  try {
    const host = facadeHost(store);
    const chat = store.getSession(createChatSession(host, { title: 'bare chat' }).id);
    assert.equal(chat.metadata.handoffEnablement.source, 'auto_policy');
    assert.equal(chat.metadata.capabilityTiers.enablementSource, 'auto_policy');
    assert.equal(chat.metadata.capabilityTiers.enabled, false);
    assert.equal(trajectoryHandoffGateFromMetadata(chat.metadata).path, 'auto_eligible');
    assert.equal(handoffRuntimeEnabled(chat.metadata), false);

    const task = store.getSession(createTaskSession(host, { title: 'bare task' }).session.id);
    assert.equal(task.metadata.handoffEnablement.source, 'auto_policy');
    assert.equal(task.metadata.capabilityTiers.enablementSource, 'auto_policy');
    assert.equal(task.metadata.capabilityTiers.enabled, false);
    assert.equal(task.metadata.autoRun, true);
    assert.equal(trajectoryHandoffGateFromMetadata(task.metadata).path, 'auto_eligible');
  } finally {
    closeStore(dir, store);
  }
});

test('store.createSession with no enablement stays mechanism_off', () => {
  const { dir, store } = openStore('knife2-bypass-');
  try {
    const session = store.createSession({ title: 'bypass', mode: 'chat', agentId: 'general' });
    const stored = store.getSession(session.id);
    assert.notEqual(stored.metadata?.handoffEnablement?.source, 'auto_policy');
    assert.notEqual(stored.metadata?.capabilityTiers?.enablementSource, 'auto_policy');
    assert.equal(trajectoryHandoffGateFromMetadata(stored.metadata).path, 'mechanism_off');
    assert.equal(trajectoryHandoffGateFromMetadata(undefined).path, 'mechanism_off');
    assert.equal(handoffRuntimeEnabled(stored.metadata), false);
  } finally {
    closeStore(dir, store);
  }
});

test('forkSession of a session with no enablement record does not gain auto_policy', () => {
  const { dir, store } = openStore('knife2-fork-');
  try {
    const source = store.createSession({ title: 'unmarked', mode: 'chat', agentId: 'general' });
    store.appendMessage(source.id, 'assistant', [{ type: 'text', text: 'ok' }]);
    const forked = forkSession(store, { sourceSessionId: source.id });
    const child = store.getSession(forked.session.id);
    assert.notEqual(child.metadata?.handoffEnablement?.source, 'auto_policy');
    assert.notEqual(child.metadata?.capabilityTiers?.enablementSource, 'auto_policy');
    assert.equal(trajectoryHandoffGateFromMetadata(child.metadata).path, 'mechanism_off');
    assert.notEqual(store.getSession(source.id).metadata?.handoffEnablement?.source, 'auto_policy');
  } finally {
    closeStore(dir, store);
  }
});

test('createChatSession with capabilityTiers.enabled false stays explicit_off', () => {
  const { dir, store } = openStore('knife2-off-');
  try {
    const created = createChatSession(facadeHost(store), {
      title: 'closed',
      metadata: { capabilityTiers: { enabled: false } },
    });
    const stored = store.getSession(created.id);
    assert.equal(stored.metadata.capabilityTiers.enabled, false);
    assert.equal(stored.metadata.capabilityTiers.enablementSource, 'explicit_off');
    assert.notEqual(stored.metadata.handoffEnablement?.source, 'auto_policy');
    assert.equal(trajectoryHandoffGateFromMetadata(stored.metadata).path, 'mechanism_off');
    assert.equal(handoffRuntimeEnabled(stored.metadata), false);
  } finally {
    closeStore(dir, store);
  }
});

test('auto_policy without a handoff machine is auto_eligible and runtime-off', () => {
  const missingTiers = { handoffEnablement: { source: 'auto_policy' } };
  const taggedTiers = {
    handoffEnablement: { source: 'auto_policy' },
    capabilityTiers: { enablementSource: 'auto_policy', enabled: false },
  };
  for (const metadata of [missingTiers, taggedTiers]) {
    const gate = trajectoryHandoffGateFromMetadata(metadata);
    assert.equal(gate.path, 'auto_eligible');
    assert.notEqual(gate.enablementSource, 'explicit_off');
    assert.equal(handoffRuntimeEnabled(metadata), false);
  }
});

test('a non-object capabilityTiers value keeps auto eligibility and records a warning', () => {
  const metadata = {
    handoffEnablement: { source: 'auto_policy' },
    capabilityTiers: 'bad',
  };
  const gate = trajectoryHandoffGateFromMetadata(metadata);
  const parsed = parseCapabilityTiers('bad');
  const warning = metadata.handoffTierWarning
    ?? gate.tierWarning
    ?? gate.warning
    ?? (parsed.ok ? undefined : parsed.warning);
  assert.equal(gate.path, 'auto_eligible');
  assert.notEqual(gate.path, 'mechanism_off');
  assert.notEqual(gate.enablementSource, 'explicit_off');
  assert.equal(handoffRuntimeEnabled(metadata), false);
  if (metadata.capabilityTiers && typeof metadata.capabilityTiers === 'object') {
    assert.notEqual(metadata.capabilityTiers.enablementSource, 'explicit_off');
  }
  assert.equal(typeof warning, 'string');
  assert.ok(warning.length > 0);
});

test('explicit_off wins over trajectoryHandoffExplicit', () => {
  const metadata = {
    capabilityTiers: { enabled: false, enablementSource: 'explicit_off' },
    trajectoryHandoffExplicit: true,
    handoffEnablement: { source: 'auto_policy' },
    taskRunMode: 'plan_execute',
  };
  const gate = trajectoryHandoffGateFromMetadata(metadata);
  assert.equal(gate.path, 'mechanism_off');
  assert.equal(gate.enablementSource, 'explicit_off');
  assert.equal(handoffRuntimeEnabled(metadata), false);
});

test('legacy trajectory flags select in_machine or mechanism_off without capability tiers', () => {
  for (const metadata of [
    { trajectoryHandoff: 'on' },
    { trajectoryHandoffExplicit: true },
    { taskRunMode: 'plan_execute' },
    { task_run_mode: 'plan_execute' },
  ]) {
    assert.equal(trajectoryHandoffGateFromMetadata(metadata).path, 'in_machine');
    assert.equal(handoffRuntimeEnabled(metadata), true);
  }
  for (const metadata of [
    { trajectoryHandoff: 'off' },
    { taskRunMode: 'handoff_off' },
    { task_run_mode: 'handoff_off' },
  ]) {
    assert.equal(trajectoryHandoffGateFromMetadata(metadata).path, 'mechanism_off');
    assert.equal(handoffRuntimeEnabled(metadata), false);
  }
});

test('auto_policy with no role models resolves the pinned session model, not modelOverride', () => {
  const opened = pinCatalog();
  try {
    const resolved = resolvePinnedRoleAdapter({
      session: {
        metadata: {
          handoffEnablement: { source: 'auto_policy' },
          capabilityTiers: { enablementSource: 'auto_policy', enabled: false },
          handoffRole: 'planner',
          pinnedSessionModel: 'openai/primary-model',
          modelOverride: 'openai/other-model',
        },
      },
      catalog: opened.catalog,
      env: process.env,
    });
    assert.equal(resolved.handled, true);
    assert.equal(resolved.rolePinFailed, false);
    assert.equal(resolved.adapter?.modelName, 'openai/primary-model');
  } finally {
    closeStore(opened.dir, opened.store);
  }
});

test('an invalid explicit role ref falls back only to the pinned session model', () => {
  const opened = pinCatalog();
  try {
    const resolved = resolvePinnedRoleAdapter({
      session: {
        metadata: {
          capabilityTiers: {
            enabled: true,
            enablementSource: 'explicit_on',
            roles: { plannerModel: 'missing/nope' },
          },
          handoffRole: 'planner',
          pinnedSessionModel: 'openai/primary-model',
          modelOverride: 'openai/other-model',
        },
      },
      catalog: opened.catalog,
      env: process.env,
    });
    assert.equal(resolved.handled, true);
    assert.equal(resolved.rolePinFailed, false);
    assert.equal(resolved.adapter?.modelName, 'openai/primary-model');
  } finally {
    closeStore(opened.dir, opened.store);
  }
});

test('explicit handoff fails closed when the role ref and the pin are both invalid', () => {
  const opened = pinCatalog();
  try {
    const resolved = resolvePinnedRoleAdapter({
      session: {
        metadata: {
          capabilityTiers: {
            enabled: true,
            enablementSource: 'explicit_on',
            roles: { plannerModel: 'missing/nope' },
          },
          handoffRole: 'planner',
          pinnedSessionModel: 'missing/also',
          modelOverride: 'openai/other-model',
        },
      },
      catalog: opened.catalog,
      env: process.env,
    });
    assert.equal(resolved.handled, true);
    assert.equal(resolved.rolePinFailed, true);
    assert.notEqual(resolved.adapter?.modelName, 'openai/other-model');
    if (resolved.adapter) assert.equal(resolved.adapter.modelName, 'handoff-fail-closed');
  } finally {
    closeStore(opened.dir, opened.store);
  }
});