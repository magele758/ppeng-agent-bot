import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGenericWebhookInbound } from '../dist/channels/turn-kernel.js';

test('parseGenericWebhookInbound carries messageId and subject [AC:r5-25-reply-draft-ingress#AC-2]', () => {
  const inbound = parseGenericWebhookInbound('mail', 'email', {
    text: 'please help',
    messageId: '<msg-1@agent.local>',
    subject: 'Need docs',
    senderId: 'alice'
  });
  assert.ok(inbound);
  assert.equal(inbound.messageId, '<msg-1@agent.local>');
  assert.equal(inbound.subject, 'Need docs');
  assert.equal(inbound.text, 'please help');
});

test('parseGenericWebhookInbound accepts message_id alias and empty subject [AC:r5-25-reply-draft-ingress#AC-2]', () => {
  const inbound = parseGenericWebhookInbound('mail', 'email', {
    text: 'ping',
    message_id: '<m2@x>',
    subject: ''
  });
  assert.ok(inbound);
  assert.equal(inbound.messageId, '<m2@x>');
  assert.equal(inbound.subject, '');
});

test('parseGenericWebhookInbound omits thread fields when absent [AC:r5-25-reply-draft-ingress#AC-3]', () => {
  const inbound = parseGenericWebhookInbound('hook', 'webhook', { text: 'hi' });
  assert.ok(inbound);
  assert.equal(inbound.messageId, undefined);
  assert.equal(inbound.subject, undefined);
});
