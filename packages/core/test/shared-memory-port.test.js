import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot, setBotDefinitionOwner } from '../dist/bots/index.js';
import { BotFunctionalGroupService } from '../dist/bots/functional-groups.js';
import { createSharedMemoryPort } from '../dist/bots/shared-memory-port.js';
import { BotRoomService } from '../dist/rooms/index.js';

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'shared-memory-port-')), 'state.db');
  const store = new SqliteStateStore(path);
  const facade = {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions: () => {},
    wakeAgentSessions: () => {}
  };
  const a = createBot(facade, { name: 'Alpha' });
  const b = createBot(facade, { name: 'Beta' });
  const principal = { userId: 'owner' };
  for (const bot of [a, b]) {
    store.updateSession(bot.canonicalSessionId, {
      metadata: { ...store.getSession(bot.canonicalSessionId).metadata, ...principal }
    });
    setBotDefinitionOwner(store, bot.id, principal);
  }
  const groups = new BotFunctionalGroupService(store);
  const rooms = new BotRoomService({
    store,
    createChatSession: () => {
      throw new Error('unused');
    },
    runSession: async () => {},
    cancelSession: () => {}
  });
  const port = createSharedMemoryPort(groups);
  return { store, a, b, principal, groups, rooms, port };
}

test('SharedMemoryPort is the named facade: set/get roundtrip and empty resolve by default', () => {
  const f = fixture();
  assert.deepEqual(f.port.get(f.principal, { scope: 'global' }), {});
  assert.deepEqual(f.port.resolveForSession(f.store.getSession(f.a.canonicalSessionId)), {});
  assert.equal(f.port.appendix(f.store.getSession(f.a.canonicalSessionId)), '');

  const saved = f.port.set(f.principal, { scope: 'global' }, { rule: 'be brief' });
  assert.deepEqual(saved, { rule: 'be brief' });
  assert.deepEqual(f.port.get(f.principal, { scope: 'global' }), { rule: 'be brief' });
  assert.deepEqual(f.port.resolveForSession(f.store.getSession(f.a.canonicalSessionId)), {
    rule: 'be brief'
  });
  assert.match(f.port.appendix(f.store.getSession(f.a.canonicalSessionId)), /be brief/);
  assert.match(f.port.appendix(f.store.getSession(f.a.canonicalSessionId)), /explicit-shared-context/);
});

test('SharedMemoryPort resolveForSession precedence: room > group > global', () => {
  const f = fixture();
  const group = f.groups.create(f.principal, 'Research');
  f.groups.move(f.principal, f.a.id, group.id);
  const room = f.rooms.create(f.principal, { title: 'War room', botIds: [f.a.id, f.b.id] });

  f.port.set(f.principal, { scope: 'global' }, { location: 'global', fallback: 'yes' });
  f.port.set(f.principal, { scope: 'group', id: group.id }, { location: 'group' });
  f.port.set(f.principal, { scope: 'room', id: room.id }, { location: 'room' });

  const plain = f.store.getSession(f.a.canonicalSessionId);
  assert.equal(f.port.resolveForSession(plain).location, 'group');
  assert.equal(f.port.resolveForSession(f.store.getSession(f.b.canonicalSessionId)).location, 'global');

  const roomSession = {
    ...plain,
    metadata: { ...plain.metadata, roomId: room.id, botId: f.a.id }
  };
  assert.deepEqual(f.port.resolveForSession(roomSession), { location: 'room', fallback: 'yes' });
});

test('SharedMemoryPort rejects invalid entries and does not leak across principals', () => {
  const f = fixture();
  assert.throws(() => f.port.set(f.principal, { scope: 'global' }, { key: 5 }));
  f.port.set(f.principal, { scope: 'global' }, { secret: 'OWNER' });
  assert.deepEqual(f.port.get({ userId: 'stranger' }, { scope: 'global' }), {});
  assert.deepEqual(
    f.port.resolveForSession({
      ...f.store.getSession(f.a.canonicalSessionId),
      metadata: { userId: 'stranger' }
    }),
    {}
  );
});
