import assert from 'node:assert/strict';
import test from 'node:test';
import { applySessionFavorite, favoritePatchFromBody } from '../dist/session-favorite.js';
import { sessionListSummary, sessionSummaryEtag } from '../dist/session-list-summary.js';
import { sessionsRoutes } from '../dist/routes/sessions.js';

type Row = { id: string; title: string; status: string; mode: string; agentId: string; metadata: Record<string, unknown> };

function memoryRuntime(seed: Row) {
  const sessions = new Map<string, Row>([[seed.id, seed]]);
  return {
    sessions,
    mergeSessionMetadata(id: string, patch: Record<string, unknown>) {
      const current = sessions.get(id);
      if (!current) throw new Error(`missing ${id}`);
      const next = { ...current, metadata: { ...current.metadata, ...patch } };
      sessions.set(id, next);
      return next;
    },
    getSession(id: string) {
      return sessions.get(id);
    },
    listSessions() {
      return [...sessions.values()];
    },
    getStateVersion() {
      return 3;
    }
  };
}

function responseCapture() {
  const headers: Record<string, string> = {};
  let body = '';
  const response = {
    statusCode: 200,
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
    },
    end(value = '') {
      body = value;
    }
  };
  return { response, read: () => ({ status: response.statusCode, headers, body }) };
}

test('收藏会留在会话上，列表摘要看得到，刷新后还在 [AC:session-favorite#AC-1] [AC:session-favorite#AC-4]', async () => {
  const runtime = memoryRuntime({
    id: 's1',
    title: '今天的会话',
    status: 'idle',
    mode: 'chat',
    agentId: 'general',
    metadata: { botId: 'b1', eventLog: 'secret-log' }
  });
  const routes = sessionsRoutes(runtime as never);
  const patch = routes.find((route) => route.method === 'PATCH' && route.pattern === '/api/sessions/:id');
  const list = routes.find((route) => route.method === 'GET' && route.pattern === '/api/sessions');
  assert.ok(patch);
  assert.ok(list);
  const saved = responseCapture();
  await patch.handler({
    requireParam: () => 's1',
    readBody: async () => ({ favorited: true }),
    response: saved.response,
    auth: { isolate: false, labProxy: false, user: null },
    request: { headers: {} },
    url: new URL('http://local/api/sessions/s1')
  } as never);
  assert.equal(saved.read().status, 200);
  assert.equal(runtime.sessions.get('s1')?.metadata.favorited, true);
  assert.equal(runtime.sessions.get('s1')?.metadata.botId, 'b1');

  const listed = responseCapture();
  await list.handler({
    response: listed.response,
    request: { headers: {} },
    url: new URL('http://local/api/sessions?view=summary'),
    auth: { isolate: false, labProxy: false, user: null }
  } as never);
  const payload = JSON.parse(listed.read().body) as { sessions: Array<{ id: string; metadata: { favorited?: boolean; eventLog?: string } }> };
  assert.equal(payload.sessions[0]?.metadata.favorited, true);
  assert.equal(payload.sessions[0]?.metadata.eventLog, undefined);

  const summary = sessionListSummary(runtime.sessions.get('s1')!);
  assert.equal(summary.metadata.favorited, true);
  const hidden = sessionSummaryEtag([sessionListSummary({ ...runtime.sessions.get('s1')!, metadata: { botId: 'b1', eventLog: 'other' } })]);
  assert.notEqual(sessionSummaryEtag([summary]), hidden);
});

test('再点一次取消收藏，非法取值不改原来的收藏 [AC:session-favorite#AC-3] [AC:session-favorite#AC-4]', async () => {
  const runtime = memoryRuntime({
    id: 's1',
    title: '已收藏',
    status: 'idle',
    mode: 'chat',
    agentId: 'general',
    metadata: { favorited: true, note: 'keep' }
  });
  const routes = sessionsRoutes(runtime as never);
  const patch = routes.find((route) => route.method === 'PATCH' && route.pattern === '/api/sessions/:id');
  assert.ok(patch);
  await assert.rejects(
    () => patch.handler({
      requireParam: () => 's1',
      readBody: async () => ({ favorited: 'yes' }),
      response: responseCapture().response,
      auth: { isolate: false, labProxy: false, user: null },
      request: { headers: {} },
      url: new URL('http://local/api/sessions/s1')
    } as never),
    /favorited must be a boolean/
  );
  assert.equal(runtime.sessions.get('s1')?.metadata.favorited, true);
  assert.equal(favoritePatchFromBody({ title: 'nope' }), undefined);
  assert.equal(favoritePatchFromBody(null), undefined);
  applySessionFavorite(runtime, 's1', { favorited: false });
  assert.equal(runtime.sessions.get('s1')?.metadata.favorited, false);
  assert.equal(runtime.sessions.get('s1')?.metadata.note, 'keep');
  assert.equal(sessionListSummary(runtime.sessions.get('s1')!).metadata.favorited, false);
});
