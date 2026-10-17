import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import {
  orderContextSnapshots,
  preparedContextSnapshotBlocksFor,
  recordPreparedContextSnapshot,
  selectContextSnapshot
} from '../dist/session/context-snapshots.js';
import { flushPreparedContextSnapshots, queuePreparedContextSnapshot } from '../dist/runtime/l5-bindings.js';

function block(id, text) {
  return {
    id,
    kind: 'user',
    label: '',
    tokens: text.length,
    text,
    chars: text.length,
    pinned: false,
    disposition: 'keep'
  };
}

function preparedInput(session, text) {
  return {
    session,
    systemPrompt: 'SYS',
    tools: [],
    messages: [{ id: 'u1', sessionId: session.id, role: 'user', parts: [{ type: 'text', text }], createdAt: new Date().toISOString() }],
    adapter: { name: 'heuristic' },
    env: {}
  };
}

function queuePrepared(store, session, text) {
  const input = preparedInput(session, text);
  queuePreparedContextSnapshot(store, session.id, preparedContextSnapshotBlocksFor(store, input));
  return input;
}

test('orders snapshots by turn and selects one [AC:play-context-replay#AC-1] [AC:play-context-replay#AC-2]', () => {
  const shuffled = [
    { id: 'later', turn: 2, createdAt: '2026-04-02T00:00:00.000Z', text: 'SECOND' },
    { id: 'early-b', turn: 1, createdAt: '2026-04-01T03:00:00.000Z', text: 'FIRST-B' },
    { id: 'early-a', turn: 1, createdAt: '2026-04-01T01:00:00.000Z', text: 'FIRST-A' }
  ];
  const ordered = orderContextSnapshots(shuffled);
  assert.deepEqual(ordered.map((item) => item.id), ['early-a', 'early-b', 'later']);
  assert.equal(selectContextSnapshot(ordered, 0)?.text, 'FIRST-A');
  assert.equal(selectContextSnapshot(ordered, 2)?.text, 'SECOND');
  assert.equal(selectContextSnapshot(ordered, -1), undefined);
  assert.equal(selectContextSnapshot(ordered, 3), undefined);
  assert.equal(selectContextSnapshot(ordered, 1.5), undefined);
});

test('caps stored snapshots per session and prunes oldest, turn_index stays monotonic [retention-cap]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-cap-'));
  try {
    const store = new SqliteStateStore(join(dir, 'state.sqlite'));
    const session = store.createSession({ title: 'cap-test', mode: 'chat', agentId: 'general', summary: '' });

    // Insert 55 rows directly to simulate going past the 50-row cap
    for (let i = 0; i < 55; i++) {
      store.db.prepare(
        `INSERT INTO context_stack_snapshots (id, session_id, turn_index, created_at, blocks_json)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        `snap-${i}`,
        session.id,
        i,
        new Date(2026, 0, 1, 0, 0, i).toISOString(),
        JSON.stringify([block(`b${i}`, `TEXT-${i}`)])
      );
    }

    // Now append one more via the store (turn_index 55, 56 rows before pruning to 50)
    const input = {
      session,
      systemPrompt: 'SYS',
      tools: [],
      messages: [{ id: 'u1', sessionId: session.id, role: 'user', parts: [{ type: 'text', text: 'NEW' }], createdAt: new Date().toISOString() }],
      adapter: { name: 'heuristic' },
      env: {}
    };
    const appended = recordPreparedContextSnapshot(store, input);

    const listed = store.listContextSnapshots(session.id);

    // Must not exceed 50
    assert.equal(listed.length, 50, `expected 50 rows, got ${listed.length}`);

    // Latest row must be the one just appended
    assert.equal(listed[listed.length - 1].id, appended.id);

    // Oldest snap-0 through snap-5 must have been pruned (kept only last 50 of 56 total)
    const ids = listed.map(s => s.id);
    assert.ok(!ids.includes('snap-0'), 'snap-0 should be pruned');
    assert.ok(!ids.includes('snap-5'), 'snap-5 should be pruned');
    assert.deepEqual(ids.slice(0, -1), Array.from({ length: 49 }, (_, i) => `snap-${i + 6}`));
    assert.equal(appended.turn, 55);

    // turn_index must be strictly increasing (monotonic)
    for (let i = 1; i < listed.length; i++) {
      assert.ok(listed[i].turn > listed[i - 1].turn, `turn_index not monotonic at index ${i}`);
    }

    // Dedup: appending identical blocks again must not add a new row
    const before = store.listContextSnapshots(session.id).length;
    const again = recordPreparedContextSnapshot(store, input);
    assert.equal(again.id, appended.id, 'dedup returns the existing snapshot');
    const after = store.listContextSnapshots(session.id).length;
    assert.equal(after, before, 'dedup: identical fingerprint must not insert a new row');

    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recording a prepared view does not compact or rewrite the summary [AC:play-context-replay#AC-1]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-'));
  try {
    const store = new SqliteStateStore(join(dir, 'state.sqlite'));
    const session = store.createSession({
      title: 'replay',
      mode: 'chat',
      agentId: 'general',
      summary: 'keep-me'
    });
    const messages = [{
      id: 'u1',
      sessionId: session.id,
      role: 'user',
      parts: [{ type: 'text', text: 'HELLO-SNAPSHOT' }],
      createdAt: '2026-01-01T00:00:00.000Z'
    }];
    const input = {
      session,
      systemPrompt: 'SYS-PROMPT',
      tools: [{ name: 'bash', description: 'shell', inputSchema: { type: 'object' } }],
      messages,
      adapter: { name: 'heuristic' },
      env: {}
    };
    const first = recordPreparedContextSnapshot(store, input);
    const second = recordPreparedContextSnapshot(store, input);
    assert.equal(second.id, first.id);
    assert.equal(store.getSession(session.id).summary, 'keep-me');
    assert.equal(store.listMessages(session.id).length, 0);

    store.db.prepare(
      `INSERT INTO context_stack_snapshots (id, session_id, turn_index, created_at, blocks_json)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      'snap-early',
      session.id,
      0,
      '2026-01-01T00:00:00.000Z',
      JSON.stringify([block('early', 'EARLIER-TEXT')])
    );
    const listed = store.listContextSnapshots(session.id);
    assert.deepEqual(listed.map((item) => item.id), ['snap-early', first.id]);
    const picked = selectContextSnapshot(listed, 0);
    assert.equal(picked.blocks[0].text, 'EARLIER-TEXT');
    assert.ok(selectContextSnapshot(listed, 1).blocks.some((item) => item.text.includes('HELLO-SNAPSHOT')));
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dedupe uses cached fingerprint, survives a fresh store and returns stored blocks [hot-path]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-dedupe-'));
  try {
    const path = join(dir, 'state.sqlite');
    const store = new SqliteStateStore(path);
    const session = store.createSession({ title: 'dedupe', mode: 'chat', agentId: 'general', summary: '' });
    const input = (text) => ({
      session,
      systemPrompt: 'SYS',
      tools: [],
      messages: [{ id: 'u1', sessionId: session.id, role: 'user', parts: [{ type: 'text', text }], createdAt: new Date().toISOString() }],
      adapter: { name: 'heuristic' },
      env: {}
    });
    const first = recordPreparedContextSnapshot(store, input('A'));
    const again = recordPreparedContextSnapshot(store, input('A'));
    assert.equal(again.id, first.id);
    assert.deepEqual(again.blocks, first.blocks);
    const second = recordPreparedContextSnapshot(store, input('B'));
    assert.notEqual(second.id, first.id);
    assert.equal(second.turn, first.turn + 1);
    store.db.close();
    const reopened = new SqliteStateStore(path);
    const same = recordPreparedContextSnapshot(reopened, input('B'));
    assert.equal(same.id, second.id);
    assert.equal(reopened.listContextSnapshots(session.id).length, 2);
    reopened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queued prepares are written later, in order, and flushed before listing [hot-path]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-queue-'));
  try {
    const store = new SqliteStateStore(join(dir, 'state.sqlite'));
    const session = store.createSession({ title: 'queue', mode: 'chat', agentId: 'general', summary: '' });
    queuePrepared(store, session, 'ONE');
    queuePrepared(store, session, 'TWO');
    assert.equal(store.listContextSnapshots(session.id).length, 0, 'nothing written inline');
    flushPreparedContextSnapshots(store, session.id);
    const flushed = store.listContextSnapshots(session.id);
    assert.equal(flushed.length, 2);
    assert.ok(flushed[0].blocks.some((b) => b.text.includes('ONE')));
    assert.ok(flushed[1].blocks.some((b) => b.text.includes('TWO')));
    queuePrepared(store, session, 'THREE');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.listContextSnapshots(session.id).length, 3);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('destroy flushes a queued snapshot; queueing after close then flush writes nothing [hot-path]', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'context-snapshots-destroy-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'context-snapshots-destroy-state-'));
  try {
    const runtime = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: { name: 'heuristic' } });
    const session = runtime.store.createSession({ title: 'destroy', mode: 'chat', agentId: 'general', summary: '' });
    queuePrepared(runtime.store, session, 'BEFORE-CLOSE');
    assert.equal(runtime.store.listContextSnapshots(session.id).length, 0);
    await runtime.destroy();
    const reopened = new SqliteStateStore(runtime.store.dbPath);
    const listed = reopened.listContextSnapshots(session.id);
    assert.equal(listed.length, 1);
    assert.ok(listed[0].blocks.some((b) => b.text.includes('BEFORE-CLOSE')));
    queuePrepared(reopened, session, 'AFTER-CLOSE');
    reopened.db.close();
    assert.doesNotThrow(() => flushPreparedContextSnapshots(reopened, session.id));
    const again = new SqliteStateStore(runtime.store.dbPath);
    assert.equal(again.listContextSnapshots(session.id).length, 1);
    again.db.close();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a failed write stays queued and the next flush writes it [hot-path]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-retry-'));
  try {
    const store = new SqliteStateStore(join(dir, 'state.sqlite'));
    const session = store.createSession({ title: 'retry', mode: 'chat', agentId: 'general', summary: '' });
    const original = store.appendContextSnapshot.bind(store);
    store.appendContextSnapshot = () => {
      throw new Error('disk full');
    };
    queuePrepared(store, session, 'KEPT');
    flushPreparedContextSnapshots(store, session.id);
    assert.equal(store.listContextSnapshots(session.id).length, 0, 'failed write is not dropped');
    store.appendContextSnapshot = original;
    flushPreparedContextSnapshots(store, session.id);
    const listed = store.listContextSnapshots(session.id);
    assert.equal(listed.length, 1);
    assert.ok(listed[0].blocks.some((b) => b.text.includes('KEPT')));
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flushing session A leaves session B queued, and B drains in the background [hot-path]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-other-session-'));
  try {
    const store = new SqliteStateStore(join(dir, 'state.sqlite'));
    const sessionA = store.createSession({ title: 'a', mode: 'chat', agentId: 'general', summary: '' });
    const sessionB = store.createSession({ title: 'b', mode: 'chat', agentId: 'general', summary: '' });
    queuePrepared(store, sessionA, 'AAA');
    queuePrepared(store, sessionB, 'BBB');
    flushPreparedContextSnapshots(store, sessionA.id);
    assert.equal(store.listContextSnapshots(sessionA.id).length, 1);
    assert.equal(store.listContextSnapshots(sessionB.id).length, 0, 'B stays queued after A is flushed');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.listContextSnapshots(sessionB.id).length, 1);
    assert.ok(store.listContextSnapshots(sessionB.id)[0].blocks.some((b) => b.text.includes('BBB')));
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing session does not block another session in flush or background drain [hot-path]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-isolate-'));
  try {
    const store = new SqliteStateStore(join(dir, 'state.sqlite'));
    const sessionA = store.createSession({ title: 'a', mode: 'chat', agentId: 'general', summary: '' });
    const sessionB = store.createSession({ title: 'b', mode: 'chat', agentId: 'general', summary: '' });
    const original = store.appendContextSnapshot.bind(store);
    store.appendContextSnapshot = (sessionId, blocks) => {
      if (sessionId === sessionA.id) throw new Error('disk full');
      return original(sessionId, blocks);
    };
    queuePrepared(store, sessionA, 'A1');
    queuePrepared(store, sessionA, 'A2');
    queuePrepared(store, sessionB, 'BBB');
    flushPreparedContextSnapshots(store);
    assert.equal(store.listContextSnapshots(sessionA.id).length, 0, 'failed A is not dropped');
    assert.equal(store.listContextSnapshots(sessionB.id).length, 1, 'B is written despite A failing');

    queuePrepared(store, sessionA, 'A3');
    queuePrepared(store, sessionB, 'BBB-2');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.listContextSnapshots(sessionA.id).length, 0);
    assert.equal(store.listContextSnapshots(sessionB.id).length, 2, 'background drain still writes B');

    store.appendContextSnapshot = original;
    flushPreparedContextSnapshots(store, sessionA.id);
    const listed = store.listContextSnapshots(sessionA.id);
    assert.equal(listed.length, 3);
    assert.ok(listed[0].blocks.some((b) => b.text.includes('A1')));
    assert.ok(listed[1].blocks.some((b) => b.text.includes('A2')));
    assert.ok(listed[2].blocks.some((b) => b.text.includes('A3')));
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing session is retried in the background once writes succeed [hot-path]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-retry-timer-'));
  try {
    const store = new SqliteStateStore(join(dir, 'state.sqlite'));
    const session = store.createSession({ title: 'retry-timer', mode: 'chat', agentId: 'general', summary: '' });
    const original = store.appendContextSnapshot.bind(store);
    store.appendContextSnapshot = () => {
      throw new Error('disk full');
    };
    queuePrepared(store, session, 'LATER');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.listContextSnapshots(session.id).length, 0, 'first drain keeps the failed item');
    store.appendContextSnapshot = original;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const listed = store.listContextSnapshots(session.id);
    assert.equal(listed.length, 1);
    assert.ok(listed[0].blocks.some((b) => b.text.includes('LATER')));
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('destroy writes other sessions when the head item fails [hot-path]', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'context-snapshots-destroy-fail-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'context-snapshots-destroy-fail-state-'));
  try {
    const runtime = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: { name: 'heuristic' } });
    const sessionA = runtime.store.createSession({ title: 'a', mode: 'chat', agentId: 'general', summary: '' });
    const sessionB = runtime.store.createSession({ title: 'b', mode: 'chat', agentId: 'general', summary: '' });
    const original = runtime.store.appendContextSnapshot.bind(runtime.store);
    runtime.store.appendContextSnapshot = (sessionId, blocks) => {
      if (sessionId === sessionA.id) throw new Error('disk full');
      return original(sessionId, blocks);
    };
    queuePrepared(runtime.store, sessionA, 'A-FAIL');
    queuePrepared(runtime.store, sessionB, 'B-OK');
    await runtime.destroy();
    const reopened = new SqliteStateStore(runtime.store.dbPath);
    assert.equal(reopened.listContextSnapshots(sessionA.id).length, 0, 'failed A is not counted as written');
    const listed = reopened.listContextSnapshots(sessionB.id);
    assert.equal(listed.length, 1);
    assert.ok(listed[0].blocks.some((b) => b.text.includes('B-OK')));
    reopened.db.close();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('queued blocks are captured before later edits to the input parts [hot-path]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-snapshots-capture-'));
  try {
    const store = new SqliteStateStore(join(dir, 'state.sqlite'));
    const session = store.createSession({ title: 'capture', mode: 'chat', agentId: 'general', summary: '' });
    const input = queuePrepared(store, session, 'SENT');
    input.messages[0].parts[0].text = 'MUTATED';
    flushPreparedContextSnapshots(store, session.id);
    const listed = store.listContextSnapshots(session.id);
    assert.equal(listed.length, 1);
    assert.ok(listed[0].blocks.some((b) => b.text.includes('SENT')));
    assert.equal(listed[0].blocks.some((b) => b.text.includes('MUTATED')), false);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

