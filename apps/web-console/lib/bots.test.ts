import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botForCanonicalSession,
  filterSessionsByPlaySurface,
  parseOpenBotResponse,
  parsePlaySurface,
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

test('Room execution sessions stay out of both private chat lists', () => {
 const sessions = [{id:'private'}, {id:'room',metadata:{roomId:'room-1'}}];
 assert.deepEqual(filterSessionsByPlaySurface(sessions,[bot],'chat').map(s=>s.id), ['private']);
 assert.deepEqual(filterSessionsByPlaySurface(sessions,[bot],'bot'), []);
});
