import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptDualModelHandoff } from '@ppeng/agent-loop';
import { SqliteStateStore } from '../dist/storage.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { trajectoryHandoffGateFromMetadata } from '../dist/runtime/run-profile.js';
import { compactFrom } from '../dist/runtime/l5-bindings.js';
import { MODEL_FALLBACK_SETTINGS_KEY } from '../dist/model/fallback-chain.js';
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

test('catalog and session reload keep explicit_off, parser_default, both roles, and caps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-reload-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    writeModelCatalog(store, {
      providers: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
      capabilityTiers: {
        enabled: false,
        enablementSource: 'explicit_off',
        roles: { plannerModel: 'pinned/model-a', executorModel: 'other/model-b' },
        caps: { perTurn: 2, perSession: 4 },
      },
    });
    const closed = readModelCatalog(store);
    assert.equal(closed.capabilityTiers.enablementSource, 'explicit_off');
    assert.equal(closed.capabilityTiers.enabled, false);
    assert.equal(closed.capabilityTiers.roles.executorModel, 'other/model-b');
    assert.equal(closed.capabilityTiers.caps.perSession, 4);

    writeModelCatalog(store, {
      providers: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
      capabilityTiers: {
        enabled: false,
        enablementSource: 'parser_default',
        roles: { plannerModel: 'pinned/model-a', executorModel: 'other/model-b' },
        caps: { perTurn: 3, perSession: 6 },
      },
    });
    const parsed = readModelCatalog(store);
    assert.equal(parsed.capabilityTiers.enablementSource, 'parser_default');
    assert.notEqual(parsed.capabilityTiers.enablementSource, 'explicit_off');
    assert.equal(parsed.capabilityTiers.roles.plannerModel, 'pinned/model-a');
    assert.equal(parsed.capabilityTiers.caps.perTurn, 3);

    const host = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions() {}, wakeAgentSessions() {} };
    const created = createChatSession(host, {
      title: 'parser',
      metadata: { capabilityTiers: parsed.capabilityTiers },
    });
    store.db.close();
    const reopened = new SqliteStateStore(join(dir, 'state.db'));
    try {
      const again = reopened.getSession(created.id);
      assert.equal(again.metadata.capabilityTiers.enablementSource, 'parser_default');
      assert.equal(again.metadata.capabilityTiers.roles.executorModel, 'other/model-b');
      assert.equal(again.metadata.capabilityTiers.caps.perSession, 6);
    } finally {
      reopened.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function pinRuntime(dir) {
  return new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    tools: [],
    modelAdapter: fallbackAdapter,
  });
}

test('compact resolves the pinned model instead of modelOverride or a VL wrap', async () => {
  const store = catalog();
  writeModelCatalog(store, {
    providers: [
      { id: 'heuristic', name: 'Heuristic', kind: 'heuristic', models: [{ id: 'heuristic', enabled: true }] },
      { id: 'other', name: 'Other', kind: 'openai-compatible', baseUrl: 'https://other.example', apiKey: 'other', models: [{ id: 'model-b', enabled: true }] },
    ],
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const previous = process.env.RAW_AGENT_VL_MODEL_NAME;
  process.env.RAW_AGENT_VL_MODEL_NAME = 'vl/should-not-wrap';
  try {
    const adapter = compactFrom({
      store,
      modelAdapter: fallbackAdapter,
      emitTrace() {},
    }).resolveModelAdapter({
      id: 's-pin',
      metadata: {
        capabilityTiers: { enabled: true, roles: { plannerModel: 'heuristic/heuristic' } },
        handoffRole: 'planner',
        pinnedSessionModel: 'heuristic/heuristic',
        modelOverride: 'other/model-b',
      },
    });
    assert.equal(adapter.modelName, 'heuristic/heuristic');
    assert.notEqual(adapter.constructor.name, 'HybridModelRouterAdapter');
    const summary = await adapter.summarizeMessages({ messages: [], reason: 'pin', agent: { id: 'general' } });
    assert.match(summary, /^Summary for/);
  } finally {
    if (previous === undefined) delete process.env.RAW_AGENT_VL_MODEL_NAME;
    else process.env.RAW_AGENT_VL_MODEL_NAME = previous;
  }
});

test('runTurnWithRetries answers from the pinned heuristic model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-pin-turn-'));
  const rt = pinRuntime(dir);
  const previous = process.env.RAW_AGENT_VL_MODEL_NAME;
  process.env.RAW_AGENT_VL_MODEL_NAME = 'vl/should-not-wrap';
  try {
    writeModelCatalog(rt.store, {
      providers: [
        { id: 'heuristic', name: 'Heuristic', kind: 'heuristic', models: [{ id: 'heuristic', enabled: true }] },
        {
          id: 'dead',
          name: 'Dead',
          kind: 'openai-compatible',
          baseUrl: 'http://pin.invalid/v1',
          apiKey: 'dead',
          models: [{ id: 'model-b', enabled: true }],
        },
      ],
      defaultRef: { providerId: 'dead', modelId: 'model-b' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const session = rt.store.createSession({
      title: 'pin',
      mode: 'chat',
      agentId: 'general',
      metadata: {
        capabilityTiers: { enabled: true, roles: { plannerModel: 'heuristic/heuristic' } },
        handoffRole: 'planner',
        pinnedSessionModel: 'heuristic/heuristic',
        modelOverride: 'dead/model-b',
      },
    });
    rt.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'hello' }]);
    const result = await bindTurnKernelHost(rt.l5()).runTurnWithRetries({
      sessionId: session.id,
      agent: rt.store.getAgent('general'),
      systemPrompt: 'sys',
      messages: rt.store.foldMessages(session.id),
      tools: [],
    });
    const text = result.assistantParts.filter((part) => part.type === 'text').map((part) => part.text).join('');
    assert.match(text, /裸 agent runtime/);
  } finally {
    if (previous === undefined) delete process.env.RAW_AGENT_VL_MODEL_NAME;
    else process.env.RAW_AGENT_VL_MODEL_NAME = previous;
    await rt.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pinned adapter that fails does not fall through to the fallback chain', async () => {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const streamed = body.includes('"stream":true');
      if (streamed) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"FALLBACK_MODEL_ANSWERED"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'FALLBACK_MODEL_ANSWERED' }, finish_reason: 'stop' }] }));
    });
  });
  const dead = createServer((request) => {
    request.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const deadPort = dead.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'handoff-pin-reject-'));
  const rt = pinRuntime(dir);
  try {
    writeModelCatalog(rt.store, {
      providers: [
        {
          id: 'dead',
          name: 'Dead',
          kind: 'openai-compatible',
          httpKind: 'chat_completions',
          baseUrl: `http://127.0.0.1:${deadPort}/v1`,
          apiKey: 'dead',
          models: [{ id: 'model-b', enabled: true }],
        },
        {
          id: 'live',
          name: 'Live',
          kind: 'openai-compatible',
          httpKind: 'chat_completions',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'live',
          models: [{ id: 'model-c', enabled: true }],
        },
      ],
      defaultRef: { providerId: 'live', modelId: 'model-c' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    rt.store.setDaemonControl(MODEL_FALLBACK_SETTINGS_KEY, {
      enabled: true,
      chain: [{ providerId: 'live', modelId: 'model-c' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const session = rt.store.createSession({
      title: 'reject',
      mode: 'chat',
      agentId: 'general',
      metadata: {
        capabilityTiers: { enabled: true },
        handoffRole: 'planner',
        pinnedSessionModel: 'dead/model-b',
        modelOverride: 'live/model-c',
      },
    });
    rt.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'hello' }]);
    const previousRetries = process.env.RAW_AGENT_MODEL_MAX_RETRIES;
    process.env.RAW_AGENT_MODEL_MAX_RETRIES = '0';
    try {
      await assert.rejects(
        () => bindTurnKernelHost(rt.l5()).runTurnWithRetries({
          sessionId: session.id,
          agent: rt.store.getAgent('general'),
          systemPrompt: 'sys',
          messages: rt.store.foldMessages(session.id),
          tools: [],
        }),
        /ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed|connection/i
      );
    } finally {
      if (previousRetries === undefined) delete process.env.RAW_AGENT_MODEL_MAX_RETRIES;
      else process.env.RAW_AGENT_MODEL_MAX_RETRIES = previousRetries;
    }
  } finally {
    server.close();
    dead.close();
    await rt.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
