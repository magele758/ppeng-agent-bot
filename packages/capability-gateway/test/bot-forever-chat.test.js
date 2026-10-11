import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGatewayHttp } from '../dist/http.js';
import { drainGatewayTurns, resetInboundDedupe } from '../dist/inbound-guard.js';
import { runAgentTurnAndReply } from '../dist/im-handlers.js';
import { writeGatewaySettings } from '../dist/gateway-settings.js';
import { call, fakeRuntime, feishuMessageEvent, makeCtx } from './gateway-harness.mjs';

beforeEach(() => resetInboundDedupe());

function withCommands(runtime) {
  const commands = [];
  runtime.handleBotChatCommand = async (sessionId, text) => {
    commands.push({ sessionId, text });
    if (text === 'hello') return null;
    return { reply: `cmd:${text}`, handled: true };
  };
  runtime.commands = commands;
  return runtime;
}

test('绑定 Bot 的入站 /new /stop /model 不新开会话也不跑模型 [AC:bot-forever-chat#AC-5]', async () => {
  const bots = { alice: { id: 'alice', canonicalSessionId: 'sess_alice' } };
  const runtime = withCommands(fakeRuntime({ bots }));
  const ctx = makeCtx({ runtime, fileConfig: { providers: { feishu: { enabled: true, verificationToken: 'tok' } } } });
  writeGatewaySettings(runtime.store, { feishu: { botId: 'alice' } });

  for (const text of ['/new', '/stop', '/model beta-1']) {
    const response = await call(handleGatewayHttp, ctx, {
      path: '/providers/feishu/events',
      body: feishuMessageEvent({ text })
    });
    assert.equal(response.status, 200);
  }
  await drainGatewayTurns();

  assert.deepEqual(
    runtime.commands.map((item) => item.text),
    ['/new', '/stop', '/model beta-1']
  );
  assert.deepEqual(runtime.commands.map((item) => item.sessionId), ['sess_alice', 'sess_alice', 'sess_alice']);
  assert.equal(runtime.calls.created.length, 0);
  assert.equal(runtime.calls.sent.length, 0);
  assert.equal(runtime.calls.ran.length, 0);

  const chat = await call(handleGatewayHttp, ctx, { path: '/chat', body: { message: '/new', botId: 'alice' } });
  assert.equal(chat.status, 200);
  assert.equal(chat.json?.command?.reply, 'cmd:/new');
  assert.equal(runtime.calls.created.length, 0);
  assert.equal(runtime.calls.sent.length, 0);
  assert.equal(runtime.calls.ran.length, 0);
});

test('绑定 Bot 的普通文本仍在固定对话里跑一轮 [AC:bot-forever-chat#AC-5]', async () => {
  const replies = [];
  const runtime = withCommands(fakeRuntime({ bots: { alice: { id: 'alice', canonicalSessionId: 'sess_alice' } } }));
  const { sessionId } = await runAgentTurnAndReply({
    runtime,
    gatewayDir: mkdtempSync(join(tmpdir(), 'bfc-gw-')),
    state: {},
    sessionKey: 'feishu:user:ou_a',
    userText: 'hello',
    agentId: 'main',
    botId: 'alice',
    reply: async (text) => {
      replies.push(text);
    }
  });
  assert.equal(sessionId, 'sess_alice');
  assert.deepEqual(runtime.commands, [{ sessionId: 'sess_alice', text: 'hello' }]);
  assert.equal(runtime.calls.created.length, 0);
  assert.deepEqual(runtime.calls.sent, [{ sessionId: 'sess_alice', text: 'hello' }]);
  assert.deepEqual(runtime.calls.ran, ['sess_alice']);
  assert.equal(replies.length, 1);
});

test('未绑定 Bot 的 /new 不会走 Bot 命令 [AC:bot-forever-chat#AC-6]', async () => {
  const runtime = withCommands(fakeRuntime());
  const ctx = makeCtx({ runtime, fileConfig: { providers: { feishu: { enabled: true, verificationToken: 'tok' } } } });
  const response = await call(handleGatewayHttp, ctx, {
    path: '/providers/feishu/events',
    body: feishuMessageEvent({ text: '/new' })
  });
  await drainGatewayTurns();
  assert.equal(response.status, 200);
  assert.deepEqual(runtime.commands, []);
  assert.equal(runtime.calls.created.length, 1);
  assert.equal(runtime.calls.created[0].message, '/new');
  assert.equal(runtime.calls.ran.length, 1);
});
