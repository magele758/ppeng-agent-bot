/**
 * Memory HTTP read routes under auth.isolate (daemon routes, driven without a socket).
 * Lives in core/test so it runs with `npm run test:unit` after daemon tsc.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { saveSemanticFact } from '../dist/memory/memory-writer.js';
import { memoryRoutes } from '../../../apps/daemon/dist/routes/memory.js';
import { compileTurnAppendixAsync } from '../dist/session/context-compiler.js';
import { writeMemorySettings } from '../dist/memory/memory-settings.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';

const ANON = { isolate: false, labProxy: false, user: null };
const asUser = (id) => ({ isolate: true, labProxy: true, user: { id, tenantId: 'default' } });

test('fast profile preview respects the same persistent memory policy as the actual prompt [AC:context-reliability#AC-9]', async () => {
  const runtime = makeRuntime();
  const session = runtime.store.createSession({ title: 'fast', mode: 'chat', agentId: 'general', metadata: { userId: 'u1', taskRunMode: 'fast' } });
  runtime.store.agentMemory().set({ scope: 'session.long', namespace: 'default', sessionId: session.id, key: 'deploy', value: 'deploy hidden in fast mode' });
  const builder = new PromptBuilder({ store: runtime.store, repoRoot: runtime.repoRoot, stateDir: runtime.stateDir });
  const actual = await builder.buildMemoryAppendixAsync({ session }, { query: 'deploy', stateDir: runtime.stateDir });
  const preview = await call(runtime, 'POST', '/api/memory/preview', { auth: ANON, body: { sessionId: session.id, query: 'deploy' } });
  assert.equal(actual, '');
  assert.equal(preview.payload.appendix, actual);
  assert.equal(preview.payload.pack.sections.length, 0);
});

test('HTTP preview matches real recall and ignores ownership overrides on an existing session [AC:context-reliability#AC-9] [AC:context-reliability#AC-8]', async () => {
  const runtime = makeRuntime();
  const session = runtime.store.createSession({ title: 'owned', mode: 'chat', agentId: 'general', metadata: { userId: 'u1', tenantId: 't1' } });
  const am = runtime.store.agentMemory();
  for (const [userId, tenantId, value] of [['u1', 't1', 'deploy own evidence'], ['u1', 't2', 'deploy FOREIGN_TENANT'], ['u2', 't1', 'deploy FOREIGN_USER']]) {
    am.set({ scope: 'user.memory', namespace: 'semantic', key: `deploy-${userId}-${tenantId}`, value, userId, tenantId });
  }
  const input = { store: runtime.store, session, query: 'deploy', stateDir: runtime.stateDir };
  const actual = await compileTurnAppendixAsync(input);
  const preview = await call(runtime, 'POST', '/api/memory/preview', { auth: ANON, body: { sessionId: session.id, userId: 'u2', tenantId: 't2', query: 'deploy' } });
  assert.equal(preview.payload.appendix, actual);
  assert.match(actual, /own evidence/);
  assert.doesNotMatch(actual, /FOREIGN_/);
  writeMemorySettings(runtime.store, { compilerEnabled: false });
  const disabled = await call(runtime, 'POST', '/api/memory/preview', { auth: ANON, body: { sessionId: session.id, query: 'deploy' } });
  assert.equal(disabled.payload.appendix, '');
  assert.equal(await compileTurnAppendixAsync(input), '');
});

function makeRuntime() {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'mem-http-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'mem-http-state-')),
    modelAdapter: { name: 'noop', async runTurn() { return { stopReason: 'end', assistantParts: [] }; }, async summarizeMessages() { return ''; } }
  });
}

async function call(runtime, method, pattern, { auth, query = '', body } = {}) {
  const spec = memoryRoutes(runtime).find((r) => r.method === method && r.pattern === pattern);
  assert.ok(spec, `route ${method} ${pattern}`);
  let status = 200;
  let payload;
  const response = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      status = this.statusCode;
      payload = text ? JSON.parse(text) : undefined;
    }
  };
  try {
    await spec.handler({
      request: {},
      response,
      url: new URL(`http://x${pattern}${query}`),
      parts: pattern.split('/').filter(Boolean),
      params: {},
      requireParam: () => '',
      readBody: async () => body ?? {},
      auth
    });
  } catch (error) {
    return { error };
  }
  return { status, payload };
}

function seed(runtime) {
  const am = runtime.store.agentMemory();
  const put = (userId, key, value, extra = {}) =>
    am.set({
      scope: 'user.memory', namespace: 'default', key, value, userId,
      importance: 0.9, confidence: 'medium', source: 'user_provided', ...extra
    });
  put('u1', 'k1', '用户一的蓝色笔记');
  put('u2', 'k2', '用户二的红色笔记');
  saveSemanticFact(am, { userId: 'u1', category: 'fact', content: '用户一的蓝色笔记事实' });
  saveSemanticFact(am, { userId: 'u2', category: 'fact', content: '用户二的红色笔记事实' });
  const s1 = runtime.store.createSession({ title: 's1', mode: 'chat', agentId: 'general', metadata: { userId: 'u1' } });
  const s2 = runtime.store.createSession({ title: 's2', mode: 'chat', agentId: 'general', metadata: { userId: 'u2' } });
  return { s1, s2 };
}

test('GET /api/memory: isolate forces the logged-in user; other modes keep the requested userId', async () => {
  const runtime = makeRuntime();
  const { s2 } = seed(runtime);

  const own = await call(runtime, 'GET', '/api/memory', { auth: asUser('u1'), query: '?scope=user.memory' });
  assert.deepEqual([...new Set(own.payload.entries.map((e) => e.userId))], ['u1']);

  const spoof = await call(runtime, 'GET', '/api/memory', { auth: asUser('u1'), query: '?scope=user.memory&userId=u2' });
  assert.deepEqual([...new Set(spoof.payload.entries.map((e) => e.userId))], ['u1']);
  assert.equal(JSON.stringify(spoof.payload).includes('红色'), false);

  const foreignSession = await call(runtime, 'GET', '/api/memory', { auth: asUser('u1'), query: `?sessionId=${s2.id}` });
  assert.equal(foreignSession.error?.name, 'NotFoundError');

  const open = await call(runtime, 'GET', '/api/memory', { auth: ANON, query: '?scope=user.memory&userId=u2' });
  assert.deepEqual([...new Set(open.payload.entries.map((e) => e.userId))], ['u2']);
  const all = await call(runtime, 'GET', '/api/memory', { auth: ANON, query: '?scope=user.memory' });
  assert.deepEqual([...new Set(all.payload.entries.map((e) => e.userId))].sort(), ['u1', 'u2']);
});

test('GET /api/memory/observations: isolate forces the user and guards the session', async () => {
  const runtime = makeRuntime();
  const { s1, s2 } = seed(runtime);
  const own = await call(runtime, 'GET', '/api/memory/observations', { auth: asUser('u1'), query: `?sessionId=${s1.id}` });
  assert.equal(own.status, 200);
  const foreign = await call(runtime, 'GET', '/api/memory/observations', { auth: asUser('u1'), query: `?sessionId=${s2.id}` });
  assert.equal(foreign.error?.name, 'NotFoundError');
  const open = await call(runtime, 'GET', '/api/memory/observations', { auth: ANON, query: `?sessionId=${s2.id}` });
  assert.equal(open.status, 200);
});

test('POST /api/memory/preview: guards the body sessionId and ignores a foreign userId under isolate', async () => {
  const runtime = makeRuntime();
  const { s1, s2 } = seed(runtime);

  const foreign = await call(runtime, 'POST', '/api/memory/preview', {
    auth: asUser('u1'), body: { sessionId: s2.id, query: '笔记' }
  });
  assert.equal(foreign.error?.name, 'NotFoundError');

  const spoof = await call(runtime, 'POST', '/api/memory/preview', {
    auth: asUser('u1'), body: { sessionId: 'preview-x', userId: 'u2', query: '笔记' }
  });
  assert.equal(spoof.status, 200);
  assert.equal(spoof.payload.appendix.includes('红色笔记'), false);
  assert.ok(spoof.payload.appendix.includes('蓝色笔记'));

  const ownSession = await call(runtime, 'POST', '/api/memory/preview', {
    auth: asUser('u1'), body: { sessionId: s1.id, userId: 'u2', query: '笔记' }
  });
  assert.equal(ownSession.status, 200);
  assert.equal(ownSession.payload.appendix.includes('红色笔记'), false);

  const open = await call(runtime, 'POST', '/api/memory/preview', {
    auth: ANON, body: { sessionId: s2.id, userId: 'u2', query: '笔记' }
  });
  assert.equal(open.status, 200);
  assert.ok(open.payload.appendix.includes('红色笔记'));
});
