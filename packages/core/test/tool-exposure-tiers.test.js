import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import { assembleOptionalTools } from '../dist/runtime/tool-assembly.js';
const settingsKey = 'tool_exposure_settings';
const tool = name => ({ name, description: `${name} team management`, inputSchema: { type: 'object', properties: {} }, approvalMode: 'always', sideEffectLevel: 'write', execute: async () => { throw Error('must not execute while loading'); } });
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'exposure-'));
    let store = new SqliteStateStore(join(dir, 'state.db'));
    t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
    const agent = { id: 'general', name: 'General', allowedTools: undefined };
    const session = store.createSession({ title: 'exposure', mode: 'chat', agentId: agent.id, background: false });
    const catalog = ['read_file', 'write_file', 'edit_file', 'bash', 'web_search', 'tool_search', 'load_capability_tool', 'bot_create', 'cron_list', 'lcu_js', 'ptc_exec', 'ask_bot_help', 'propose_tool', 'extension_tool'].map(tool);
    store.setDaemonControl('web_settings', { searchUrl: 'https://example.org/?q={query}' });
    const input = () => ({ env: { RAW_AGENT_WEB_SEARCH_URL: 'https://example.org/?q={query}' }, tools: catalog, agent, session: store.getSession(session.id), settingsStore: store });
    const visible = () => filterToolsForSession(input()).tools.map(t => t.name);
    const assembled = assembleOptionalTools({ env: { RAW_AGENT_DISCOVERY: '0' }, store, stateDir: dir, getCronStore() { throw Error('not used'); }, getCatalog: () => catalog });
    const ctx = () => ({ agent, session: store.getSession(session.id), repoRoot: dir, stateDir: dir });
    const search = (query) => assembled.find(t => t.name === 'tool_search').execute(ctx(), { query });
    const load = name => assembled.find(t => t.name === 'load_capability_tool').execute(ctx(), { name });
    return { store, agent, session, catalog, input, visible, search, load, ctx, reopen() { store.db.close(); store = new SqliteStateStore(join(dir, 'state.db')); return store; } };
}
test('daily tools are direct, other tiers withheld [AC:tool-exposure-tiers#AC-1] [AC:tool-exposure-tiers#AC-2] [AC:tool-exposure-tiers#AC-12]', t => { const h = fixture(t); assert.deepEqual(h.visible().sort(), ['read_file', 'write_file', 'edit_file', 'bash', 'web_search', 'tool_search', 'load_capability_tool'].sort()); });
test('one search loads at most five without executing targets [AC:tool-exposure-tiers#AC-3]', async (t) => { const h = fixture(t); h.catalog.push(...Array.from({ length: 7 }, (_, i) => tool(`extra_${i}`))); const r = await h.search('extra_'); assert.equal(r.ok, true); const d = JSON.parse(r.content); assert.equal(d.loaded.length, 5); assert.equal(h.visible().filter(n => n.startsWith('extra_')).length, 5); });
test('no matches never load everything [AC:tool-exposure-tiers#AC-4]', async (t) => { const h = fixture(t), before = h.visible(); const r = await h.search('not-a-tool-xyz'); assert.match(r.content, /no_match/); assert.deepEqual(h.visible(), before); });
test('loaded tools survive restart but not a new session [AC:tool-exposure-tiers#AC-5]', async (t) => { const h = fixture(t); await h.search('bot_create'); assert.ok(h.visible().includes('bot_create')); const store = h.reopen(); assert.ok(h.visible().includes('bot_create')); const other = store.createSession({ title: 'new', mode: 'chat', agentId: 'general', background: false }); assert.ok(!filterToolsForSession({ ...h.input(), session: other }).tools.some(t => t.name === 'bot_create')); });
test('agent pins are isolated and do not grant disabled tools [AC:tool-exposure-tiers#AC-6]', t => { const h = fixture(t); h.store.setDaemonControl(settingsKey, { mode: 'progressive', pinnedGroups: { general: ['bot-config', 'computer'] } }); assert.ok(h.visible().includes('bot_create')); assert.ok(!h.visible().includes('lcu_js')); assert.ok(!filterToolsForSession({ ...h.input(), agent: { id: 'other', name: 'Other' } }).tools.some(t => t.name === 'bot_create')); });
test('full means all authorized tools, without search meta tools [AC:tool-exposure-tiers#AC-7]', t => { const h = fixture(t); h.store.setDaemonControl(settingsKey, { mode: 'full', pinnedGroups: {} }); assert.ok(h.visible().includes('bot_create')); assert.ok(h.visible().includes('extension_tool')); assert.ok(!h.visible().includes('tool_search')); assert.ok(!h.visible().includes('lcu_js')); assert.ok(!h.visible().includes('ptc_exec')); });
test('revocation and whitelist remain effective after disclosure [AC:tool-exposure-tiers#AC-8]', async (t) => { const h = fixture(t); await h.search('bot_create'); h.agent.allowedTools = ['read_file']; assert.ok(!h.visible().includes('bot_create')); assert.equal((await h.load('bot_create')).ok, false); assert.ok(!(await h.search('bot_create')).content.includes('"name": "bot_create"')); });
test('external discovery off does not disable local search [AC:tool-exposure-tiers#AC-9]', async (t) => { const h = fixture(t); h.store.setDaemonControl('discovery_settings', { enabled: false }); await h.search('bot_create'); assert.ok(h.visible().includes('bot_create')); assert.equal(h.store.getDaemonControl('discovery_settings').enabled, false); });
test('mode changes affect next selection without replay [AC:tool-exposure-tiers#AC-11]', t => { const h = fixture(t); h.store.appendMessage(h.session.id, 'user', [{ type: 'text', text: 'retain history' }]); const before = h.store.foldMessages(h.session.id); h.store.setDaemonControl(settingsKey, { mode: 'full', pinnedGroups: {} }); assert.ok(h.visible().includes('bot_create')); h.store.setDaemonControl(settingsKey, { mode: 'progressive', pinnedGroups: {} }); assert.ok(!h.visible().includes('bot_create')); assert.deepEqual(h.store.foldMessages(h.session.id), before); });
test('exact approved baseline plus room planning and external Agent tools [AC:tool-exposure-tiers#AC-14] [AC:room-task-collaboration#AC-2] [AC:external-agent-bots#AC-4]', async (t) => {
    const h = fixture(t);
    const { TOOL_GROUPS: groups } = await import('../dist/tools/tool-exposure.js');
    const addedExternalTools = new Set(['external_agent_list', 'external_agent_delegate', 'external_agent_status', 'external_agent_cancel', 'external_agent_input']);
    for (const name of addedExternalTools) assert.equal(groups.find(group => group.tools.includes(name))?.id, 'team');
    const counts = excludeRoom => [1, 2, 3].map(tier => groups.filter(g => g.tier === tier && !g.extension).reduce((sum, group) => sum + group.tools.filter(name => !excludeRoom || (name !== 'room_route_turn' && !addedExternalTools.has(name))).length, 0));
    assert.deepEqual(counts(true), [50, 23, 68], 'the original classified inventory stays unchanged');
    assert.deepEqual(counts(false), [51, 28, 68]);
    assert.equal(groups.find(group => group.tools.includes('room_route_turn')).tier, 1);
    const names = groups.flatMap(group => group.tools);
    assert.equal(names.length, new Set(names).size);
    assert.ok(!h.visible().includes('extension_tool'));
    await h.search('extension_tool');
    assert.ok(h.visible().includes('extension_tool'));
});
test('direct load and clear preserve transcript [AC:tool-exposure-tiers#AC-15]', async (t) => { const h = fixture(t); await h.load('bot_create'); assert.ok(h.visible().includes('bot_create')); const before = h.store.foldMessages(h.session.id); const mod = await import('../dist/tools/tool-exposure.js'); mod.clearToolExposure(h.store, h.session.id); assert.ok(!h.visible().includes('bot_create')); assert.deepEqual(h.store.foldMessages(h.session.id), before); });
test('real agent loop searches then executes without a separate load [AC:tool-exposure-tiers#AC-3]', async (t) => {
    const { RawAgentRuntime } = await import('../dist/runtime.js');
    const dir = mkdtempSync(join(tmpdir(), 'exposure-loop-'));
    let turn = 0, calls = 0;
    const observed = [];
    const adapter = { name: 'exposure-local', runTurn: async (input) => {
            const names = input.tools.map(t => t.name);
            observed.push(names);
            turn++;
            if (turn === 1) {
                assert.ok(!names.includes('extension_probe'));
                return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'search-1', name: 'tool_search', input: { query: 'extension_probe' } }] };
            }
            if (turn === 2) {
                assert.ok(names.includes('extension_probe'));
                return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'probe-1', name: 'extension_probe', input: {} }] };
            }
            return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
        } };
    const rt = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: adapter, extraTools: [{ ...tool('extension_probe'), approvalMode: 'never', sideEffectLevel: 'none', execute: async () => { calls++; return { ok: true, content: 'probe done' }; } }] });
    t.after(async () => { await rt.destroy(); rmSync(dir, { recursive: true, force: true }); });
    const session = rt.store.createSession({ agentId: 'general', mode: 'chat', title: 'load on next turn', background: false });
    rt.sendUserMessage(session.id, 'Use extension_probe');
    await rt.runSession(session.id);
    assert.equal(turn, 3);
    assert.equal(calls, 1);
    assert.equal(observed[1].includes('extension_probe'), true);
});
test('failed loader reports no false success [AC:tool-exposure-tiers#AC-4]', async (t) => {
    const h = fixture(t);
    const { createToolSearchTools } = await import('../dist/tools/tool-search.js');
    const tools = createToolSearchTools({ settingsStore: h.store, env: {}, getCatalog: () => h.catalog, getRegistry: () => ({ listBoundCards: () => [] }), discloseTool: () => { throw Error('storage unavailable'); } });
    const result = await tools[0].execute(h.ctx(), { query: 'bot_create' });
    assert.equal(result.ok, false);
    const d = JSON.parse(result.content);
    assert.deepEqual(d.loaded, []);
    assert.match(d.failures[0].reason, /storage unavailable/);
    assert.ok(!h.visible().includes('bot_create'));
});
test('allowlist is authorization, not a pinned group [AC:tool-exposure-tiers#AC-1] [AC:tool-exposure-tiers#AC-6]', t => { const h = fixture(t); h.agent.allowedTools = ['read_file', 'tool_search', 'load_capability_tool', 'bot_create']; assert.ok(!h.visible().includes('bot_create')); h.store.setDaemonControl(settingsKey, { mode: 'progressive', pinnedGroups: { general: ['bot-config'] } }); assert.ok(h.visible().includes('bot_create')); });
test('disabled external discovery and browser stay unavailable in every mode [AC:tool-exposure-tiers#AC-8] [AC:tool-exposure-tiers#AC-9]', async (t) => { const h = fixture(t); h.catalog.push(tool('tailscale_list_devices'), tool('browser_navigate')); h.store.setDaemonControl('discovery_settings', { enabled: false, tailscaleEnabled: true }); h.store.setDaemonControl('browser_settings', { enabled: false }); const r = await h.search('tailscale'); assert.deepEqual(JSON.parse(r.content).loaded, []); h.store.setDaemonControl(settingsKey, { mode: 'full', pinnedGroups: {} }); assert.ok(!h.visible().includes('tailscale_list_devices')); assert.ok(!h.visible().includes('browser_navigate')); });
