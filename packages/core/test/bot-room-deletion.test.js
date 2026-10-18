import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'room-delete-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const bots = ['Alpha', 'Beta'].map(name => createBot(facade, { name }));
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of bots) {
    const session = store.getSession(bot.canonicalSessionId);
    store.updateSession(session.id, { metadata: { ...session.metadata, ...principal } });
    store.appendMessage(session.id, 'user', [{ type: 'text', text: 'Private conversation' }]);
  }
  const host = { store, createChatSession: input => createChatSession(facade, input), runSession: async () => {}, cancelSession: () => {} };
  const rooms = new BotRoomService(host);
  const room = rooms.create(principal, { title: 'Disposable', botIds: bots.map(bot => bot.id) });
  return { store, bots, host, principal, rooms, room, cleanup() { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('delete a room durably while preserving member Bots and private conversations [AC:bot-functional-groups#AC-1]', () => {
  const f = fixture();
  try {
    f.rooms.send(f.principal, f.room.id, { text: 'Shared question' });
    f.rooms.delete(f.principal, f.room.id);
    assert.deepEqual(new BotRoomService(f.host).list(f.principal), []);
    assert.throws(() => f.rooms.get(f.principal, f.room.id), /not found/i);
    for (const bot of f.bots) {
      assert.ok(f.store.getBot(bot.id));
      assert.equal(f.store.listMessages(bot.canonicalSessionId)[0].parts[0].text, 'Private conversation');
    }
    for (const table of ['bot_room_messages', 'bot_room_turns', 'bot_room_contexts']) {
      assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id=?`).get(f.room.id).n, 0);
    }
  } finally { f.cleanup(); }
});

test('failed unauthorized room deletion keeps the room and permits an owner retry [AC:bot-functional-groups#AC-2]', () => {
  const f = fixture();
  try {
    assert.throws(() => f.rooms.delete({ userId: 'stranger', tenantId: 'team' }, f.room.id), /forbidden/i);
    assert.equal(f.rooms.get(f.principal, f.room.id).title, 'Disposable');
    f.rooms.delete(f.principal, f.room.id);
    assert.deepEqual(f.rooms.list(f.principal), []);
  } finally { f.cleanup(); }
});

test('deleting a running room cancels its work and fences late replies [AC:bot-functional-groups#AC-1]', async () => {
  const f = fixture();
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const running = new Promise(resolve => { release = resolve; });
  const cancelled = [];
  f.host.runSession = async id => {
    started();
    await running;
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'Late reply' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.host.cancelSession = id => cancelled.push(id);
  try {
    f.rooms.send(f.principal, f.room.id, { text: 'Start work' });
    const tick = f.rooms.tick();
    await ready;
    f.rooms.delete(f.principal, f.room.id);
    assert.equal(cancelled.length, 1);
    release();
    await tick;
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM bot_room_messages WHERE room_id=?').get(f.room.id).n, 0);
    assert.deepEqual(new BotRoomService(f.host).list(f.principal), []);
  } finally { release(); f.cleanup(); }
});
