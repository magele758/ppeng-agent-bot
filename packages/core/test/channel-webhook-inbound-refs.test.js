import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGenericWebhookInbound } from '../dist/channels/turn-kernel.js';

test('parseGenericWebhookInbound carries references and inReplyTo aliases [AC:r5-26-inbound-refs#AC-1] [AC:r5-26-inbound-refs#AC-4]', () => {
  const inbound = parseGenericWebhookInbound('mail', 'email', {
    text: 'please help',
    messageId: '<msg-2@agent.local>',
    subject: 'Re: Need docs',
    references: '<root@x> <msg-1@agent.local>',
    in_reply_to: '<msg-1@agent.local>'
  });
  assert.ok(inbound);
  assert.equal(inbound.messageId, '<msg-2@agent.local>');
  assert.equal(inbound.references, '<root@x> <msg-1@agent.local>');
  assert.equal(inbound.inReplyTo, '<msg-1@agent.local>');
});

test('parseGenericWebhookInbound accepts inReplyTo camelCase [AC:r5-26-inbound-refs#AC-4]', () => {
  const inbound = parseGenericWebhookInbound('mail', 'email', {
    text: 'ping',
    messageId: '<m@x>',
    inReplyTo: '<prev@x>',
    references: '<root@x>'
  });
  assert.ok(inbound);
  assert.equal(inbound.inReplyTo, '<prev@x>');
  assert.equal(inbound.references, '<root@x>');
});

test('parseGenericWebhookInbound omits refs when absent [AC:r5-26-inbound-refs#AC-3]', () => {
  const inbound = parseGenericWebhookInbound('hook', 'webhook', { text: 'hi' });
  assert.ok(inbound);
  assert.equal(inbound.references, undefined);
  assert.equal(inbound.inReplyTo, undefined);
});
