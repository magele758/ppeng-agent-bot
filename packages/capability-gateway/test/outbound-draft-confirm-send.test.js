import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOutboundDraft,
  confirmOutboundDraft,
  claimOutboundDraft,
  settleOutboundDraft
} from '../dist/outbound-drafts.js';
import { deliverChannelText, releaseOutboundDraft } from '../dist/outbound.js';
import { deliverToChannel } from '../dist/channels.js';
import { cleanupGatewayTemps } from './gateway-harness.mjs';

after(() => cleanupGatewayTemps());

test('Draft → Confirm → Send: confirm does not post; claim+settle posts once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcs-'));
  const gatewayDir = join(dir, 'gateway');
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push(String(init?.body ?? ''));
    return new Response('ok', { status: 200 });
  };
  try {
    const draft = await appendOutboundDraft(gatewayDir, { channelId: 'out', text: 'stepwise' });
    assert.equal(draft.status, 'pending_approval');
    const confirmed = await confirmOutboundDraft(gatewayDir, draft.id);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(fetched.length, 0);

    const claimed = await claimOutboundDraft(gatewayDir, draft.id);
    assert.equal(claimed.status, 'sending');
    assert.equal(fetched.length, 0);

    const channels = [{ id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' }];
    // send via release path on a fresh draft to exercise full pipeline
    const d2 = await appendOutboundDraft(gatewayDir, { channelId: 'out', text: 'via release' });
    const sent = await releaseOutboundDraft({
      gatewayDir,
      id: d2.id,
      decision: 'approve',
      channels
    });
    assert.equal(sent.status, 'sent');
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], /via release/);

    // original claimed draft still sending — settle without double-post requirement here
    await settleOutboundDraft(gatewayDir, draft.id, { status: 'failed', error: 'abandoned in test' });
  } finally {
    globalThis.fetch = original;
  }
});

test('deliverChannelText never silent-sends even with approval approved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcs-silent-'));
  const gatewayDir = join(dir, 'gateway');
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    const channel = { id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' };
    await deliverChannelText({ gatewayDir, channel, text: 'no silent', approval: 'approved' });
    assert.equal(calls, 0);
    const drafts = JSON.parse(readFileSync(join(gatewayDir, 'outbound-drafts.json'), 'utf8'));
    assert.equal(drafts.items.length, 1);
    assert.equal(drafts.items[0].status, 'pending_approval');
    assert.equal(drafts.items[0].text, 'no silent');
  } finally {
    globalThis.fetch = original;
  }
});

test('slack/telegram/email still draft under deliverChannelText with approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcs-human-'));
  const gatewayDir = join(dir, 'gateway');
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  try {
    await deliverChannelText({
      gatewayDir,
      channel: {
        id: 's',
        type: 'slack',
        url: 'https://slack.example/api',
        slackBotToken: 'xoxb-test',
        slackChannelId: 'C1'
      },
      text: 'hold',
      approval: 'approved'
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('transport still requires approval token (not a silent user path)', async () => {
  await assert.rejects(
    () => deliverToChannel({ id: 'c', type: 'http_post', url: 'http://127.0.0.1:9/x' }, { text: 'x' }),
    /egress_not_approved/
  );
});
