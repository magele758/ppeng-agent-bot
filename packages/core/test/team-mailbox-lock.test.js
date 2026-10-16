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

test('a stale mtime mailbox lock is reclaimed and the send lands', () => {
  const plan = planDir('mbox-stale-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    writeFileSync(lock, `${process.pid}:held`);
    ageLock(lock, 60_000);
    const msg = box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'kept' });
    assert.equal(msg.content, 'kept');
    assert.equal(existsSync(lock), false);
    assert.equal(box.peekInbox('b')[0]?.content, 'kept');
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a dead-pid mailbox lock is reclaimed', () => {
  const plan = planDir('mbox-dead-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    writeFileSync(lock, '999999:crashed');
    const msg = box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'after-crash' });
    assert.equal(msg.content, 'after-crash');
    assert.equal(existsSync(lock), false);
    assert.match(readFileSync(join(plan, 'runtime', 'mailbox', 'b.jsonl'), 'utf8'), /after-crash/);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a fresh live mailbox lock is not stolen and the wait throws', () => {
  const plan = planDir('mbox-live-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, `${process.pid}:live`);
    assert.throws(
      () => box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'dropped' }),
      /Team mailbox lock timed out/
    );
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid}:live`);
    assert.equal(existsSync(join(plan, 'runtime', 'mailbox', 'b.jsonl')), false);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a crash leftover mailbox lock does not drop the next send', () => {
  const plan = planDir('mbox-leftover-');
  try {
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, '');
    ageLock(lock, 60_000);
    const box = new TeamFileMailbox(plan, fast);
    box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'recovered' });
    assert.equal(box.peekInbox('b').length, 1);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});
