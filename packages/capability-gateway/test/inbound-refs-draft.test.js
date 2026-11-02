import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEmailReplyReferences,
  emailWebhookDraftReplyFields
} from '../dist/channels/email.js';

test('buildEmailReplyReferences appends messageId and dedupes trailing dup [AC:r5-26-inbound-refs#AC-1]', () => {
  assert.equal(
    buildEmailReplyReferences('<root@x> <a@x>', '<b@x>'),
    '<root@x> <a@x> <b@x>'
  );
  assert.equal(
    buildEmailReplyReferences('<root@x> <a@x> <b@x>', '<b@x>'),
    '<root@x> <a@x> <b@x>'
  );
  assert.equal(
    buildEmailReplyReferences('<root@x> <b@x> <a@x>', '<b@x>'),
    '<root@x> <a@x> <b@x>'
  );
});

test('buildEmailReplyReferences omits when parent or messageId missing [AC:r5-26-inbound-refs#AC-2]', () => {
  assert.equal(buildEmailReplyReferences(undefined, '<m@x>'), undefined);
  assert.equal(buildEmailReplyReferences('', '<m@x>'), undefined);
  assert.equal(buildEmailReplyReferences('<root@x>', ''), undefined);
  assert.equal(buildEmailReplyReferences('<root@x>', undefined), undefined);
});

test('emailWebhookDraftReplyFields builds references chain [AC:r5-26-inbound-refs#AC-1]', () => {
  assert.deepEqual(
    emailWebhookDraftReplyFields('email', {
      messageId: '<m@x>',
      subject: 'Hello',
      references: '<root@x> <prev@x>'
    }),
    {
      inReplyTo: '<m@x>',
      replyToSubject: 'Hello',
      references: '<root@x> <prev@x> <m@x>'
    }
  );
});

test('emailWebhookDraftReplyFields omits references when messageId only [AC:r5-26-inbound-refs#AC-2]', () => {
  assert.deepEqual(
    emailWebhookDraftReplyFields('email', { messageId: '<m@x>', subject: 'Hello' }),
    { inReplyTo: '<m@x>', replyToSubject: 'Hello' }
  );
});

test('emailWebhookDraftReplyFields still empty for non-email [AC:r5-26-inbound-refs#AC-3]', () => {
  assert.deepEqual(
    emailWebhookDraftReplyFields('slack', {
      messageId: '<m@x>',
      subject: 'Hi',
      references: '<root@x>'
    }),
    {}
  );
  assert.deepEqual(
    emailWebhookDraftReplyFields('webhook', { messageId: '<m@x>', references: '<a@x>' }),
    {}
  );
});

test('sendEmailHttp still defaults references to inReplyTo when draft omits refs [AC:r5-26-inbound-refs#AC-5] [AC:r5-26-inbound-refs#AC-2]', async () => {
  const { sendEmailHttp } = await import('../dist/channels/email.js');
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(String(init?.body ?? ''));
    return new Response('ok', { status: 200 });
  };
  try {
    await sendEmailHttp(
      {
        id: 'mail-1',
        type: 'email',
        url: 'https://relay.example/send',
        target: 'user@example.com',
        subject: 'Hello'
      },
      'body text',
      {},
      { inReplyTo: '<msg-1@agent.local>', claimedFrom: 'agent1@agent.local' }
    );
    const payload = JSON.parse(calls[0]);
    assert.equal(payload.inReplyTo, '<msg-1@agent.local>');
    assert.equal(payload.references, '<msg-1@agent.local>');
  } finally {
    globalThis.fetch = original;
  }
});
