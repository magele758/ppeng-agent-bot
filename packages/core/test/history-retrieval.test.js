import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryTools } from '../dist/tools/history-tools.js';
import { createMemoryTools } from '../dist/tools/memory-tools.js';

function setup() {
  const sessions = [
    { id: 'now', title: 'Current', metadata: { userId: 'u', tenantId: 't' } },
    { id: 'old', title: 'Release notes', metadata: { userId: 'u', tenantId: 't' } },
    { id: 'other-user', title: 'SECRET user', metadata: { userId: 'v', tenantId: 't' } },
    { id: 'other-tenant', title: 'SECRET tenant', metadata: { userId: 'u', tenantId: 'z' } },
    { id: 'other-bot', title: 'SECRET bot', agentId: 'private', metadata: { userId: 'u', tenantId: 't', botId: 'private' } },
    { id: 'unknown', title: 'SECRET unknown', metadata: {} }
  ];
  const nodes = (sid) => [{ id: `m-${sid}`, seq: 1, role: 'user', surfaceOp: 'append', createdAt: '2026-01-01', parts: [{ type: 'text', text: `部署约束 ${'原始证据'.repeat(1800)}` }] }, { id: 'replacement', seq: 2, surfaceOp: 'replace', role: 'system', parts: [{ type: 'text', text: '部署约束 summary' }] }];
  const store = { listSessions: () => sessions, getSession: id => sessions.find(s => s.id === id), listSurfaceNodes: nodes };
  const tools = createHistoryTools({ historyStore: store });
  return { sessions, store, search: tools.find(t => t.name === 'history_search'), read: tools.find(t => t.name === 'history_read'), ctx: { session: sessions[0] } };
}

test('search finds compressed original history with a readable reference [AC:context-reliability#AC-6]', async () => {
  const { search, ctx } = setup();
  const out = JSON.parse((await search.execute(ctx, { query: '部署约束', session_id: 'old' })).content);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].title, 'Release notes');
  assert.equal(out.matches[0].messageId, 'm-old');
  assert.ok(out.matches[0].ref);
  assert.match(out.matches[0].excerpt, /部署约束/);
});

test('history reads exact source through bounded continuation pages [AC:context-reliability#AC-7]', async () => {
  const { search, read, ctx, store } = setup();
  const hit = JSON.parse((await search.execute(ctx, { query: '部署约束', session_id: 'old' })).content).matches[0];
  let offset = 0, text = '';
  do {
    const result = await read.execute(ctx, { ref: hit.ref, offset, limit: 1000 });
    assert.equal(result.ok, true);
    const page = JSON.parse(result.content);
    text += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(text, store.listSurfaceNodes('old')[0].parts[0].text);
});

test('search and direct references reveal no other user tenant bot or unknown owner [AC:context-reliability#AC-8]', async () => {
  const { search, read, ctx, sessions } = setup();
  const out = JSON.parse((await search.execute(ctx, { query: '部署约束' })).content);
  assert.deepEqual(out.matches.map(m => m.sessionId).sort(), ['now', 'old']);
  for (const id of ['other-user', 'other-tenant', 'other-bot', 'unknown', 'missing']) {
    const result = await search.execute(ctx, { query: '部署约束', session_id: id });
    assert.deepEqual(JSON.parse(result.content), { matches: [] });
    const value = await read.execute(ctx, { ref: `history:${id}:m-${id}:0` });
    assert.deepEqual(value, { ok: false, content: 'Source unavailable.' });
  }
  sessions[1].metadata.userId = 'revoked';
  assert.equal((await read.execute(ctx, { ref: 'history:old:m-old:0' })).ok, false);
  ctx.session = sessions[5];
  assert.deepEqual(JSON.parse((await search.execute(ctx, { query: '部署约束' })).content).matches.map(m => m.sessionId), ['unknown']);
});

test('memory search reference reads original in pages without exposing another session [AC:context-reliability#AC-7] [AC:context-reliability#AC-8]', async () => {
  const value = `部署约束 ${'完整记录'.repeat(2000)}`;
  const row = { id: 'memory-one', scope: 'scratch', key: 'deployment', value, updatedAt: '2026-01-01', importance: 1 };
  const tools = createMemoryTools({ listSessionMemory: async (id) => id === 'now' ? [row] : [] });
  const ctx = { session: { id: 'now', metadata: {} } };
  const found = JSON.parse((await tools.find(t => t.name === 'memory_search').execute(ctx, { query: '部署约束' })).content).matches[0];
  assert.ok(found.ref);
  const read = tools.find(t => t.name === 'memory_read');
  let offset = 0, text = '';
  do { const result = await read.execute(ctx, { ref: found.ref, offset, limit: 1200 }); assert.equal(result.ok, true); const page = JSON.parse(result.content); text += page.text; offset = page.nextOffset; } while (offset !== null);
  assert.equal(text, value);
  assert.equal((await read.execute({ session: { id: 'other', metadata: {} } }, { ref: found.ref })).ok, false);
});

test('stored WAL replacement still resolves original source by search and seq [AC:context-reliability#AC-6] [AC:context-reliability#AC-7]', async () => {
  const { SqliteStateStore } = await import('../dist/storage.js');
  const { createToolServices } = await import('../dist/runtime/tool-services.js');
  const { createBuiltinTools } = await import('../dist/tools/builtin-tools.js');
  const store = new SqliteStateStore(':memory:');
  try {
    store.upsertAgent({ id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] });
    const metadata = { userId: 'owner', tenantId: 'tenant' };
    const old = store.createSession({ title: 'Archived release', agentId: 'general', mode: 'chat', metadata });
    const current = store.createSession({ title: 'Current', agentId: 'general', mode: 'chat', metadata });
    const message = store.appendMessage(old.id, 'user', [{ type: 'text', text: '部署约束: staging only' }]);
    store.appendReplacement(old.id, { startSeq: message.seq, endSeq: message.seq, role: 'system', parts: [{ type: 'text', text: 'A summary without detail' }] });
    assert.ok(!JSON.stringify(store.foldMessages(old.id)).includes('staging only'));
    const tools = createBuiltinTools(createToolServices({ store, stateDir: '/tmp/history-test' }));
    const ctx = { session: current };
    const hits = JSON.parse((await tools.find(t => t.name === 'history_search').execute(ctx, { query: '部署约束' })).content).matches;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].messageId, message.id);
    const result = await tools.find(t => t.name === 'history_read').execute(ctx, { session_id: old.id, seq: message.seq });
    assert.equal(JSON.parse(result.content).text, '部署约束: staging only');
  } finally { store.db.close(); }
});

test('memory reference read rechecks user tenant bot and current ownership [AC:context-reliability#AC-8]', async () => {
  let row = { id: 'id', scope: 'user.memory', key: 'private', value: 'SECRET', userId: 'u', tenantId: 't', updatedAt: '2026-01-01' };
  const tools = createMemoryTools({ listSessionMemory: async () => [], getAgentMemoryById: async () => row });
  const read = tools.find(t => t.name === 'memory_read');
  const ctx = { session: { id: 'current', metadata: { userId: 'u', tenantId: 't' } } };
  assert.equal((await read.execute(ctx, { ref: 'memory:user:id' })).ok, true);
  for (const patch of [{ userId: 'other' }, { tenantId: 'other' }, { agentId: 'private' }]) {
    const saved = { ...row }; row = { ...row, ...patch };
    assert.deepEqual(await read.execute(ctx, { ref: 'memory:user:id' }), { ok: false, content: 'Source unavailable.' });
    row = saved;
  }
  ctx.session.metadata = {};
  assert.equal((await read.execute(ctx, { ref: 'memory:user:id' })).ok, false);
});

test('runtime memory search reads another session memory and excludes foreign identities [AC:context-reliability#AC-7] [AC:context-reliability#AC-8]', async () => {
  const { SqliteStateStore } = await import('../dist/storage.js');
  const { createToolServices } = await import('../dist/runtime/tool-services.js');
  const store = new SqliteStateStore(':memory:');
  try {
    store.upsertAgent({ id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] });
    const current = store.createSession({ title: 'current', agentId: 'general', mode: 'chat', metadata: { userId: 'u', tenantId: 't' } });
    const old = store.createSession({ title: 'old', agentId: 'general', mode: 'chat', metadata: { userId: 'u', tenantId: 't' } });
    const rows = [];
    for (const scope of ['user.memory', 'team.memory', 'project.memory']) {
      for (const [tag, identity] of [['own', { userId: 'u', tenantId: 't' }], ['global', { userId: 'u' }], ['tenant', { userId: 'u', tenantId: 'other' }], ['user', { userId: 'v', tenantId: 't' }], ['bot', { userId: 'u', tenantId: 't', agentId: 'private' }]]) {
        rows.push(store.agentMemory().set({ scope, namespace: 'fact', key: `${scope}-${tag}`, value: `recallneedle ${tag} ${'original '.repeat(1000)}`, sessionId: old.id, importance: 1, confidence: 'high', ...identity }));
      }
    }
    const tools = createMemoryTools(createToolServices({ store, stateDir: '/tmp/history-test' }));
    const search = tools.find(t => t.name === 'memory_search'), read = tools.find(t => t.name === 'memory_read');
    const ctx = { session: current };
    const matches = JSON.parse((await search.execute(ctx, { query: 'recallneedle', limit: 20 })).content).matches;
    assert.equal(matches.length, 6);
    assert.ok(matches.every(hit => /-(own|global)$/.test(hit.key)));
    for (const hit of matches) {
      const first = JSON.parse((await read.execute(ctx, { ref: hit.ref, limit: 500 })).content);
      assert.equal(first.text.length, 500); assert.equal(first.nextOffset, 500);
    }
    store.updateSession(current.id, { metadata: { userId: 'u' } });
    const globalOnly = JSON.parse((await search.execute(ctx, { query: 'recallneedle', limit: 20 })).content).matches;
    assert.equal(globalOnly.length, 3); assert.ok(globalOnly.every(hit => hit.key.endsWith('-global')));
    for (const hit of matches.filter(hit => hit.key.endsWith('-own'))) assert.equal((await read.execute(ctx, { ref: hit.ref })).ok, false);
    store.updateSession(current.id, { metadata: {} });
    assert.deepEqual(JSON.parse((await search.execute(ctx, { query: 'recallneedle' })).content), { matches: [] });
    for (const hit of matches) assert.equal((await read.execute(ctx, { ref: hit.ref })).ok, false);
  } finally { store.db.close(); }
});
