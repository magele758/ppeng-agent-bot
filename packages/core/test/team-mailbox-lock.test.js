import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamFileMailbox, withMailboxLock } from '../dist/teams/mailbox.js';
import { setLockRenameForTests } from '../dist/teams/lock-liveness.js';

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

/** v2 body: our pid, a start time this process does not have, and a token we never issued. */
function reusedOwnPid(tag) {
  return `${process.pid}:1:deadbeef${tag}:nonce${tag}`;
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

test('a fresh old-format mailbox lock with a live pid is not reclaimed', async () => {
  const plan = planDir('mbox-v1-fresh-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, `${process.pid}:${Date.now()}`);
    await assert.rejects(
      () => box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'dropped' }),
      /Team mailbox lock timed out/
    );
    assert.equal(existsSync(join(plan, 'runtime', 'mailbox', 'b.jsonl')), false);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('an old-format mailbox lock with a live pid is reclaimed once its mtime is stale', async () => {
  const plan = planDir('mbox-v1-stale-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, `${process.pid}:${Date.now()}`);
    ageLock(lock, 60_000);
    const msg = await box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'after-v1' });
    assert.equal(msg.content, 'after-v1');
    assert.equal(box.peekInbox('b')[0]?.content, 'after-v1');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('our pid with a foreign token and an old mtime is a reused pid and is reclaimed', async () => {
  const plan = planDir('mbox-reuse-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, reusedOwnPid('mbox'));
    ageLock(lock, 60_000);
    const started = Date.now();
    const msg = await box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'reused' });
    assert.ok(Date.now() - started < 500);
    assert.equal(msg.content, 'reused');
    assert.equal(box.peekInbox('b')[0]?.content, 'reused');
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a mailbox lock this process holds is not reclaimed when its mtime is aged', async () => {
  const plan = planDir('mbox-held-');
  try {
    const inbox = join(plan, 'runtime', 'mailbox');
    const lock = lockOf(plan);
    let releaseHold;
    const hold = new Promise((resolve) => {
      releaseHold = resolve;
    });
    const held = withMailboxLock(inbox, async () => {
      ageLock(lock, 60_000);
      await hold;
    }, { staleMs: 40, waitMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const send = new TeamFileMailbox(plan, fast).send({ planId: 'p', type: 'task', from: 'a', to: 'c', content: 'blocked' }).then(
      () => 'stole',
      () => 'waited'
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    releaseHold();
    await held;
    assert.equal(await send, 'waited');
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('release removes only the body this process wrote', async () => {
  const plan = planDir('mbox-release-');
  try {
    const inbox = join(plan, 'runtime', 'mailbox');
    const lock = lockOf(plan);
    const replaced = `${process.pid}:1:foreign:notours`;
    let releaseHold;
    const hold = new Promise((resolve) => {
      releaseHold = resolve;
    });
    const held = withMailboxLock(inbox, async () => {
      writeFileSync(lock, replaced);
      await hold;
    }, { staleMs: 40, waitMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseHold();
    await held;
    assert.equal(readFileSync(lock, 'utf8'), replaced);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('reclaim leaves a live replacement and does not leak a parked lock', async () => {
  const plan = planDir('mbox-replaced-');
  try {
    const box = new TeamFileMailbox(plan, fast);
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, '999999:crashed');
    const msg = await box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'kept' });
    assert.equal(msg.content, 'kept');
    assert.equal(existsSync(lock), false);
    const parked = readdirSync(join(plan, 'runtime', 'mailbox')).filter((name) => name.includes('.reclaim'));
    assert.deepEqual(parked, []);
  } finally {
    rmSync(plan, { recursive: true, force: true });
  }
});

test('a mailbox rename that keeps failing throws the lock timeout', async () => {
  const plan = planDir('mbox-rename-');
  try {
    const box = new TeamFileMailbox(plan, { staleMs: 40, waitMs: 80 });
    const lock = lockOf(plan);
    mkdirSync(join(plan, 'runtime', 'mailbox'), { recursive: true });
    writeFileSync(lock, '999999:crashed');
    ageLock(lock, 60_000);
    setLockRenameForTests(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    const started = Date.now();
    await assert.rejects(
      () => box.send({ planId: 'p', type: 'task', from: 'a', to: 'b', content: 'no' }),
      /Team mailbox lock timed out/
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(readFileSync(lock, 'utf8'), '999999:crashed');
    assert.equal(existsSync(join(plan, 'runtime', 'mailbox', 'b.jsonl')), false);
  } finally {
    setLockRenameForTests(undefined);
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
