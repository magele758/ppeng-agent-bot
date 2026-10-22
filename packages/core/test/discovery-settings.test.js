import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { CapabilityRegistry } from '../dist/discovery/index.js';
import { createToolSearchTools } from '../dist/tools/tool-search.js';
import { resolveEffectiveConfig } from '../dist/config/effective-config.js';
import {
  defaultDiscoverySettings,
  readDiscoverySettings,
  writeDiscoverySettings,
  resolveDiscoveryEnabled,
  resolveTailscaleDiscoveryEnabled,
  hasPersistedDiscoverySettings
} from '../dist/discovery/settings.js';

function isOffRefusal(res) {
  return res.ok === false && /disabled|未开启/.test(String(res.content ?? ''));
}

async function runToolSearch(store, env) {
  const registry = new CapabilityRegistry(store.capabilities());
  const tools = createToolSearchTools({
    getRegistry: () => registry,
    settingsStore: store,
    env
  });
  const search = tools.find((tool) => tool.name === 'tool_search');
  assert.ok(search, 'tool_search missing');
  return search.execute({ sessionId: 's' }, { query: 'nothing-matches' });
}

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-settings-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    await fn(store);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('discovery settings: UI persistence wins over env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-settings-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));

  assert.equal(hasPersistedDiscoverySettings(store), false);
  // No UI row and no env → on. Explicit 0/false/no/off stays off. Saved value wins after that.
  assert.equal(resolveDiscoveryEnabled(store, {}), true);
  assert.equal(resolveDiscoveryEnabled(store, { RAW_AGENT_DISCOVERY: '1' }), true);
  assert.equal(resolveDiscoveryEnabled(store, { RAW_AGENT_DISCOVERY: '0' }), false);
  assert.equal(resolveDiscoveryEnabled(store, { RAW_AGENT_DISCOVERY: 'false' }), false);
  assert.equal(resolveDiscoveryEnabled(store, { RAW_AGENT_DISCOVERY: 'no' }), false);
  assert.equal(resolveDiscoveryEnabled(store, { RAW_AGENT_DISCOVERY: 'off' }), false);

  writeDiscoverySettings(store, { enabled: true, tailscaleEnabled: true });
  assert.equal(hasPersistedDiscoverySettings(store), true);
  // Persisted off would win; here on wins even if env says 0
  assert.equal(resolveDiscoveryEnabled(store, { RAW_AGENT_DISCOVERY: '0' }), true);
  assert.equal(
    resolveTailscaleDiscoveryEnabled(store, {
      RAW_AGENT_DISCOVERY: '0',
      RAW_AGENT_TAILSCALE_DISCOVERY: '0'
    }),
    true
  );

  writeDiscoverySettings(store, { enabled: false, tailscaleEnabled: true });
  assert.equal(resolveDiscoveryEnabled(store, { RAW_AGENT_DISCOVERY: '1' }), false);
  assert.equal(
    resolveTailscaleDiscoveryEnabled(store, { RAW_AGENT_DISCOVERY: '1', RAW_AGENT_TAILSCALE_DISCOVERY: '1' }),
    false
  );

  const s = readDiscoverySettings(store);
  assert.equal(s.enabled, false);
  assert.equal(s.tailscaleEnabled, true);

  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('未保存且未设置 RAW_AGENT_DISCOVERY 时 tool_search 不会因未开启被拒绝 [AC:discovery-default-on#AC-1]', async () => {
  await withStore(async (store) => {
    assert.equal(hasPersistedDiscoverySettings(store), false);
    assert.equal(resolveDiscoveryEnabled(store, {}), true);
    const res = await runToolSearch(store, {});
    assert.equal(isOffRefusal(res), false);
    assert.equal(res.ok, true);
    const body = JSON.parse(res.content);
    assert.ok(Array.isArray(body.hits));
  });
});

test('已保存关闭后外部发现拒绝而本地搜索独立 [AC:discovery-default-on#AC-2]', async () => {
  await withStore(async (store) => {
    writeDiscoverySettings(store, { enabled: false });
    const env = { RAW_AGENT_DISCOVERY: '1' };
    assert.equal(resolveDiscoveryEnabled(store, env), false);
    const res = await runToolSearch(store, env);
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(res.content).externalDiscoveryEnabled, false);
    assert.deepEqual(JSON.parse(res.content).hits, []);
    const tools=createToolSearchTools({settingsStore:store,env,getRegistry:()=>{throw new Error('Disabled discovery must not access registry');}});
    assert.equal((await tools.find(t=>t.name==='load_capability_tool').execute({}, {id:'external-capability'})).ok,false);
  });
});

test('已保存开启后即使环境为关 tool_search 也不会因未开启失败 [AC:discovery-default-on#AC-3]', async () => {
  await withStore(async (store) => {
    writeDiscoverySettings(store, { enabled: true });
    const env = { RAW_AGENT_DISCOVERY: '0' };
    assert.equal(resolveDiscoveryEnabled(store, env), true);
    const res = await runToolSearch(store, env);
    assert.equal(isOffRefusal(res), false);
    assert.equal(res.ok, true);
  });
});

test('安装关闭外部发现不阻止本地搜索 [AC:discovery-default-on#AC-4]', async () => {
  await withStore(async (store) => {
    assert.equal(hasPersistedDiscoverySettings(store), false);
    const env = { RAW_AGENT_DISCOVERY: '0' };
    assert.equal(resolveDiscoveryEnabled(store, env), false);
    const res = await runToolSearch(store, env);
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(res.content).externalDiscoveryEnabled, false);
    assert.deepEqual(JSON.parse(res.content).hits, []);
    const tools=createToolSearchTools({settingsStore:store,env,getRegistry:()=>{throw new Error('Disabled discovery must not access registry');}});
    assert.equal((await tools.find(t=>t.name==='load_capability_tool').execute({}, {id:'external-capability'})).ok,false);
  });
});

test('默认总开关开启，设备列表、主动扫描和白名单仍关闭 [AC:discovery-default-on#AC-5]', () => {
  const defaults = defaultDiscoverySettings();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.tailscaleEnabled, false);
  assert.equal(defaults.activeScanEnabled, false);
  assert.deepEqual(defaults.hostAllowlist, []);
  assert.deepEqual(defaults.cidrAllowlist, []);

  const item = resolveEffectiveConfig({ env: {} }).items.find((entry) => entry.id === 'manual.discovery');
  assert.ok(item);
  assert.equal(item.enabled, true);
  assert.equal(item.mode, 'on');
  assert.equal(item.source, 'local-fallback');
  assert.equal(item.reasonCode, 'default_on');
  assert.match(item.reason, /on by default/i);
});
