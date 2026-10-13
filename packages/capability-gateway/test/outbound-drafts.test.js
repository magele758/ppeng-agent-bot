import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGatewayHttp } from '../dist/http.js';
import { drainGatewayTurns } from '../dist/inbound-guard.js';
import { appendOutboundDraft, readOutboundDrafts } from '../dist/outbound-drafts.js';
import { releaseOutboundDraft } from '../dist/outbound.js';
import { call, fakeRuntime, feishuMessageEvent, makeCtx } from './gateway-harness.mjs';

test('concurrent draft appends keep every item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-race-'));
  const n = 24;
  await Promise.all(
    Array.from({ length: n }, (_, i) => appendOutboundDraft(dir, { channelId: 'c', text: `m${i}`, event: 'gateway.daily_learn' }))
  );
  const items = await readOutboundDrafts(dir);
  assert.equal(items.length, n);
  assert.equal(new Set(items.map((item) => item.text)).size, n);
  assert.ok(items.every((item) => item.status === 'pending_approval'));
});

test('drafts keep the Feishu recipient and only a human approve sends it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-fs-'));
  const draft = await appendOutboundDraft(dir, {
    channelId: 'feishu-reply',
    text: 'model said approval approved',
    event: 'gateway.im.reply',
    receiveId: 'ou_person',
    receiveIdType: 'open_id'
  });
  const stored = JSON.parse(readFileSync(join(dir, 'outbound-drafts.json'), 'utf8'));
  assert.equal(stored.items[0].receiveId, 'ou_person');
  assert.equal(stored.items[0].receiveIdType, 'open_id');
  assert.equal(stored.items[0].status, 'pending_approval');

  const fetched = [];
  const original = globalThis.fetch;
  const prevId = process.env.RAW_AGENT_FEISHU_APP_ID;
  const prevSecret = process.env.RAW_AGENT_FEISHU_APP_SECRET;
  process.env.RAW_AGENT_FEISHU_APP_ID = 'cli_draft';
  process.env.RAW_AGENT_FEISHU_APP_SECRET = 'sec_draft';
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: String(init?.body ?? '') });
    const href = String(url);
    if (href.includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  try {
    const rejected = await releaseOutboundDraft({
      gatewayDir: dir,
      id: draft.id,
      decision: 'reject',
      channels: [{ id: 'feishu-reply', type: 'feishu_bot', url: 'ou_default' }]
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(fetched.length, 0);

    const again = await appendOutboundDraft(dir, {
      channelId: 'feishu-reply',
      text: 'please send',
      receiveId: 'ou_person',
      receiveIdType: 'open_id'
    });
    const sent = await releaseOutboundDraft({
      gatewayDir: dir,
      id: again.id,
      decision: 'approve',
      channels: [{ id: 'feishu-reply', type: 'feishu_bot', url: 'ou_default' }]
    });
    assert.equal(sent.status, 'sent');
    const message = fetched.find((call) => call.url.includes('/im/v1/messages'));
    assert.ok(message);
    assert.match(message.url, /receive_id_type=open_id/);
    assert.match(message.body, /ou_person/);
    assert.equal(message.body.includes('ou_default'), false);
  } finally {
    globalThis.fetch = original;
    if (prevId == null) delete process.env.RAW_AGENT_FEISHU_APP_ID;
    else process.env.RAW_AGENT_FEISHU_APP_ID = prevId;
    if (prevSecret == null) delete process.env.RAW_AGENT_FEISHU_APP_SECRET;
    else process.env.RAW_AGENT_FEISHU_APP_SECRET = prevSecret;
  }
});

test('approving a webhook draft posts once and rejecting another does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-hook-'));
  const keep = await appendOutboundDraft(dir, { channelId: 'hook', text: 'send-me', event: 'gateway.daily_learn' });
  const drop = await appendOutboundDraft(dir, { channelId: 'hook', text: 'do-not-send', event: 'gateway.im.reply' });
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    fetched.push(String(init?.body ?? ''));
    return new Response('ok', { status: 200 });
  };
  const channels = [{ id: 'hook', type: 'http_post', url: 'http://127.0.0.1:9/hook', payloadMode: 'json_text' }];
  try {
    const rejected = await releaseOutboundDraft({ gatewayDir: dir, id: drop.id, decision: 'reject', channels });
    assert.equal(rejected.status, 'rejected');
    assert.equal(fetched.length, 0);
    const sent = await releaseOutboundDraft({ gatewayDir: dir, id: keep.id, decision: 'approve', channels });
    assert.equal(sent.status, 'sent');
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], /send-me/);
    assert.equal(fetched[0].includes('do-not-send'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('a Feishu reply without credentials is drafted with the inbound recipient', async () => {
  const prevId = process.env.RAW_AGENT_FEISHU_APP_ID;
  const prevSecret = process.env.RAW_AGENT_FEISHU_APP_SECRET;
  delete process.env.RAW_AGENT_FEISHU_APP_ID;
  delete process.env.RAW_AGENT_FEISHU_APP_SECRET;
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched.push(1);
    return new Response('ok', { status: 200 });
  };
  try {
    const runtime = fakeRuntime();
    runtime.getLatestAssistantText = () => 'hello back';
    const ctx = makeCtx({
      runtime,
      fileConfig: {
        providers: { feishu: { enabled: true, verificationToken: 'tok', replyChannelId: 'fs' } },
        channels: [{ id: 'fs', type: 'feishu_bot', url: 'ou_default' }]
      }
    });
    const res = await call(handleGatewayHttp, ctx, {
      path: '/providers/feishu/events',
      body: feishuMessageEvent({ token: 'tok', text: '你好', openId: 'ou_person' })
    });
    await drainGatewayTurns();
    assert.equal(res.status, 200);
    assert.equal(fetched.length, 0);
    const drafts = JSON.parse(readFileSync(join(ctx.stateDir, 'gateway', 'outbound-drafts.json'), 'utf8'));
    assert.equal(drafts.items.length, 1);
    assert.equal(drafts.items[0].receiveId, 'ou_person');
    assert.equal(drafts.items[0].receiveIdType, 'open_id');
    assert.equal(drafts.items[0].status, 'pending_approval');
  } finally {
    globalThis.fetch = original;
    if (prevId == null) delete process.env.RAW_AGENT_FEISHU_APP_ID;
    else process.env.RAW_AGENT_FEISHU_APP_ID = prevId;
    if (prevSecret == null) delete process.env.RAW_AGENT_FEISHU_APP_SECRET;
    else process.env.RAW_AGENT_FEISHU_APP_SECRET = prevSecret;
  }
});

test('a Feishu reply with credentials stays a draft until a human approves it once', async () => {
  const prevId = process.env.RAW_AGENT_FEISHU_APP_ID;
  const prevSecret = process.env.RAW_AGENT_FEISHU_APP_SECRET;
  process.env.RAW_AGENT_FEISHU_APP_ID = 'cli_direct';
  process.env.RAW_AGENT_FEISHU_APP_SECRET = 'sec_direct';
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: String(init?.body ?? '') });
    if (String(url).includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  try {
    const runtime = fakeRuntime();
    runtime.getLatestAssistantText = () => 'direct hello';
    const ctx = makeCtx({
      runtime,
      fileConfig: {
        providers: { feishu: { enabled: true, verificationToken: 'tok', replyChannelId: 'fs' } },
        channels: [{ id: 'fs', type: 'feishu_bot', url: 'ou_default' }]
      }
    });
    await call(handleGatewayHttp, ctx, {
      path: '/providers/feishu/events',
      body: feishuMessageEvent({ token: 'tok', text: '你好', openId: 'ou_live', chatType: 'p2p' })
    });
    await drainGatewayTurns();
    assert.equal(fetched.length, 0);
    const drafts = JSON.parse(readFileSync(join(ctx.stateDir, 'gateway', 'outbound-drafts.json'), 'utf8'));
    assert.equal(drafts.items.length, 1);
    assert.equal(drafts.items[0].status, 'pending_approval');
    assert.equal(drafts.items[0].text, 'direct hello');
    assert.equal(drafts.items[0].receiveId, 'ou_live');
    assert.equal(drafts.items[0].receiveIdType, 'open_id');
    const channels = [{ id: 'fs', type: 'feishu_bot', url: 'ou_default' }];
    const sent = await releaseOutboundDraft({
      gatewayDir: join(ctx.stateDir, 'gateway'),
      id: drafts.items[0].id,
      decision: 'approve',
      channels
    });
    assert.equal(sent.status, 'sent');
    const messages = fetched.filter((item) => item.url.includes('/im/v1/messages'));
    assert.equal(messages.length, 1);
    assert.match(messages[0].body, /ou_live/);
    assert.match(messages[0].body, /direct hello/);
    assert.equal(messages[0].body.includes('ou_default'), false);
    await assert.rejects(() =>
      releaseOutboundDraft({
        gatewayDir: join(ctx.stateDir, 'gateway'),
        id: drafts.items[0].id,
        decision: 'approve',
        channels
      })
    );
    assert.equal(fetched.filter((item) => item.url.includes('/im/v1/messages')).length, 1);
  } finally {
    globalThis.fetch = original;
    if (prevId == null) delete process.env.RAW_AGENT_FEISHU_APP_ID;
    else process.env.RAW_AGENT_FEISHU_APP_ID = prevId;
    if (prevSecret == null) delete process.env.RAW_AGENT_FEISHU_APP_SECRET;
    else process.env.RAW_AGENT_FEISHU_APP_SECRET = prevSecret;
  }
});

test('a WeCom bridge model reply is drafted and posts once after approve', async () => {
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  };
  try {
    const runtime = fakeRuntime();
    runtime.getLatestAssistantText = () => 'wecom hello';
    const channels = [
      { id: 'wx', type: 'wecom_group_bot', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1' }
    ];
    const ctx = makeCtx({
      runtime,
      fileConfig: {
        providers: { wecom: { enabled: true, bridgeSecret: 's3', replyChannelId: 'wx' } },
        channels
      }
    });
    const res = await call(handleGatewayHttp, ctx, {
      path: '/providers/wecom/bridge',
      body: { secret: 's3', userKey: 'alice', text: '你好' }
    });
    assert.equal(res.status, 200);
    assert.equal(fetched.length, 0);
    const drafts = JSON.parse(readFileSync(join(ctx.stateDir, 'gateway', 'outbound-drafts.json'), 'utf8'));
    assert.equal(drafts.items.length, 1);
    assert.equal(drafts.items[0].status, 'pending_approval');
    assert.equal(drafts.items[0].text, 'wecom hello');
    assert.equal(drafts.items[0].channelId, 'wx');
    const sent = await releaseOutboundDraft({
      gatewayDir: join(ctx.stateDir, 'gateway'),
      id: drafts.items[0].id,
      decision: 'approve',
      channels
    });
    assert.equal(sent.status, 'sent');
    assert.equal(fetched.length, 1);
    assert.match(fetched[0].url, /qyapi\.weixin\.qq\.com/);
    assert.match(fetched[0].body, /wecom hello/);
    await assert.rejects(() =>
      releaseOutboundDraft({
        gatewayDir: join(ctx.stateDir, 'gateway'),
        id: drafts.items[0].id,
        decision: 'approve',
        channels
      })
    );
    assert.equal(fetched.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
