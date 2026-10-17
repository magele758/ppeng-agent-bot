import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamFileMailbox, withMailboxLock } from '../dist/teams/mailbox.js';
import { acquireFdLock } from '../dist/teams/fd-lock.js';

const fast = { staleMs: 40, waitMs: 40 };

function planDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function inboxOf(plan) {
  return join(plan, 'runtime', 'mailbox');
}

test('a leftover path lock does not block the mailbox and the send lands', async () => {
  const plan = planDir('mbox-legacy-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    writeFileSync(join(inboxOf(plan), '.mailbox.lock'), 'not-a-pid');
    const msg = await box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'kept' });
    assert.equal(msg.content, 'kept');
    assert.equal(readFileSync(join(inboxOf(plan), '.mailbox.lock'), 'utf8'), 'not-a-pid');
    assert.equal(box.peekInbox('b')[0]?.content, 'kept');
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a held mailbox lock times out and does not use Atomics.wait', async () => {
  const plan = planDir('mbox-held-');
  const original = Atomics.wait;
  let calls = 0;
  Atomics.wait = (...args) => {
    calls += 1;
    return original.apply(Atomics, args);
  };
  try {
    const held = await acquireFdLock(join(inboxOf(plan), '.mailbox.lock.db'), { waitMs: 1_000, timeout: 'holder' });
    await assert.rejects(
      () => new TeamFileMailbox(plan, fast).send({ planId: 'p', type: 'task', from: 'a', to: 'c', content: 'blocked' }),
      /Team mailbox lock timed out/
    );
    assert.equal(calls, 0);
    held.release();
  } finally {
    Atomics.wait = original;
    rmSync(plan, { recursive: true, force: true });
  }
});

test('two mailbox callers in one process run one at a time', async () => {
  const plan = planDir('mbox-serial-');
  try {
    const order = [];
    const first = withMailboxLock(inboxOf(plan), async () => {
      order.push('first-enter');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first-leave');
    }, { waitMs: 1_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const second = withMailboxLock(inboxOf(plan), async () => {
      order.push('second-enter');
    }, { waitMs: 1_000 });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-enter', 'first-leave', 'second-enter']);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});


