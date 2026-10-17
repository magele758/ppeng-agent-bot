import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverToChannel } from '../dist/channels.js';
import { handleGatewayHttp } from '../dist/http.js';
import { call, cleanupGatewayTemps, fakeRuntime, makeCtx } from './gateway-harness.mjs';

after(() => cleanupGatewayTemps());

test('deliverToChannel does not fetch until a human approval is passed', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    await assert.rejects(
      () => deliverToChannel({ id: 'c', type: 'http_post', url: 'http://127.0.0.1:9/hook' }, { text: 'hi' }),
      /egress_not_approved/
    );
    assert.equal(calls, 0);
    const sent = await deliverToChannel(
      { id: 'c', type: 'http_post', url: 'http://127.0.0.1:9/hook' },
      { text: 'hi' },
      { approval: 'approved' }
    );
    assert.equal(sent.ok, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('webhook inbound is fenced and the reply is drafted instead of posted', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    const runtime = fakeRuntime();
    runtime.getLatestAssistantText = () => 'hello back';
    const ctx = makeCtx({
      runtime,
      fileConfig: {
        channels: [{ id: 'hook', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' }]
      }
    });
    const res = await call(handleGatewayHttp, ctx, {
      path: '/channels/hook/webhook',
      body: { text: 'hello from outside', conversationKey: 'c1', senderId: 'u1' }
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 0);
    assert.match(runtime.calls.created[0].message, /«external source=im /);
    assert.match(runtime.calls.created[0].message, /hello from outside/);
    assert.match(res.json.reply.text, /hello back/);
    const drafts = JSON.parse(readFileSync(join(ctx.stateDir, 'gateway', 'outbound-drafts.json'), 'utf8'));
    assert.equal(drafts.items.length, 1);
    assert.equal(drafts.items[0].status, 'pending_approval');
    assert.match(drafts.items[0].text, /hello back/);
  } finally {
    globalThis.fetch = original;
  }
});
