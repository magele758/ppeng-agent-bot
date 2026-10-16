import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import {
  orderContextSnapshots,
  recordPreparedContextSnapshot,
  selectContextSnapshot
} from '../dist/session/context-snapshots.js';

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
