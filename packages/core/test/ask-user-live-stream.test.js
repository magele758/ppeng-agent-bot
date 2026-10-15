/**
 * After ask_user is answered, the approval route resumes the run without its own
 * SSE consumer. A follower that subscribed first must still see the new tokens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, createMockLlm } from '../dist/exports/public.js';
import { sessionsRoutes } from '../../../apps/daemon/dist/routes/sessions.js';
import { miscRoutes } from '../../../apps/daemon/dist/routes/misc.js';

const ANON = { isolate: false, labProxy: false, user: null };

function runtimeWithMock(script) {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'ask-follow-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'ask-follow-state-')),
    modelAdapter: createMockLlm(script)
  });
}

function sseResponse() {
  const emitter = new EventEmitter();
  const chunks = [];
  return {
    chunks,
    disconnect() {
      emitter.emit('close');
    },
    statusCode: 200,
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
      emitter.emit('close');
    },
    on(event, fn) {
      emitter.on(event, fn);
    },
    removeListener(event, fn) {
      emitter.removeListener(event, fn);
    }
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function decideApproval(runtime, id, decision) {
  const spec = miscRoutes(runtime, { pkgName: 't', pkgVersion: '0' }).find(
    (route) => route.method === 'POST' && route.pattern === '/api/approvals/:id/:decision'
  );
  assert.ok(spec);
  const response = {
    statusCode: 200,
    setHeader() {},
    end() {}
  };
  await spec.handler({
    request: { headers: {} },
    response,
    url: new URL(`http://x/api/approvals/${id}/${decision}`),
    parts: ['api', 'approvals', id, decision],
    params: { id, decision },
    requireParam: (name) => (name === 'id' ? id : decision),
    readBody: async () => ({}),
    auth: ANON
  });
}

test('ask_user resume streams later tokens to a follower attached before approve [AC:ask-user-live-stream#AC-1]', async () => {
  const runtime = runtimeWithMock((input) => {
    const answered = input.messages.some((message) =>
      message.parts.some(
        (part) => part.type === 'tool_result' && String(part.content ?? '').includes('用户回复')
      )
    );
    if (!answered) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'ask1',
            name: 'ask_user',
            input: { question: 'which color?' }
          }
        ]
      };
    }
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'continued-blue' }] };
  });
  try {
    const session = runtime.createChatSession({ title: 'ask', message: 'need a color' });
    const blocked = await runtime.runSession(session.id);
    assert.equal(blocked.status, 'waiting_approval');
    const pending = runtime.listApprovals('pending').filter((item) => item.sessionId === session.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolName, 'ask_user');

    const response = sseResponse();
    const route = sessionsRoutes(runtime).find(
      (item) => item.method === 'POST' && item.pattern === '/api/sessions/:id/stream'
    );
    assert.ok(route);
    const followed = route.handler({
      request: { headers: {} },
      response,
      url: new URL(`http://x/api/sessions/${session.id}/stream`),
      parts: ['api', 'sessions', session.id, 'stream'],
      params: { id: session.id },
      requireParam: (name) => {
        if (name === 'id') return session.id;
        throw new Error(`missing ${name}`);
      },
      readBody: async () => ({ follow: true }),
      auth: ANON
    });

    assert.ok(await waitFor(() => response.chunks.join('').includes('event: ready')), 'follower became ready');
    runtime.mergeSessionMetadata(session.id, { askUserReply: 'blue', askUserPending: false });
    await decideApproval(runtime, pending[0].id, 'approve');
    await followed;

    const wire = response.chunks.join('');
    assert.match(wire, /"type":"text_delta"/);
    assert.match(wire, /continued-blue/);
    assert.match(wire, /event: result/);
    assert.equal(runtime.getLatestAssistantText(session.id), 'continued-blue');
    assert.equal(runtime.getSession(session.id).status, 'idle');
  } finally {
    await runtime.destroy?.();
  }
});

test('closing the follower does not cancel the ask_user continuation [AC:ask-user-live-stream#AC-1]', async () => {
  let release = () => {};
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = runtimeWithMock(async (input) => {
    const answered = input.messages.some((message) =>
      message.parts.some(
        (part) => part.type === 'tool_result' && String(part.content ?? '').includes('用户回复')
      )
    );
    if (!answered) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'ask1',
            name: 'ask_user',
            input: { question: 'which color?' }
          }
        ]
      };
    }
    await hold;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'after-close' }] };
  });
  try {
    const session = runtime.createChatSession({ title: 'ask-close', message: 'need a color' });
    const blocked = await runtime.runSession(session.id);
    assert.equal(blocked.status, 'waiting_approval');
    const pending = runtime.listApprovals('pending').filter((item) => item.sessionId === session.id);
    assert.equal(pending[0]?.toolName, 'ask_user');

    const response = sseResponse();
    const route = sessionsRoutes(runtime).find(
      (item) => item.method === 'POST' && item.pattern === '/api/sessions/:id/stream'
    );
    assert.ok(route);
    const followed = route.handler({
      request: { headers: {} },
      response,
      url: new URL(`http://x/api/sessions/${session.id}/stream`),
      parts: ['api', 'sessions', session.id, 'stream'],
      params: { id: session.id },
      requireParam: (name) => (name === 'id' ? session.id : ''),
      readBody: async () => ({ follow: true }),
      auth: ANON
    });
    assert.ok(await waitFor(() => response.chunks.join('').includes('event: ready')));
    runtime.mergeSessionMetadata(session.id, { askUserReply: 'blue', askUserPending: false });
    const resumed = decideApproval(runtime, pending[0].id, 'approve');
    assert.ok(await waitFor(() => runtime.getSession(session.id)?.status === 'running'));
    response.disconnect();
    release();
    await resumed;
    await followed;
    assert.equal(runtime.getLatestAssistantText(session.id), 'after-close');
    assert.equal(runtime.getSession(session.id).status, 'idle');
  } finally {
    release();
    await runtime.destroy?.();
  }
});
