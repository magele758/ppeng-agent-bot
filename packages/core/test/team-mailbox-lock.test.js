import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamFileMailbox } from '../dist/teams/mailbox.js';

const fast = { staleMs: 40, waitMs: 30 };

function planDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function lockOf(plan) {
  return join(plan, 'runtime', 'mailbox', '.mailbox.lock');
}

function ageLock(lock, msAgo) {
  const old = new Date(Date.now() - msAgo);
  utimesSync(lock, old, old);
}

test('a stale mtime mailbox lock is reclaimed and the send lands', async () => {
  const plan = planDir('mbox-stale-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    writeFileSync(lock, 'not-a-pid');
    ageLock(lock, 60_000);
    const msg = await box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'kept' });
    assert.equal(msg.content, 'kept');
    assert.equal(existsSync(lock), false);
    assert.equal(box.peekInbox('b')[0]?.content, 'kept');
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a dead-pid mailbox lock is reclaimed', async () => {
  const plan = planDir('mbox-dead-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    writeFileSync(lock, '999999:crashed');
    const msg = await box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'after-crash' });
    assert.equal(msg.content, 'after-crash');
    assert.equal(existsSync(lock), false);
    assert.match(readFileSync(join(plan, 'runtime', 'mailbox', 'b.jsonl'), 'utf8'), /after-crash/);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a fresh live mailbox lock is not stolen and the wait throws', async () => {
  const plan = planDir('mbox-live-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, `${process.pid}:live`);
    await assert.rejects(
      () => box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'dropped' }),
      /Team mailbox lock timed out/
    );
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid}:live`);
    assert.equal(existsSync(join(plan, 'runtime', 'mailbox', 'b.jsonl')), false);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a crash leftover mailbox lock does not drop the next send', async () => {
  const plan = planDir('mbox-leftover-');
  try {
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, '');
    ageLock(lock, 60_000);
    const box = new TeamFileMailbox(plan, fast);
    await box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'recovered' });
    assert.equal(box.peekInbox('b').length, 1);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('an old lock owned by a live pid is not reclaimed', async () => {
  const plan = planDir('mbox-live-old-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, `${process.pid}:still-alive`);
    ageLock(lock, 60_000);
    await assert.rejects(
      () => box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'dropped' }),
      /Team mailbox lock timed out/
    );
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid}:still-alive`);
    assert.equal(existsSync(join(plan, 'runtime', 'mailbox', 'b.jsonl')), false);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('mailbox lock wait does not call Atomics.wait', async () => {
  const plan = planDir('mbox-atomics-');
  const original = Atomics.wait;
  let calls = 0;
  Atomics.wait = (...args) => {
    calls += 1;
    return original.apply(Atomics, args);
  };
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, `${process.pid}:live`);
    await assert.rejects(() => box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'no' }));
    assert.equal(calls, 0);
  } finally {
    Atomics.wait = original;
    rmSync(plan, { recursive: true, force: true });
  }
});
