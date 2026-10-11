import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGatewayHttp } from '../dist/http.js';
import { drainGatewayTurns } from '../dist/inbound-guard.js';
import { runAgentTurnAndReply } from '../dist/im-handlers.js';
import {
  isSilentMarker,
  resolveImOutbound,
  SILENT_ACK
} from '../dist/silent-reply.js';
import {
  RECOVERED_REPLY_PREFIX,
  beginOutboundAttempt,
  finishOutbound,
  recoverOutboundLedger,
  sendLedgered
} from '../dist/delivery-ledger.js';
import { recoverGatewayOutbound } from '../dist/outbound.js';
import { call, fakeRuntime, feishuMessageEvent, makeCtx } from './gateway-harness.mjs';

const ZH_ACK = '收到，没有更多要补充的。';
const EN_ACK = 'Got it. Nothing more to add.';

test('静默标记判定：整段才算，顺带提到不算 [AC:bot-gateway-delivery#AC-1] [AC:bot-gateway-delivery#AC-4]', () => {
  for (const token of ['[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY', 'no_reply', '  [silent]  ', '`[SILENT]`', '**NO_REPLY**', '[静默]', '沉默']) {
    assert.equal(isSilentMarker(token), true, token);
  }
  assert.equal(isSilentMarker('Use [SILENT] when nothing changed'), false);
  assert.equal(isSilentMarker('hello\n[SILENT]'), false);
  assert.equal(SILENT_ACK.zh, ZH_ACK);
  assert.equal(SILENT_ACK.en, EN_ACK);
});

test('人直接发来的静默回复换成简短确认，不把标记发出去 [AC:bot-gateway-delivery#AC-1] [AC:bot-gateway-delivery#AC-2]', async () => {
  const zh = resolveImOutbound('[SILENT]', { origin: 'human', userText: '在吗' });
  const en = resolveImOutbound('NO_REPLY', { origin: 'human', locale: 'en' });
  assert.equal(zh.action, 'send');
  assert.equal(zh.text, ZH_ACK);
  assert.equal(en.text, EN_ACK);
  assert.doesNotMatch(zh.text, /SILENT|NO_REPLY/);
  assert.doesNotMatch(en.text, /SILENT|NO_REPLY/);

  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response('ok', { status: 200 });
  };
  try {
    const runtime = fakeRuntime();
    runtime.getLatestAssistantText = () => '[SILENT]';
    const ctx = makeCtx({
      runtime,
      fileConfig: {
        providers: { feishu: { enabled: true, verificationToken: 'tok', replyChannelId: 'out' } },
        channels: [{ id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' }]
      }
    });
    const res = await call(handleGatewayHttp, ctx, {
      path: '/providers/feishu/events',
      body: feishuMessageEvent({ token: 'tok', text: '你好' })
    });
    await drainGatewayTurns();
    assert.equal(res.status, 200);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0].body, new RegExp(ZH_ACK));
    assert.doesNotMatch(fetched[0].body, /\[SILENT\]|NO_REPLY/);
  } finally {
    globalThis.fetch = original;
  }
});

test('定时任务与 webhook 的静默回复不外发、也不发确认 [AC:bot-gateway-delivery#AC-3]', async () => {
  for (const origin of ['cron', 'webhook']) {
    const decision = resolveImOutbound('NO_REPLY', { origin, locale: 'zh', userText: '你好' });
    assert.equal(decision.action, 'drop');
  }

  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push(String(init?.body ?? ''));
    return new Response('ok', { status: 200 });
  };
  try {
    const runtime = fakeRuntime();
    runtime.getLatestAssistantText = () => '[SILENT]';
    const ctx = makeCtx({
      runtime,
      fileConfig: {
        channels: [{ id: 'hook', type: 'webhook', url: 'http://im.test/hook', payloadMode: 'json_text' }]
      }
    });
    const res = await call(handleGatewayHttp, ctx, {
      path: '/channels/hook/webhook',
      body: { text: 'ping from webhook', conversationKey: 'c1', senderId: 'u1' }
    });
    assert.equal(res.status, 200);
    assert.equal(fetched.length, 0);
    assert.equal(res.json?.reply ?? null, null);
  } finally {
    globalThis.fetch = original;
  }
});

test('提到静默标记的普通回复原样送达 [AC:bot-gateway-delivery#AC-4]', async () => {
  const prose = 'Use [SILENT] when nothing changed';
  const decision = resolveImOutbound(prose, { origin: 'human', locale: 'en' });
  assert.equal(decision.action, 'send');
  assert.equal(decision.text, prose);

  const sent = [];
  const runtime = fakeRuntime();
  runtime.getLatestAssistantText = () => prose;
  await runAgentTurnAndReply({
    runtime,
    gatewayDir: mkdtempSync(join(tmpdir(), 'gw-silent-')),
    state: { version: 1, rollingItems: [], seenLinks: [] },
    sessionKey: 'feishu:user:ou',
    userText: 'hello',
    agentId: 'general',
    origin: 'human',
    reply: async (text) => {
      sent.push(text);
    }
  });
  assert.deepEqual(sent, [prose]);
});

test('发送中重启会带重复前缀再投递，已送达的不再发 [AC:bot-gateway-delivery#AC-5]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-ledger-'));
  const target = { type: 'channel', channelId: 'out' };
  const original = 'morning brief is ready';

  const id = beginOutboundAttempt(dir, target, original);
  const crashed = JSON.parse(readFileSync(join(dir, 'delivery-ledger.json'), 'utf8'));
  assert.equal(crashed.items.find((row) => row.id === id).state, 'attempting');

  const resent = [];
  const n = await recoverOutboundLedger(dir, async (_row, text) => {
    resent.push(text);
  });
  assert.equal(n, 1);
  assert.equal(resent.length, 1);
  assert.ok(resent[0].startsWith(RECOVERED_REPLY_PREFIX));
  assert.match(resent[0], /Recovered reply/);
  assert.match(resent[0], /duplicate/i);
  assert.match(resent[0], /morning brief is ready/);

  const again = [];
  const n2 = await recoverOutboundLedger(dir, async (_row, text) => {
    again.push(text);
  });
  assert.equal(n2, 0);
  assert.deepEqual(again, []);

  const done = mkdtempSync(join(tmpdir(), 'gw-ledger-ok-'));
  await sendLedgered({
    gatewayDir: done,
    target,
    text: 'already delivered',
    send: async () => {}
  });
  const afterOk = [];
  assert.equal(await recoverOutboundLedger(done, async (_row, text) => afterOk.push(text)), 0);
  assert.deepEqual(afterOk, []);

  const failedDir = mkdtempSync(join(tmpdir(), 'gw-ledger-fail-'));
  await assert.rejects(() =>
    sendLedgered({
      gatewayDir: failedDir,
      target,
      text: 'maybe sent',
      send: async () => {
        throw new Error('socket reset');
      }
    })
  );
  finishOutbound(failedDir, beginOutboundAttempt(failedDir, target, 'second'), 'delivered');
  const retry = [];
  await recoverOutboundLedger(failedDir, async (_row, text) => {
    retry.push(text);
  });
  assert.equal(retry.length, 1);
  assert.match(retry[0], /maybe sent/);
  assert.match(retry[0], /Recovered reply/);
});

test('重启后续投渠道与飞书，缺渠道或缺凭证则记失败 [AC:bot-gateway-delivery#AC-5]', async () => {
  const channelDir = mkdtempSync(join(tmpdir(), 'gw-resend-ch-'));
  beginOutboundAttempt(channelDir, { type: 'channel', channelId: 'out' }, 'channel body');
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response('ok', { status: 200 });
  };
  try {
    const sent = await recoverGatewayOutbound({
      gatewayDir: channelDir,
      channels: [{ id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' }]
    });
    assert.equal(sent, 1);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0].body, /channel body/);
    assert.match(fetched[0].body, /Recovered reply/);
  } finally {
    globalThis.fetch = original;
  }

  const missingDir = mkdtempSync(join(tmpdir(), 'gw-resend-miss-'));
  beginOutboundAttempt(missingDir, { type: 'channel', channelId: 'gone' }, 'nowhere');
  assert.equal(
    await recoverGatewayOutbound({
      gatewayDir: missingDir,
      channels: [{ id: 'out', type: 'http_post', url: 'http://im.test/hook' }]
    }),
    0
  );

  const badDir = mkdtempSync(join(tmpdir(), 'gw-resend-bad-'));
  beginOutboundAttempt(badDir, { type: 'channel', channelId: 'out' }, 'nope');
  globalThis.fetch = async () => new Response('no', { status: 500 });
  try {
    assert.equal(
      await recoverGatewayOutbound({
        gatewayDir: badDir,
        channels: [{ id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' }]
      }),
      0
    );
  } finally {
    globalThis.fetch = original;
  }

  const feishuDir = mkdtempSync(join(tmpdir(), 'gw-resend-fs-'));
  beginOutboundAttempt(
    feishuDir,
    { type: 'feishu', receiveId: 'ou_1', receiveIdType: 'open_id' },
    'feishu body'
  );
  const prevId = process.env.RAW_AGENT_FEISHU_APP_ID;
  const prevSecret = process.env.RAW_AGENT_FEISHU_APP_SECRET;
  delete process.env.RAW_AGENT_FEISHU_APP_ID;
  delete process.env.RAW_AGENT_FEISHU_APP_SECRET;
  assert.equal(await recoverGatewayOutbound({ gatewayDir: feishuDir, channels: [] }), 0);

  const feishuOk = mkdtempSync(join(tmpdir(), 'gw-resend-fs-ok-'));
  beginOutboundAttempt(
    feishuOk,
    { type: 'feishu', receiveId: 'ou_2', receiveIdType: 'chat_id' },
    'feishu ok'
  );
  process.env.RAW_AGENT_FEISHU_APP_ID = 'cli_test';
  process.env.RAW_AGENT_FEISHU_APP_SECRET = 'secret_test';
  const feishuCalls = [];
  globalThis.fetch = async (url, init) => {
    feishuCalls.push(String(url));
    const href = String(url);
    if (href.includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }), { status: 200 });
    }
    assert.match(String(init?.body ?? ''), /feishu ok/);
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  try {
    assert.equal(await recoverGatewayOutbound({ gatewayDir: feishuOk, channels: [] }), 1);
    assert.ok(feishuCalls.some((url) => url.includes('/im/v1/messages')));
  } finally {
    globalThis.fetch = original;
    if (prevId == null) delete process.env.RAW_AGENT_FEISHU_APP_ID;
    else process.env.RAW_AGENT_FEISHU_APP_ID = prevId;
    if (prevSecret == null) delete process.env.RAW_AGENT_FEISHU_APP_SECRET;
    else process.env.RAW_AGENT_FEISHU_APP_SECRET = prevSecret;
  }

  const unknownDir = mkdtempSync(join(tmpdir(), 'gw-resend-unk-'));
  const id = beginOutboundAttempt(unknownDir, { type: 'channel', channelId: 'out' }, 'bad target');
  const ledgerPath = join(unknownDir, 'delivery-ledger.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger.items.find((row) => row.id === id).target = { type: 'pigeon' };
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  assert.equal(await recoverGatewayOutbound({ gatewayDir: unknownDir, channels: [] }), 0);
});
