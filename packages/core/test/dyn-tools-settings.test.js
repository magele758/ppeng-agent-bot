import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSaveAsTool,
  createDynToolStore,
  createDynToolStoreFromSessionMemory,
  defaultDynToolSettings,
  hydrateTurnDynTools,
  readDynToolSettings,
  writeDynToolSettings,
  SAVE_AS_TOOL_NAME,
  PROPOSE_TOOL_NAME,
  SEARCH_DYN_TOOLS_NAME
} from '../dist/dyn-tools/index.js';
import { filterToolsForSession, resolveTurnTools } from '../dist/turn/resolve-turn-tools.js';

function kvStore() {
  const map = new Map([['tool_exposure_settings',{mode:'full',pinnedGroups:{}}]]);
  return {
    getDaemonControl(key) {
      return map.get(key);
    },
    setDaemonControl(key, value) {
      map.set(key, value);
    }
  };
}

function metaTool(name) {
  return {
    name,
    description: name,
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content: '' })
  };
}

const saveTool = metaTool(SAVE_AS_TOOL_NAME);
const proposeTool = metaTool(PROPOSE_TOOL_NAME);
const searchTool = metaTool(SEARCH_DYN_TOOLS_NAME);
const metaTools = [saveTool, proposeTool, searchTool];

const agent = { id: 'main', name: 'Main', role: 'assistant', instructions: '', capabilities: [] };
const session = {
  id: 's1',
  title: 't',
  mode: 'chat',
  status: 'idle',
  agentId: 'main',
  background: false,
  todo: [],
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

test('unconfigured settings default enabled=false', () => {
  assert.equal(readDynToolSettings(kvStore()).enabled, false);
  assert.equal(defaultDynToolSettings().enabled, false);
});

test('enabled=false hides meta tools and hydrates empty', () => {
  const kv = kvStore();
  const filtered = filterToolsForSession({
    env: {},
    tools: [saveTool],
    agent,
    session,
    settingsStore: kv
  });
  assert.ok(!filtered.tools.some((t) => t.name === SAVE_AS_TOOL_NAME));
  const store = createDynToolStore();
  store.upsert({
    name: 'ghost_fn',
    description: 'g',
    source: { code: 'return 1' },
    sessionId: 's1',
    status: 'active'
  });
  const hydrated = hydrateTurnDynTools({
    store: kv,
    session,
    dynStore: store,
    materializeDeps: { getAuthorizedTools: () => [] }
  });
  assert.deepEqual(hydrated.names, []);
});

test('allowPropose=false unloads propose_tool from tools[]', () => {
  const kv = kvStore();
  writeDynToolSettings(kv, { enabled: true, allowPropose: false, allowSave: true });
  const filtered = filterToolsForSession({
    env: {},
    tools: metaTools,
    agent,
    session,
    settingsStore: kv
  });
  assert.ok(filtered.tools.some((t) => t.name === SAVE_AS_TOOL_NAME));
  assert.ok(!filtered.tools.some((t) => t.name === PROPOSE_TOOL_NAME));
  const resolved = resolveTurnTools({
    env: {},
    tools: metaTools,
    agent,
    session,
    sessionId: session.id,
    systemPromptChars: 10,
    settingsStore: kv
  });
  assert.ok(!resolved.turnTools.some((t) => t.name === PROPOSE_TOOL_NAME));
});

test('allowSave=false unloads save_as_tool from tools[] (non-PTC)', () => {
  const kv = kvStore();
  writeDynToolSettings(kv, { enabled: true, allowSave: false, allowPropose: true });
  const filtered = filterToolsForSession({
    env: {},
    tools: metaTools,
    agent,
    session,
    settingsStore: kv
  });
  assert.ok(!filtered.tools.some((t) => t.name === SAVE_AS_TOOL_NAME));
  assert.ok(filtered.tools.some((t) => t.name === PROPOSE_TOOL_NAME));
});

test('enabled=false unloads all dyn meta tools including search_dyn_tools', () => {
  const kv = kvStore();
  writeDynToolSettings(kv, { enabled: false, allowSave: true, allowPropose: true });
  const filtered = filterToolsForSession({
    env: {},
    tools: metaTools,
    agent,
    session,
    settingsStore: kv
  });
  assert.deepEqual(
    filtered.tools.map((t) => t.name).filter((n) => [SAVE_AS_TOOL_NAME, PROPOSE_TOOL_NAME, SEARCH_DYN_TOOLS_NAME].includes(n)),
    []
  );
});

test('search_dyn_tools stays hidden until active count exceeds hydrateTopK', () => {
  const rows = [];
  const kv = new Map([['tool_exposure_settings',{mode:'full',pinnedGroups:{}}]]);
  const store = {
    getDaemonControl(key) {
      return kv.get(key);
    },
    setDaemonControl(key, value) {
      kv.set(key, value);
    },
    upsertSessionMemory(input) {
      rows.push({
        ...input,
        id: `m-${input.key}`,
        metadata: input.metadata ?? {},
        updatedAt: new Date().toISOString()
      });
    },
    listSessionMemory(sessionId, scope) {
      return rows.filter((r) => r.sessionId === sessionId && (!scope || r.scope === scope));
    },
    deleteSessionMemory(sessionId, scope, key) {
      const idx = rows.findIndex((r) => r.sessionId === sessionId && r.scope === scope && r.key === key);
      if (idx < 0) return false;
      rows.splice(idx, 1);
      return true;
    }
  };
  writeDynToolSettings(store, { enabled: true, allowSave: true, allowPropose: true, hydrateTopK: 2 });
  const dyn = createDynToolStoreFromSessionMemory(store);
  dyn.upsert({ name: 'fn_a', description: 'a', source: { code: 'return 1' }, sessionId: 's1', status: 'active' });
  const hidden = filterToolsForSession({
    env: {},
    tools: metaTools,
    agent,
    session,
    settingsStore: store
  });
  assert.ok(!hidden.tools.some((t) => t.name === SEARCH_DYN_TOOLS_NAME));
  dyn.upsert({ name: 'fn_b', description: 'b', source: { code: 'return 1' }, sessionId: 's1', status: 'active' });
  dyn.upsert({ name: 'fn_c', description: 'c', source: { code: 'return 1' }, sessionId: 's1', status: 'active' });
  const shown = filterToolsForSession({
    env: {},
    tools: metaTools,
    agent,
    session,
    settingsStore: store
  });
  assert.ok(shown.tools.some((t) => t.name === SEARCH_DYN_TOOLS_NAME));
});

test('enabled=true + allowSave=false rejects save_as_tool execute', async () => {
  const kv = kvStore();
  writeDynToolSettings(kv, { enabled: true, allowSave: false });
  const store = createDynToolStore();
  const tool = createSaveAsTool({
    getStore: () => store,
    settingsStore: kv
  });
  const result = await tool.execute(
    { session, agent, repoRoot: process.cwd(), stateDir: process.cwd() },
    { name: 'add_one', description: 'a', code: 'return 1' }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /allowSave/);
});
