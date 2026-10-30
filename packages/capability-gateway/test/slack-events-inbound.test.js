import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { test, beforeEach, after } from 'node:test';
import { SqliteStateStore } from '../../core/dist/storage.js';
import { createCronJob } from '../../core/dist/cron/cron-facade.js';
import { handleGatewayHttp } from '../dist/http.js';
import { drainGatewayTurns, resetInboundDedupe } from '../dist/inbound-guard.js';
import { writeGatewaySettings } from '../dist/gateway-settings.js';
import { readOutboundDrafts } from '../dist/outbound-drafts.js';
import {
  call,
  cleanupGatewayTemps,
  fakeRuntime,
  makeCtx
} from './gateway-harness.mjs';

const SECRET = 'slack-signing-secret-do-not-log';
const SECRET_ENV = 'PPENG_TEST_SLACK_EVENTS_SECRET';
process.env[SECRET_ENV] = SECRET;

beforeEach(() => resetInboundDedupe());
after(() => cleanupGatewayTemps());

function slackSig(raw, timestamp, secret = SECRET) {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`, 'utf8').digest('hex')}`;
}

function slackHeaders(raw, timestamp) {
  return {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': slackSig(raw, timestamp)
  };
}

function messageEvent(patch = {}) {
  return {
    type: 'event_callback',
    event_id: patch.eventId ?? 'Ev-thread-1',
    event: {
      type: patch.type ?? 'message',
      channel: patch.channel ?? 'C0123ABC',
      user: patch.user ?? 'U123',
      text: patch.text ?? 'hello thread',
      ts: patch.ts ?? '1700000000.000100',
      ...(patch.threadTs ? { thread_ts: patch.threadTs } : {}),
      ...(patch.botId ? { bot_id: patch.botId } : {}),
      ...(patch.subtype ? { subtype: patch.subtype } : {})
    }
  };
}

function slackCtx({ runtime, spec = { enabled: true, signingSecret: SECRET, defaultAgentId: 'main' }, channels } = {}) {
  const rt = runtime ?? fakeRuntime();
  const ctx = makeCtx({ runtime: rt, fileConfig: { providers: { slack: spec }, channels } });
  return { runtime: rt, ctx };
}

const post = (ctx, body, headers, rawBody) =>
  call(handleGatewayHttp, ctx, { path: '/providers/slack/events', body, rawBody, headers });

function routineHost(runtime, stateDir) {
  return {
    stateDir,
    store: runtime.store,
    cronStore: undefined,
    setCronStore(next) {
      this.cronStore = next;
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    runSession: (sessionId) => runtime.runSession(sessionId)
  };
}

test('签名正确的线程消息进入 slack:频道:线程 并唤醒一次例行任务 [AC:slack-events-inbound#AC-1]', async () => {
  const runtime = fakeRuntime();
  const { ctx } = slackCtx({ runtime });
  const store = new SqliteStateStore(join(ctx.stateDir, 'state.db'));
  runtime.store = store;
  const parent = store.createSession({ title: 'listener', mode: 'chat', agentId: 'general', background: false });
  createCronJob(routineHost(runtime, join(ctx.stateDir, 'gateway')), {
    sessionId: parent.id,
    name: 'on slack',
    prompt: '总结这条 Slack 消息',
    event: 'slack/message',
    secretEnv: SECRET_ENV
  });
  const body = messageEvent({ threadTs: '1700000000.000001', text: 'need a hand' });
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const r = await post(ctx, undefined, slackHeaders(raw, timestamp), raw);
  await drainGatewayTurns();
  assert.equal(r.status, 200);
  assert.equal(runtime.calls.created.length, 1);
  assert.equal(runtime.calls.created[0].title.startsWith('IM slack:C0123ABC:'), true);
  assert.match(runtime.calls.created[0].message, /slack:C0123ABC:1700000000\.000001/);
  assert.equal(runtime.calls.ran.length, 2);
  const woke = store.listSessions().find((session) => session.id !== parent.id && session.id !== runtime.calls.created[0].id);
  assert.ok(woke, 'routine child session');
  const text = store
    .listMessages(woke.id)
    .filter((message) => message.role === 'user')
    .map((message) => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''))
    .join('\n');
  assert.match(text, /«external source=event label=slack\/message»/);
  assert.match(text, /thread: slack:C0123ABC:1700000000\.000001/);
  store.db.close();
});

test('签名缺失、错误或过期时不运行也不唤醒 [AC:slack-events-inbound#AC-2]', async () => {
  const { runtime, ctx } = slackCtx();
  const body = messageEvent({ eventId: 'Ev-bad' });
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const missing = await post(ctx, body);
  const bad = await post(ctx, undefined, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=deadbeef' }, raw);
  const staleTs = String(Math.floor(Date.now() / 1000) - 301);
  const stale = await post(ctx, undefined, slackHeaders(raw, staleTs), raw);
  await drainGatewayTurns();
  assert.equal(missing.status, 403);
  assert.equal(bad.status, 403);
  assert.equal(stale.status, 403);
  assert.equal(runtime.calls.ran.length, 0);
  assert.equal(runtime.calls.created.length, 0);
});

test('同一 event_id 重试不再运行 Agent [AC:slack-events-inbound#AC-3]', async () => {
  const { runtime, ctx } = slackCtx();
  const body = messageEvent({ eventId: 'Ev-dup', ts: '1700000000.000200' });
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = slackHeaders(raw, timestamp);
  const first = await post(ctx, undefined, headers, raw);
  const second = await post(ctx, undefined, headers, raw);
  await drainGatewayTurns();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json?.duplicate, true);
  assert.equal(runtime.calls.created.length, 1);
  assert.equal(runtime.calls.ran.length, 1);
});

test('URL 验证、机器人自己的消息和编辑不创建会话 [AC:slack-events-inbound#AC-4]', async () => {
  const { runtime, ctx } = slackCtx();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const challengeBody = { type: 'url_verification', challenge: 'plain-challenge' };
  const challengeRaw = JSON.stringify(challengeBody);
  const challenge = await post(ctx, undefined, slackHeaders(challengeRaw, timestamp), challengeRaw);
  assert.equal(challenge.status, 200);
  assert.deepEqual(challenge.json, { challenge: 'plain-challenge' });

  for (const body of [
    messageEvent({ eventId: 'Ev-bot', botId: 'B123' }),
    messageEvent({ eventId: 'Ev-edit', subtype: 'message_changed' })
  ]) {
    const raw = JSON.stringify(body);
    const r = await post(ctx, undefined, slackHeaders(raw, timestamp), raw);
    assert.equal(r.status, 200);
  }
  await drainGatewayTurns();
  assert.equal(runtime.calls.created.length, 0);
  assert.equal(runtime.calls.ran.length, 0);
});

test('白名单之外的发送者不运行也不唤醒 [AC:slack-events-inbound#AC-5]', async () => {
  const { runtime, ctx } = slackCtx();
  writeGatewaySettings(runtime.store, { slack: { signingSecret: SECRET, allowedSenders: ['U-ok'] } });
  const body = messageEvent({ eventId: 'Ev-stranger', user: 'U-nope' });
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const r = await post(ctx, undefined, slackHeaders(raw, timestamp), raw);
  await drainGatewayTurns();
  assert.equal(r.status, 200);
  assert.equal(runtime.calls.ran.length, 0);
  assert.equal(runtime.calls.created.length, 0);
});

test('顶层消息用自己的 ts 当线程，回复只进草稿', async () => {
  const { runtime, ctx } = slackCtx({
    spec: { enabled: true, signingSecret: SECRET, defaultAgentId: 'main', replyChannelId: 'ops-slack' },
    channels: [{ id: 'ops-slack', type: 'slack', url: 'http://127.0.0.1:9/slack', tokenEnv: 'SLACK_BOT_TOKEN' }]
  });
  const body = messageEvent({ eventId: 'Ev-top', ts: '1700000000.000300', text: 'top level' });
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const r = await post(ctx, undefined, slackHeaders(raw, timestamp), raw);
  await drainGatewayTurns();
  assert.equal(r.status, 200);
  assert.match(runtime.calls.created[0].message, /slack:C0123ABC:1700000000\.000300/);
  const drafts = await readOutboundDrafts(`${ctx.stateDir}/gateway`);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].status, 'pending_approval');
  assert.equal(drafts[0].channelId, 'ops-slack');
});

test('未配置签名密钥时拒绝，未启用时 404', async () => {
  const open = slackCtx({ spec: { enabled: true } });
  const denied = await post(open.ctx, messageEvent({ eventId: 'Ev-open' }));
  assert.equal(denied.status, 403);
  assert.equal(open.runtime.calls.ran.length, 0);

  const off = slackCtx({ spec: { enabled: false, signingSecret: SECRET } });
  const missing = await post(off.ctx, messageEvent({ eventId: 'Ev-off' }));
  assert.equal(missing.status, 404);
  assert.equal(off.runtime.calls.ran.length, 0);
});
