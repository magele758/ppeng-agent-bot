import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';

const fresh = () => new SqliteStateStore(join(mkdtempSync(join(tmpdir(), 'feed-page-')), 'db'));

test('visible transcript cursor returns the newest page, then the page before it, with no overlap or gap [AC:play-feed-window#AC-1] [AC:play-feed-window#AC-2]', () => {
  const store = fresh();
  try {
    const session = store.createSession({ title: 'long', mode: 'chat', agentId: 'general' });
    const rows = [];
    for (let n = 0; n < 75; n += 1) {
      rows.push(store.appendMessage(session.id, n % 2 ? 'assistant' : 'user', [{ type: 'text', text: `m${n}` }]));
    }
    store.db.prepare(`UPDATE session_messages SET surface_op='replace' WHERE id=?`).run(rows.at(-1).id);
    const all = store.listMessages(session.id);
    assert.equal(all.length, 75);
    assert.equal(all.at(-1).id, rows.at(-1).id);

    const limit = 30;
    const first = store.listVisibleMessagesPage(session.id, { limit });
    assert.equal(first.hasMore, true);
    assert.equal(first.messages.length, limit);
    assert.deepEqual(first.messages.map((message) => message.id), all.slice(-limit).map((message) => message.id));
    assert.equal(first.nextCursor, first.messages[0].seq);
    assert.notEqual(first.messages.length, all.length);

    const second = store.listVisibleMessagesPage(session.id, { limit, beforeSeq: first.nextCursor });
    assert.deepEqual(
      second.messages.map((message) => message.id),
      all.slice(-2 * limit, -limit).map((message) => message.id)
    );
    const firstIds = new Set(first.messages.map((message) => message.id));
    assert.equal(second.messages.some((message) => firstIds.has(message.id)), false);
    const allIds = all.map((message) => message.id);
    const joinAt = allIds.indexOf(second.messages.at(-1).id);
    assert.equal(allIds[joinAt + 1], first.messages[0].id);

    const seen = [];
    let cursor = undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = store.listVisibleMessagesPage(session.id, cursor == null ? { limit } : { limit, beforeSeq: cursor });
      seen.unshift(...page.messages);
      if (!page.hasMore) break;
      assert.ok(page.nextCursor);
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen.map((message) => message.id), allIds);
    assert.throws(() => store.listVisibleMessagesPage(session.id, { beforeSeq: 0 }), /Invalid history cursor/);
  } finally {
    store.db.close();
  }
});
