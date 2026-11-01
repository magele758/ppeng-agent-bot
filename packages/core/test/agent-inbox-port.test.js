import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createAgentInboxPort } from '../dist/agent-inbox/index.js';
import {
  ingestProductDomainEmail,
  emailReceivedMatchesBind,
  recipientsFromEmailBody
} from '../dist/agent-inbox/inbound.js';

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-inbox-')), 'state.db');
  const store = new SqliteStateStore(path);
  const principal = { userId: 'owner' };
  const port = createAgentInboxPort(store);
  return { path, store, principal, port };
}

test('AgentInboxPort checkAvailability validates format only', () => {
  const f = fixture();
  assert.deepEqual(f.port.checkAvailability('agent'), { available: true });
  assert.deepEqual(f.port.checkAvailability('a1b2'), { available: true });
  assert.deepEqual(f.port.checkAvailability('test-user'), { available: true });
  assert.deepEqual(f.port.checkAvailability('test.user'), { available: true });
  assert.deepEqual(f.port.checkAvailability('test_user'), { available: true });
  assert.equal(f.port.checkAvailability('').available, false);
  assert.equal(f.port.checkAvailability('-invalid').available, false);
  assert.equal(f.port.checkAvailability('UPPERCASE').available, false);
  assert.equal(f.port.checkAvailability('test@example').available, false);
});

test('AgentInboxPort claim requires explicit naming', () => {
  const f = fixture();
  assert.equal(f.port.list(f.principal), undefined);
  const inbox = f.port.claim(f.principal, 'agent1');
  assert.equal(inbox.localPart, 'agent1');
  assert.equal(inbox.address, 'agent1@agent.local');
  assert.ok(inbox.claimedAt);
  const listed = f.port.list(f.principal);
  assert.equal(listed?.localPart, 'agent1');
});

test('AgentInboxPort enforces one inbox per user', () => {
  const f = fixture();
  f.port.claim(f.principal, 'agent1');
  assert.throws(() => f.port.claim(f.principal, 'agent2'), /Already claimed/);
  const listed = f.port.list(f.principal);
  assert.equal(listed?.localPart, 'agent1');
});

test('AgentInboxPort refuses local-part taken by another user', () => {
  const f = fixture();
  const other = { userId: 'other' };
  f.port.claim(f.principal, 'shared');
  assert.equal(f.port.checkAvailability('shared').available, false);
  assert.throws(() => f.port.claim(other, 'shared'), /already claimed/i);
});

test('AgentInboxPort release removes inbox', () => {
  const f = fixture();
  f.port.claim(f.principal, 'agent1');
  assert.ok(f.port.list(f.principal));
  assert.equal(f.port.release(f.principal), true);
  assert.equal(f.port.list(f.principal), undefined);
  assert.equal(f.port.release(f.principal), false);
  assert.equal(f.port.checkAvailability('agent1').available, true);
});

test('AgentInboxPort storeInbound and search/read threads', () => {
  const f = fixture();
  f.port.claim(f.principal, 'agent1');
  f.port.storeInbound('agent1', {
    messageId: 'm1',
    threadId: 't1',
    from: 'sender@example.com',
    to: ['agent1@agent.local'],
    subject: 'Hello',
    receivedAt: new Date().toISOString(),
    body: 'Body 1'
  });
  f.port.storeInbound('agent1', {
    messageId: 'm2',
    threadId: 't1',
    from: 'sender@example.com',
    to: ['agent1@agent.local'],
    subject: 'Re: Hello',
    receivedAt: new Date().toISOString(),
    body: 'Body 2'
  });
  f.port.storeInbound('agent1', {
    messageId: 'm3',
    threadId: 't2',
    from: 'other@example.com',
    to: ['agent1@agent.local'],
    subject: 'Different',
    receivedAt: new Date().toISOString(),
    body: 'Body 3'
  });
  const all = f.port.searchThreads(f.principal);
  assert.equal(all.length, 2);
  const filtered = f.port.searchThreads(f.principal, 'hello');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].threadId, 't1');
  assert.equal(filtered[0].messageCount, 2);
  const thread = f.port.readThread(f.principal, 't1');
  assert.equal(thread.length, 2);
  assert.equal(thread[0].messageId, 'm1');
  assert.equal(thread[1].messageId, 'm2');
});

test('AgentInboxPort dedupes by messageId', () => {
  const f = fixture();
  f.port.claim(f.principal, 'agent1');
  const msg = {
    messageId: 'm1',
    threadId: 't1',
    from: 'sender@example.com',
    to: ['agent1@agent.local'],
    subject: 'Test',
    receivedAt: new Date().toISOString(),
    body: 'Body'
  };
  f.port.storeInbound('agent1', msg);
  f.port.storeInbound('agent1', msg);
  assert.equal(f.port.readThread(f.principal, 't1').length, 1);
});

test('AgentInboxPort matchesClaimedInbox with +tag addressing', () => {
  const f = fixture();
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'anything'), false);
  f.port.claim(f.principal, 'agent1');
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent1'), true);
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent1+tag'), true);
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent1+nested+tag'), true);
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent2'), false);
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent2+tag'), false);
});

test('AgentInboxPort isolates per user', () => {
  const f = fixture();
  const other = { userId: 'other' };
  f.port.claim(f.principal, 'user1');
  f.port.claim(other, 'user2');
  assert.equal(f.port.list(f.principal)?.localPart, 'user1');
  assert.equal(f.port.list(other)?.localPart, 'user2');
});

test('product-domain ingest stores without HMAC and honors +tag', () => {
  const f = fixture();
  f.port.claim(f.principal, 'agent1');
  const result = ingestProductDomainEmail(f.port, {
    to: ['agent1+orders@agent.local'],
    from: 'shop@example.com',
    subject: 'Order',
    body: 'shipped',
    messageId: 'mid-1'
  });
  assert.equal(result.stored, true);
  assert.equal(result.localPart, 'agent1');
  const threads = f.port.searchThreads(f.principal, 'order');
  assert.equal(threads.length, 1);
  assert.equal(f.port.readThread(f.principal, 'mid-1')[0].body, 'shipped');
});

test('email/received bind matches claimed inbox +tag', () => {
  const f = fixture();
  f.port.claim(f.principal, 'agent1');
  assert.equal(
    emailReceivedMatchesBind(f.port, f.principal, 'agent1', ['agent1+tag@agent.local']),
    true
  );
  assert.equal(
    emailReceivedMatchesBind(f.port, f.principal, 'agent1', ['other@agent.local']),
    false
  );
  assert.deepEqual(recipientsFromEmailBody({ to: 'agent1@agent.local' }), ['agent1@agent.local']);
});
