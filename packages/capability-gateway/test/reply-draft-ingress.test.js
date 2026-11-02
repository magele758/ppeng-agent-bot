import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailWebhookDraftReplyFields } from '../dist/channels/email.js';
import { createUserDeliveryPort } from '../dist/user-delivery-port.js';
import { appendOutboundDraft, readOutboundDrafts } from '../dist/outbound-drafts.js';
import { deliverChannelText } from '../dist/outbound.js';

test('emailWebhookDraftReplyFields maps messageId/subject for email only [AC:r5-25-reply-draft-ingress#AC-2] [AC:r5-25-reply-draft-ingress#AC-3]', () => {
  assert.deepEqual(
    emailWebhookDraftReplyFields('email', { messageId: '<m@x>', subject: 'Hello' }),
    { inReplyTo: '<m@x>', replyToSubject: 'Hello' }
  );
  assert.deepEqual(
    emailWebhookDraftReplyFields('email', { messageId: '<m@x>', subject: '' }),
    { inReplyTo: '<m@x>', replyToSubject: '' }
  );
  assert.deepEqual(emailWebhookDraftReplyFields('email', { messageId: '  ' }), {});
  assert.deepEqual(emailWebhookDraftReplyFields('slack', { messageId: '<m@x>', subject: 'Hi' }), {});
  assert.deepEqual(emailWebhookDraftReplyFields('webhook', { messageId: '<m@x>' }), {});
});

test('UserDeliveryPort.draft stores forwarded thread fields [AC:r5-25-reply-draft-ingress#AC-1]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r5-25-udp-'));
  try {
    const port = createUserDeliveryPort({ gatewayDir: dir, channels: [] });
    const draft = await port.draft({
      channelId: 'mail',
      text: 'reply body',
      event: 'gateway.im.reply',
      inReplyTo: '<orig@agent.local>',
      references: '<root@x> <orig@agent.local>',
      subject: '',
      replyToSubject: 'Quarterly update'
    });
    assert.equal(draft.inReplyTo, '<orig@agent.local>');
    assert.equal(draft.references, '<root@x> <orig@agent.local>');
    assert.equal(draft.subject, '');
    assert.equal(draft.replyToSubject, 'Quarterly update');
    const items = await readOutboundDrafts(dir);
    assert.equal(items[0].inReplyTo, '<orig@agent.local>');
    assert.equal(items[0].replyToSubject, 'Quarterly update');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deliverChannelText forwards thread fields into the draft [AC:r5-25-reply-draft-ingress#AC-1]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r5-25-dct-'));
  try {
    await deliverChannelText({
      gatewayDir: dir,
      channel: {
        id: 'mail',
        type: 'email',
        url: 'https://relay.example/send',
        target: 'user@example.com'
      },
      text: 'hi',
      inReplyTo: '<a@b>',
      replyToSubject: 'Orig'
    });
    const items = await readOutboundDrafts(dir);
    assert.equal(items.length, 1);
    assert.equal(items[0].inReplyTo, '<a@b>');
    assert.equal(items[0].replyToSubject, 'Orig');
    assert.equal(items[0].status, 'pending_approval');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendOutboundDraft still stores thread fields (ledger path) [AC:r5-25-reply-draft-ingress#AC-5]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r5-25-ledger-'));
  try {
    const draft = await appendOutboundDraft(dir, {
      channelId: 'mail',
      text: 'x',
      inReplyTo: '<z@z>',
      replyToSubject: 'S'
    });
    assert.equal(draft.inReplyTo, '<z@z>');
    assert.equal(draft.replyToSubject, 'S');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
