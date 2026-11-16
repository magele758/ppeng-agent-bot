import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';

function fixture(t) {
  const store = new SqliteStateStore(':memory:');
  t.after(() => store.db.close());
  const add = (title) => store.createSession({ title, mode: 'chat', agentId: 'general' }).id;
  return { store, side: store.sidechats, a: add('模型推理入门'), b: add('部署排查') };
}

function input(sessionId, requestId = 'r1') {
  return {
    sessionId,
    messageId: 'msg1',
    agentId: 'general',
    question: '为什么？',
    requestId,
    anchor: { kind: 'range', quote: 'KV cache', start: 6, end: 14, prefix: '保留', suffix: '。' }
  };
}

test('跨会话找相同摘录、短词及后续回答，撤权和删除时隐藏所有命中 [AC:sidechat#AC-3]', (t) => {
  const { store, side, a, b } = fixture(t);
  const first = side.start('alice', input(a)),
    second = side.start('alice', input(b));
  side.finish(first.thread.id, first.runId, 'complete', '第一次解释。');
  const next = side.start('alice', {
    ...input(a, 'r2'),
    threadId: first.thread.id,
    question: '再举个例子？'
  });
  side.finish(first.thread.id, next.runId, 'complete', '键和值可以复用，缓存是关键。');
  const hidden = side.start('bob', input(a));
  side.finish(hidden.thread.id, hidden.runId, 'complete', '缓存也能搜。');
  const related = side.search('alice', [a, b], { exactQuote: 'kv cache', excludeSessionId: b });
  assert.deepEqual(
    related.map((h) => h.thread.id),
    [first.thread.id]
  );
  assert.equal(related[0].sessionTitle, '模型推理入门');
  for (const query of ['键和值', '缓存', '键']) {
    const [hit, ...others] = side.search('alice', [a, b], { query });
    assert.equal(others.length, 0);
    assert.equal(hit.matches[0].messageId, side.get('alice', [a], first.thread.id).messages.at(-1).id);
    assert.ok(hit.matches[0].snippet.includes(query));
    assert.deepEqual(side.search('alice', [b], { query }), []);
  }
  assert.equal(side.get('alice', [b], first.thread.id), undefined);
  assert.equal(side.get('bob', [a], first.thread.id), undefined);
  assert.equal(store.deleteSession(a), true);
  assert.equal(side.get('alice', [a], first.thread.id), undefined);
  assert.deepEqual(side.search('alice', [a, b], { query: '缓存' }), []);
  assert.deepEqual(
    side.search('alice', [a, b], { query: 'KV cache' }).map((h) => h.thread.id),
    [second.thread.id]
  );
});

test('重复创建、重试和延迟到达的旧回复不能覆盖当前生成 [AC:sidechat#AC-6]', (t) => {
  const { side, a } = fixture(t);
  const first = side.start('alice', input(a));
  const duplicate = side.start('alice', input(a));
  assert.equal(duplicate.runId, null);
  assert.equal(duplicate.thread.id, first.thread.id);
  side.progress(first.thread.id, first.runId, '部分');
  side.finish(first.thread.id, first.runId, 'failed', '部分', 'interrupted');
  const retry = { ...input(a), threadId: first.thread.id, retry: true, attemptId: 'retry1' };
  const restarted = side.start('alice', retry);
  assert.ok(restarted.runId);
  assert.equal(side.start('alice', retry).runId, null);
  assert.equal(side.finish(first.thread.id, first.runId, 'complete', '过期回复'), false);
  side.finish(first.thread.id, restarted.runId, 'stopped', '新片段');
  assert.equal(side.start('alice', retry).runId, null);
  const last = side.start('alice', { ...retry, attemptId: 'retry2' });
  assert.equal(side.finish(first.thread.id, last.runId, 'complete', '完整回复'), true);
  const detail = side.get('alice', [a], first.thread.id);
  assert.deepEqual(
    detail.messages.map((m) => m.text),
    ['为什么？', '完整回复']
  );
  assert.equal(detail.status, 'complete');
  assert.equal(side.list('alice', a).length, 1);
});

test('重启只恢复无人执行的生成，保留部分答案，其他实例可继续生成 [AC:sidechat#AC-6]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sidechat-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runtime.sqlite');
  const writer = new SqliteStateStore(path);
  const peer = new SqliteStateStore(path);
  t.after(() => {
    if (writer.db.isOpen) writer.db.close();
    peer.db.close();
  });
  const source = writer.createSession({ title: '来源', agentId: 'general', mode: 'chat' });
  const active = writer.sidechats.start('reader', input(source.id));
  writer.sidechats.progress(active.thread.id, active.runId, '回复的开头');
  const peerTurn = peer.sidechats.start('reader', input(source.id, 'r2'));
  peer.sidechats.recoverInterrupted();
  const reading = (id) => peer.sidechats.get('reader', [source.id], id);
  assert.equal(reading(active.thread.id).messages.at(-1).generationId, active.runId);
  writer.db.close();
  peer.sidechats.recoverInterrupted();
  assert.equal(reading(active.thread.id).status, 'failed');
  assert.equal(reading(active.thread.id).messages.at(-1).text, '回复的开头');
  assert.equal(reading(active.thread.id).messages.at(-1).generationId, undefined);
  assert.equal(reading(peerTurn.thread.id).status, 'generating');
  assert.equal(peer.sidechats.finish(peerTurn.thread.id, peerTurn.runId, 'complete', '独立回复'), true);
});

test('检索支持短词、字面符号、重建、整句优先排序和分组分页 [AC:sidechat#AC-3]', (t) => {
  const { store, side, a, b } = fixture(t);
  const first = side.start('reader', input(a));
  side.finish(first.thread.id, first.runId, 'complete', '命中 KV cache 和 KV cache，还有 a_"%b。');
  const other = side.start('reader', {
    ...input(b),
    botId: 'student',
    question: '也用 KV cache？',
    anchor: { kind: 'message', quote: '其他概念' }
  });
  side.finish(other.thread.id, other.runId, 'complete', '两个连续字缓存。');
  const search = (opts) => side.search('reader', [a, b], opts);
  const ranked = search({ query: 'KV cache' });
  assert.deepEqual(
    ranked.map((h) => h.thread.id),
    [first.thread.id, other.thread.id]
  );
  assert.deepEqual(
    ranked[0].matches.map((m) => m.field),
    ['quote', 'assistant']
  );
  assert.equal(search({ query: 'KV cache', offset: 1, limit: 1 })[0].thread.id, other.thread.id);
  assert.equal(search({ query: 'a_"%', limit: 1 })[0].thread.id, first.thread.id);
  assert.deepEqual(
    search({ botId: 'student' }).map((h) => h.thread.id),
    [other.thread.id]
  );
  assert.deepEqual(search({ to: '1900-01-01' }), []);
  assert.deepEqual(search({ from: '2900-01-01' }), []);
  assert.deepEqual(side.search('reader', [], {}), []);
  const indexed = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sidechat_fts'").get();
  if (indexed) {
    store.db.exec("INSERT INTO sidechat_fts(sidechat_fts) VALUES ('rebuild')");
    store.db.exec("INSERT INTO sidechat_fts(sidechat_fts,rank) VALUES ('integrity-check',1)");
    assert.deepEqual(search({ query: 'KV cache' }), ranked);
  }
});

test('详情读取期间另一连接完成回复，状态与消息仍来自同一快照 [AC:sidechat#AC-6]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sidechat-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'runtime.sqlite');
  const writer = new SqliteStateStore(dbPath);
  const reader = new SqliteStateStore(dbPath);
  t.after(() => {
    reader.db.close();
    writer.db.close();
  });
  const source = writer.createSession({ title: '来源', agentId: 'general', mode: 'chat' });
  const active = writer.sidechats.start('reader', input(source.id));
  // Force one genuine commit on another connection immediately after the first SELECT.
  // No timing assumptions about thread scheduling or the speed of either reader.
  const prepare = reader.db.prepare.bind(reader.db);
  reader.db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!/^\s*select\b/i.test(sql)) return stmt;
    reader.db.prepare = prepare;
    for (const method of ['get', 'all']) {
      const read = stmt[method].bind(stmt);
      stmt[method] = (...args) => {
        const result = read(...args);
        assert.equal(writer.sidechats.finish(active.thread.id, active.runId, 'complete', '已完成'), true);
        return result;
      };
    }
    return stmt;
  };
  const read = () => reader.sidechats.get('reader', [source.id], active.thread.id);
  const beforeCommit = read();
  assert.equal(beforeCommit.status, beforeCommit.messages.at(-1).status);
  const afterCommit = read();
  assert.equal(afterCommit.status, 'complete');
  assert.equal(afterCommit.messages.at(-1).text, '已完成');
});
