import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { ValidationError } from '../dist/errors.js';
import {
  createBot,
  normalizeBotModelOverride,
  openBot,
  readBotModelOverride,
  updateBot
} from '../dist/bots/index.js';
import {
  pickerOptions,
  readModelCatalog,
  resolveModelOverrideRef,
  resolveSessionModelAdapter,
  resolveSessionPreferredRef,
  setCatalogDefaultRef,
  upsertProvider
} from '../dist/model/provider-catalog.js';
import { resolveModelRoute, resolveRouteCandidates } from '../dist/model/registry-router.js';
import { spawnSubagent, spawnTeammate } from '../dist/runtime/spawn-host.js';
import { inheritModelOverride } from '../dist/runtime/spawn-policy.js';
import { setLogLevel, resetLogLevel } from '../dist/logger.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-model-'));
  return new SqliteStateStore(join(dir, 'state.db'));
}

function facadeHost(store) {
  return {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions: () => {},
    wakeAgentSessions: () => {}
  };
}

function seedCatalog(store) {
  const a = upsertProvider(store, {
    id: 'prov-a',
    name: 'Alpha',
    kind: 'openai-compatible',
    baseUrl: 'https://alpha.invalid/v1',
    apiKey: 'sk-a',
    models: [
      { id: 'alpha-1', enabled: true },
      { id: 'alpha-off', enabled: false },
      { id: 'shared', enabled: true }
    ]
  });
  const b = upsertProvider(store, {
    id: 'prov-b',
    name: 'Beta',
    kind: 'anthropic-compatible',
    baseUrl: 'https://beta.invalid',
    apiKey: 'sk-b',
    models: [
      { id: 'beta-1', enabled: true },
      { id: 'shared', enabled: true }
    ]
  });
  setCatalogDefaultRef(store, { providerId: 'prov-a', modelId: 'alpha-1' });
  return { a, b, options: pickerOptions(readModelCatalog(store), {}) };
}

const REF_B = { providerId: 'prov-b', modelId: 'beta-1' };

function modelOf(adapter) {
  return adapter.options?.model;
}

test('updateBot saves, reads back and clears modelOverride on every bot chat', () => {
  const store = tempStore();
  const host = facadeHost(store);
  const { options } = seedCatalog(store);
  const bot = createBot(host, { name: 'Pinned' });
  const perUser = openBot(host, bot.id, { userId: 'user_1' });
  assert.equal(readBotModelOverride(store.getSession(bot.canonicalSessionId).metadata), undefined);

  updateBot(host, bot.id, { modelOverride: REF_B }, { modelOptions: options });
  assert.deepEqual(store.getSession(bot.canonicalSessionId).metadata.modelOverride, REF_B);
  assert.deepEqual(store.getSession(perUser.sessionId).metadata.modelOverride, REF_B);

  updateBot(host, bot.id, { maxTurns: 48 }, { modelOptions: options });
  assert.deepEqual(store.getSession(bot.canonicalSessionId).metadata.modelOverride, REF_B);

  updateBot(host, bot.id, { modelOverride: null }, { modelOptions: options });
  assert.ok(!('modelOverride' in store.getSession(bot.canonicalSessionId).metadata));
  assert.ok(!('modelOverride' in store.getSession(perUser.sessionId).metadata));
  store.db.close();
});

test('updateBot rejects models outside the configured picker list and malformed values [AC:bots#AC-4]', () => {
  const store = tempStore();
  const host = facadeHost(store);
  const { options } = seedCatalog(store);
  const bot = createBot(host, { name: 'Strict' });
  const bad = [
    { providerId: 'prov-a', modelId: 'alpha-off' },
    { providerId: 'prov-a', modelId: 'nope' },
    { providerId: 'ghost', modelId: 'alpha-1' },
    'alpha-1',
    { providerId: 'prov-a' },
    7
  ];
  for (const value of bad) {
    assert.throws(
      () => updateBot(host, bot.id, { modelOverride: value }, { modelOptions: options }),
      ValidationError,
      JSON.stringify(value)
    );
  }
  assert.throws(() => updateBot(host, bot.id, { modelOverride: REF_B }), ValidationError);
  assert.equal(store.getSession(bot.canonicalSessionId).metadata.modelOverride, undefined);
  assert.equal(normalizeBotModelOverride('', options), null);
  store.db.close();
});

test('openBot never overwrites a saved pin, including a fresh per-user chat', () => {
  const store = tempStore();
  const host = facadeHost(store);
  const { options } = seedCatalog(store);
  const bot = createBot(host, { name: 'Sticky' });
  updateBot(host, bot.id, { modelOverride: REF_B }, { modelOptions: options });

  openBot(host, bot.id);
  assert.deepEqual(store.getSession(bot.canonicalSessionId).metadata.modelOverride, REF_B);
  const first = openBot(host, bot.id, { userId: 'user_9' });
  assert.equal(first.createdSession, true);
  assert.deepEqual(store.getSession(first.sessionId).metadata.modelOverride, REF_B);
  openBot(host, bot.id, { userId: 'user_9' });
  assert.deepEqual(store.getSession(first.sessionId).metadata.modelOverride, REF_B);

  const plain = createBot(host, { name: 'Plain' });
  openBot(host, plain.id);
  openBot(host, plain.id, { userId: 'user_9' });
  for (const s of store.listSessions().filter((x) => x.metadata?.botId === plain.id)) {
    assert.ok(!('modelOverride' in s.metadata));
  }
  store.db.close();
});

test('runtime routing adopts modelOverride over session modelRef and the default [AC:bots#AC-4]', () => {
  const store = tempStore();
  seedCatalog(store);
  const session = {
    id: 's1',
    metadata: { modelRef: { providerId: 'prov-a', modelId: 'shared' }, modelOverride: REF_B }
  };
  const route = resolveModelRoute({ store, session, env: {} });
  assert.equal(modelOf(route.primary), 'beta-1');
  assert.equal(route.primary.name, 'anthropic-compatible');
  assert.equal(route.decisions[0].type, 'preferred');
  assert.match(route.decisions[0].message, /^override ref prov-b\/beta-1/);
  assert.equal(modelOf(resolveSessionModelAdapter(store, session, {})), 'beta-1');

  const noOverride = resolveModelRoute({
    store,
    session: { id: 's2', metadata: { modelRef: { providerId: 'prov-a', modelId: 'shared' } } },
    env: {}
  });
  assert.equal(modelOf(noOverride.primary), 'shared');
  const plain = resolveModelRoute({ store, session: { id: 's3', metadata: {} }, env: {} });
  assert.equal(modelOf(plain.primary), 'alpha-1');
  store.db.close();
});

test('an unresolvable modelOverride falls back to the global default and warns once', () => {
  const store = tempStore();
  seedCatalog(store);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  setLogLevel('warn');
  try {
    const session = {
      id: 'gone',
      metadata: { modelOverride: { providerId: 'prov-b', modelId: 'deleted-model' } }
    };
    const route = resolveModelRoute({ store, session, env: {} });
    assert.equal(modelOf(route.primary), 'alpha-1');
    assert.ok(route.decisions.some((d) => d.type === 'fallback' && /modelOverride/.test(d.message)));
    resolveModelRoute({ store, session, env: {} });
    resolveSessionModelAdapter(store, session, {});
    assert.equal(warnings.filter((w) => w.includes('deleted-model')).length, 1);
  } finally {
    console.warn = origWarn;
    resetLogLevel();
  }
  store.db.close();
});

test('a pinned provider without credentials is treated as unresolvable', () => {
  const store = tempStore();
  seedCatalog(store);
  upsertProvider(store, {
    id: 'prov-c',
    name: 'NoKey',
    kind: 'openai-compatible',
    baseUrl: 'https://c.invalid/v1',
    apiKey: '',
    models: [{ id: 'c-1', enabled: true }]
  });
  const catalog = readModelCatalog(store);
  assert.equal(resolveModelOverrideRef(catalog, { providerId: 'prov-c', modelId: 'c-1' }, {}), undefined);
  assert.deepEqual(resolveModelOverrideRef(catalog, REF_B, {}), REF_B);
  store.db.close();
});

test('string overrides (spawn_subagent model) resolve by model id, preferring the default provider', () => {
  const store = tempStore();
  seedCatalog(store);
  const catalog = readModelCatalog(store);
  assert.deepEqual(resolveModelOverrideRef(catalog, 'beta-1', {}), REF_B);
  assert.deepEqual(resolveModelOverrideRef(catalog, 'shared', {}), {
    providerId: 'prov-a',
    modelId: 'shared'
  });
  assert.equal(resolveModelOverrideRef(catalog, 'unknown-model', {}), undefined);
  assert.equal(resolveModelOverrideRef(catalog, undefined, {}), undefined);
  const picked = resolveSessionPreferredRef(catalog, { id: 'x', metadata: { modelOverride: 'beta-1' } }, {});
  assert.equal(picked.source, 'override');
  store.db.close();
});

test('a pinned model bypasses the thinking-mode filter that would skip the session ref', () => {
  const catalog = {
    providers: [
      {
        id: 'p1',
        name: 'Think',
        kind: 'openai-compatible',
        baseUrl: 'https://p1.invalid/v1',
        apiKey: 'k',
        models: [{ id: 'think-1', enabled: true, capabilities: ['thinking'] }]
      },
      {
        id: 'p2',
        name: 'Plain',
        kind: 'openai-compatible',
        baseUrl: 'https://p2.invalid/v1',
        apiKey: 'k',
        models: [{ id: 'plain-1', enabled: true }]
      }
    ],
    defaultRef: { providerId: 'p2', modelId: 'plain-1' },
    updatedAt: ''
  };
  const { refs } = resolveRouteCandidates({
    catalog,
    env: {},
    session: {
      id: 't',
      metadata: { thinkingMode: 'off', modelOverride: { providerId: 'p1', modelId: 'think-1' } }
    }
  });
  assert.equal(refs[0].modelId, 'think-1');
});

function spawnHost(store) {
  return {
    store,
    repoRoot: '/tmp',
    stateDir: '/tmp',
    workspaceManager: {},
    sandbox: undefined,
    setSandbox() {},
    backgroundJobAborts: new Map(),
    async runSession(id) {
      return store.getSession(id);
    }
  };
}

function runContext(session) {
  return {
    repoRoot: '/tmp',
    stateDir: '/tmp',
    session,
    agent: { id: 'general', name: 'General', role: 'general', instructions: '', capabilities: [] }
  };
}

function parent(store, metadata) {
  store.upsertAgent({ id: 'general', name: 'General', role: 'general', instructions: '', capabilities: [] });
  return store.createSession({ title: 'parent', mode: 'chat', agentId: 'general', metadata });
}

test('subagents and teammates inherit the parent pin; explicit opts.model wins', async () => {
  const store = tempStore();
  const p = parent(store, { botId: 'b', canonicalBotChat: true, modelOverride: REF_B });
  await spawnSubagent(spawnHost(store), runContext(p), 'go', undefined, {});
  await spawnSubagent(spawnHost(store), runContext(p), 'go', undefined, { model: 'alpha-1' });
  await spawnTeammate(spawnHost(store), runContext(p), { name: 'mate-x', role: 'helper', prompt: 'hi' });
  const kids = store.listSessions().filter((s) => s.parentSessionId === p.id);
  assert.equal(kids.length, 3);
  const byMode = (mode) => kids.filter((s) => s.mode === mode);
  const subs = byMode('subagent').map((s) => s.metadata.modelOverride);
  assert.ok(subs.some((m) => JSON.stringify(m) === JSON.stringify(REF_B)));
  assert.ok(subs.includes('alpha-1'));
  assert.deepEqual(byMode('teammate')[0].metadata.modelOverride, REF_B);
  store.db.close();
});

test('children of an unpinned parent carry no modelOverride (behavior unchanged)', async () => {
  const store = tempStore();
  const p = parent(store, { botId: 'b', canonicalBotChat: true });
  await spawnSubagent(spawnHost(store), runContext(p), 'go', undefined, {});
  await spawnTeammate(spawnHost(store), runContext(p), { name: 'mate-y', role: 'helper', prompt: 'hi' });
  for (const kid of store.listSessions().filter((s) => s.parentSessionId === p.id)) {
    assert.ok(!('modelOverride' in kid.metadata));
  }
  assert.deepEqual(inheritModelOverride({}), {});
  assert.deepEqual(inheritModelOverride({ modelOverride: '  ' }), {});
  assert.deepEqual(inheritModelOverride({ modelOverride: { providerId: 'x' } }), {});
  store.db.close();
});

test('without any override the route is identical to before (session ref / default)', () => {
  const store = tempStore();
  seedCatalog(store);
  const catalog = readModelCatalog(store);
  assert.equal(resolveSessionPreferredRef(catalog, undefined, {}).source, 'default');
  assert.equal(
    resolveSessionPreferredRef(catalog, { id: 'a', metadata: { modelRef: REF_B } }, {}).source,
    'session'
  );
  store.db.close();
});

test('Bot follow default ignores legacy selection and tracks default changes [AC:bot-follow-default#AC-1]', () => {
  const store = tempStore();
  seedCatalog(store);
  const session = { id: 'legacy', metadata: { canonicalBotChat: true, modelRef: REF_B } };
  assert.equal(modelOf(resolveModelRoute({ store, session, env: {} }).primary), 'alpha-1');
  setCatalogDefaultRef(store, REF_B);
  assert.equal(modelOf(resolveModelRoute({ store, session, env: {} }).primary), 'beta-1');
  session.metadata.modelOverride = { providerId: 'prov-a', modelId: 'alpha-1' };
  assert.equal(modelOf(resolveModelRoute({ store, session, env: {} }).primary), 'alpha-1');
  store.db.close();
});

test('saving follow default clears legacy model selections on bot chats [AC:bot-follow-default#AC-2]', () => {
  const store = tempStore();
  const host = facadeHost(store);
  const { options } = seedCatalog(store);
  const bot = createBot(host, { name: 'Follow' });
  const user = openBot(host, bot.id, { userId: 'follow-user' });
  for (const id of [bot.canonicalSessionId, user.sessionId]) {
    const session = store.getSession(id);
    store.updateSession(id, { metadata: { ...session.metadata, modelRef: REF_B } });
  }
  updateBot(host, bot.id, { modelOverride: null }, { modelOptions: options });
  for (const id of [bot.canonicalSessionId, user.sessionId]) {
    assert.equal(store.getSession(id).metadata.modelRef, undefined);
  }
  store.db.close();
});
