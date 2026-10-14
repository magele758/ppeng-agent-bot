import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleGatewayHttp } from '../dist/http.js';
import {
  claimInboundEvent,
  drainGatewayTurns,
  FEISHU_SIGNATURE_WINDOW_MS,
  resetInboundDedupe,
  verifyFeishuSignature
} from '../dist/inbound-guard.js';
import { extractFeishuInboundText, feishuUrlVerificationResponse } from '../dist/im-handlers.js';
import {
  call,
  fakeRuntime,
  feishuEncrypt,
  feishuMessageEvent,
  feishuSign,
  makeCtx
} from './gateway-harness.mjs';

test('feishu url_verification', () => {
  const r = feishuUrlVerificationResponse({ type: 'url_verification', challenge: 'abc' });
  assert.deepStrictEqual(r, { challenge: 'abc' });
});

test('feishu extract group text', () => {
  const body = {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: {
        chat_id: 'oc_xxx',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"hello"}'
      },
      sender: { sender_id: { open_id: 'ou_1' } }
    }
  };
  const x = extractFeishuInboundText(body);
  assert.ok(x);
  assert.equal(x.text, 'hello');
  assert.equal(x.receiveIdType, 'chat_id');
  assert.equal(x.receiveId, 'oc_xxx');
});

function sign(raw, key, timestamp, nonce = 'n1') {
  return createHash('sha256').update(timestamp + nonce + key + raw).digest('hex');
}

test('feishu signature older than 5 minutes is rejected', () => {
  const now = 1_700_000_000_000;
  const raw = '{"a":1}';
  const key = 'k';
  const freshTs = String(Math.floor(now / 1000));
  const staleTs = String(Math.floor((now - FEISHU_SIGNATURE_WINDOW_MS - 1000) / 1000));
  assert.equal(
    verifyFeishuSignature({
      rawBody: raw,
      encryptKey: key,
      timestamp: freshTs,
      nonce: 'n1',
      signature: sign(raw, key, freshTs),
      nowMs: now
    }),
    true
  );
  assert.equal(
    verifyFeishuSignature({
      rawBody: raw,
      encryptKey: key,
      timestamp: staleTs,
      nonce: 'n1',
      signature: sign(raw, key, staleTs),
      nowMs: now
    }),
    false
  );
});

test('stale Feishu timestamp is 403 and does not run the agent', async () => {
  const key = 'enc-key-1';
  const runtime = fakeRuntime();
  const ctx = makeCtx({ runtime, fileConfig: { providers: { feishu: { enabled: true, encryptKey: key } } } });
  const raw = JSON.stringify({ encrypt: feishuEncrypt(feishuMessageEvent({ token: 'ignored' }), key) });
  const timestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
  const stale = await call(handleGatewayHttp, ctx, {
    path: '/providers/feishu/events',
    rawBody: raw,
    headers: feishuSign(raw, key, { timestamp })
  });
  assert.equal(stale.status, 403);
  assert.equal(runtime.calls.ran.length, 0);
});

test('Feishu retry after memory reset does not run the agent again', async () => {
  const runtime = fakeRuntime();
  const ctx = makeCtx({
    runtime,
    fileConfig: { providers: { feishu: { enabled: true, verificationToken: 'tok' } } }
  });
  const ev = feishuMessageEvent({ eventId: 'ev_restart', token: 'tok' });
  const post = () => call(handleGatewayHttp, ctx, { path: '/providers/feishu/events', body: ev });
  const first = await post();
  await drainGatewayTurns();
  resetInboundDedupe();
  const second = await post();
  await drainGatewayTurns();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(runtime.calls.ran.length, 1);
});

test('persisted Feishu claim does not pin the in-memory map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-dedupe-mem-'));
  const key = 'feishu:event:ev_persist_only';
  const now = Date.now();
  resetInboundDedupe();
  assert.equal(claimInboundEvent(key, now, dir), true);
  assert.equal(claimInboundEvent(key, now), true);
  assert.equal(claimInboundEvent(key, now, dir), false);
  resetInboundDedupe();
});

test('same Feishu event_id stays claimed after the in-memory map is cleared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-dedupe-'));
  const key = 'feishu:event:ev_restart';
  const now = Date.now();
  assert.equal(claimInboundEvent(key, now, dir), true);
  resetInboundDedupe();
  assert.equal(claimInboundEvent(key, now + 7 * 60 * 60 * 1000, dir), false);
  assert.equal(claimInboundEvent('feishu:event:ev_other', now, dir), true);
});
