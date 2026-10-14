import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { AuthorizationError } from '../dist/errors.js';
import { createBot, openBot, setBotDefinitionOwner } from '../dist/bots/index.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'unowned-bot-'));
  return new SqliteStateStore(join(dir, 'state.db'));
}

function host(store) {
  return {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions: () => {},
    wakeAgentSessions: () => {}
  };
}

function definitionOwner(store, botId) {
  return store.db.prepare('SELECT principal FROM bot_definition_owners WHERE bot_id=?').get(botId);
}

/** Legacy canonical: no login owner, and no explicit claim row. */
function makeOwnerless(store, bot, userId) {
  const prior = store.getSession(bot.canonicalSessionId);
  const metadata = { ...prior.metadata, allowedTools: ['bash'] };
  if (userId === undefined) delete metadata.userId;
  else metadata.userId = userId;
  delete metadata.tenantId;
  store.updateSession(bot.canonicalSessionId, { metadata });
  store.db.prepare('DELETE FROM bot_definition_owners WHERE bot_id=?').run(bot.id);
  store.appendMessage(bot.canonicalSessionId, 'user', [{ type: 'text', text: 'legacy private' }]);
}

function assertStillOwnerless(store, bot, userId) {
  const session = store.getSession(bot.canonicalSessionId);
  if (userId === undefined) assert.equal(session.metadata.userId, undefined);
  else assert.equal(session.metadata.userId, userId);
  assert.equal(session.metadata.tenantId, undefined);
  assert.deepEqual(session.metadata.allowedTools, ['bash']);
  assert.equal(definitionOwner(store, bot.id), undefined);
  assert.equal(store.getBot(bot.id).canonicalSessionId, bot.canonicalSessionId);
  const history = store.listMessages(bot.canonicalSessionId);
  assert.equal(history.length, 1);
  assert.match(JSON.stringify(history[0]), /legacy private/);
  assert.equal(
    store.listSessions().some((item) => item.metadata?.userId === 'other-user' && item.metadata?.botId === bot.id),
    false
  );
}

test('opening an ownerless legacy bot does not assign it to the installer [AC:unowned-legacy-bot#AC-1]', () => {
  const store = tempStore();
  const h = host(store);
  for (const blank of [undefined, '   ']) {
    const bot = createBot(h, { name: blank === undefined ? 'Legacy' : 'Blank owner' });
    makeOwnerless(store, bot, blank);
    const first = openBot(h, bot.id);
    assert.equal(first.createdSession, false);
    assert.equal(first.sessionId, bot.canonicalSessionId);
    const again = openBot(h, bot.id);
    assert.equal(again.createdSession, false);
    assert.equal(again.sessionId, bot.canonicalSessionId);
    assertStillOwnerless(store, bot, blank);
    const installer = store.getDaemonControl('bot.installationPrincipal');
    assert.notEqual(store.getSession(bot.canonicalSessionId).metadata.userId, installer);
    const before = store.listSessions().map((item) => item.id).sort();
    assert.throws(
      () => openBot(h, bot.id, { userId: 'other-user', tenantId: 'tenant' }),
      AuthorizationError
    );
    assert.deepEqual(store.listSessions().map((item) => item.id).sort(), before);
    assertStillOwnerless(store, bot, blank);
  }
  store.db.close();
});

test('another login cannot spawn a personal chat from an ownerless allowlist [AC:unowned-legacy-bot#AC-2]', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: 'Unclaimed' });
  makeOwnerless(store, bot, undefined);
  const before = store.listSessions().map((item) => item.id).sort();
  assert.throws(
    () => openBot(h, bot.id, { userId: 'other-user', tenantId: 'tenant' }),
    AuthorizationError
  );
  assert.deepEqual(store.listSessions().map((item) => item.id).sort(), before);
  assertStillOwnerless(store, bot, undefined);
  store.db.close();
});

test('an installation-owned bot still opens a personal chat with the same allowlist [AC:unowned-legacy-bot#AC-3]', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: 'Shared' });
  const prior = store.getSession(bot.canonicalSessionId);
  store.updateSession(bot.canonicalSessionId, {
    metadata: { ...prior.metadata, allowedTools: ['bash'] }
  });
  const installer = prior.metadata.userId;
  assert.match(installer, /^installation:/);
  const opened = openBot(h, bot.id, { userId: 'user_a', tenantId: 'tenant' });
  assert.equal(opened.createdSession, true);
  assert.notEqual(opened.sessionId, bot.canonicalSessionId);
  const mine = store.getSession(opened.sessionId);
  assert.equal(mine.metadata.userId, 'user_a');
  assert.deepEqual(mine.metadata.allowedTools, ['bash']);
  assert.equal(store.getSession(bot.canonicalSessionId).metadata.userId, installer);
  const again = openBot(h, bot.id, { userId: 'user_a', tenantId: 'tenant' });
  assert.equal(again.createdSession, false);
  assert.equal(again.sessionId, opened.sessionId);
  store.db.close();
});

test('a user-owned bot stays with that user [AC:unowned-legacy-bot#AC-4]', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: 'Alice' });
  const prior = store.getSession(bot.canonicalSessionId);
  store.updateSession(bot.canonicalSessionId, {
    metadata: { ...prior.metadata, userId: 'alice', tenantId: 'tenant', allowedTools: ['bash'] }
  });
  setBotDefinitionOwner(store, bot.id, { userId: 'alice', tenantId: 'tenant' });
  const mine = openBot(h, bot.id, { userId: 'alice', tenantId: 'tenant' });
  assert.equal(mine.createdSession, false);
  assert.equal(mine.sessionId, bot.canonicalSessionId);
  const before = store.listSessions().length;
  assert.throws(
    () => openBot(h, bot.id, { userId: 'bob', tenantId: 'tenant' }),
    AuthorizationError
  );
  assert.equal(store.listSessions().length, before);
  assert.equal(store.getSession(bot.canonicalSessionId).metadata.userId, 'alice');
  assert.deepEqual(store.getSession(bot.canonicalSessionId).metadata.allowedTools, ['bash']);
  store.db.close();
});
