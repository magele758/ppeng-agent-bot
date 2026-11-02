import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createAgentInboxPort } from '../dist/agent-inbox/index.js';
import {
  ingestProductDomainEmail,
  productEmailFieldsFromBody
} from '../dist/agent-inbox/inbound.js';
import { createAgentInboxTools } from '../dist/agent-inbox/tools.js';

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-inbox-r526-')), 'state.db');
  const store = new SqliteStateStore(path);
  const principal = { userId: 'owner' };
  const port = createAgentInboxPort(store);
  return { path, store, principal, port, cleanup: () => { try { rmSync(path, { force: true }); } catch {} } };
}

test('productEmailFieldsFromBody extracts inReplyTo/references [AC:r5-26-inbound-refs#AC-4]', () => {
  const fields = productEmailFieldsFromBody(
    {
      from: 'a@x',
      subject: 'S',
      text: 'body',
      messageId: '<m2@x>',
      in_reply_to: '<m1@x>',
      references: '<root@x> <m1@x>'
    },
    'delivery-1'
  );
  assert.ok(fields);
  assert.equal(fields.inReplyTo, '<m1@x>');
  assert.equal(fields.references, '<root@x> <m1@x>');
});

test('storeInbound/readThread round-trip inReplyTo/references [AC:r5-26-inbound-refs#AC-4]', () => {
  const f = fixture();
  try {
    f.port.claim(f.principal, 'agent1');
    const result = ingestProductDomainEmail(f.port, {
      to: ['agent1@agent.local'],
      from: 'shop@example.com',
      subject: 'Order',
      body: 'shipped',
      messageId: 'mid-2',
      threadId: 'mid-1',
      inReplyTo: '<mid-1@x>',
      references: '<root@x> <mid-1@x>'
    });
    assert.equal(result.stored, true);
    const msgs = f.port.readThread(f.principal, 'mid-1');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].inReplyTo, '<mid-1@x>');
    assert.equal(msgs[0].references, '<root@x> <mid-1@x>');
    assert.equal(msgs[0].body, 'shipped');
  } finally {
    f.cleanup();
  }
});

test('read_email_thread JSON includes inReplyTo/references with fenced body [AC:r5-26-inbound-refs#AC-4]', async () => {
  const f = fixture();
  try {
    f.port.claim(f.principal, 'agent1');
    ingestProductDomainEmail(f.port, {
      to: ['agent1@agent.local'],
      from: 'a@x',
      subject: 'S',
      body: 'secret body',
      messageId: 'mid-9',
      threadId: 't-9',
      inReplyTo: '<prev@x>',
      references: '<root@x> <prev@x>'
    });

    const tools = createAgentInboxTools(f.store, f.port);
    const read = tools.find((t) => t.name === 'read_email_thread');
    assert.ok(read);
    // principalFromSession only needs session.metadata.userId
    const result = await read.execute(
      { session: { id: 's1', metadata: { userId: 'owner' } } },
      { thread_id: 't-9' }
    );
    assert.equal(result.ok, true, result.content);
    const body = JSON.parse(result.content);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].inReplyTo, '<prev@x>');
    assert.equal(body.messages[0].references, '<root@x> <prev@x>');
    assert.match(String(body.messages[0].body), /untrusted|secret body/i);
  } finally {
    f.cleanup();
  }
});
