import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { HeuristicModelAdapter, OpenAICompatibleAdapter } from '../dist/model/model-adapters.js';
import { parseRemoteModelList, listRemoteModels, normalizeOpenAiCompatibleBaseUrl, baseUrlFromModelsEndpoint } from '../dist/model/list-models.js';
import {
  ENV_FALLBACK_PROVIDER_ID,
  HEURISTIC_PROVIDER_ID,
  MODEL_PROVIDERS_KEY,
  createAdapterFromProvider,
  deleteProvider,
  envFallbackProvider,
  hasPersistedModelCatalog,
  heuristicRef,
  maskApiKey,
  mergeModelRefMetadata,
  mergeScannedModels,
  parseModelRef,
  pickerOptions,
  publicCatalogPayload,
  publicProvider,
  readModelCatalog,
  suggestProviderName,
  resolveDefaultModelRef,
  resolveSessionPreferredRef,
  resolveSessionModelAdapter,
  setCatalogDefaultRef,
  upsertProvider,
  writeModelCatalog
} from '../dist/model/provider-catalog.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'model-prov-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  return { dir, store };
}

test('suggestProviderName derives a short label from Base URL', () => {
  assert.equal(suggestProviderName('https://api.deepseek.com/v1'), 'Deepseek');
  assert.equal(suggestProviderName('https://openrouter.ai/api/v1'), 'Openrouter');
  assert.equal(suggestProviderName('http://127.0.0.1:11434/v1'), '本地服务');
  assert.equal(suggestProviderName('http://localhost:11434/v1'), '本地服务');
  assert.equal(suggestProviderName('', 'heuristic'), '本地启发式');
  assert.equal(suggestProviderName('', 'anthropic-compatible'), 'Anthropic');
  assert.equal(suggestProviderName('', 'openai-compatible'), 'OpenAI 兼容');
});

test('parseRemoteModelList accepts OpenAI and Anthropic shapes', () => {
  const openai = parseRemoteModelList({
    data: [
      { id: 'gpt-4o', owned_by: 'openai' },
      { id: 'gpt-4o' },
      { id: '' }
    ]
  });
  assert.deepEqual(
    openai.map((m) => m.id),
    ['gpt-4o']
  );
  const anthropic = parseRemoteModelList({
    data: [{ id: 'claude-sonnet-4-5', display_name: 'Sonnet' }]
  });
  assert.equal(anthropic[0]?.ownedBy, 'Sonnet');
  const strings = parseRemoteModelList({ models: ['a', 'b'] });
  assert.deepEqual(
    strings.map((m) => m.id),
    ['a', 'b']
  );
});

test('listRemoteModels uses GET /models and Bearer auth', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'deepseek-chat', owned_by: 'deepseek' }] })
    };
  };
  const listed = await listRemoteModels({
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    fetchImpl
  });
  assert.equal(listed.models[0]?.id, 'deepseek-chat');
  assert.equal(calls[0]?.url, 'https://api.deepseek.com/v1/models');
  assert.equal(calls[0]?.auth, 'Bearer sk-test');
});

test('catalog CRUD + picker + masked key stay in daemon_control KV', () => {
  const { dir, store } = tmpStore();
  assert.equal(hasPersistedModelCatalog(store), false);
  const p = upsertProvider(store, {
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-super-secret-key',
    models: [{ id: 'deepseek-chat', enabled: true }]
  });
  assert.equal(hasPersistedModelCatalog(store), true);
  assert.equal(readModelCatalog(store).providers[0]?.apiKey, 'sk-super-secret-key');
  const pub = publicProvider(p, 'ui');
  assert.equal(pub.hasApiKey, true);
  assert.equal(JSON.stringify(pub).includes('super-secret'), false);
  assert.match(maskApiKey('sk-super-secret-key'), /…/);
  const payload = publicCatalogPayload(store, {});
  assert.deepEqual(Object.keys(payload.effective.defaultRef).sort(), ['modelId', 'providerId']);
  assert.ok(payload.options.some((o) => o.modelId === 'deepseek-chat'));
  assert.ok(payload.options.some((o) => o.providerId === HEURISTIC_PROVIDER_ID));
  assert.ok(payload.catalog.providers.find((x) => x.id === p.id)?.apiKeyMasked.includes('sk-'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload.catalog.providers.find((x) => x.id === p.id) ?? {}, 'apiKey'),
    false
  );
  setCatalogDefaultRef(store, { providerId: p.id, modelId: 'deepseek-chat' });
  assert.deepEqual(resolveDefaultModelRef(store, {}), { providerId: p.id, modelId: 'deepseek-chat' });
  assert.equal(deleteProvider(store, p.id), true);
  assert.equal(readModelCatalog(store).providers.length, 0);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('pickerOptions omits disabled models', () => {
  const opts = pickerOptions(
    {
      providers: [
        {
          id: 'p1',
          name: 'P',
          kind: 'openai-compatible',
          baseUrl: 'https://x',
          apiKey: 'k',
          useJsonMode: true,
          models: [
            { id: 'on', enabled: true },
            { id: 'off', enabled: false }
          ],
          createdAt: 't',
          updatedAt: 't'
        }
      ],
      defaultRef: null,
      updatedAt: 't'
    },
    {}
  );
  assert.ok(opts.some((o) => o.modelId === 'on'));
  assert.equal(
    opts.some((o) => o.modelId === 'off'),
    false
  );
});

test('mergeScannedModels keeps enabled flags and appends leftovers', () => {
  const merged = mergeScannedModels(
    [
      { id: 'keep-off', enabled: false },
      { id: 'gone', enabled: true }
    ],
    [{ id: 'keep-off' }, { id: 'new-one', ownedBy: 'x' }]
  );
  assert.equal(merged.find((m) => m.id === 'keep-off')?.enabled, false);
  assert.equal(merged.find((m) => m.id === 'new-one')?.enabled, true);
  assert.ok(merged.some((m) => m.id === 'gone'));
});

test('resolveSessionModelAdapter uses session modelRef over env fallback', () => {
  const { dir, store } = tmpStore();
  const p = upsertProvider(store, {
    name: 'Local',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: 'k',
    models: [{ id: 'my-model', enabled: true }]
  });
  const session = {
    id: 's1',
    title: 't',
    mode: 'chat',
    status: 'idle',
    agentId: 'general',
    background: false,
    todo: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { modelRef: { providerId: p.id, modelId: 'my-model' } }
  };
  const adapter = resolveSessionModelAdapter(store, session, {
    RAW_AGENT_MODEL_PROVIDER: 'heuristic'
  }, new HeuristicModelAdapter());
  assert.equal(adapter.name, 'openai-compatible');
  assert.ok(adapter instanceof OpenAICompatibleAdapter);
  const heuristic = resolveSessionModelAdapter(
    store,
    { ...session, metadata: { modelRef: heuristicRef() } },
    {},
    new HeuristicModelAdapter()
  );
  assert.ok(heuristic instanceof HeuristicModelAdapter);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('mergeModelRefMetadata leaves unpinned sessions following global [AC:global-default-model-clarity#AC-2]', () => {
  const { dir, store } = tmpStore();
  writeModelCatalog(store, {
    providers: [],
    defaultRef: null,
    updatedAt: new Date().toISOString()
  });
  const meta = mergeModelRefMetadata(store, {}, {}, {});
  assert.equal(meta.modelRef, undefined);
  const explicit = mergeModelRefMetadata(
    store,
    {},
    { providerId: 'p1', modelId: 'm1' },
    {}
  );
  assert.deepEqual(explicit.modelRef, { providerId: 'p1', modelId: 'm1' });
  assert.equal(parseModelRef({ providerId: 'a', modelId: 'b' })?.modelId, 'b');
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('global default is hot, persistent, and explicit pins survive until cleared [AC:global-default-model-clarity#AC-2] [AC:global-default-model-clarity#AC-3]', () => {
  const { dir, store } = tmpStore();
  try {
    const p = upsertProvider(store, { name: 'Test', kind: 'openai-compatible', baseUrl: 'http://localhost:9999/v1', apiKey: 'test', models: [{ id: 'one', enabled: true }, { id: 'two', enabled: true }] });
    const one = { providerId: p.id, modelId: 'one' };
    const two = { providerId: p.id, modelId: 'two' };
    const unpinned = { metadata: mergeModelRefMetadata(store, {}, {}, {}) };
    const pinned = { metadata: mergeModelRefMetadata(store, {}, { modelRef: one }, {}) };
    setCatalogDefaultRef(store, two, {});
    assert.deepEqual(resolveSessionPreferredRef(readModelCatalog(store), unpinned, {}).ref, two);
    assert.deepEqual(resolveSessionPreferredRef(readModelCatalog(store), pinned, {}).ref, one);
    assert.deepEqual(resolveSessionPreferredRef(readModelCatalog(store), { metadata: { modelOverride: one } }, {}).ref, one);
    pinned.metadata = mergeModelRefMetadata(store, pinned.metadata, { modelRef: null }, {});
    assert.deepEqual(resolveSessionPreferredRef(readModelCatalog(store), pinned, {}).ref, two);
    const restarted = new SqliteStateStore(join(dir, 'state.db'));
    try { assert.deepEqual(resolveDefaultModelRef(restarted, {}), two); } finally { restarted.db.close(); }
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('disabled or deleted default selections fail without replacing saved model [AC:global-default-model-clarity#AC-6]', () => {
  const { dir, store } = tmpStore();
  try {
    const p = upsertProvider(store, { name: 'Test', kind: 'openai-compatible', baseUrl: 'http://localhost:9999/v1', apiKey: 'test', models: [{ id: 'one', enabled: true }, { id: 'off', enabled: false }] });
    const saved = readModelCatalog(store).defaultRef;
    for (const modelId of ['off', 'deleted']) {
      assert.throws(() => setCatalogDefaultRef(store, { providerId: p.id, modelId }, {}), /enabled|available/i);
      assert.deepEqual(readModelCatalog(store).defaultRef, saved);
    }
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('env fallback provider is listed but keys stay masked', () => {
  const env = {
    RAW_AGENT_MODEL_PROVIDER: 'openai-compatible',
    RAW_AGENT_BASE_URL: 'https://api.openai.com/v1',
    RAW_AGENT_API_KEY: 'sk-env-secret',
    RAW_AGENT_MODEL_NAME: 'gpt-4o-mini'
  };
  const p = envFallbackProvider(env);
  assert.equal(p?.id, ENV_FALLBACK_PROVIDER_ID);
  const { dir, store } = tmpStore();
  const payload = publicCatalogPayload(store, env);
  const shown = payload.catalog.providers.find((x) => x.id === ENV_FALLBACK_PROVIDER_ID);
  assert.equal(shown?.hasApiKey, true);
  assert.equal(JSON.stringify(shown).includes('sk-env-secret'), false);
  assert.ok(pickerOptions(readModelCatalog(store), env).some((o) => o.source === 'env'));
  const adapter = createAdapterFromProvider(p, 'gpt-4o-mini');
  assert.equal(adapter.name, 'openai-compatible');
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('KV key is model_providers', () => {
  assert.equal(MODEL_PROVIDERS_KEY, 'model_providers');
});

test('normalizeOpenAiCompatibleBaseUrl appends /v1 when missing', () => {
  assert.equal(normalizeOpenAiCompatibleBaseUrl('https://api.tokenpony.cn'), 'https://api.tokenpony.cn/v1');
  assert.equal(normalizeOpenAiCompatibleBaseUrl('https://api.tokenpony.cn/'), 'https://api.tokenpony.cn/v1');
  assert.equal(normalizeOpenAiCompatibleBaseUrl('https://api.tokenpony.cn/v1'), 'https://api.tokenpony.cn/v1');
  assert.equal(normalizeOpenAiCompatibleBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
  assert.equal(baseUrlFromModelsEndpoint('https://api.tokenpony.cn/v1/models'), 'https://api.tokenpony.cn/v1');
});

test('upsertProvider stores host-only OpenAI URL with /v1', () => {
  const { dir, store } = tmpStore();
  const p = upsertProvider(store, {
    name: 'Tokenpony',
    kind: 'openai-compatible',
    baseUrl: 'https://api.tokenpony.cn',
    apiKey: 'sk-test'
  });
  assert.equal(p.baseUrl, 'https://api.tokenpony.cn/v1');
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
