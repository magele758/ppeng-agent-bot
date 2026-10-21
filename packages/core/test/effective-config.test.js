import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEffectiveConfig,
  resolveStorage,
  resolveDomainSelection,
  resolveEmbeddingRecall
} from '../dist/config/effective-config.js';
import { createProviderConfigFromEnv, validateProviderConfig } from '../dist/storage/provider-config.js';
import { createCoreStorageContext } from '../dist/storage/repository-factory.js';
import {
  defaultMemorySettings,
  normalizeMemorySettings,
  writeMemorySettings,
  readMemorySettings
} from '../dist/memory/memory-settings.js';
import { memoryEmbeddingConfigured, memoryEmbeddingRequested } from '../dist/memory/memory-embedding.js';

const S3_FULL = {
  RAW_AGENT_S3_ENDPOINT: 'http://127.0.0.1:9000',
  RAW_AGENT_S3_BUCKET: 'b',
  RAW_AGENT_S3_ACCESS_KEY: 'k',
  RAW_AGENT_S3_SECRET_KEY: 's'
};

function byId(cfg, id) {
  const it = cfg.items.find((x) => x.id === id);
  assert.ok(it, `item ${id} missing`);
  return it;
}

function kv() {
  const m = new Map();
  return {
    getDaemonControl: (k) => m.get(k),
    setDaemonControl: (k, v) => void m.set(k, v)
  };
}

// ── 存储：没配 → 本地 ─────────────────────────────────────────────────────────

test('storage: nothing configured → every feature local-fallback, mode local', () => {
  const cfg = resolveEffectiveConfig({ env: {} });
  assert.equal(cfg.mode, 'local');
  for (const id of ['eventBuffer', 'skillRegistry', 'assetStorage', 'dispatchLock', 'sessionStore']) {
    const it = byId(cfg, `storage.${id}`);
    assert.equal(it.source, 'local-fallback', id);
    assert.equal(it.enabled, false, id);
  }
  assert.deepEqual(cfg.warnings, []);
});

test('storage: DATABASE_URL → event buffer + skill registry on PG; sessions still SQLite (honest)', () => {
  const cfg = resolveEffectiveConfig({ env: { DATABASE_URL: 'postgres://u:p@h/db' } });
  const eb = byId(cfg, 'storage.eventBuffer');
  assert.equal(eb.mode, 'redis_postgres');
  assert.equal(eb.source, 'auto-detected');
  assert.ok(eb.hints.some((h) => h.code === 'redis_optional_missing'));
  assert.equal(byId(cfg, 'storage.skillRegistry').mode, 'pg_redis');
  const ss = byId(cfg, 'storage.sessionStore');
  assert.equal(ss.mode, 'sqlite');
  assert.ok(ss.hints.some((h) => h.code === 'session_still_sqlite'));
  assert.equal(cfg.mode, 'hybrid');
  assert.deepEqual(cfg.warnings, []);
});

test('storage: DATABASE_URL + REDIS_URL → no "redis missing" hint, lock uses Redis', () => {
  const cfg = resolveEffectiveConfig({
    env: { DATABASE_URL: 'postgres://h/db', REDIS_URL: 'redis://h:6379' }
  });
  assert.deepEqual(byId(cfg, 'storage.eventBuffer').hints, []);
  assert.equal(byId(cfg, 'storage.dispatchLock').mode, 'redis');
  assert.equal(byId(cfg, 'storage.dispatchLock').source, 'auto-detected');
});

test('storage: REDIS_URL alone → only the scheduler lock goes to Redis', () => {
  const r = resolveStorage({ REDIS_URL: 'redis://h:6379' });
  assert.equal(r.config.dispatchLock, 'redis');
  assert.equal(r.config.eventBuffer, 'local');
  assert.equal(r.config.assetStorage, 'local');
});

test('storage: S3 fully configured → tiered assets, cache dir defaults under stateDir, Redis optional', () => {
  const r = resolveStorage({ ...S3_FULL }, { stateDir: '/var/state' });
  assert.equal(r.config.assetStorage, 'tiered');
  assert.equal(r.tieredCacheDir, '/var/state/tiered-cache');
  assert.deepEqual(r.missingForced, []);
  const it = r.items.find((x) => x.id === 'storage.assetStorage');
  assert.equal(it.source, 'auto-detected');
});

test('storage: S3 half-configured → local + actionable warning, never an error', () => {
  const env = { RAW_AGENT_S3_ENDPOINT: 'http://127.0.0.1:9000' };
  const r = resolveStorage(env);
  assert.equal(r.config.assetStorage, 'local');
  assert.deepEqual(r.missingForced, []);
  const it = r.items.find((x) => x.id === 'storage.assetStorage');
  assert.equal(it.source, 'local-fallback');
  assert.equal(it.reasonCode, 'partial_config');
  const w = it.warnings.find((x) => x.code === 'partial_s3');
  assert.ok(w);
  assert.match(w.message, /RAW_AGENT_S3_BUCKET/);
  assert.match(w.message, /RAW_AGENT_S3_SECRET_KEY/);
  assert.deepEqual(validateProviderConfig(r.config, env), []);
  const eff = resolveEffectiveConfig({ env });
  assert.deepEqual(eff.summary.partial, ['storage.assetStorage']);
});

// ── 存储：显式值优先 ───────────────────────────────────────────────────────────

test('storage: explicit local/sqlite beats auto-detection (backward compatible)', () => {
  const env = {
    DATABASE_URL: 'postgres://h/db',
    REDIS_URL: 'redis://h',
    ...S3_FULL,
    RAW_AGENT_EVENT_BUFFER_PROVIDER: 'LOCAL',
    RAW_AGENT_SKILL_REGISTRY_PROVIDER: 'local_fs',
    RAW_AGENT_ASSET_STORAGE_PROVIDER: 'local',
    RAW_AGENT_DISPATCH_LOCK_PROVIDER: 'local',
    RAW_AGENT_SESSION_STORE_PROVIDER: 'sqlite'
  };
  const cfg = resolveEffectiveConfig({ env });
  for (const id of ['eventBuffer', 'skillRegistry', 'assetStorage', 'dispatchLock', 'sessionStore']) {
    const it = byId(cfg, `storage.${id}`);
    assert.equal(it.source, 'explicit-env', id);
    assert.equal(it.enabled, false, id);
  }
  const p = createProviderConfigFromEnv(env);
  assert.equal(p.eventBuffer, 'local');
  assert.equal(p.skillRegistry, 'local_fs');
  assert.equal(p.assetStorage, 'local');
  assert.equal(p.dispatchLock, 'local');
  assert.deepEqual(validateProviderConfig(p, env), []);
});

test('storage: forcing a cloud provider without its dependency is the only hard error', () => {
  const env = {
    RAW_AGENT_EVENT_BUFFER_PROVIDER: 'redis_postgres',
    RAW_AGENT_ASSET_STORAGE_PROVIDER: 'tiered',
    RAW_AGENT_DISPATCH_LOCK_PROVIDER: 'redis'
  };
  const p = createProviderConfigFromEnv(env);
  const missing = validateProviderConfig(p, env);
  assert.ok(missing.includes('DATABASE_URL'));
  assert.ok(missing.includes('RAW_AGENT_S3_BUCKET'));
  assert.ok(missing.includes('REDIS_URL'));
  assert.ok(!missing.includes('RAW_AGENT_TIERED_CACHE_DIR'), 'cache dir has a default now');
  assert.deepEqual(resolveStorage(env).missingForced.sort(), [...new Set(missing)].sort());
});

test('storage: explicit tiered no longer demands REDIS_URL / cache dir', () => {
  const env = { ...S3_FULL, RAW_AGENT_ASSET_STORAGE_PROVIDER: 'tiered' };
  assert.deepEqual(validateProviderConfig(createProviderConfigFromEnv(env), env), []);
});

test('storage: explicit session postgres is reported honestly as still SQLite', () => {
  const cfg = resolveEffectiveConfig({
    env: { RAW_AGENT_SESSION_STORE_PROVIDER: 'postgres', DATABASE_URL: 'postgres://h/db' }
  });
  const ss = byId(cfg, 'storage.sessionStore');
  assert.equal(ss.mode, 'sqlite');
  assert.equal(ss.source, 'explicit-env');
  assert.ok(ss.warnings.some((w) => w.code === 'session_postgres_not_migrated'));
});

test('storage: unrecognised provider value is warned about and ignored (falls through to auto)', () => {
  const cfg = resolveEffectiveConfig({
    env: { RAW_AGENT_EVENT_BUFFER_PROVIDER: 'mongo', DATABASE_URL: 'postgres://h/db' }
  });
  const eb = byId(cfg, 'storage.eventBuffer');
  assert.equal(eb.source, 'auto-detected');
  assert.ok(eb.warnings.some((w) => w.code === 'invalid_provider_value'));
});

test('storage: deployment mode — explicit wins, otherwise derived from what is actually external', () => {
  assert.equal(createProviderConfigFromEnv({}).deploymentMode, 'local');
  assert.equal(createProviderConfigFromEnv({ REDIS_URL: 'redis://h' }).deploymentMode, 'hybrid');
  assert.equal(
    createProviderConfigFromEnv({ REDIS_URL: 'redis://h', RAW_AGENT_DEPLOYMENT_MODE: 'local' }).deploymentMode,
    'local'
  );
  const env = { RAW_AGENT_DEPLOYMENT_MODE: 'cloud' };
  assert.ok(validateProviderConfig(createProviderConfigFromEnv(env), env).includes('DATABASE_URL'));
});

test('storage: runtime fallbacks show up as local-fallback with the reason and downgrade the config', () => {
  const note = { code: 'pg_unreachable', message: 'unreachable', params: { error: 'x' } };
  const input = {
    env: { DATABASE_URL: 'postgres://h/db' },
    runtime: { storageFallbacks: { eventBuffer: note, skillRegistry: note } }
  };
  const cfg = resolveEffectiveConfig(input);
  const eb = byId(cfg, 'storage.eventBuffer');
  assert.equal(eb.source, 'local-fallback');
  assert.equal(eb.reasonCode, 'runtime_fallback');
  assert.equal(eb.warnings[0].code, 'pg_unreachable');
  assert.equal(cfg.mode, 'local');
  const r = resolveStorage(input.env, { fallbacks: input.runtime.storageFallbacks });
  assert.equal(r.config.eventBuffer, 'local');
  assert.equal(r.config.skillRegistry, 'local_fs');
  assert.deepEqual(r.autoPostgres, []);
});

test('createCoreStorageContext: nothing configured returns immediately, all local', async () => {
  const ctx = await createCoreStorageContext({}, { stateDir: '/tmp/x' });
  assert.equal(ctx.eventBuffer, undefined);
  assert.equal(ctx.tieredAssets, undefined);
  assert.equal(ctx.cloudSkillsLoader, undefined);
  assert.deepEqual(ctx.warnings, []);
  assert.equal(ctx.config.eventBuffer, 'local');
  await ctx.shutdown();
});

test('createCoreStorageContext: DATABASE_URL unreachable → falls back to local with warnings (no throw)', async () => {
  const warned = [];
  const ctx = await createCoreStorageContext(
    { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' },
    { pgConnectTimeoutMs: 800, log: { warn: (m) => warned.push(m) } }
  );
  assert.equal(ctx.eventBuffer, undefined);
  assert.equal(ctx.cloudSkillsLoader, undefined);
  assert.equal(ctx.config.eventBuffer, 'local');
  assert.equal(ctx.config.skillRegistry, 'local_fs');
  assert.equal(ctx.fallbacks.eventBuffer?.code, 'pg_unreachable');
  assert.ok(warned.some((m) => /unreachable/.test(m)));
  await ctx.shutdown();
});

test('createCoreStorageContext: explicit cloud provider with missing dependency still throws', async () => {
  await assert.rejects(
    createCoreStorageContext({ RAW_AGENT_EVENT_BUFFER_PROVIDER: 'redis_postgres' }),
    /DATABASE_URL/
  );
});

// ── 领域包 ────────────────────────────────────────────────────────────────────

test('domains: nothing configured → none mounted', () => {
  const s = resolveDomainSelection({});
  assert.deepEqual(s.ids, []);
  assert.equal(s.source, 'local-fallback');
});

test('domains: SRE_* / STOCK_* connection settings auto-mount their pack', () => {
  assert.deepEqual(resolveDomainSelection({ SRE_PROM_URL: 'http://p' }).ids, ['sre']);
  assert.deepEqual(resolveDomainSelection({ STOCK_API_KEY: 'k' }).ids, ['stock']);
  const both = resolveDomainSelection({ SRE_PAGERDUTY_TOKEN: 't', STOCK_NEWS_URL: 'http://n' });
  assert.deepEqual(both.ids, ['sre', 'stock']);
  assert.equal(both.source, 'auto-detected');
  assert.deepEqual(both.detected.sre, ['SRE_PAGERDUTY_TOKEN']);
});

test('domains: ambient KUBECONFIG / provider choice alone is not "configured"', () => {
  assert.deepEqual(resolveDomainSelection({ KUBECONFIG: '/home/u/.kube/config', STOCK_QUOTE_PROVIDER: 'yahoo' }).ids, []);
});

test('domains: an explicit RAW_AGENT_DOMAINS CSV wins over auto-detection (even blank)', () => {
  assert.deepEqual(resolveDomainSelection({ RAW_AGENT_DOMAINS: 'stock', SRE_PROM_URL: 'http://p' }).ids, ['stock']);
  const blank = resolveDomainSelection({ RAW_AGENT_DOMAINS: '', SRE_PROM_URL: 'http://p' });
  assert.deepEqual(blank.ids, []);
  assert.equal(blank.source, 'explicit-env');
  const erp = resolveDomainSelection({ RAW_AGENT_DOMAINS: 'erp,homeiot' });
  assert.deepEqual(erp.ids, ['erp', 'homeiot']);
});

test('domains: erp / homeiot are never auto-mounted', () => {
  assert.deepEqual(resolveDomainSelection({ ERP_BASE_URL: 'http://e', HOMEIOT_URL: 'http://h' }).ids, []);
});

// ── 向量召回 ──────────────────────────────────────────────────────────────────

test('embedding: auto follows a dedicated embedding upstream, not the chat key alone', () => {
  assert.equal(resolveEmbeddingRecall({}, 'auto').enabled, false);
  const chatOnly = { RAW_AGENT_BASE_URL: 'http://x/v1', RAW_AGENT_API_KEY: 'k' };
  assert.equal(resolveEmbeddingRecall(chatOnly, 'auto').enabled, false);
  assert.equal(resolveEmbeddingRecall({ ...chatOnly, RAW_AGENT_EMBEDDING_MODEL: 'm' }, 'auto').enabled, true);
  assert.equal(
    resolveEmbeddingRecall({ RAW_AGENT_EMBEDDING_BASE_URL: 'http://e', RAW_AGENT_EMBEDDING_API_KEY: 'k' }, 'auto').enabled,
    true
  );
  const partial = resolveEmbeddingRecall({ RAW_AGENT_EMBEDDING_API_KEY: 'k' }, 'auto');
  assert.equal(partial.enabled, false);
  assert.equal(partial.reasonCode, 'embedding_partial');
});

test('embedding: explicit off beats a configured upstream; explicit on may reuse the chat key', () => {
  const dedicated = { RAW_AGENT_EMBEDDING_BASE_URL: 'http://e', RAW_AGENT_EMBEDDING_API_KEY: 'k' };
  assert.equal(resolveEmbeddingRecall(dedicated, 'off').enabled, false);
  const chatOnly = { RAW_AGENT_BASE_URL: 'http://x/v1', RAW_AGENT_API_KEY: 'k' };
  assert.equal(resolveEmbeddingRecall(chatOnly, 'on').enabled, true);
  assert.equal(resolveEmbeddingRecall({}, 'on').enabled, false);
});

test('embedding: effective item reports source lab vs auto-detected vs fallback', () => {
  const dedicated = { RAW_AGENT_EMBEDDING_BASE_URL: 'http://e', RAW_AGENT_EMBEDDING_API_KEY: 'k' };
  const pick = (env, mode) =>
    byId(resolveEffectiveConfig({ env, lab: { memory: { persisted: mode !== 'auto', embeddingRecallMode: mode } } }), 'capability.embeddingRecall');
  assert.equal(pick(dedicated, 'auto').source, 'auto-detected');
  assert.equal(pick(dedicated, 'auto').enabled, true);
  assert.equal(pick(dedicated, 'off').source, 'lab');
  assert.equal(pick(dedicated, 'off').enabled, false);
  assert.equal(pick({}, 'auto').source, 'local-fallback');
  assert.equal(pick({}, 'on').warnings[0].code, 'embedding_no_key');
});

test('memory settings: tri-state with legacy boolean compatibility', () => {
  assert.equal(defaultMemorySettings().embeddingRecallMode, 'auto');
  assert.equal(normalizeMemorySettings({}).embeddingRecallMode, 'auto');
  assert.equal(normalizeMemorySettings({ embeddingRecall: true }).embeddingRecallMode, 'on');
  assert.equal(normalizeMemorySettings({ embeddingRecall: false }).embeddingRecallMode, 'off');
  assert.equal(normalizeMemorySettings({ embeddingRecallMode: 'auto', embeddingRecall: false }).embeddingRecallMode, 'auto');
  assert.equal(normalizeMemorySettings({ embeddingRecallMode: 'on' }).embeddingRecall, true);
});

test('memory settings: saving an unrelated field does not turn auto into an explicit off', () => {
  const store = kv();
  writeMemorySettings(store, { curatorMode: 'observe_only' });
  assert.equal(readMemorySettings(store).embeddingRecallMode, 'auto');
  writeMemorySettings(store, { embeddingRecall: false });
  assert.equal(readMemorySettings(store).embeddingRecallMode, 'off');
  writeMemorySettings(store, { dialogueExtract: false });
  assert.equal(readMemorySettings(store).embeddingRecallMode, 'off');
  writeMemorySettings(store, { embeddingRecallMode: 'auto' });
  assert.equal(readMemorySettings(store).embeddingRecallMode, 'auto');
});

test('memory embedding gate: legacy boolean callers keep working', () => {
  const chatOnly = { RAW_AGENT_BASE_URL: 'http://x/v1', RAW_AGENT_API_KEY: 'k' };
  assert.equal(memoryEmbeddingConfigured(chatOnly, { embeddingRecall: true }), true);
  assert.equal(memoryEmbeddingConfigured(chatOnly, { embeddingRecall: false }), false);
  assert.equal(memoryEmbeddingConfigured({}, { embeddingRecall: true }), false);
  assert.equal(memoryEmbeddingRequested({}, { embeddingRecall: true }), true);
  assert.equal(memoryEmbeddingRequested({}, defaultMemorySettings()), false);
  assert.equal(
    memoryEmbeddingRequested({ RAW_AGENT_EMBEDDING_MODEL: 'm', RAW_AGENT_BASE_URL: 'http://x', RAW_AGENT_API_KEY: 'k' }, defaultMemorySettings()),
    true
  );
});

// ── web 搜索（Lab > env > 兜底）──────────────────────────────────────────────

test('webSearch: Lab template > env template > not exposed', () => {
  const tpl = 'https://s.example/?q={query}';
  const pick = (input) => byId(resolveEffectiveConfig(input), 'capability.webSearch');

  const none = pick({ env: {} });
  assert.equal(none.enabled, false);
  assert.equal(none.source, 'local-fallback');

  const fromEnv = pick({ env: { RAW_AGENT_WEB_SEARCH_URL: tpl } });
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.source, 'auto-detected');

  const fromLab = pick({
    env: { RAW_AGENT_WEB_SEARCH_URL: tpl },
    lab: { webSearch: { persisted: true, template: 'https://lab.example/?q={query}' } }
  });
  assert.equal(fromLab.source, 'lab');
  assert.equal(fromLab.enabled, true);

  const cleared = pick({
    env: { RAW_AGENT_WEB_SEARCH_URL: tpl },
    lab: { webSearch: { persisted: true, template: '' } }
  });
  assert.equal(cleared.enabled, false, 'an explicit Lab clear beats the env fallback');
  assert.equal(cleared.source, 'lab');

  const bad = pick({ env: { RAW_AGENT_WEB_SEARCH_URL: 'https://s.example/' } });
  assert.ok(bad.warnings.some((w) => w.code === 'web_search_missing_query'));
});

// ── MCP / VL ──────────────────────────────────────────────────────────────────

test('mcp: URLs or stdio configured → enabled; none → off; broken stdio → warning', () => {
  const pick = (env) => byId(resolveEffectiveConfig({ env }), 'capability.mcp');
  assert.equal(pick({}).enabled, false);
  const http = pick({ RAW_AGENT_MCP_URLS: 'http://a/mcp, http://b/mcp' });
  assert.equal(http.enabled, true);
  assert.equal(http.params.http, 2);
  assert.equal(pick({ RAW_AGENT_MCP_URL: 'http://a/mcp' }).enabled, true);
  const stdio = pick({ RAW_AGENT_MCP_STDIO: JSON.stringify([{ command: 'npx', args: ['x'] }]) });
  assert.equal(stdio.enabled, true);
  assert.equal(stdio.params.stdio, 1);
  const bad = pick({ RAW_AGENT_MCP_STDIO: 'not json' });
  assert.equal(bad.enabled, false);
  assert.ok(bad.warnings.some((w) => w.code === 'mcp_stdio_invalid'));
  const json = pick({
    RAW_AGENT_MCP_HTTP: JSON.stringify([{ url: 'http://j/mcp' }]),
    RAW_AGENT_MCP_URLS: 'http://j/mcp,http://k/mcp'
  });
  assert.equal(json.params.http, 2);
  const badHttp = pick({ RAW_AGENT_MCP_HTTP: '{' });
  assert.equal(badHttp.enabled, false);
  assert.ok(badHttp.warnings.some((w) => w.code === 'mcp_http_invalid'));
  const live = byId(
    resolveEffectiveConfig({
      env: { RAW_AGENT_MCP_URLS: 'http://a/mcp' },
      runtime: { mcpHttpConnected: 1 }
    }),
    'capability.mcp'
  );
  assert.equal(live.reasonCode, 'mcp_connected');
  assert.equal(live.params.connected, 1);
  assert.equal(live.params.http, 1);
});

test('vision: VL model with endpoint → hybrid router on; model only → warning, off; none → off', () => {
  const pick = (input) => byId(resolveEffectiveConfig(input), 'capability.vision');
  assert.equal(pick({ env: {} }).enabled, false);
  const ok = pick({
    env: { RAW_AGENT_VL_MODEL_NAME: 'vl', RAW_AGENT_BASE_URL: 'http://x/v1', RAW_AGENT_API_KEY: 'k' }
  });
  assert.equal(ok.enabled, true);
  assert.equal(ok.source, 'auto-detected');
  const own = pick({
    env: { RAW_AGENT_VL_MODEL_NAME: 'vl', RAW_AGENT_VL_BASE_URL: 'http://v/v1', RAW_AGENT_VL_API_KEY: 'k' }
  });
  assert.equal(own.enabled, true);
  const half = pick({ env: { RAW_AGENT_VL_MODEL_NAME: 'vl' } });
  assert.equal(half.enabled, false);
  assert.equal(half.reasonCode, 'partial_config');
  assert.ok(half.warnings.some((w) => w.code === 'vl_missing_endpoint'));
  const viaLab = pick({
    env: { RAW_AGENT_VL_MODEL_NAME: 'vl' },
    lab: { openAiCompatibleProviderConfigured: true }
  });
  assert.equal(viaLab.enabled, true);
});

// ── 刻意保持显式的能力 ─────────────────────────────────────────────────────────

test('gateway: config file present does NOT enable it (inbound endpoint) — only a hint', () => {
  const pick = (input) => byId(resolveEffectiveConfig(input), 'capability.gateway');
  const detected = pick({ env: {}, probes: { gatewayConfigExists: true } });
  assert.equal(detected.enabled, false);
  assert.ok(detected.hints.some((h) => h.code === 'gateway_config_detected'));
  assert.equal(pick({ env: { RAW_AGENT_GATEWAY_ENABLED: '1' }, probes: { gatewayConfigExists: true } }).enabled, true);
  const off = pick({ env: { RAW_AGENT_GATEWAY_ENABLED: '0' }, probes: { gatewayConfigExists: true } });
  assert.equal(off.enabled, false);
  assert.equal(off.source, 'explicit-env');
  const noFile = pick({ env: { RAW_AGENT_GATEWAY_ENABLED: 'true' }, probes: { gatewayConfigExists: false } });
  assert.ok(noFile.warnings.some((w) => w.code === 'gateway_no_config'));
});

test('manual capabilities: binaries on PATH never auto-enable anything', () => {
  const cfg = resolveEffectiveConfig({
    env: {},
    probes: { localBinaries: ['claude', 'codex'] }
  });
  const ext = byId(cfg, 'manual.externalAiTools');
  assert.equal(ext.enabled, false);
  assert.ok(ext.hints.some((h) => h.code === 'local_binaries_detected' && /claude/.test(h.message)));
  for (const id of ['externalAiTools', 'browser', 'cron', 'a2ui']) {
    assert.equal(byId(cfg, `manual.${id}`).enabled, false, id);
  }
  const discovery = byId(cfg, 'manual.discovery');
  assert.equal(discovery.enabled, true);
  assert.equal(discovery.mode, 'on');
  assert.equal(discovery.source, 'local-fallback');
  assert.equal(discovery.reasonCode, 'default_on');
  const discoveryOff = resolveEffectiveConfig({ env: { RAW_AGENT_DISCOVERY: '0' } });
  assert.equal(byId(discoveryOff, 'manual.discovery').enabled, false);
  assert.equal(byId(discoveryOff, 'manual.discovery').source, 'explicit-env');
  assert.equal(byId(discoveryOff, 'manual.discovery').reasonCode, 'explicit_off');
  const discoveryOn = resolveEffectiveConfig({ env: { RAW_AGENT_DISCOVERY: '1' } });
  assert.equal(byId(discoveryOn, 'manual.discovery').enabled, true);
  assert.equal(byId(discoveryOn, 'manual.discovery').source, 'explicit-env');
  assert.equal(byId(discoveryOn, 'manual.discovery').reasonCode, 'explicit_on');
  const on = resolveEffectiveConfig({ env: { RAW_AGENT_EXTERNAL_AI_TOOLS: '1', RAW_AGENT_CRON_TOOLS: '0' } });
  assert.equal(byId(on, 'manual.externalAiTools').enabled, true);
  assert.equal(byId(on, 'manual.externalAiTools').source, 'explicit-env');
  assert.equal(byId(on, 'manual.cron').enabled, false);
  assert.equal(byId(on, 'manual.cron').source, 'explicit-env');
});

test('manual capabilities: Lab persisted value beats env', () => {
  const cfg = resolveEffectiveConfig({
    env: { RAW_AGENT_BROWSER_TOOLS: '1', RAW_AGENT_DISCOVERY: '1' },
    lab: { browser: { persisted: true, enabled: false }, discovery: { persisted: true, enabled: false } }
  });
  assert.equal(byId(cfg, 'manual.browser').enabled, false);
  assert.equal(byId(cfg, 'manual.browser').source, 'lab');
  assert.equal(byId(cfg, 'manual.discovery').enabled, false);
});

test('effective config never leaks connection strings or secrets', () => {
  const cfg = resolveEffectiveConfig({
    env: {
      DATABASE_URL: 'postgres://user:SECRETPW@h/db',
      REDIS_URL: 'redis://:REDISPW@h:6379',
      RAW_AGENT_S3_SECRET_KEY: 'S3SECRET',
      RAW_AGENT_S3_ENDPOINT: 'http://e',
      RAW_AGENT_API_KEY: 'APIKEY',
      SRE_PAGERDUTY_TOKEN: 'PDTOKEN'
    }
  });
  const text = JSON.stringify(cfg);
  for (const s of ['SECRETPW', 'REDISPW', 'S3SECRET', 'APIKEY', 'PDTOKEN']) {
    assert.ok(!text.includes(s), `leaked ${s}`);
  }
});
