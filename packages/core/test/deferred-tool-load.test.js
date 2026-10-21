import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgents } from '../dist/builtin-agents.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
import { assembleOptionalTools } from '../dist/runtime/tool-assembly.js';
import { SqliteStateStore } from '../dist/storage.js';
import { withOnDemandDisclosure } from '../dist/tools/deferred-disclosure.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';

const MISSING_TOOL = /unknown tool|没有这个工具|no such tool/i;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deferred-tool-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = store.createSession({
    title: 'general chat',
    mode: 'chat',
    agentId: 'general',
    background: false
  });
  const agent = builtinAgents.find((item) => item.id === 'general');
  assert.ok(agent);
  assert.equal(agent.allowedTools, undefined);
  return { dir, store, session, agent };
}

function shell(name, description, execute) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute
  };
}

function wire(store, dir, catalog) {
  const env = { RAW_AGENT_DISCOVERY: '0' };
  const assembled = assembleOptionalTools({
    env,
    store,
    stateDir: dir,
    getCronStore() {
      throw new Error('cron store is not used');
    },
    getCatalog: () => catalog
  });
  const search = assembled.find((tool) => tool.name === 'tool_search');
  const load = assembled.find((tool) => tool.name === 'load_capability_tool');
  assert.ok(search);
  assert.ok(load);
  return { env, search, load };
}

function visibleNames(env, store, catalog, agent, session) {
  return filterToolsForSession({
    env,
    tools: catalog,
    agent,
    session,
    settingsStore: store
  }).tools.map((tool) => tool.name);
}

function context(dir, session, agent) {
  return { repoRoot: dir, stateDir: dir, session, agent };
}

function searchedNames(result) {
  if (!result.ok) return [];
  const body = JSON.parse(result.content);
  return (body.hits ?? []).map((hit) => hit.name);
}

test('隐藏的股票行情能被搜到、加载并在下一步调用 [AC:necessary-tool-injection#AC-2]', async (t) => {
  const { dir, store, session, agent } = fixture(t);
  const quote = withOnDemandDisclosure(
    shell('quote_get', 'Get the latest stock quote for a symbol.', async () => ({
      ok: false,
      content: 'Connection failed: stock quote provider is unreachable (STOCK_API_KEY is not set).'
    }))
  );
  const k8s = withOnDemandDisclosure(
    shell('k8s_get', 'Query Kubernetes cluster resources.', async () => ({
      ok: false,
      content: 'Connection failed: cluster API is unreachable.'
    }))
  );
  const read = shell('read_file', 'Read a file from the workspace.', async () => ({
    ok: true,
    content: 'ok'
  }));
  const catalog = [read, quote, k8s];
  const { env, search, load } = wire(store, dir, catalog);
  const ctx = context(dir, session, agent);

  const first = visibleNames(env, store, catalog, agent, session);
  assert.equal(first.includes('quote_get'), false);
  assert.equal(first.includes('k8s_get'), false);
  assert.equal(first.includes('read_file'), true);

  const searched = await search.execute(ctx, { query: 'stock quote' });
  assert.equal(searched.ok, true);
  assert.equal(String(searched.content).includes('Capability discovery is disabled'), false);
  const body = JSON.parse(searched.content);
  const quoteHit = body.hits.find((hit) => hit.name === 'quote_get');
  assert.ok(quoteHit);
  assert.equal(quoteHit.source, 'deferred_tool');
  assert.equal(quoteHit.description, quote.description);
  assert.equal(body.hits.some((hit) => hit.name === 'k8s_get'), false);

  const loaded = await load.execute(ctx, { name: 'quote_get' });
  assert.equal(loaded.ok, true);
  assert.match(loaded.content, /quote_get/);
  assert.match(loaded.content, /next step/);

  const fresh = store.getSession(session.id);
  assert.ok(fresh);
  const second = visibleNames(env, store, catalog, agent, fresh);
  assert.equal(second.includes('quote_get'), true);
  assert.equal(second.includes('k8s_get'), false);

  const executed = await quote.execute(ctx, { symbol: 'AAPL' });
  assert.equal(executed.ok, false);
  assert.match(executed.content, /connection|STOCK_API_KEY|key/i);
  assert.doesNotMatch(executed.content, MISSING_TOOL);

  const prefix = new PromptBuilder({ store, repoRoot: dir, stateDir: dir }).buildStablePrefix({
    agent,
    session: fresh,
    repoRoot: dir
  });
  assert.match(prefix, /Tool delivery is progressive/);
  assert.match(prefix, /tool_search/);
  assert.match(prefix, /loaded automatically/);
  assert.match(prefix, /callable next turn/);
  assert.match(prefix, /permissions and configuration/);
});

test('关掉本机桌面操作后不能搜出或加载桌面工具 [AC:necessary-tool-injection#AC-3]', async (t) => {
  const { dir, store, session, agent } = fixture(t);
  store.setDaemonControl('computer_use_settings', { enabled: false });
  const desktop = withOnDemandDisclosure(
    shell('lcu_click', 'Click on the local desktop.', async () => ({ ok: true, content: 'clicked' }))
  );
  const catalog = [
    shell('read_file', 'Read a file from the workspace.', async () => ({ ok: true, content: 'ok' })),
    desktop
  ];
  const { env, search, load } = wire(store, dir, catalog);
  const ctx = context(dir, session, agent);

  for (const query of ['lcu_click', '']) {
    const searched = await search.execute(ctx, { query });
    assert.equal(searchedNames(searched).includes('lcu_click'), false, query);
  }
  const loaded = await load.execute(ctx, { name: 'lcu_click' });
  assert.equal(loaded.ok, false);
  const fresh = store.getSession(session.id);
  assert.ok(fresh);
  assert.equal(JSON.stringify(fresh.metadata).includes('lcu_click'), false);
  assert.equal(visibleNames(env, store, catalog, agent, fresh).includes('lcu_click'), false);
});

test('未开启动态工具时不能搜出或加载 save_as_tool [AC:necessary-tool-injection#AC-4]', async (t) => {
  const { dir, store, session, agent } = fixture(t);
  assert.equal(store.getDaemonControl('dyn_tool_settings'), undefined);
  const save = withOnDemandDisclosure(
    shell('save_as_tool', 'Save a temporary tool for reuse.', async () => ({ ok: true, content: 'saved' }))
  );
  const catalog = [
    shell('read_file', 'Read a file from the workspace.', async () => ({ ok: true, content: 'ok' })),
    save
  ];
  const { env, search, load } = wire(store, dir, catalog);
  const ctx = context(dir, session, agent);

  for (const query of ['save_as_tool', '']) {
    const searched = await search.execute(ctx, { query });
    assert.equal(searchedNames(searched).includes('save_as_tool'), false, query);
  }
  const loaded = await load.execute(ctx, { name: 'save_as_tool' });
  assert.equal(loaded.ok, false);
  const fresh = store.getSession(session.id);
  assert.ok(fresh);
  assert.equal(JSON.stringify(fresh.metadata).includes('save_as_tool'), false);
  assert.equal(visibleNames(env, store, catalog, agent, fresh).includes('save_as_tool'), false);
});
