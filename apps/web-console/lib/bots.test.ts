import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBotsHash,
  botCardSelected,
  botCardSubtitle,
  botForCanonicalSession,
  botsHashIntent,
  botsPane,
  filterSessionsByPlaySurface,
  parseOpenBotResponse,
  parsePlaySurface,
  showBotsEmpty,
  visibleBotRoster
} from './bots.ts';

const bot = {
  id: 'researcher',
  name: 'Researcher',
  title: '资料员',
  description: '',
  agentId: 'researcher',
  canonicalSessionId: 'sess_bot',
  hidden: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

test('botForCanonicalSession matches roster by canonicalSessionId', () => {
  assert.equal(botForCanonicalSession([bot], 'sess_bot')?.id, 'researcher');
  assert.equal(botForCanonicalSession([bot], 'other'), undefined);
  assert.equal(botForCanonicalSession([bot], null), undefined);
});

test('visibleBotRoster drops hidden', () => {
  assert.deepEqual(
    visibleBotRoster([bot, { ...bot, id: 'x', hidden: true }]).map((b) => b.id),
    ['researcher']
  );
});

test('parsePlaySurface only accepts chat|bot', () => {
  assert.equal(parsePlaySurface('chat'), 'chat');
  assert.equal(parsePlaySurface('bot'), 'bot');
  assert.equal(parsePlaySurface('task'), undefined);
});

test('filterSessionsByPlaySurface treats per-user bot chats as bot surface', () => {
  const sessions = [
    { id: 'sess_chat' },
    { id: 'sess_user_bot', metadata: { botId: 'researcher', canonicalBotChat: true } }
  ];
  assert.deepEqual(
    filterSessionsByPlaySurface(sessions, [bot], 'bot').map((s) => s.id),
    ['sess_user_bot']
  );
  assert.equal(botForCanonicalSession([bot], 'sess_user_bot', sessions)?.id, 'researcher');
});

test('filterSessionsByPlaySurface keeps bot work out of ordinary chat without a roster hit', () => {
  const sessions = [
    { id: 'chat' },
    { id: 'canon', metadata: { canonicalBotChat: true, botId: 'missing' } },
    { id: 'worker', metadata: { spawnSource: 'bot-goal-continuation', botId: 'missing' } },
    { id: 'fork', metadata: { botGoalWorker: true } },
    { id: 'room', metadata: { roomId: 'room-1', canonicalBotChat: true } }
  ];
  assert.deepEqual(filterSessionsByPlaySurface(sessions, [], 'chat').map((s) => s.id), ['chat']);
  assert.deepEqual(
    filterSessionsByPlaySurface(sessions, [], 'bot').map((s) => s.id),
    ['canon', 'worker', 'fork']
  );
});

test('filterSessionsByPlaySurface splits chat vs bot canonical', () => {
  const sessions = [{ id: 'sess_chat' }, { id: 'sess_bot' }, { id: 'sess_other' }];
  assert.deepEqual(
    filterSessionsByPlaySurface(sessions, [bot], 'bot').map((s) => s.id),
    ['sess_bot']
  );
  assert.deepEqual(
    filterSessionsByPlaySurface(sessions, [bot], 'chat').map((s) => s.id),
    ['sess_chat', 'sess_other']
  );
});

test('parseOpenBotResponse accepts session object or sessionId', () => {
  assert.equal(parseOpenBotResponse({ bot, session: { id: 'sess_bot' } }).sessionId, 'sess_bot');
  assert.equal(parseOpenBotResponse({ bot, sessionId: 'sess_alt' }).sessionId, 'sess_alt');
  assert.throws(() => parseOpenBotResponse({ bot }), /缺少 bot 或 session/);
});

test('roster pane prefers create, then group, then a selected bot', () => {
  assert.equal(botsPane(true, true, true), 'create');
  assert.equal(botsPane(false, true, true), 'group');
  assert.equal(botsPane(false, false, true), 'detail');
  assert.equal(botsPane(false, false, false), 'none');
  assert.equal(botCardSelected('ada', 'ada', false), true);
  assert.equal(botCardSelected('ada', 'ada', true), false);
  assert.equal(botCardSelected('ada', 'bob', false), false);
  assert.equal(botCardSubtitle('Ada', 'Ada'), null);
  assert.equal(botCardSubtitle('Ada', ''), null);
  assert.equal(botCardSubtitle('Ada', undefined), null);
  assert.equal(botCardSubtitle('Ada', 'Helper'), 'Helper');
  assert.equal(showBotsEmpty(0, 'none'), true);
  assert.equal(showBotsEmpty(0, 'detail'), true);
  assert.equal(showBotsEmpty(0, 'create'), false);
  assert.equal(showBotsEmpty(0, 'group'), false);
  assert.equal(showBotsEmpty(2, 'none'), false);
});

test('a hash opens group create ahead of a permissions deep link', () => {
  const readGroup = (hash: string) => hash.includes('group');
  const readPermissions = (hash: string) => (hash.includes('bot=') ? { botId: 'ada' } : null);
  assert.deepEqual(botsHashIntent('#/group', readGroup, readPermissions), { kind: 'group' });
  assert.deepEqual(botsHashIntent('#/bot=ada', readGroup, readPermissions), { kind: 'permissions', botId: 'ada' });
  assert.deepEqual(botsHashIntent('#/chat', readGroup, readPermissions), { kind: 'ignore' });
  const calls: string[] = [];
  const set = {
    setCreating: (value: boolean) => calls.push(`creating:${value}`),
    setCreatingGroup: (value: boolean) => calls.push(`group:${value}`),
    setNotice: (value: null) => calls.push(`notice:${value}`),
    setQuery: (value: string) => calls.push(`query:${value}`),
    setSelectedId: (value: string) => calls.push(`id:${value}`)
  };
  applyBotsHash('#/chat', readGroup, readPermissions, set);
  assert.deepEqual(calls, []);
  applyBotsHash('#/group', readGroup, readPermissions, set);
  assert.deepEqual(calls, ['creating:false', 'notice:null', 'group:true']);
  calls.length = 0;
  applyBotsHash('#/bot=ada', readGroup, readPermissions, set);
  assert.deepEqual(calls, ['creating:false', 'notice:null', 'group:false', 'query:', 'id:ada']);
});

test('Room execution sessions stay out of both private chat lists', () => {
 const sessions = [{id:'private'}, {id:'room',metadata:{roomId:'room-1'}}];
 assert.deepEqual(filterSessionsByPlaySurface(sessions,[bot],'chat').map(s=>s.id), ['private']);
 assert.deepEqual(filterSessionsByPlaySurface(sessions,[bot],'bot'), []);
});
