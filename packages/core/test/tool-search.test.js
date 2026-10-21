import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { CapabilityRegistry } from '../dist/discovery/index.js';
import {
  createToolSearchTools,
  discoveryToolsEnabled,
  searchBoundCapabilities,
  toolDisclosureBudget
} from '../dist/tools/tool-search.js';

test('tool_search: budget limits hits for ≥30 bound cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-search-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const registry = new CapabilityRegistry(store.capabilities());
  for (let i = 0; i < 35; i++) {
    const card = registry.create({
      kind: 'custom',
      name: `tool_alpha_${i}`,
      description: `Alpha helper ${i}`,
      endpoint: `https://example.com/t/${i}`,
      trust: 'verified'
    });
    registry.bind(card.id, {
      approved: true,
      bindings: [{ toolName: `tool_alpha_${i}`, schemaHashPin: `hash${i}` }]
    });
  }
  const env = { RAW_AGENT_DISCOVERY: '1', RAW_AGENT_TOOL_DISCLOSURE_BUDGET: '10' };
  assert.equal(discoveryToolsEnabled(env), true);
  assert.equal(toolDisclosureBudget(env), 10);
  const hits = searchBoundCapabilities(registry, 'alpha', 10);
  assert.ok(hits.length <= 10);
  assert.ok(hits.length > 0);

  const tools = createToolSearchTools({ getRegistry: () => registry, env });
  assert.equal(tools.length, 2);
  const search = tools.find((t) => t.name === 'tool_search');
  const res = await search.execute({ sessionId: 's' }, { query: 'alpha' });
  assert.equal(res.ok, true);
  const body = JSON.parse(res.content);
  assert.ok(body.count <= 10);

  const strictTools = createToolSearchTools({
    getRegistry: () => registry,
    getShortlist: () => [hits[0].id],
    env: { ...env, RAW_AGENT_TOOL_LOAD_STRICT: '1' }
  });
  const load = strictTools.find((t) => t.name === 'load_capability_tool');
  const denied = await load.execute({ sessionId: 's' }, { id: hits[1].id });
  assert.equal(denied.ok, false);
  const allowed = await load.execute({ sessionId: 's' }, { id: hits[0].id });
  assert.equal(allowed.ok, true);

  const off = createToolSearchTools({
    getRegistry: () => registry,
    env: { RAW_AGENT_DISCOVERY: '0' }
  });
  const offRes = await off[0].execute({ sessionId: 's' }, { query: 'x' });
  assert.equal(offRes.ok, true);
  assert.equal(JSON.parse(offRes.content).externalDiscoveryEnabled, false);
  assert.deepEqual(JSON.parse(offRes.content).hits, []);

  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
