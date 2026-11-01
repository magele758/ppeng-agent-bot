import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createAgentInboxPort } from '../dist/agent-inbox/index.js';

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-inbox-')), 'state.db');
  const store = new SqliteStateStore(path);
  const principal = { userId: 'owner' };
  const port = createAgentInboxPort(store);
  return { path, store, principal, port };
}

test('AgentInboxPort checkAvailability validates format only', () => {
  const f = fixture();
  
  // Valid formats
  assert.deepEqual(f.port.checkAvailability('agent'), { available: true });
  assert.deepEqual(f.port.checkAvailability('a1b2'), { available: true });
  assert.deepEqual(f.port.checkAvailability('test-user'), { available: true });
  assert.deepEqual(f.port.checkAvailability('test.user'), { available: true });
  assert.deepEqual(f.port.checkAvailability('test_user'), { available: true });
  
  // Invalid formats
  assert.equal(f.port.checkAvailability('').available, false);
  assert.equal(f.port.checkAvailability('-invalid').available, false);
  assert.equal(f.port.checkAvailability('UPPERCASE').available, false);
  assert.equal(f.port.checkAvailability('test@example').available, false);
});

test('AgentInboxPort claim requires explicit naming', () => {
  const f = fixture();
  
  // No inbox before claiming
  assert.equal(f.port.list(f.principal), undefined);
  
  // Claim one
  const inbox = f.port.claim(f.principal, 'agent1');
  assert.equal(inbox.localPart, 'agent1');
  assert.equal(inbox.address, 'agent1@agent.local');
  assert.ok(inbox.claimedAt);
  
  // List returns it
  const listed = f.port.list(f.principal);
  assert.equal(listed?.localPart, 'agent1');
});

test('AgentInboxPort enforces one inbox per user', () => {
  const f = fixture();
  
  f.port.claim(f.principal, 'agent1');
  const existing = f.port.list(f.principal);
  assert.ok(existing);
  
  // Claiming again replaces it (updates the same slot)
  const second = f.port.claim(f.principal, 'agent2');
  assert.equal(second.localPart, 'agent2');
  
  // Still only one
  const listed = f.port.list(f.principal);
  assert.equal(listed?.localPart, 'agent2');
});

test('AgentInboxPort release removes inbox', () => {
  const f = fixture();
  
  f.port.claim(f.principal, 'agent1');
  assert.ok(f.port.list(f.principal));
  
  const released = f.port.release(f.principal);
  assert.equal(released, true);
  
  assert.equal(f.port.list(f.principal), undefined);
  
  // Releasing again returns false
  assert.equal(f.port.release(f.principal), false);
});

test('AgentInboxPort storeInbound and search/read threads', () => {
  const f = fixture();
  f.port.claim(f.principal, 'agent1');
  
  // Store some messages
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
  
  // Search without query
  const all = f.port.searchThreads(f.principal);
  assert.equal(all.length, 2);
  
  // Search with query
  const filtered = f.port.searchThreads(f.principal, 'hello');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].threadId, 't1');
  assert.equal(filtered[0].messageCount, 2);
  
  // Read thread
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
  
  const thread = f.port.readThread(f.principal, 't1');
  assert.equal(thread.length, 1);
});

test('AgentInboxPort matchesClaimedInbox with +tag addressing', () => {
  const f = fixture();
  
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'anything'), false);
  
  f.port.claim(f.principal, 'agent1');
  
  // Exact match
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent1'), true);
  
  // With +tag
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent1+tag'), true);
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent1+nested+tag'), true);
  
  // Doesn't match different local-part
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent2'), false);
  assert.equal(f.port.matchesClaimedInbox(f.principal, 'agent2+tag'), false);
});

test('AgentInboxPort isolates per user', () => {
  const f = fixture();
  const other = { userId: 'other' };
  
  f.port.claim(f.principal, 'user1');
  f.port.claim(other, 'user2');
  
  const owned = f.port.list(f.principal);
  const theirs = f.port.list(other);
  
  assert.equal(owned?.localPart, 'user1');
  assert.equal(theirs?.localPart, 'user2');
});
