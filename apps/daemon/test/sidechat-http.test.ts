import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RawAgentRuntime,
  ResourceOwnerStore,
  upsertProvider,
  type ModelTurnInput,
  type ModelAdapter
} from '@ppeng/agent-core';
import { sidechatRoutes } from '../dist/routes/sidechat.js';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';

function fixture(t: TestContext, turn: ModelAdapter['runTurn']) {
  const dir = mkdtempSync(join(tmpdir(), 'sidechat-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'test',
      runTurn: turn,
      summarizeMessages: async () => ''
    }
  });
  t.after(async () => {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  const router = new Router({
    readBody: async (req: any) => req.body,
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) })
  }).addAll(sidechatRoutes(runtime, {}));
  async function request(path: string, body?: unknown, user = 'ada', method?: string) {
    let value: any;
    const response = {
      setHeader() {},
      end(text: string) {
        value = JSON.parse(text);
      }
    };
    const success = await router.dispatch(
      { method: method ?? (body === undefined ? 'GET' : 'POST'), body } as any,
      response as any,
      new URL('/api/sidechats' + path, 'http://localhost'),
      { isolate: true, labProxy: true, user: { id: user, tenantId: 't', email: user + '@example.test' } }
    );
    assert.ok(success);
    return value;
  }
  function source(sessionId: string) {
    runtime.store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'Original question' }]);
    const m = runtime.store.appendMessage(sessionId, 'assistant', [
      { type: 'text', text: 'Original answer about key vectors.' }
    ]);
    runtime.store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'Unrelated later question' }]);
    return {
      sessionId,
      messageId: m.id,
      anchor: { kind: 'range', quote: 'key vectors', start: 22, end: 33 },
      requestId: 'first-' + sessionId,
      question: 'Explain this'
    };
  }
  async function done(id: string) {
    for (let i = 0; i < 100; i++) {
      const detail = await request('/' + id);
      if (detail.thread.status !== 'generating') return detail;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail('sidechat still generating');
  }
  return { runtime, source, request, done };
}
const answer = (text: string) => ({ stopReason: 'end' as const, assistantParts: [{ type: 'text' as const, text }] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('凝练迟到时保留改写、清除和后一次凝练 [AC:sidechat-concurrency#AC-1]', { timeout: 5000 }, async (t) => {
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  const f = fixture(t, async (input) => {
    if (!JSON.stringify(input.messages).includes('凝练成一句话')) return answer('完成的讨论');
    const turn = deferred<string>();
    pending.push(turn);
    return answer(await turn.promise);
  });
  const chat = f.runtime.createChatSession({ agentId: 'general', metadata: { userId: 'ada' } });
  const created = await f.request('', f.source(chat.id));
  const path = '/' + created.thread.id;
  await f.done(created.thread.id);
  async function startNote() {
    const count = pending.length;
    const result = f.request(path + '/note', {}, 'ada', 'POST').then(
      value => ({ value, error: undefined }),
      error => ({ value: undefined, error })
    );
    while (pending.length === count) await new Promise(resolve => setImmediate(resolve));
    return { result, gate: pending.at(-1)! };
  }
  for (const note of ['后来手写的结论', '']) {
    const old = await startNote();
    await f.request(path, { note }, 'ada', 'PATCH');
    old.gate.resolve('过期凝练');
    const result = await old.result;
    assert.equal((await f.request(path)).thread.note, note);
    assert.equal(result.error?.statusCode, 409);
  }
  const old = await startNote();
  const latest = await startNote();
  latest.gate.resolve('后一次凝练');
  assert.equal((await latest.result).value.thread.note, '后一次凝练');
  old.gate.resolve('前一次凝练');
  assert.equal((await old.result).error?.statusCode, 409);
  assert.equal((await f.request(path)).thread.note, '后一次凝练');
});

test('删除落库失败后回答继续完成并可追问 [AC:sidechat-concurrency#AC-2]', async (t) => {
  const gate = deferred<void>();
  let signal: AbortSignal | undefined;
  const f = fixture(t, async (input) => {
    signal = input.signal;
    await gate.promise;
    return answer('保留的完整回答');
  });
  const chat = f.runtime.createChatSession({ agentId: 'general', metadata: { userId: 'ada' } });
  const created = await f.request('', f.source(chat.id));
  const path = '/' + created.thread.id;
  f.runtime.store.db.exec(`CREATE TRIGGER reject_sidechat_delete BEFORE DELETE ON sidechat_threads
    BEGIN SELECT RAISE(ABORT, 'delete failed'); END;`);
  await assert.rejects(f.request(path, undefined, 'ada', 'DELETE'), /delete failed/);
  assert.equal(signal?.aborted, false);
  gate.resolve();
  assert.equal((await f.done(created.thread.id)).messages.at(-1).text, '保留的完整回答');
  await f.request(path + '/messages', { question: '继续追问', requestId: 'after-delete-failure' });
  assert.equal((await f.done(created.thread.id)).messages.length, 4);
});

test('both source identities reply in an isolated durable conversation [AC:sidechat#AC-2]', async (t) => {
  const calls: ModelTurnInput[] = [];
  const f = fixture(t, async (input) => {
    calls.push(input);
    return answer('side answer');
  });
  const chat = f.runtime.createChatSession({ agentId: 'general', title: 'Chat', metadata: { userId: 'ada' } });
  const bot = f.runtime.createBot({ name: 'Annotation teacher', description: 'Explain concepts with drawings' });
  const botSession = f.runtime.openBot(bot.id, { userId: 'ada', tenantId: 't' }).sessionId;
  for (const id of [chat.id, botSession]) {
    const body = f.source(id);
    const before = f.runtime.store.listMessages(id);
    const snapshot = f.runtime.getSession(id);
    const first = await f.request('', body);
    await f.done(first.thread.id);
    assert.equal(first.thread.botId || undefined, id === chat.id ? undefined : bot.id);
    assert.equal(calls.at(-1)?.agent.id, f.runtime.getSession(id)?.agentId);
    const messages = JSON.stringify(calls.at(-1)?.messages);
    for (const text of ['Original question', 'Original answer', 'key vectors', 'Explain this'])
      assert.ok(messages.includes(text));
    assert.ok(!messages.includes('Unrelated later'));
    const next = await f.request('/' + first.thread.id + '/messages', {
      question: 'Explain another detail',
      requestId: 'second'
    });
    const done = await f.done(next.thread.id);
    assert.equal(done.messages.length, 4);
    assert.ok(JSON.stringify(calls.at(-1)?.messages).includes('side answer'));
    assert.deepEqual(f.runtime.getSession(id), snapshot);
    assert.deepEqual(f.runtime.store.listMessages(id), before);
    await assert.rejects(f.request('/' + first.thread.id, undefined, 'other'), { statusCode: 404 });
    await assert.rejects(f.request('', body, 'other'), { statusCode: 404 });
    await assert.rejects(
      f.request('/' + first.thread.id + '/messages', { requestId: 'stranger', question: 'hi' }, 'other'),
      { statusCode: 404 }
    );
  }
});
test('stopping and retrying a duplicated request cannot overwrite another attempt [AC:sidechat#AC-6]', async (t) => {
  let calls = 0,
    release!: () => void,
    finishRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    finishRetry = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(t, async () => {
    if (++calls === 1) {
      await gate;
      return answer('stale');
    }
    await retryGate;
    return answer('fresh');
  });
  const session = f.runtime.createChatSession({ agentId: 'general', metadata: { userId: 'ada' } });
  const body = f.source(session.id);
  const started = await f.request('', body);
  const path = '/' + started.thread.id;
  assert.equal((await f.request('', body)).thread.id, started.thread.id);
  const stop = { requestId: body.requestId, generationId: started.messages.at(-1).generationId };
  const stopped = await f.request(path + '/stop', stop);
  assert.equal(stopped.thread.status, 'stopped');
  const retry = { requestId: body.requestId, attemptId: 'retry-1' };
  await f.request(path + '/retry', retry);
  const afterLateStop = await f.request(path + '/stop', stop);
  assert.equal(afterLateStop.thread.status, 'generating');
  finishRetry();
  await f.done(started.thread.id);
  await f.request(path + '/retry', retry);
  release();
  await new Promise((r) => setImmediate(r));
  const done = await f.request(path);
  assert.equal(calls, 2);
  assert.equal(done.messages.length, 2);
  assert.equal(done.messages.at(-1).text, 'fresh');
});

test('search and preview a previous conversation then revoke access [AC:sidechat#AC-3]', async (t) => {
  const f = fixture(t, async () => answer('searchable-intermediate-answer'));
  const chat = f.runtime.createChatSession({ title: 'old', agentId: 'general', metadata: { userId: 'ada' } });
  const bot = f.runtime.createBot({ name: 'Read' });
  const sid = f.runtime.openBot(bot.id, { userId: 'ada', tenantId: 't' }).sessionId;
  const ref = await f.request('', f.source(chat.id));
  await f.done(ref.thread.id);
  const inBot = await f.request('', f.source(sid));
  await f.done(inBot.thread.id);
  const related = '?exactQuote=key%20vectors&excludeSessionId=' + sid;
  const matches = await f.request(related);
  assert.deepEqual(
    matches.items.map((item: any) => item.thread.id),
    [ref.thread.id]
  );
  const hits = await f.request('?q=searchable-intermediate-answer&sessionId=' + chat.id);
  assert.equal(hits.items[0].matches[0].messageId, ref.messages.at(-1).id);
  const page = await f.request('?q=vectors&limit=1');
  assert.equal(page.nextCursor, 1);
  const last = await f.request('?q=vectors&limit=1&cursor=' + page.nextCursor);
  assert.notEqual(page.items[0].thread.id, last.items[0].thread.id);
  assert.equal(last.nextCursor, undefined);
  f.runtime.store.updateSession(chat.id, { metadata: { userId: 'other' } });
  assert.deepEqual((await f.request(related)).items, []);
  await assert.rejects(f.request('/' + ref.thread.id), { statusCode: 404 });
  await assert.rejects(f.request('/' + ref.thread.id, undefined, 'other'), { statusCode: 404 });
});

test('provider stream uses the source Bot model and checkpoints partial text after failure [AC:sidechat#AC-2] [AC:sidechat#AC-6]', async (t) => {
  const f = fixture(t, async () => {
    throw Error('unexpected fallback');
  });
  upsertProvider(f.runtime.store, {
    id: 'study',
    name: 'Study',
    kind: 'openai-compatible',
    apiKey: 'test',
    baseUrl: 'https://study.invalid/v1',
    models: [
      { id: 'fast', enabled: true },
      { id: 'teacher', enabled: true }
    ]
  });
  const requests: string[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.ok(String(url).startsWith('https://study.invalid/'));
    const body = JSON.parse(String(init.body));
    requests.push(body.model);
    assert.ok(JSON.stringify(body.messages).includes('Explain concepts with drawings'));
    return new Response(
      new ReadableStream({
        start(c) {
          stream = c;
          c.enqueue(
            new TextEncoder().encode(
              'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'first-part' } }] }) + '\n\n'
            )
          );
        }
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  });
  const bot = f.runtime.createBot({ name: 'SSE fixture', description: 'Explain concepts with drawings' });
  const sid = f.runtime.openBot(bot.id, { userId: 'ada', tenantId: 't' }).sessionId;
  f.runtime.mergeSessionMetadata(sid, { modelOverride: { providerId: 'study', modelId: 'teacher' } });
  const first = await f.request('', f.source(sid));
  let partial: any;
  for (let i = 0; i < 100; i++) {
    partial = await f.request('/' + first.thread.id);
    if (partial.messages.at(-1).text === 'first-part') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(requests, ['teacher']);
  assert.equal(partial.thread.status, 'generating');
  assert.equal(partial.messages.at(-1).text, 'first-part');
  stream.error(Error('fixture upstream ended abruptly'));
  const failed = await f.done(first.thread.id);
  assert.equal(failed.thread.status, 'failed');
  assert.equal(failed.messages.at(-1).text, 'first-part');
  assert.equal(failed.messages.at(-1).error, 'generation_failed');
});

test('ordinary task conversations and legacy canonical Bot sessions support annotations [AC:sidechat#AC-2]', async (t) => {
  const calls: ModelTurnInput[] = [];
  const f = fixture(t, async (input) => {
    calls.push(input);
    return answer('ok');
  });
  const ordinary = f.runtime.createTaskSession({
    title: 'study',
    agentId: 'general',
    metadata: { userId: 'ada' }
  }).session;
  const body = f.source(ordinary.id);
  assert.equal(ordinary.mode, 'task');
  await f.done((await f.request('', body)).thread.id);
  const bot = f.runtime.createBot({ name: 'Old Bot' });
  const id = bot.canonicalSessionId;
  // Older installations can have the definition's canonical pointer without its redundant metadata flag.
  f.runtime.store.updateSession(id, { metadata: { userId: 'ada' } });
  const legacy = await f.request('', f.source(id));
  assert.equal(legacy.thread.botId, bot.id);
  assert.equal(calls.at(-1)?.agent.id, bot.agentId);
  const room = f.runtime.createChatSession({ agentId: 'general', metadata: { userId: 'ada', roomId: 'room' } });
  await assert.rejects(f.request('', f.source(room.id)), { statusCode: 400 });
});
test('malformed ranges do not create annotations; long sources prefer the actual selected occurrence [AC:sidechat#AC-2]', async (t) => {
  const calls: ModelTurnInput[] = [];
  const f = fixture(t, async (input) => {
    calls.push(input);
    return answer('ok');
  });
  const sess = f.runtime.createChatSession({ agentId: 'general', metadata: { userId: 'ada' } });
  const long = 'KV cache: first occurrence. ' + '.'.repeat(18000) + 'Later: KV cache is here.';
  const message = f.runtime.store.appendMessage(sess.id, 'assistant', [{ type: 'text', text: long }]);
  const anchor = {
    kind: 'range',
    quote: 'KV cache',
    start: long.lastIndexOf('KV cache'),
    end: long.lastIndexOf('KV cache') + 8
  };
  const body = { sessionId: sess.id, messageId: message.id, question: 'why?', requestId: 'range', anchor };
  await assert.rejects(f.request('', { ...body, anchor: { ...anchor, end: anchor.start + 1 } }), { statusCode: 400 });
  await assert.rejects(f.request('', { ...body, anchor: { ...anchor, prefix: ['wrong type'] } }), { statusCode: 400 });
  const first = await f.request('', body);
  await f.done(first.thread.id);
  const input = JSON.stringify(calls[0]?.messages);
  assert.ok(input.includes('Later: KV cache is here.'));
  assert.ok(!input.includes('first occurrence'));
  const whole = await f.request('', { ...body, anchor: { kind: 'message', quote: 'abbreviated' }, requestId: 'whole' });
  assert.equal(whole.thread.anchor.quote, long);
});

test('visible replacement replies can be annotated and removed originals retain the searchable snapshot [AC:sidechat#AC-3] [AC:sidechat#AC-4]', async (t) => {
  const f = fixture(t, async () => answer('fixture'));
  const { store } = f.runtime;
  const sess = f.runtime.createChatSession({ agentId: 'general', metadata: { userId: 'ada' } });
  const raw = store.appendMessage(sess.id, 'assistant', [{ type: 'text', text: 'raw source' }]);
  const summary = store.appendReplacement(sess.id, {
    startSeq: raw.seq!,
    endSeq: raw.seq!,
    role: 'assistant',
    parts: [{ type: 'text', text: 'A summary with searchable tail-needle' }]
  });
  const body = {
    sessionId: sess.id,
    messageId: summary.id,
    requestId: 'compacted',
    question: 'expand',
    anchor: { kind: 'message', quote: 'A summary' }
  };
  const result = await f.request('', body);
  const open = await f.done(result.thread.id);
  assert.equal(open.sourceAvailable, true);
  assert.equal(open.thread.anchor.quote, 'A summary with searchable tail-needle');
  const normal = store.appendMessage(sess.id, 'assistant', [
    { type: 'text', text: 'Normal reply with deleted-tail-needle' }
  ]);
  const other = await f.request('', { ...body, messageId: normal.id, requestId: 'normal' });
  const beforeDelete = await f.done(other.thread.id);
  assert.ok(store.rewriteMessageParts(sess.id, normal.id, []));
  const closed = await f.request('/' + other.thread.id);
  assert.equal(closed.sourceAvailable, false);
  assert.deepEqual(closed.messages, beforeDelete.messages);
  const hits = await f.request('?q=deleted-tail-needle');
  assert.equal(hits.items[0].thread.id, other.thread.id);
  assert.equal(hits.items[0].matches[0].field, 'quote');
});

test('删除进行中的批注会停掉回答；别人删不掉也看不到 [AC:sidechat-delete#AC-3]', async (t) => {
  let arm: ((input: ModelTurnInput) => void) | null = null;
  let sawAbort = false;
  const f = fixture(t, async (input) => {
    if (!arm) return answer('留下的回答');
    const notify = arm;
    arm = null;
    if (!input.signal) throw new Error('missing signal');
    notify(input);
    await new Promise((_resolve, reject) => {
      input.signal!.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('aborted'));
      });
    });
    return answer('不应留下');
  });
  const chat = f.runtime.createChatSession({ agentId: 'general', title: 'Chat', metadata: { userId: 'ada' } });
  const body = f.source(chat.id);
  const messages = () => f.runtime.store.listMessages(chat.id).length;
  const before = messages();
  const kept = await f.request('', { ...body, requestId: 'keep', question: 'kepttoken 的问题' });
  await f.done(kept.thread.id);
  arm = () => undefined;
  const created = await f.request('', { ...body, requestId: 'drop', question: '问题 plumtoken' });
  assert.equal(created.thread.status, 'generating');
  await assert.rejects(f.request('/' + created.thread.id, undefined, 'bob', 'DELETE'), (error: any) => {
    assert.equal(error.statusCode, 404);
    assert.equal(String(error.message).includes('plumtoken'), false);
    return true;
  });
  assert.equal((await f.request('/' + created.thread.id)).thread.status, 'generating');
  assert.deepEqual((await f.request('?q=plumtoken', undefined, 'bob')).items, []);
  assert.equal((await f.request('/' + created.thread.id, undefined, 'ada', 'DELETE')).deleted, true);
  assert.equal(sawAbort, true);
  await assert.rejects(f.request('/' + created.thread.id), { statusCode: 404 });
  assert.deepEqual((await f.request('?q=plumtoken')).items, []);
  assert.equal((await f.request('?q=kepttoken')).items[0].thread.id, kept.thread.id);
  assert.equal(messages(), before);
});

test('没有完成回答时不能凝练；完成后一句话、掌握和标题只属于本人 [AC:sidechat-learning#AC-4] [AC:sidechat-learning#AC-6]', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(t, async (input) => {
    const blob = JSON.stringify(input.messages);
    if (blob.includes('凝练成一句话')) return answer('只缓存历史键值。');
    await gate;
    return answer('side answer');
  });
  const chat = f.runtime.createChatSession({ agentId: 'general', title: 'Chat', metadata: { userId: 'ada' } });
  const created = await f.request('', f.source(chat.id));
  await assert.rejects(f.request('/' + created.thread.id + '/note', {}, 'ada', 'POST'), {
    statusCode: 400,
    message: 'sidechat_note_needs_reply'
  });
  assert.equal((await f.request('/' + created.thread.id)).thread.note, '');
  release();
  await f.done(created.thread.id);
  const noted = await f.request('/' + created.thread.id + '/note', {}, 'ada', 'POST');
  assert.equal(noted.thread.note, '只缓存历史键值。');
  await assert.rejects(f.request('/' + created.thread.id, { grasp: 'mastered', title: '别人的标题' }, 'bob', 'PATCH'), {
    statusCode: 404
  });
  const renamed = await f.request('/' + created.thread.id, { grasp: 'mastered', title: '新的旁注标题' }, 'ada', 'PATCH');
  assert.equal(renamed.thread.grasp, 'mastered');
  assert.equal(renamed.thread.title, '新的旁注标题');
  assert.equal(renamed.thread.note, '只缓存历史键值。');
  const hits = await f.request('?q=' + encodeURIComponent('只缓存历史键值'));
  assert.equal(hits.items[0].thread.id, created.thread.id);
  assert.deepEqual((await f.request('?q=' + encodeURIComponent('只缓存历史键值'), undefined, 'bob')).items, []);
});
