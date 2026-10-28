import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserDeliveryPort } from '../dist/user-delivery-port.js';
import { deliverChannelText } from '../dist/outbound.js';
import { deliverToChannel } from '../dist/channels.js';
import { cleanupGatewayTemps } from './gateway-harness.mjs';

after(() => cleanupGatewayTemps());

test('UserDeliveryPort drafts without posting and confirm approve sends once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'user-delivery-port-'));
  const gatewayDir = join(dir, 'gateway');
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response('ok', { status: 200 });
  };
  try {
    const channels = [{ id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' }];
    const port = createUserDeliveryPort({ gatewayDir, channels });
    const draft = await port.draft({ channelId: 'out', text: 'hello human', event: 'test' });
    assert.equal(draft.status, 'pending_approval');
    assert.equal(fetched.length, 0);
    const listed = await port.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, draft.id);

    const sent = await port.confirm({ id: draft.id, decision: 'approve' });
    assert.equal(sent.status, 'sent');
    assert.equal(fetched.length, 1);
    assert.match(fetched[0].body, /hello human/);

    await assert.rejects(() => port.confirm({ id: draft.id, decision: 'approve' }));
    assert.equal(fetched.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('deliverChannelText user-facing path goes through UserDeliveryPort draft (no silent post)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'user-delivery-port-dct-'));
  const gatewayDir = join(dir, 'gateway');
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    const channel = { id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' };
    await deliverChannelText({ gatewayDir, channel, text: 'via port' });
    assert.equal(calls, 0);
    const drafts = JSON.parse(readFileSync(join(gatewayDir, 'outbound-drafts.json'), 'utf8'));
    assert.equal(drafts.items.length, 1);
    assert.equal(drafts.items[0].text, 'via port');
    assert.equal(drafts.items[0].status, 'pending_approval');
  } finally {
    globalThis.fetch = original;
  }
});

test('deliverToChannel remains transport-only and still requires human approval token', async () => {
  await assert.rejects(
    () => deliverToChannel({ id: 'c', type: 'http_post', url: 'http://127.0.0.1:9/hook' }, { text: 'x' }),
    /egress_not_approved/
  );
});
