import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createCronJob, updateCronJob } from '../dist/cron/cron-facade.js';
import { RoutineRunStore, drainRoutineRuns } from '../dist/cron/routine-runtime.js';
import { BotRoomService, deliverBotRoomMessage } from '../dist/rooms/index.js';
import { AuthorizationError, ValidationError } from '../dist/errors.js';

function fixture(reply = 'room report') {
  const stateDir = mkdtempSync(join(tmpdir(), 'routine-room-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const facade = { store, stateDir, cronStore: undefined, setCronStore(s) { this.cronStore = s; }, runImageRetention: async () => {}, wakeAllAutonomousSessions() {}, wakeAgentSessions() {} };
  const principal = { userId: 'alice', tenantId: 'team' };
  const bot = createBot(facade, { name: 'RoomBot' });
  store.updateSession(bot.canonicalSessionId, { metadata: { ...store.getSession(bot.canonicalSessionId).metadata, ...principal } });
  const host = { ...facade, log: { warn() {}, info() {} }, runSession: async (id) => { if (reply !== null) store.appendMessage(id, 'assistant', [{ type: 'text', text: reply }]); return store.getSession(id); } };
  const rooms = new BotRoomService({ store, createChatSession: () => { throw new Error('room turn'); }, runSession: async () => { throw new Error('room turn'); }, cancelSession() {} });
  const room = rooms.create(principal, { title: 'Standup', botIds: [bot.id] });
  return { store, host, principal, bot, rooms, room };
}

async function finish(host, store) {
  await drainRoutineRuns(host);
  await new Promise(resolve => setImmediate(resolve));
  await drainRoutineRuns(host);
  return new RoutineRunStore(store);
}

test('a completed routine posts one bot message and recovery does not duplicate it [AC:bot-routine-lifecycle#AC-14]', async () => {
  const { store, host, principal, bot, rooms, room } = fixture('shipped the digest');
  const job = createCronJob(host, { botId: bot.id, userId: principal.userId, tenantId: principal.tenantId, name: 'digest', prompt: 'summarize', intervalMs: 60000, roomId: room.id });
  const runs = new RoutineRunStore(store);
  const run = runs.enqueue(job, new Date().toISOString());
  const ledger = await finish(host, store);
  const done = ledger.get(run.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.roomDelivery.status, 'delivered');
  assert.equal(done.roomDelivery.roomId, room.id);
  const messages = rooms.messages(principal, room.id).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender.type, 'bot');
  assert.equal(messages[0].sender.id, bot.id);
  assert.equal(messages[0].sender.name, bot.name);
  assert.equal(messages[0].text, 'shipped the digest');
  assert.equal(messages[0].id, done.roomDelivery.messageId);
  assert.equal(rooms.turns(principal, room.id).length, 0);
  assert.ok(store.listMessages(done.mainSessionId).some(message => JSON.stringify(message).includes(run.id)));
  await drainRoutineRuns(host);
  const path = store.dbPath;
  store.db.close();
  const reopened = new SqliteStateStore(path);
  await drainRoutineRuns({ ...host, store: reopened });
  assert.equal(new BotRoomService({ store: reopened, createChatSession() {}, runSession: async () => {}, cancelSession() {} }).messages(principal, room.id).messages.length, 1);
  reopened.db.close();
});

test('a silence token posts nothing and sends no summary [AC:bot-routine-lifecycle#AC-14]', async () => {
  for (const reply of ['[SILENT]', ' [silent] ']) {
    const silent = fixture(reply);
    const job = createCronJob(silent.host, { botId: silent.bot.id, userId: silent.principal.userId, tenantId: silent.principal.tenantId, name: 'quiet-token', prompt: 'check', intervalMs: 60000, roomId: silent.room.id });
    const run = new RoutineRunStore(silent.store).enqueue(job, new Date().toISOString());
    const ledger = await finish(silent.host, silent.store);
    const done = ledger.get(run.id);
    assert.equal(done.status, 'silent');
    assert.equal(done.roomDelivery, undefined);
    assert.equal(silent.rooms.messages(silent.principal, silent.room.id).messages.length, 0);
    assert.equal(silent.store.listMessages(done.mainSessionId).length, 0);
    silent.store.db.close();
  }
});

test('whitespace output posts nothing and stays failed [AC:bot-routine-lifecycle#AC-14]', async () => {
  const blank = fixture('   \n\t  ');
  const job = createCronJob(blank.host, { botId: blank.bot.id, userId: blank.principal.userId, tenantId: blank.principal.tenantId, name: 'spaces', prompt: 'check', intervalMs: 60000, roomId: blank.room.id });
  const run = new RoutineRunStore(blank.store).enqueue(job, new Date().toISOString());
  const ledger = await finish(blank.host, blank.store);
  assert.equal(ledger.get(run.id).status, 'failed');
  assert.equal(ledger.get(run.id).roomDelivery, undefined);
  assert.equal(blank.rooms.messages(blank.principal, blank.room.id).messages.length, 0);
  blank.store.db.close();
});

test('silence, precheck skip, failure and empty output post nothing [AC:bot-routine-lifecycle#AC-14] [AC:routine-failure-governance#AC-5]', async () => {
  const silent = fixture('[NO_UPDATE]');
  const silentJob = createCronJob(silent.host, { botId: silent.bot.id, userId: silent.principal.userId, tenantId: silent.principal.tenantId, name: 'quiet', prompt: 'check', intervalMs: 60000, roomId: silent.room.id });
  const silentRun = new RoutineRunStore(silent.store).enqueue(silentJob, new Date().toISOString());
  const silentLedger = await finish(silent.host, silent.store);
  assert.equal(silentLedger.get(silentRun.id).status, 'silent');
  assert.equal(silent.rooms.messages(silent.principal, silent.room.id).messages.length, 0);
  assert.equal(silent.store.listMessages(silentLedger.get(silentRun.id).mainSessionId).length, 0);
  silent.store.db.close();

  const skipped = fixture('should not run');
  const skippedJob = createCronJob(skipped.host, { botId: skipped.bot.id, userId: skipped.principal.userId, tenantId: skipped.principal.tenantId, name: 'gate', prompt: 'check', intervalMs: 60000, roomId: skipped.room.id, precheck: { kind: 'predicate', source: '{"wakeAgent":false}' } });
  const skippedRun = new RoutineRunStore(skipped.store).enqueue(skippedJob, new Date().toISOString());
  const skippedLedger = await finish(skipped.host, skipped.store);
  assert.equal(skippedLedger.get(skippedRun.id).status, 'skipped');
  assert.equal(skipped.rooms.messages(skipped.principal, skipped.room.id).messages.length, 0);
  assert.ok(skipped.store.listMessages(skippedLedger.get(skippedRun.id).mainSessionId).some(message => JSON.stringify(message).includes('skipped')));
  skipped.store.db.close();

  const failed = fixture('partial');
  failed.host.runSession = () => Promise.reject(new Error('executor rejected'));
  const failedJob = createCronJob(failed.host, { botId: failed.bot.id, userId: failed.principal.userId, tenantId: failed.principal.tenantId, name: 'boom', prompt: 'check', intervalMs: 60000, roomId: failed.room.id });
  const failedRun = new RoutineRunStore(failed.store).enqueue(failedJob, new Date().toISOString());
  const failedLedger = await finish(failed.host, failed.store);
  assert.equal(failedLedger.get(failedRun.id).status, 'failed');
  assert.equal(failed.rooms.messages(failed.principal, failed.room.id).messages.length, 0);
  assert.ok(failed.store.listMessages(failedLedger.get(failedRun.id).mainSessionId).some(message => JSON.stringify(message).includes(failedRun.id)));
  failed.store.db.close();

  const empty = fixture(null);
  const emptyJob = createCronJob(empty.host, { botId: empty.bot.id, userId: empty.principal.userId, tenantId: empty.principal.tenantId, name: 'blank', prompt: 'check', intervalMs: 60000, roomId: empty.room.id });
  const emptyRun = new RoutineRunStore(empty.store).enqueue(emptyJob, new Date().toISOString());
  const emptyLedger = await finish(empty.host, empty.store);
  assert.equal(emptyLedger.get(emptyRun.id).status, 'failed');
  assert.equal(empty.rooms.messages(empty.principal, empty.room.id).messages.length, 0);
  empty.store.db.close();
});

test('a routine without a room keeps the private summary only [AC:bot-routine-lifecycle#AC-14]', async () => {
  const { store, host, principal, bot, rooms, room } = fixture('private only');
  const job = createCronJob(host, { botId: bot.id, userId: principal.userId, tenantId: principal.tenantId, name: 'plain', prompt: 'check', intervalMs: 60000 });
  const run = new RoutineRunStore(store).enqueue(job, new Date().toISOString());
  const ledger = await finish(host, store);
  assert.equal(ledger.get(run.id).status, 'completed');
  assert.equal(ledger.get(run.id).roomDelivery, undefined);
  assert.equal(rooms.messages(principal, room.id).messages.length, 0);
  assert.equal(store.listMessages(ledger.get(run.id).mainSessionId).length, 1);
  const prompt = store.listMessages(ledger.get(run.id).sessionId).find(message => message.role === 'user');
  assert.equal(JSON.stringify(prompt).includes('posted to the group'), false);
  store.db.close();
});

test('another principal, a non-member and a non-bot routine cannot target a room, and null clears it [AC:bot-routine-lifecycle#AC-14]', () => {
  const { store, host, principal, bot, rooms, room } = fixture();
  const bob = createBot(host, { name: 'BobBot' });
  store.updateSession(bob.canonicalSessionId, { metadata: { ...store.getSession(bob.canonicalSessionId).metadata, userId: 'bob' } });
  const other = rooms.create({ userId: 'bob' }, { title: 'Other', botIds: [bob.id] });
  assert.throws(() => createCronJob(host, { botId: bot.id, userId: principal.userId, tenantId: principal.tenantId, name: 'foreign', prompt: 'check', intervalMs: 60000, roomId: other.id }), AuthorizationError);
  const outsider = createBot(host, { name: 'Outsider' });
  store.updateSession(outsider.canonicalSessionId, { metadata: { ...store.getSession(outsider.canonicalSessionId).metadata, ...principal } });
  assert.throws(() => createCronJob(host, { botId: outsider.id, userId: principal.userId, tenantId: principal.tenantId, name: 'outsider', prompt: 'check', intervalMs: 60000, roomId: room.id }), ValidationError);
  const session = store.createSession({ title: 'plain', mode: 'chat', agentId: 'general', metadata: { ...principal } });
  assert.throws(() => createCronJob(host, { sessionId: session.id, name: 'nobot', prompt: 'check', intervalMs: 60000, roomId: room.id }), ValidationError);
  const job = createCronJob(host, { botId: bot.id, userId: principal.userId, tenantId: principal.tenantId, name: 'bound', prompt: 'check', intervalMs: 60000, roomId: `  ${room.id}  ` });
  assert.equal(job.metadata.roomId, room.id);
  assert.equal(createCronJob(host, { botId: bot.id, userId: principal.userId, tenantId: principal.tenantId, name: 'blank-room', prompt: 'check', intervalMs: 60000, roomId: '   ' }).metadata.roomId, undefined);
  assert.throws(() => updateCronJob(host, job.id, { roomId: '  ' }), ValidationError);
  assert.throws(() => updateCronJob(host, job.id, { roomId: other.id }), AuthorizationError);
  assert.equal(updateCronJob(host, job.id, { roomId: null }).metadata.roomId, undefined);
  store.db.prepare('DELETE FROM sessions WHERE id=?').run(job.sessionId);
  host.cronStore.update(job.id, { metadata: { botId: bot.id } });
  assert.throws(() => updateCronJob(host, job.id, { roomId: room.id }), AuthorizationError);
  host.cronStore.update(job.id, { metadata: { botId: bot.id, principal: { userId: '   ', tenantId: '   ' } } });
  assert.throws(() => updateCronJob(host, job.id, { roomId: room.id }), AuthorizationError);
  host.cronStore.update(job.id, { metadata: { botId: bot.id, principal: { userId: principal.userId, tenantId: `  ${principal.tenantId}  ` } } });
  assert.equal(updateCronJob(host, job.id, { roomId: room.id }).metadata.roomId, room.id);
  store.db.close();
});

test('a paused room or a removed member records a skipped delivery and still writes the private summary [AC:bot-routine-lifecycle#AC-14]', async () => {
  const paused = fixture('still private');
  const pausedJob = createCronJob(paused.host, { botId: paused.bot.id, userId: paused.principal.userId, tenantId: paused.principal.tenantId, name: 'paused', prompt: 'check', intervalMs: 60000, roomId: paused.room.id });
  paused.rooms.patch(paused.principal, paused.room.id, { status: 'paused' });
  const warnings = [];
  paused.host.log.warn = (...args) => warnings.push(args);
  const pausedRun = new RoutineRunStore(paused.store).enqueue(pausedJob, new Date().toISOString());
  const pausedLedger = await finish(paused.host, paused.store);
  assert.equal(paused.rooms.messages(paused.principal, paused.room.id).messages.length, 0);
  assert.equal(pausedLedger.get(pausedRun.id).roomDelivery.status, 'skipped');
  assert.equal(pausedLedger.get(pausedRun.id).roomDelivery.reason, 'room_paused');
  assert.ok(paused.store.listMessages(pausedLedger.get(pausedRun.id).mainSessionId).some(message => JSON.stringify(message).includes(pausedRun.id)));
  assert.ok(warnings.length > 0);
  paused.store.db.close();

  const removed = fixture('after removal');
  const removedJob = createCronJob(removed.host, { botId: removed.bot.id, userId: removed.principal.userId, tenantId: removed.principal.tenantId, name: 'left', prompt: 'check', intervalMs: 60000, roomId: removed.room.id });
  removed.rooms.removeMember(removed.principal, removed.room.id, removed.bot.id);
  const removedRun = new RoutineRunStore(removed.store).enqueue(removedJob, new Date().toISOString());
  const removedLedger = await finish(removed.host, removed.store);
  assert.equal(removed.rooms.messages(removed.principal, removed.room.id).messages.length, 0);
  assert.equal(removedLedger.get(removedRun.id).roomDelivery.status, 'skipped');
  assert.equal(removedLedger.get(removedRun.id).roomDelivery.reason, 'bot_not_member');
  assert.ok(removed.store.listMessages(removedLedger.get(removedRun.id).mainSessionId).length > 0);
  removed.store.db.close();

  const orphaned = fixture('owner gone');
  const orphanedJob = createCronJob(orphaned.host, { botId: orphaned.bot.id, userId: orphaned.principal.userId, tenantId: orphaned.principal.tenantId, name: 'orphan', prompt: 'check', intervalMs: 60000, roomId: orphaned.room.id });
  const orphanedRun = new RoutineRunStore(orphaned.store).enqueue(orphanedJob, new Date().toISOString());
  orphaned.store.deleteSession(orphanedJob.sessionId);
  orphaned.store.db.prepare('DELETE FROM bots WHERE id=?').run(orphaned.bot.id);
  const orphanedLedger = await finish(orphaned.host, orphaned.store);
  const orphanedDone = orphanedLedger.get(orphanedRun.id);
  assert.equal(orphanedDone.status, 'failed');
  assert.equal(orphanedDone.roomDelivery, undefined);
  assert.equal(orphaned.rooms.messages(orphaned.principal, orphaned.room.id).messages.length, 0);
  orphaned.store.db.close();
});

test('deliverBotRoomMessage is idempotent and does not start a room turn [AC:bot-routine-lifecycle#AC-14]', () => {
  const { store, principal, bot, rooms, room } = fixture();
  const first = deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: '  once  ', idempotencyKey: 'routine:run:1' });
  const second = deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'once', idempotencyKey: 'routine:run:1' });
  assert.equal(first.delivered, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(first.message.text, 'once');
  assert.equal(rooms.messages(principal, room.id).messages.length, 1);
  assert.equal(rooms.turns(principal, room.id).length, 0);
  assert.equal(deliverBotRoomMessage(store, { roomId: 'missing', botId: bot.id, principal, text: 'no', idempotencyKey: 'k' }).reason, 'room_missing');
  assert.equal(deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal: { userId: 'bob' }, text: 'no', idempotencyKey: 'k2' }).reason, 'principal_mismatch');
  rooms.patch(principal, room.id, { status: 'paused' });
  assert.equal(deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'no', idempotencyKey: 'k3' }).reason, 'room_paused');
  rooms.patch(principal, room.id, { status: 'active' });
  rooms.removeMember(principal, room.id, bot.id);
  assert.equal(deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'no', idempotencyKey: 'k4' }).reason, 'bot_not_member');
  rooms.addMember(principal, room.id, bot.id);
  const current = rooms.get(principal, room.id);
  current.botIds.push('missing-bot');
  store.db.prepare('UPDATE bot_rooms SET data=? WHERE id=?').run(JSON.stringify(current), room.id);
  assert.equal(deliverBotRoomMessage(store, { roomId: room.id, botId: 'missing-bot', principal, text: 'no', idempotencyKey: 'k5' }).reason, 'bot_missing');
  assert.equal(deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: '   ', idempotencyKey: 'k6' }).reason, 'empty');
  const beforeSilent = rooms.messages(principal, room.id).messages.length;
  const silentPost = deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: ' [SILENT] ', idempotencyKey: 'k-silent' });
  assert.equal(silentPost.delivered, false);
  assert.equal(silentPost.reason, 'silent');
  assert.equal(rooms.messages(principal, room.id).messages.length, beforeSilent);
  assert.equal(deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'no', idempotencyKey: '   ' }).reason, 'invalid_key');
  assert.equal(deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'no', idempotencyKey: 'k'.repeat(201) }).reason, 'invalid_key');
  const long = deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'x'.repeat(9000), idempotencyKey: 'long' });
  assert.equal(long.message.text.length, 8000);
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql, ...rest) => {
    const statement = prepare(sql, ...rest);
    if (!String(sql).startsWith('INSERT INTO bot_room_messages')) return statement;
    store.db.prepare = prepare;
    return { run() { throw Object.assign(new Error('UNIQUE constraint failed'), { errcode: 2067, code: 'ERR_SQLITE_ERROR' }); } };
  };
  const raced = deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'race', idempotencyKey: 'race' });
  assert.equal(raced.delivered, false);
  assert.equal(raced.reason, 'conflict');
  const winner = { id: 'winner', roomId: room.id, seq: 51, sender: { type: 'bot', id: bot.id, name: bot.name }, text: 'won', attachmentIds: [], createdAt: new Date().toISOString() };
  const insert = prepare('INSERT INTO bot_room_messages(id,room_id,seq,idem_key,data) VALUES(?,?,?,?,?)');
  let planted = false;
  store.db.prepare = (sql, ...rest) => {
    const statement = prepare(sql, ...rest);
    if (!planted && String(sql).startsWith('INSERT INTO bot_room_messages')) {
      planted = true;
      return { run(...args) { insert.run(winner.id, room.id, winner.seq, 'tie', JSON.stringify(winner)); return statement.run(...args); } };
    }
    return statement;
  };
  const tied = deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'tie', idempotencyKey: 'tie' });
  assert.equal(tied.delivered, true);
  assert.equal(tied.message.id, 'winner');
  store.db.prepare = (sql, ...rest) => {
    const statement = prepare(sql, ...rest);
    if (String(sql).startsWith('INSERT INTO bot_room_messages')) return { run() { throw Object.assign(new Error('disk full'), { code: 'SQLITE_IOERR' }); } };
    return statement;
  };
  assert.throws(() => deliverBotRoomMessage(store, { roomId: room.id, botId: bot.id, principal, text: 'boom', idempotencyKey: 'boom' }), /disk full/);
  store.db.close();
});
