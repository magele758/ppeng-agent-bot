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
