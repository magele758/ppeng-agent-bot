import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOutboundDraft,
  claimOutboundDraft,
  confirmOutboundDraft,
  editOutboundDraft,
  OUTBOUND_DRAFT_MAX_TEXT
} from '../dist/outbound-drafts.js';
import { describeOutboundIdentity } from '../dist/outbound-identity.js';
import { createUserDeliveryPort } from '../dist/user-delivery-port.js';
import { cleanupGatewayTemps } from './gateway-harness.mjs';

after(() => cleanupGatewayTemps());

const CHANNELS = [
  { id: 'out', type: 'http_post', url: 'http://im.test/hook?key=SECRETKEY', payloadMode: 'json_text' },
  { id: 'slack1', type: 'slack', url: 'https://slack.com/api/chat.postMessage', target: 'C123', tokenEnv: 'SLACK_BOT_TOKEN' },
  { id: 'tg', type: 'telegram', url: 'https://api.telegram.org', target: '42', headers: { Authorization: 'Bearer env:TG_TOKEN' } },
  { id: 'tg-inline', type: 'telegram', url: '42', headers: { authorization: 'Bearer 123:abcdef' } },
  { id: 'mail', type: 'email', url: 'https://mail.test/send', target: 'a@example.test' },
  { id: 'fs', type: 'feishu_bot', url: 'ou_abc' },
  { id: 'wecom', type: 'wecom_group_bot', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send', wecomKey: 'KEY' },
  { id: 'hook', type: 'webhook', url: 'not a url' }
];

function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(init?.body ?? ''));
    return new Response('ok', { status: 200 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function gw(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'gateway');
}

test('editing a pending draft keeps it pending, posts nothing, and keeps the original text [AC:outbound-draft-edit-identity#AC-1]', async () => {
  const gatewayDir = gw('ode-1-');
  const net = stubFetch();
  try {
    const port = createUserDeliveryPort({ gatewayDir, channels: CHANNELS });
    const draft = await port.draft({ channelId: 'out', text: 'first draft' });
    assert.equal(draft.revision, undefined);

    const edited = await port.edit({ id: draft.id, text: 'better wording', expectedRevision: 0 });
    assert.equal(edited.status, 'pending_approval');
    assert.equal(edited.text, 'better wording');
    assert.equal(edited.originalText, 'first draft');
    assert.equal(edited.revision, 1);
    assert.ok(edited.editedAt);

    const again = await port.edit({ id: draft.id, text: 'final wording' });
    assert.equal(again.originalText, 'first draft');
    assert.equal(again.revision, 2);

    const same = await port.edit({ id: draft.id, text: 'final wording' });
    assert.equal(same.revision, 2);

    const [listed] = await port.list();
    assert.equal(listed.status, 'pending_approval');
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('approve after edit sends exactly the edited text once [AC:outbound-draft-edit-identity#AC-2]', async () => {
  const gatewayDir = gw('ode-2-');
  const net = stubFetch();
  try {
    const port = createUserDeliveryPort({ gatewayDir, channels: CHANNELS });
    const draft = await port.draft({ channelId: 'out', text: 'original' });
    const edited = await port.edit({ id: draft.id, text: 'edited body' });
    const sent = await port.confirm({ id: draft.id, decision: 'approve', expectedRevision: edited.revision });
    assert.equal(sent.status, 'sent');
    assert.equal(net.calls.length, 1);
    assert.match(net.calls[0], /edited body/);
    assert.doesNotMatch(net.calls[0], /original/);
    await assert.rejects(() => port.confirm({ id: draft.id, decision: 'approve' }));
    assert.equal(net.calls.length, 1);
  } finally {
    net.restore();
  }
});

test('approving a stale preview fails closed and sends nothing [AC:outbound-draft-edit-identity#AC-3]', async () => {
  const gatewayDir = gw('ode-3-');
  const net = stubFetch();
  try {
    const port = createUserDeliveryPort({ gatewayDir, channels: CHANNELS });
    const draft = await port.draft({ channelId: 'out', text: 'v0' });
    await port.edit({ id: draft.id, text: 'v1' });

    await assert.rejects(
      () => port.confirm({ id: draft.id, decision: 'approve', expectedRevision: 0 }),
      (error) => error.code === 'CONFLICT' && error.statusCode !== 400
    );
    await assert.rejects(() => port.edit({ id: draft.id, text: 'v2', expectedRevision: 0 }), /changed since/);
    assert.equal(net.calls.length, 0);
    const [listed] = await port.list();
    assert.equal(listed.status, 'pending_approval');
    assert.equal(listed.text, 'v1');

    const sent = await port.confirm({ id: draft.id, decision: 'approve', expectedRevision: 1 });
    assert.equal(sent.status, 'sent');
    assert.equal(net.calls.length, 1);
  } finally {
    net.restore();
  }
});

test('non-editable drafts and empty or oversized text are rejected [AC:outbound-draft-edit-identity#AC-4]', async () => {
  const gatewayDir = gw('ode-4-');
  const net = stubFetch();
  try {
    const port = createUserDeliveryPort({ gatewayDir, channels: CHANNELS });
    const draft = await port.draft({ channelId: 'out', text: 'keep me' });

    await assert.rejects(() => editOutboundDraft(gatewayDir, draft.id, { text: '   ' }), /must not be empty/);
    await assert.rejects(
      () => editOutboundDraft(gatewayDir, draft.id, { text: 'x'.repeat(OUTBOUND_DRAFT_MAX_TEXT + 1) }),
      /exceeds/
    );
    await assert.rejects(() => editOutboundDraft(gatewayDir, 'draft_missing', { text: 'x' }), /not found/);

    await confirmOutboundDraft(gatewayDir, draft.id);
    await assert.rejects(() => port.edit({ id: draft.id, text: 'late edit' }), /is confirmed/);
    await claimOutboundDraft(gatewayDir, draft.id);
    await assert.rejects(() => port.edit({ id: draft.id, text: 'late edit' }), /is sending/);

    const [listed] = await port.list();
    assert.equal(listed.text, 'keep me');
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('identity bar describes who each channel sends as without secrets [AC:outbound-draft-edit-identity#AC-5]', async () => {
  const gatewayDir = gw('ode-5-');
  const env = { RAW_AGENT_FEISHU_APP_ID: 'cli_a1b2c3d4e5f6', RAW_AGENT_FEISHU_APP_SECRET: 'sek', SLACK_BOT_TOKEN: 'xoxb-secret' };
  const mk = async (channelId, extra = {}) => appendOutboundDraft(gatewayDir, { channelId, text: 't', ...extra });
  const id = async (channelId, extra, e = env) => describeOutboundIdentity(await mk(channelId, extra), CHANNELS, e);

  assert.deepEqual(await id('out'), { channelId: 'out', kind: 'http_post', resolved: true, sender: 'im.test' });
  const slack = await id('slack1');
  assert.deepEqual([slack.kind, slack.sender, slack.recipient], ['slack', 'env:SLACK_BOT_TOKEN', 'C123']);
  const tg = await id('tg');
  assert.deepEqual([tg.sender, tg.recipient], ['env:TG_TOKEN', '42']);
  const tgInline = await id('tg-inline');
  assert.deepEqual([tgInline.sender, tgInline.recipient], ['inline', '42']);
  const mail = await id('mail');
  // r5-22: empty channel.from + no claimedFrom → do not invent URL host; unresolved
  assert.deepEqual([mail.resolved, mail.sender, mail.recipient], [false, undefined, 'a@example.test']);
  const fs = await id('fs');
  assert.deepEqual([fs.kind, fs.resolved, fs.sender, fs.recipient], ['feishu_bot', true, 'cli_…f6', 'ou_abc']);
  const fsMissing = await id('fs', undefined, {});
  assert.deepEqual([fsMissing.resolved, fsMissing.sender], [false, undefined]);
  const direct = await id('whatever', { receiveId: 'oc_chat', receiveIdType: 'chat_id' });
  assert.deepEqual([direct.kind, direct.resolved, direct.sender, direct.recipient], ['feishu_app', true, 'cli_…f6', 'chat_id:oc_chat']);
  const shortApp = await id('fs', undefined, { RAW_AGENT_FEISHU_APP_ID: 'short', RAW_AGENT_FEISHU_APP_SECRET: 's' });
  assert.equal(shortApp.sender, 'sh…');
  const wecom = await id('wecom');
  assert.equal(wecom.sender, 'qyapi.weixin.qq.com');
  const bad = await id('hook');
  assert.equal(bad.sender, undefined);
  const missing = await id('nope');
  assert.deepEqual(missing, { channelId: 'nope', kind: 'unknown', resolved: false });

  const port = createUserDeliveryPort({ gatewayDir, channels: CHANNELS });
  const previews = await port.listPreviews();
  assert.equal(previews.length, 12);
  const serialized = JSON.stringify(previews.map((preview) => preview.identity));
  for (const secret of ['SECRETKEY', 'xoxb-secret', 'abcdef', 'cli_a1b2c3d4e5f6', 'sek', '/hook', 'KEY"']) {
    assert.ok(!serialized.includes(secret), `identity leaked ${secret}`);
  }
  assert.ok(previews.every((preview) => preview.identity.channelId === preview.channelId));
});
