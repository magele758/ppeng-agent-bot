import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginFromDir } from '../dist/plugins/plugin-loader.js';
import {
  CONNECTOR_GRANTS_KEY,
  createConnectorRegistry,
  discoveryConnectorId,
  instructionsForGranted,
  mergeGrantedConnectorTools,
  pluginConnectorId,
  shouldInjectDiscovery
} from '../dist/connectors/registry.js';

const SECRET = 'super-secret-acme-value';
const USAGE = 'Call acme_ping to check the connector.';

function memoryStore() {
  const kv = new Map();
  return {
    getDaemonControl(key) {
      return kv.has(key) ? structuredClone(kv.get(key)) : undefined;
    },
    setDaemonControl(key, value) {
      kv.set(key, structuredClone(value));
    }
  };
}

function promptFragment(registry, env) {
  return ['stable prefix', instructionsForGranted(registry, env)].filter(Boolean).join('\n\n---\n\n');
}

function writePlugin(root) {
  const pluginDir = join(root, 'acme');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      id: 'acme',
      name: 'Acme',
      instructions: 'USAGE.md',
      auth: { kind: 'bearer', secretEnv: 'ACME_TOKEN', headerName: 'X-Acme-Token' },
      tools: [{ name: 'acme_ping', description: `Ping Acme ${SECRET}` }]
    })
  );
  writeFileSync(join(pluginDir, 'USAGE.md'), `${USAGE}\nThe live token is ${SECRET}.\n`);
  return pluginDir;
}

function card(overrides) {
  return {
    id: 'docs',
    kind: 'mcp',
    name: 'Docs',
    description: `Search docs ${SECRET}`,
    endpoint: 'https://user:super-secret-acme-value@docs.example',
    transport: 'mcp',
    trust: 'untrusted',
    scope: ['read'],
    credRef: 'vault:docs',
    source: 'manual',
    metadata: { apiKey: SECRET },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'connector-plugin-'));
  const pluginDir = writePlugin(root);
  const loaded = loadPluginFromDir(pluginDir);
  const cards = [card({ id: 'untrusted-card', name: 'UNTRUSTED-MARKER', trust: 'untrusted' })];
  const store = memoryStore();
  const env = { ACME_TOKEN: SECRET };
  const registry = createConnectorRegistry({
    store,
    getPlugins: () => [loaded],
    getCapabilities: () => cards,
    getDomains: () => [{ id: 'sre', title: 'SRE Agent', instructions: '' }]
  });
  return { root, loaded, cards, store, env, registry };
}

test('ungranted connectors contribute no tools and no prompt instructions', () => {
  const h = harness();
  try {
    assert.equal(h.loaded.tools.length, 0);
    assert.equal(h.loaded.authKind, 'bearer');
    assert.equal(h.loaded.secretEnv, 'ACME_TOKEN');
    assert.match(h.loaded.instructionText, /Call acme_ping/);

    assert.deepEqual(h.registry.toolsForGranted(h.env), []);
    const prompt = promptFragment(h.registry, h.env);
    assert.equal(prompt.includes(USAGE), false);
    assert.equal(prompt.includes('UNTRUSTED-MARKER'), false);
    assert.equal(prompt.includes(SECRET), false);
    assert.equal(shouldInjectDiscovery('untrusted', false), false);
    assert.equal(shouldInjectDiscovery('bound', false), false);

    const listed = h.registry.listConnectors(h.env);
    assert.equal(listed.some((row) => row.id === pluginConnectorId('acme') && row.granted === false), true);
    assert.equal(listed.some((row) => row.source === 'domain' && row.title === 'SRE Agent'), true);
    assert.equal(listed.some((row) => row.id === discoveryConnectorId('untrusted-card')), false);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('grant reveals instructions without the secret, revoke drops the connector on the next turn', () => {
  const h = harness();
  try {
    h.cards.push(card({ id: 'docs', name: 'Bound Docs', trust: 'bound' }));
    const pluginId = pluginConnectorId('acme');
    assert.throws(
      () => h.registry.grantConnector(pluginId, { secretEnv: 'ACME_TOKEN', value: SECRET }, h.env),
      /secretEnv or credRef/
    );
    assert.equal(JSON.stringify(h.store.getDaemonControl(CONNECTOR_GRANTS_KEY) ?? {}).includes(SECRET), false);

    const granted = h.registry.grantConnector(
      pluginId,
      { secretEnv: 'ACME_TOKEN', credRef: 'vault:acme' },
      h.env
    );
    assert.equal(granted.granted, true);
    assert.equal(granted.secretEnv, 'ACME_TOKEN');
    assert.equal(granted.credRef, 'vault:acme');
    const prompt = promptFragment(h.registry, h.env);
    assert.equal(prompt.includes(USAGE), true);
    assert.equal(prompt.includes('Secret env name: ACME_TOKEN'), true);
    assert.equal(prompt.includes(SECRET), false);
    assert.equal(prompt.includes('UNTRUSTED-MARKER'), false);
    const tools = h.registry.toolsForGranted(h.env);
    assert.deepEqual(tools.map((tool) => tool.name), ['acme_ping']);
    assert.equal(JSON.stringify(tools).includes(SECRET), false);

    const docsId = discoveryConnectorId('docs');
    h.registry.grantConnector(docsId, { credRef: 'vault:docs' }, h.env);
    const withDocs = promptFragment(h.registry, h.env);
    assert.equal(withDocs.includes('Bound Docs'), true);
    assert.equal(withDocs.includes(SECRET), false);
    assert.equal(withDocs.includes('user:'), false);

    const pub = h.registry.listPublic(h.env);
    const wire = JSON.stringify(pub);
    assert.equal(wire.includes(SECRET), false);
    assert.equal(wire.includes(USAGE), false);
    assert.equal(wire.includes('instructions'), false);
    assert.equal(pub.find((row) => row.id === pluginId).secretEnv, 'ACME_TOKEN');
    assert.equal(pub.find((row) => row.id === pluginId).credRef, 'vault:acme');
    assert.throws(
      () => h.registry.grantConnector(pluginId, { credRef: SECRET }, h.env),
      /reference name/
    );

    h.registry.revokeConnector(pluginId, h.env);
    h.registry.revokeConnector(docsId, h.env);
    const next = createConnectorRegistry({
      store: h.store,
      getPlugins: () => [h.loaded],
      getCapabilities: () => h.cards,
      getDomains: () => [{ id: 'sre', title: 'SRE Agent', instructions: '' }]
    });
    const after = promptFragment(next, h.env);
    assert.equal(after.includes(USAGE), false);
    assert.equal(after.includes('Bound Docs'), false);
    assert.deepEqual(next.toolsForGranted(h.env), []);
    assert.equal(next.listConnectors(h.env).find((row) => row.id === pluginId).granted, false);
    assert.equal(shouldInjectDiscovery('untrusted', true), false);
    assert.equal(shouldInjectDiscovery('bound', true), true);

    const catalog = [{ name: 'prom_query' }];
    let injected = new Set();
    injected = mergeGrantedConnectorTools(catalog, [{ name: 'acme_ping' }], injected);
    assert.deepEqual(catalog.map((tool) => tool.name), ['prom_query', 'acme_ping']);
    injected = mergeGrantedConnectorTools(catalog, [], injected);
    assert.deepEqual(catalog.map((tool) => tool.name), ['prom_query']);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('a later model turn omits a revoked connector and never sees the secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-runtime-'));
  const pluginRoot = mkdtempSync(join(tmpdir(), 'connector-plugins-'));
  writePlugin(pluginRoot);
  const prev = {
    plugins: process.env.RAW_AGENT_PLUGINS_DIR,
    token: process.env.ACME_TOKEN,
    turns: process.env.RAW_AGENT_MAX_TURNS,
    strict: process.env.RAW_AGENT_PROMPT_CACHE_STRICT
  };
  process.env.RAW_AGENT_PLUGINS_DIR = pluginRoot;
  process.env.ACME_TOKEN = SECRET;
  process.env.RAW_AGENT_MAX_TURNS = '8';
  process.env.RAW_AGENT_PROMPT_CACHE_STRICT = '0';
  const seen = [];
  const { RawAgentRuntime } = await import('../dist/runtime.js');
  let rt;
  try {
    rt = new RawAgentRuntime({
      repoRoot: root,
      stateDir: mkdtempSync(join(tmpdir(), 'connector-state-')),
      modelAdapter: {
        name: 'connector-registry-test',
        async runTurn(input) {
          seen.push({
            prompt: input.systemPrompt,
            tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description }))
          });
          return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
        },
        async summarizeMessages() {
          return '';
        }
      }
    });
    const session = rt.store.createSession({
      title: 'connectors',
      mode: 'chat',
      agentId: 'general',
      background: false,
      metadata: { permissionMode: 'auto' }
    });
    const pluginId = pluginConnectorId('acme');
    const say = async (text) => {
      rt.store.appendMessage(session.id, 'user', [{ type: 'text', text }]);
      await rt.runSession(session.id);
      return seen.at(-1);
    };

    const before = await say('before grant');
    assert.equal(before.prompt.includes(USAGE), false);
    assert.equal(before.tools.some((tool) => tool.name === 'acme_ping'), false);
    assert.equal(JSON.stringify(before).includes(SECRET), false);

    rt.connectors.grantConnector(pluginId, { secretEnv: 'ACME_TOKEN', credRef: 'vault:acme' });
    const granted = await say('after grant');
    assert.equal(granted.prompt.includes(USAGE), true);
    assert.equal(granted.prompt.includes('Secret env name: ACME_TOKEN'), true);
    assert.equal(granted.tools.some((tool) => tool.name === 'acme_ping'), true);
    assert.equal(JSON.stringify(granted).includes(SECRET), false);
    assert.equal(JSON.stringify(rt.connectors.listPublic()).includes(SECRET), false);

    rt.connectors.revokeConnector(pluginId);
    const revoked = await say('after revoke');
    assert.equal(revoked.prompt.includes(USAGE), false);
    assert.equal(revoked.tools.some((tool) => tool.name === 'acme_ping'), false);
    assert.equal(JSON.stringify(revoked).includes(SECRET), false);
  } finally {
    if (prev.plugins === undefined) delete process.env.RAW_AGENT_PLUGINS_DIR;
    else process.env.RAW_AGENT_PLUGINS_DIR = prev.plugins;
    if (prev.token === undefined) delete process.env.ACME_TOKEN;
    else process.env.ACME_TOKEN = prev.token;
    if (prev.turns === undefined) delete process.env.RAW_AGENT_MAX_TURNS;
    else process.env.RAW_AGENT_MAX_TURNS = prev.turns;
    if (prev.strict === undefined) delete process.env.RAW_AGENT_PROMPT_CACHE_STRICT;
    else process.env.RAW_AGENT_PROMPT_CACHE_STRICT = prev.strict;
    if (rt) await rt.destroy();
    rmSync(root, { recursive: true, force: true });
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});
