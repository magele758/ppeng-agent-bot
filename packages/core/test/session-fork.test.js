import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError } from '../dist/errors.js';
import { createMemorySurfaceStore } from '../dist/session/surface-store.js';
import { forkSession, assertCanFork } from '../dist/session/session-fork.js';

test('fork 409 when turn is open', () => {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 'src', mode: 'chat', agentId: 'general' });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'hi' }]);
  store.updateSession(session.id, { status: 'running' });
  const reject = assertCanFork({
    session: store.getSession(session.id),
    folded: store.foldMessages(session.id)
  });
  assert.equal(reject, 'turn_open');
  assert.throws(() => forkSession(store, { sourceSessionId: session.id }), (err) => {
    assert.ok(err instanceof ConflictError);
    assert.equal(err.statusCode, 409);
    return true;
  });
});

test('fork copies closed WAL prefix into a new session', () => {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 'src', mode: 'chat', agentId: 'general' });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'keep' }]);
  store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'ok' }]);
  const result = forkSession(store, { sourceSessionId: session.id, title: 'child' });
  assert.notEqual(result.session.id, session.id);
  assert.equal(result.session.parentSessionId, session.id);
  assert.ok(result.copied >= 2);
  const folded = store.foldMessages(result.session.id);
  assert.ok(folded.some((m) => m.parts.some((p) => p.type === 'text' && p.text === 'keep')));
});

for (const backend of ['sqlite', 'memory']) {
  test(`${backend} fork keeps quotes bound to the copied original [AC:bot-reply-quote#AC-1] [AC:bot-reply-quote#AC-5]`, async () => {
    const { SqliteStateStore } = await import('../dist/storage.js');
    const { embedReplyQuotes } = await import('../dist/reply-quote.js');
    const store = backend === 'sqlite' ? new SqliteStateStore(':memory:') : createMemorySurfaceStore();
    try {
      const source = store.createSession({ title: 'quoted source', mode: 'chat', agentId: 'general' });
      const original = store.appendMessage(source.id, 'assistant', [{ type: 'text', text: 'FULL_FORK_QUOTE_BODY_72' }], { key: 'original-reply' });
      store.appendMessage(source.id, 'user', [{ type: 'text', text: 'explain this reply' }], { replyTo: { messageId: original.id, excerpt: 'short quote' } });
      store.appendMessage(source.id, 'assistant', [{ type: 'text', text: 'finished' }]);
      const fork = forkSession(store, { sourceSessionId: source.id });
      const child = store.foldMessages(fork.session.id);
      const copiedOriginal = child.find(message => message.key === 'original-reply');
      const copiedUser = child.find(message => message.role === 'user');
      assert.notEqual(copiedOriginal.id, original.id);
      assert.deepEqual(copiedUser.replyTo, { messageId: copiedOriginal.id, excerpt: 'short quote' });
      store.hideByKey(fork.session.id, 'original-reply');
      const modelView = embedReplyQuotes(store.foldMessages(fork.session.id), id => backend === 'sqlite' ? store.readHistoryById(fork.session.id, id) : child.find(message => message.id === id));
      const prepared = modelView.find(message => message.id === copiedUser.id);
      assert.match(JSON.stringify(prepared.parts), /FULL_FORK_QUOTE_BODY_72/);
      assert.doesNotMatch(JSON.stringify(copiedUser), /FULL_FORK_QUOTE_BODY_72/);
      assert.equal(store.foldMessages(source.id).find(message => message.role === 'user').replyTo.messageId, original.id);
    } finally {
      if (backend === 'sqlite') store.db.close();
    }
  });
}

test('fork refuses protected history when its host cannot persist visibility [AC:bot-functional-groups#AC-9]', async () => {
  const { SqliteStateStore } = await import('../dist/storage.js');
  const store = new SqliteStateStore(':memory:');
  try {
    const parent = store.createSession({ title: 'protected source', mode: 'chat', agentId: 'general' });
    store.appendMessage(parent.id, 'assistant', [{ type: 'text', text: 'protected history' }]);
    store.setDaemonControl('bot.sharedExposure:' + parent.id, { revoked: [{ fromSeq: 1, toSeq: 1, startedAt: 'a', endedAt: 'b' }] });
    const readOnlyPolicy = new Proxy(store, { get(target, key) {
      if (key === 'setDaemonControl') return undefined;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    assert.throws(() => forkSession(readOnlyPolicy, { sourceSessionId: parent.id }), ConflictError);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before);
  } finally { store.db.close(); }
});
