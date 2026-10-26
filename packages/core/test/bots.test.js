import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { ConflictError, ValidationError } from '../dist/errors.js';
import {
  BOT_ROSTER_CAP,
  canonicalBotChatTitle,
  createBot,
  faceUpdatePatch,
  getBot,
  listBots,
  normalizeBotFaceStyle,
  openBot,
  readFaceInput,
  slugifyBotName,
  updateBot
} from '../dist/bots/index.js';
import { getCurrentSchemaVersion, LATEST_SCHEMA_VERSION } from '../dist/stores/migrations/index.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'bots-'));
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

test('slugifyBotName: ascii names become stable ids', () => {
  assert.equal(slugifyBotName('Researcher'), 'researcher');
  assert.equal(slugifyBotName('Office Manager'), 'office-manager');
  assert.equal(slugifyBotName('调研助手'), '');
});

test('schema v15 creates bots table', () => {
  const store = tempStore();
  assert.equal(getCurrentSchemaVersion(store.db), LATEST_SCHEMA_VERSION);
  assert.ok(LATEST_SCHEMA_VERSION >= 15);
  const row = store.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='bots'`)
    .get();
  assert.ok(row);
  store.db.close();
});

test('createBot: agent 1:1 + canonical session [AC:bots#AC-1]', () => {
  const store = tempStore();
  const bot = createBot(host(store), {
    name: 'Researcher',
    title: '资料员',
    description: '读文档、做摘要'
  });
  assert.equal(bot.id, 'researcher');
  assert.equal(bot.agentId, 'researcher');
  assert.equal(bot.name, 'Researcher');
  assert.equal(bot.hidden, false);
  assert.equal(bot.avatar, null);

  const agent = store.getAgent('researcher');
  assert.ok(agent);
  assert.equal(agent.domainId, 'bot');
  assert.match(agent.instructions, /资料员|读文档/);

  const session = store.getSession(bot.canonicalSessionId);
  assert.ok(session);
  assert.equal(session.title, canonicalBotChatTitle('Researcher'));
  assert.equal(session.agentId, 'researcher');
  assert.equal(session.metadata.botId, 'researcher');
  assert.equal(session.metadata.canonicalBotChat, true);
  assert.equal(session.metadata.sessionCut, true);
  assert.equal(session.metadata.permissionMode, 'auto');
  assert.equal(session.metadata.maxTurns, 0);
  assert.equal(agent.autonomous, true);
  assert.ok(agent.capabilities.includes('task-management'));
  assert.ok(agent.capabilities.includes('orchestration'));
  assert.match(agent.instructions, /permissionMode/);
  assert.doesNotMatch(agent.instructions, /full permission|Never ask the user to approve/i);
  assert.equal(store.listMessages(session.id).length, 0);
  store.db.close();
});

test('createBot: optional avatar is an emoji or image URL and can be cleared', () => {
  const store = tempStore();
  const h = host(store);
  const marked = createBot(h, { name: 'Emoji', avatar: ' 🤖 ' });
  assert.equal(marked.avatar, '🤖');
  assert.equal(getBot(store, marked.id).avatar, '🤖');
  const pictured = createBot(h, { name: 'Picture', avatar: 'https://cdn.example/bot.png' });
  assert.equal(pictured.avatar, 'https://cdn.example/bot.png');
  const cleared = updateBot(h, pictured.id, { avatar: '  ' });
  assert.equal(cleared.avatar, null);
  assert.throws(() => createBot(h, { name: 'Bad', avatar: 'ftp://cdn.example/bot.png' }));
  assert.throws(() => createBot(h, { name: 'Words', avatar: 'not an emoji' }));
  const omitted = createBot(h, { name: 'Plain' });
  assert.equal(omitted.avatar, null);
  store.db.close();
});

test('createBot: duplicate name is conflict; hidden excluded from default list [AC:bots#AC-1]', () => {
  const store = tempStore();
  const h = host(store);
  createBot(h, { name: 'Alpha' });
  assert.throws(() => createBot(h, { name: 'alpha' }), ConflictError);
  const hidden = createBot(h, { name: 'Beta' });
  updateBot(h, hidden.id, { hidden: true });
  assert.deepEqual(
    listBots(store).map((b) => b.name),
    ['Alpha']
  );
  assert.equal(listBots(store, { includeHidden: true }).length, 2);
  store.db.close();
});

test('openBot: keeps an existing bypass session and still sets sessionCut', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: 'Legacy' });
  const prior = store.getSession(bot.canonicalSessionId);
  store.updateSession(bot.canonicalSessionId, {
    metadata: { ...prior.metadata, permissionMode: 'bypass', sessionCut: false }
  });
  const opened = openBot(h, bot.id);
  assert.equal(opened.createdSession, false);
  const next = store.getSession(opened.sessionId);
  assert.equal(next.metadata.permissionMode, 'bypass');
  assert.equal(next.metadata.sessionCut, true);
  store.db.close();
});

test('openBot: does not rewrite ask to auto, and fills a missing mode with auto', () => {
  const store = tempStore();
  const h = host(store);
  const asked = createBot(h, { name: 'Asked' });
  const askedPrior = store.getSession(asked.canonicalSessionId);
  store.updateSession(asked.canonicalSessionId, {
    metadata: { ...askedPrior.metadata, permissionMode: 'ask' }
  });
  openBot(h, asked.id);
  assert.equal(store.getSession(asked.canonicalSessionId).metadata.permissionMode, 'ask');

  const blank = createBot(h, { name: 'Blank' });
  const blankPrior = store.getSession(blank.canonicalSessionId);
  const { permissionMode: _dropped, ...rest } = blankPrior.metadata;
  store.updateSession(blank.canonicalSessionId, { metadata: rest });
  openBot(h, blank.id);
  assert.equal(store.getSession(blank.canonicalSessionId).metadata.permissionMode, 'auto');
  store.db.close();
});

test('openBot: per-user chats do not share the canonical session', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: 'Shared' });
  const a = openBot(h, bot.id, { userId: 'user_a', tenantId: 'default' });
  const b = openBot(h, bot.id, { userId: 'user_b', tenantId: 'default' });
  assert.equal(a.createdSession, true);
  assert.equal(b.createdSession, true);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.sessionId, bot.canonicalSessionId);
  const again = openBot(h, bot.id, { userId: 'user_a', tenantId: 'default' });
  assert.equal(again.createdSession, false);
  assert.equal(again.sessionId, a.sessionId);
  const sessA = store.getSession(a.sessionId);
  assert.equal(sessA.metadata.userId, 'user_a');
  assert.equal(sessA.metadata.botId, bot.id);
  store.db.close();
});

test('openBot: missing session is recreated', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: 'Keeper' });
  const oldId = bot.canonicalSessionId;
  store.updateBot(bot.id, { canonicalSessionId: 'session_gone' });
  const opened = openBot(h, bot.id);
  assert.equal(opened.createdSession, true);
  assert.notEqual(opened.sessionId, oldId);
  assert.notEqual(opened.sessionId, 'session_gone');
  const session = store.getSession(opened.sessionId);
  assert.ok(session);
  assert.equal(getBot(store, bot.id).canonicalSessionId, opened.sessionId);
  store.db.close();
});

test('face input keeps only present fields and rejects an unknown choice', () => {
  assert.deepEqual(readFaceInput({ name: 'A' }), {});
  assert.deepEqual(readFaceInput({ faceShape: 'bean', faceColor: null }), { faceShape: 'bean', faceColor: null });
  assert.deepEqual(faceUpdatePatch({}), {});
  assert.deepEqual(faceUpdatePatch({ faceShape: 'circle', faceColor: 'mint' }), {
    faceShape: 'circle',
    faceColor: 'mint'
  });
  assert.throws(() => faceUpdatePatch({ faceColor: 'gold' }), ValidationError);
});

test('face style accepts classic or soft, blank clears, garbage is rejected [AC:bot-face-soft-style#AC-5]', () => {
  assert.equal(normalizeBotFaceStyle(undefined), null);
  assert.equal(normalizeBotFaceStyle(null), null);
  assert.equal(normalizeBotFaceStyle(''), null);
  assert.equal(normalizeBotFaceStyle('  '), null);
  assert.equal(normalizeBotFaceStyle('classic'), 'classic');
  assert.equal(normalizeBotFaceStyle('soft'), 'soft');
  assert.throws(() => normalizeBotFaceStyle('blob'), ValidationError);
  assert.throws(() => normalizeBotFaceStyle('SOFT'), ValidationError);
  assert.deepEqual(readFaceInput({ faceStyle: 'soft' }), { faceStyle: 'soft' });
  assert.deepEqual(readFaceInput({ name: 'A' }), {});
  assert.deepEqual(faceUpdatePatch({ faceStyle: 'soft' }), { faceStyle: 'soft' });
  assert.deepEqual(faceUpdatePatch({ faceStyle: '' }), { faceStyle: null });
  assert.deepEqual(faceUpdatePatch({ faceStyle: '  ' }), { faceStyle: null });
  assert.deepEqual(faceUpdatePatch({}), {});
  assert.throws(() => faceUpdatePatch({ faceExpression: 'wink' }), ValidationError);
  assert.deepEqual(faceUpdatePatch({ faceStyle: 'soft', faceExpression: 'wink' }), {
    faceStyle: 'soft',
    faceExpression: 'wink'
  });
  assert.deepEqual(faceUpdatePatch({ faceStyle: 'classic' }, { faceStyle: 'soft', faceShape: 'pebble', faceColor: 'lilac' }), {
    faceStyle: 'classic',
    faceShape: null,
    faceColor: null,
    faceExpression: null
  });
  assert.deepEqual(faceUpdatePatch({ faceStyle: 'classic' }, { faceStyle: 'soft', faceShape: 'bean', faceColor: 'mint' }), {
    faceStyle: 'classic',
    faceShape: null,
    faceColor: null,
    faceExpression: null
  });
  assert.deepEqual(
    faceUpdatePatch({ faceStyle: 'classic', faceShape: 'bean', faceColor: 'mint' }, { faceStyle: 'soft', faceShape: 'bean', faceColor: 'mint' }),
    { faceStyle: 'classic', faceShape: 'bean', faceColor: 'mint', faceExpression: null }
  );
  assert.deepEqual(faceUpdatePatch({ faceStyle: 'soft' }, { faceStyle: 'classic', faceShape: 'star', faceColor: 'red' }), {
    faceStyle: 'soft',
    faceShape: null,
    faceColor: null
  });
  assert.deepEqual(faceUpdatePatch({ faceStyle: 'soft', faceShape: 'bean', faceColor: 'mint' }, { faceStyle: null, faceShape: 'bean', faceColor: 'mint' }), {
    faceStyle: 'soft',
    faceShape: 'bean',
    faceColor: 'mint'
  });
  assert.deepEqual(faceUpdatePatch({ faceStyle: 'classic', faceShape: 'star' }, { faceStyle: null, faceShape: 'circle', faceColor: 'red' }), {
    faceStyle: 'classic',
    faceShape: 'star'
  });
});

test('createBot stores soft style and a blank style stays classic [AC:bot-face-soft-style#AC-1] [AC:bot-face-soft-style#AC-5]', () => {
  const store = tempStore();
  const h = host(store);
  const plain = createBot(h, { name: 'PlainStyle' });
  assert.equal(plain.faceStyle, null);
  assert.equal(getBot(store, plain.id).faceStyle, null);
  const soft = createBot(h, {
    name: 'SoftBot',
    faceStyle: 'soft',
    faceShape: 'pebble',
    faceColor: 'lilac',
    faceExpression: 'wink'
  });
  assert.equal(soft.faceStyle, 'soft');
  assert.equal(soft.faceExpression, 'wink');
  assert.equal(getBot(store, soft.id).faceStyle, 'soft');
  assert.equal(getBot(store, soft.id).faceExpression, 'wink');
  const kept = updateBot(h, soft.id, { title: 'Still soft' });
  assert.equal(kept.faceStyle, 'soft');
  assert.equal(kept.faceExpression, 'wink');
  const shared = createBot(h, { name: 'SharedLook', faceStyle: 'soft', faceShape: 'bean', faceColor: 'mint', faceExpression: 'shy' });
  const keptShared = updateBot(h, shared.id, { faceStyle: 'classic', faceShape: 'bean', faceColor: 'mint' });
  assert.equal(keptShared.faceStyle, 'classic');
  assert.equal(keptShared.faceShape, 'bean');
  assert.equal(keptShared.faceColor, 'mint');
  assert.equal(keptShared.faceExpression, null);
  const dropped = updateBot(h, shared.id, { faceStyle: 'soft' });
  assert.equal(dropped.faceStyle, 'soft');
  assert.equal(dropped.faceShape, null);
  assert.equal(dropped.faceColor, null);
  const classicBot = createBot(h, { name: 'ClassicLook', faceShape: 'star', faceColor: 'red' });
  const recolored = updateBot(h, classicBot.id, { faceStyle: 'classic', faceShape: 'circle' });
  assert.equal(recolored.faceStyle, 'classic');
  assert.equal(recolored.faceShape, 'circle');
  assert.equal(recolored.faceColor, 'red');
  const classic = updateBot(h, soft.id, { faceStyle: 'classic' });
  assert.equal(classic.faceStyle, 'classic');
  assert.equal(classic.faceShape, null);
  assert.equal(classic.faceColor, null);
  assert.equal(classic.faceExpression, null);
  const cleared = updateBot(h, soft.id, { faceStyle: null });
  assert.equal(cleared.faceStyle, null);
  assert.equal(cleared.faceExpression, null);
  assert.throws(() => createBot(h, { name: 'LookOnClassic', faceExpression: 'wink' }), ValidationError);
  assert.throws(() => createBot(h, { name: 'BadStyle', faceStyle: 'sparkle' }), ValidationError);
  assert.throws(() => updateBot(h, plain.id, { faceStyle: 'round' }), ValidationError);
  store.db.close();
});

test('createBot stores a face choice and update can clear it', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: 'DeskBot', faceShape: 'circle', faceColor: 'blue' });
  assert.equal(bot.faceShape, 'circle');
  assert.equal(bot.faceColor, 'blue');
  assert.equal(getBot(store, bot.id).faceShape, 'circle');
  const renamed = updateBot(h, bot.id, { title: 'Still blue' });
  assert.equal(renamed.faceShape, 'circle');
  assert.equal(renamed.faceColor, 'blue');
  const cleared = updateBot(h, bot.id, { faceShape: null, faceColor: null });
  assert.equal(cleared.faceShape, null);
  assert.equal(cleared.faceColor, null);
  const plain = createBot(h, { name: 'Plain' });
  assert.equal(plain.faceShape, null);
  assert.equal(plain.faceColor, null);
  assert.throws(() => createBot(h, { name: 'Nope', faceShape: 'spark' }), ValidationError);
  const drop = createBot(h, { name: 'Drop', faceShape: 'teardrop', faceColor: 'black' });
  assert.equal(drop.faceShape, 'teardrop');
  assert.equal(drop.faceColor, 'black');
  assert.throws(() => updateBot(h, bot.id, { faceColor: 'gold' }), ValidationError);
  store.db.close();
});

test('createBot: non-slug name still works; empty name rejected', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: '调研助手' });
  assert.match(bot.id, /^bot_/);
  assert.equal(bot.agentId, bot.id);
  assert.throws(() => createBot(h, { name: '   ' }), ValidationError);
  store.db.close();
});

test('createBot: roster cap is the visible roster', () => {
  const store = tempStore();
  const h = host(store);
  const bots = [];
  for (let i = 0; i < BOT_ROSTER_CAP; i += 1) {
    bots.push(createBot(h, { name: `Cap ${i}` }));
  }
  assert.throws(() => createBot(h, { name: 'Overflow' }), ValidationError);
  updateBot(h, bots[0].id, { hidden: true });
  const freed = createBot(h, { name: 'After hide' });
  assert.equal(freed.hidden, false);
  assert.throws(() => createBot(h, { name: 'Still full' }), ValidationError);
  store.db.close();
});

function patchCanonical(store, bot, patch) {
  const prior = store.getSession(bot.canonicalSessionId);
  store.updateSession(bot.canonicalSessionId, { metadata: { ...prior.metadata, ...patch } });
}

test('openBot: a per-user chat inherits the saved turn budget only when it is a preset', () => {
  const store = tempStore();
  const h = host(store);
  const cases = [
    [48, 48],
    [96, 96],
    [24, 24],
    [0, 0],
    [50, 0],
    ['48', 0]
  ];
  cases.forEach(([saved, expected], i) => {
    const bot = createBot(h, { name: `Budget${i}` });
    patchCanonical(store, bot, { maxTurns: saved });
    const opened = openBot(h, bot.id, { userId: 'u1' });
    assert.equal(opened.createdSession, true);
    assert.equal(store.getSession(opened.sessionId).metadata.maxTurns, expected, `saved ${saved}`);
  });
  store.db.close();
});

test('openBot: a per-user chat inherits skill and model pins from the canonical chat', () => {
  const store = tempStore();
  const h = host(store);
  const pinned = createBot(h, { name: 'Pinned' });
  patchCanonical(store, pinned, {
    allowedSkills: [' alpha ', 'beta'],
    modelOverride: { providerId: 'p1', modelId: 'm1' }
  });
  const mine = store.getSession(openBot(h, pinned.id, { userId: 'u1' }).sessionId);
  assert.deepEqual(mine.metadata.allowedSkills, ['alpha', 'beta']);
  assert.deepEqual(mine.metadata.modelOverride, { providerId: 'p1', modelId: 'm1' });

  const plain = createBot(h, { name: 'Plain' });
  const theirs = store.getSession(openBot(h, plain.id, { userId: 'u1' }).sessionId);
  assert.equal('allowedSkills' in theirs.metadata, false);
  assert.equal('modelOverride' in theirs.metadata, false);
  assert.equal('allowedTools' in theirs.metadata, false);
  store.db.close();
});

test('openBot: reopening a per-user chat repairs a blank permission mode and the session cut', () => {
  const store = tempStore();
  const h = host(store);
  const bot = createBot(h, { name: 'Repair' });
  const first = openBot(h, bot.id, { userId: 'u1' });
  const created = store.getSession(first.sessionId);
  store.updateSession(first.sessionId, {
    metadata: { ...created.metadata, permissionMode: '   ', sessionCut: false }
  });
  const again = openBot(h, bot.id, { userId: 'u1' });
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(again.createdSession, false);
  const repaired = store.getSession(first.sessionId);
  assert.equal(repaired.metadata.permissionMode, 'auto');
  assert.equal(repaired.metadata.sessionCut, true);
  store.db.close();
});

test('Bloub appearance persists without altering existing styles [AC:bot-bloub-dynamic#AC-1]', () => {
  const store = tempStore();
  try {
    const appearance = { faceStyle: 'bloub', faceShape: 'pebble', faceColor: 'peach', faceExpression: 'happy' };
    const bot = createBot(host(store), { name: 'Dynamic Bloub', ...appearance });
    assert.equal(getBot(store, bot.id).faceStyle, 'bloub');
    for (const [key, value] of Object.entries(appearance)) assert.equal(getBot(store, bot.id)[key], value);
    const soft = updateBot(host(store), bot.id, { ...appearance, faceStyle: 'soft' });
    assert.equal(soft.faceStyle, 'soft');
    const classic = updateBot(host(store), bot.id, { faceStyle: 'classic' });
    assert.equal(classic.faceShape, null);
    assert.equal(classic.faceExpression, null);
  } finally { store.db.close(); }
});
