/**
 * POST /api/chat/stream: dropping the SSE client (refresh, navigation) must not
 * cancel the run. Only an explicit cancel stops it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANONYMOUS_AUTH, RawAgentRuntime } from '@ppeng/agent-core';
import { setCatalogDefaultRef, upsertProvider } from '../../packages/core/dist/model/provider-catalog.js';
import { replayApiKey, startReplayServer } from '../../packages/agent-loop/dist/testing/upstream-replay.js';
import { sessionsRoutes } from '../../apps/daemon/dist/routes/sessions.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chatChunk(content, finish = null) {
  return { data: { id: 'chatcmpl-Sse', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: finish }] } };
}

/** 30 tokens, 100 ms apart: ~3 s if nobody hangs up. */
const slowAnswer = {
  status: 200,
  delayMs: 100,
  events: [...Array.from({ length: 30 }, (_, i) => chatChunk(`tok${i} `)), chatChunk('', 'stop'), { data: '[DONE]' }]
};

async function setup(responses) {
  const upstream = await startReplayServer(responses);
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'sse-dc-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'sse-dc-state-'))
  });
  upsertProvider(runtime.store, {
    id: 'replay',
    name: 'replay',
    kind: 'openai-compatible',
    baseUrl: upstream.baseUrl,
    apiKey: replayApiKey(),
    useJsonMode: false,
    models: [{ id: 'replay-model', enabled: true }]
  });
  setCatalogDefaultRef(runtime.store, { providerId: 'replay', modelId: 'replay-model' });

  const routes = sessionsRoutes(runtime);
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (piece) => (raw += piece));
    request.on('end', () => {
      const url = new URL(`http://x${request.url}`);
      const route = routes.find(
        (item) => item.method === request.method && matchPattern(item.pattern, url.pathname)
      );
      if (!route) {
        response.statusCode = 404;
        response.end('no route');
        return;
      }
      const params = matchPattern(route.pattern, url.pathname) ?? {};
      void Promise.resolve(
        route.handler({
          request,
          response,
          url,
          parts: url.pathname.split('/').filter(Boolean),
          params,
          requireParam: (name) => {
            const value = params[name];
            if (!value) throw new Error(`missing ${name}`);
            return value;
          },
          readBody: async () => (raw ? JSON.parse(raw) : {}),
          auth: ANONYMOUS_AUTH
        })
      ).catch((error) => {
        if (!response.writableEnded) {
          response.statusCode = 500;
          response.end(error instanceof Error ? error.message : String(error));
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/api/chat/stream`;
  const close = async () => {
    await runtime.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await upstream.close();
  };
  return { upstream, runtime, url, base, close };
}

function matchPattern(pattern, pathname) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    const part = expected[i];
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(actual[i]);
    else if (part !== actual[i]) return null;
  }
  return params;
}

function postChat(url, title, signal) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, message: 'hi' }),
    signal
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return false;
}

function sessionByTitle(runtime, title) {
  return runtime.store.listSessions().find((s) => s.title === title);
}

function outcomeOf(session) {
  return session?.metadata?.outcome;
}

test('刷新或断开流式连接不会中止回合，完成后回复留在历史里 [AC:refresh-keeps-agent-run#AC-1] [AC:refresh-keeps-agent-run#AC-3] [AC:chat-basics#AC-5]', async () => {
  const env = await setup([slowAnswer]);
  try {
    const ac = new AbortController();
    const res = await postChat(env.url, 'sse-dc', ac.signal);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: model')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    assert.match(seen, /tok0/);
    ac.abort();

    const session = sessionByTitle(env.runtime, 'sse-dc');
    assert.ok(await waitFor(() => /tok29/.test(env.runtime.getLatestAssistantText(session.id)), 8000));
    assert.equal(env.upstream.abandoned(), 0, 'refresh must not abandon the upstream request');
    const settled = env.runtime.getSession(session.id);
    const outcome = outcomeOf(settled);
    assert.notEqual(outcome?.kind, 'aborted');
    assert.notEqual(outcome?.reason, 'abort');
    assert.notEqual(outcome?.reason, 'user_abort');
    const kinds = (await env.runtime.listTraceEvents(session.id)).map((e) => e.kind);
    assert.ok(!kinds.includes('cancel'), `refresh traced a cancel (${kinds.join(',')})`);
    assert.equal(env.upstream.requests.length, 1);
  } finally {
    await env.close();
  }
});

test('断开后重新跟上同一场，能看到后续输出和完成后的回复 [AC:refresh-keeps-agent-run#AC-3]', async () => {
  const env = await setup([slowAnswer]);
  try {
    const ac = new AbortController();
    const res = await postChat(env.url, 'sse-rejoin', ac.signal);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('tok0')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    assert.match(seen, /tok0/);
    const session = sessionByTitle(env.runtime, 'sse-rejoin');
    ac.abort();
    const follow = await fetch(`${env.base}/api/sessions/${encodeURIComponent(session.id)}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ follow: true })
    });
    const followed = await follow.text();
    assert.match(env.runtime.getLatestAssistantText(session.id), /tok29/);
    assert.match(followed, /tok29|text_delta/);
    const outcome = outcomeOf(env.runtime.getSession(session.id));
    assert.notEqual(outcome?.kind, 'aborted');
  } finally {
    await env.close();
  }
});

test('明确停止仍然会终止正在生成的回复 [AC:refresh-keeps-agent-run#AC-2] [AC:chat-basics#AC-5]', async () => {
  const env = await setup([slowAnswer]);
  try {
    const ac = new AbortController();
    const res = await postChat(env.url, 'sse-stop', ac.signal);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('tok0')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    assert.match(seen, /tok0/);
    const session = sessionByTitle(env.runtime, 'sse-stop');
    const disconnectedAt = Date.now();
    const cancel = await fetch(`${env.base}/api/sessions/${encodeURIComponent(session.id)}/cancel`, {
      method: 'POST'
    });
    assert.equal(cancel.status, 200);
    assert.ok(await waitFor(() => env.upstream.abandoned() === 1), 'explicit stop abandons upstream');
    assert.ok(Date.now() - disconnectedAt < 2000, 'explicit stop aborts promptly');
    assert.ok(await waitFor(() => env.runtime.getSession(session.id).status !== 'running'));
    const kinds = (await env.runtime.listTraceEvents(session.id)).map((e) => e.kind);
    assert.ok(kinds.includes('cancel'), `cancel traced (got ${kinds.join(',')})`);
    const outcome = outcomeOf(env.runtime.getSession(session.id));
    assert.equal(outcome?.kind, 'aborted');
    ac.abort();
  } finally {
    await env.close();
  }
});

test('a stream that completes normally is not cancelled when the response closes', async () => {
  const env = await setup([{ ...slowAnswer, delayMs: 0 }]);
  try {
    const text = await (await postChat(env.url, 'sse-full')).text();
    assert.match(text, /event: result/);
    const session = sessionByTitle(env.runtime, 'sse-full');
    await sleep(50);
    const kinds = (await env.runtime.listTraceEvents(session.id)).map((e) => e.kind);
    assert.ok(!kinds.includes('cancel'));
    assert.equal(env.upstream.abandoned(), 0);
    assert.match(env.runtime.getLatestAssistantText(session.id), /tok29/);
  } finally {
    await env.close();
  }
});

test('the reply reaches the client token by token before the final result, and is saved [AC:chat-basics#AC-2]', async () => {
  const env = await setup([{ ...slowAnswer, delayMs: 20 }]);
  try {
    const res = await postChat(env.url, 'sse-progressive');
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let firstDeltaBeforeResult = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (!firstDeltaBeforeResult && buf.includes('"type":"text_delta"')) {
        firstDeltaBeforeResult = !buf.includes('event: result');
      }
    }
    assert.ok(firstDeltaBeforeResult, 'text arrived before the run finished');
    const deltas = buf.match(/"type":"text_delta"/g) ?? [];
    assert.ok(deltas.length >= 10, `expected many deltas, got ${deltas.length}`);
    assert.match(buf, /event: result/);
    const session = sessionByTitle(env.runtime, 'sse-progressive');
    assert.match(env.runtime.getLatestAssistantText(session.id), /tok0 [\s\S]*tok29/);
  } finally {
    await env.close();
  }
});

test('a caller that only joins an in-flight run cannot cancel it by aborting [AC:chat-basics#AC-5]', async () => {
  const env = await setup([{ ...slowAnswer, delayMs: 20 }]);
  try {
    const session = env.runtime.createChatSession({ title: 'joined', message: 'hi' });
    const owner = env.runtime.runSession(session.id, { onModelStreamChunk: () => undefined });
    const ac = new AbortController();
    const joined = env.runtime.runSession(session.id, { signal: ac.signal });
    ac.abort();
    await Promise.all([owner, joined]);
    assert.equal(env.upstream.abandoned(), 0);
    assert.match(env.runtime.getLatestAssistantText(session.id), /tok29/);
  } finally {
    await env.close();
  }
});
