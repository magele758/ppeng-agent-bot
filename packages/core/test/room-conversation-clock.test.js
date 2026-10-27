import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';
import {
  CLOCK_NOTICE_MARK,
  HISTORY_DATE_RULE,
  appendClockNotice,
  formatWrittenAt
} from '../src/session/conversation-clock.ts';

const WRITTEN_AT = '2026-10-20T01:14:00.000Z';
const NOW = Date.parse('2026-10-26T16:30:00.000Z');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'room-clock-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const a = createBot(facade, { name: 'Alpha' });
  const b = createBot(facade, { name: 'Beta' });
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of [a, b]) {
    const session = store.getSession(bot.canonicalSessionId);
    store.updateSession(bot.canonicalSessionId, { metadata: { ...session.metadata, ...principal, timezone: 'Asia/Shanghai' } });
  }
  const host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async () => {},
    cancelSession: id => store.updateSession(id, { status: 'idle' })
  };
  return { store, rooms: new BotRoomService(host), host, a, b, principal };
}

test('room history keeps the written day and does not store the live clock [AC:conversation-date-clock#AC-4]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Dates', botIds: [f.a.id, f.b.id], hostBotId: f.a.id });
  const sent = f.rooms.send(f.principal, room.id, { text: '今天开会', mentions: [f.a.id] });
  const row = f.store.db.prepare('SELECT data FROM bot_room_messages WHERE id=?').get(sent.message.id);
  const data = JSON.parse(row.data);
  data.createdAt = WRITTEN_AT;
  f.store.db.prepare('UPDATE bot_room_messages SET data=? WHERE id=?').run(JSON.stringify(data), sent.message.id);

  let prompt = '';
  f.host.runSession = async id => {
    const latest = f.store.listMessages(id).at(-1);
    prompt = latest.parts.map(part => part.text ?? '').join('\n');
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ack' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  await f.rooms.tick();

  const written = formatWrittenAt(WRITTEN_AT, 'Asia/Shanghai');
  assert.equal(written, '2026-10-20 09:14 Asia/Shanghai');
  assert.match(prompt, /2026-10-20 09:14 Asia\/Shanghai/);
  assert.match(prompt, /"writtenAt":"2026-10-20 09:14 Asia\/Shanghai"/);
  assert.ok(prompt.includes(HISTORY_DATE_RULE));
  assert.equal(prompt.includes(CLOCK_NOTICE_MARK), false);
  assert.equal(prompt.includes('Current time:'), false);

  const memberId = f.store.db.prepare('SELECT session_id FROM bot_room_contexts WHERE room_id=? AND bot_id=?').get(room.id, f.a.id).session_id;
  const stored = f.store.listMessages(memberId).find(message => message.role === 'user');
  const before = JSON.stringify(stored);
  const noticed = appendClockNotice([JSON.parse(before)], NOW, 'Asia/Shanghai');
  const notice = noticed[0].parts.map(part => part.text ?? '').join('\n');
  assert.match(notice, /2026-10-27/);
  assert.equal(JSON.stringify(f.store.listMessages(memberId).find(message => message.role === 'user')), before);
  assert.equal(before.includes(CLOCK_NOTICE_MARK), false);
  f.store.db.close();
});
