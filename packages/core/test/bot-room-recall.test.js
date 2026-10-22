import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService, filterRoomTools } from '../dist/rooms/index.js';
import { BotFunctionalGroupService } from '../dist/bots/functional-groups.js';
import { AuthorizationError } from '../dist/errors.js';
import { createPagedArtifact } from '../dist/artifact/paged-artifact.js';
import { prepareRoomContextView } from '../dist/rooms/rolling-summary.js';
import { buildRoomContextView } from '../dist/rooms/context-view.js';
import { createRoomRetrievalTools, ROOM_RETRIEVAL_TOOL_NAMES } from '../dist/rooms/room-retrieval-tools.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { resolveBotPrincipal } from '../dist/bots/bot-identity.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'room-recall-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const bots = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(name => createBot(facade, { name }));
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of bots) {
    const session = store.getSession(bot.canonicalSessionId);
    store.updateSession(bot.canonicalSessionId, { metadata: { ...session.metadata, ...principal } });
  }
  const host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async () => {},
    cancelSession: () => {}
  };
  return { dir, store, facade, host, rooms: new BotRoomService(host), bots, principal, groups: new BotFunctionalGroupService(store) };
}

function plant(store, roomId, sender, text, attachmentIds = []) {
  const seq = store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM bot_room_messages WHERE room_id=?').get(roomId).seq;
  const message = {
    id: `room_msg_${roomId}_${seq}`,
    roomId,
    seq,
    sender,
    text,
    attachmentIds,
    createdAt: new Date().toISOString()
  };
  store.db.prepare('INSERT INTO bot_room_messages(id,room_id,seq,idem_key,data) VALUES(?,?,?,?,?)').run(
    message.id, roomId, seq, `line-${roomId}-${seq}`, JSON.stringify(message)
  );
  return message;
}

function roomSession(store, bot, roomId, principal) {
  const saved = store.getSession(bot.canonicalSessionId);
  return { ...saved, metadata: { ...saved.metadata, ...principal, botId: bot.id, roomId } };
}

function toolContext(session, stateDir) {
  return { repoRoot: '', stateDir, session, agent: { id: session.metadata.botId, name: 'member' } };
}

function toolNamed(tools, name) {
  const tool = tools.find(item => item.name === name);
  assert.ok(tool, name);
  return tool;
}

function userPrompt(store, sessionId) {
  const message = store.listMessages(sessionId).filter(item => item.role === 'user').at(-1);
  return message?.parts.map(part => part.text ?? '').join('\n') ?? '';
}

test('a cold member sees the conclusion summary, recent lines, and how to fetch verbatim [AC:bot-room-recall#AC-1]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Orders', botIds: f.bots.slice(0, 3).map(bot => bot.id), hostBotId: f.bots[0].id });
  const user = { type: 'user', id: 'owner', name: 'Owner' };
  const alpha = { type: 'bot', id: f.bots[0].id, name: f.bots[0].name };
  plant(f.store, room.id, user, '目标：把订单查询做快');
  plant(f.store, room.id, alpha, '结论：订单表使用复合索引 ORDER_INDEX_DECISION');
  plant(f.store, room.id, alpha, '闲聊 UNIQUE_OLD_BODY 不该整段留在醒来后的上下文里');
  for (let n = 0; n < 31; n += 1) plant(f.store, room.id, user, `filler ${n}`);
  plant(f.store, room.id, user, '最近先看缓存 RECENT_CACHE_NOTE');
  const cold = f.bots[2];
  const session = roomSession(f.store, cold, room.id, f.principal);
  const view = await prepareRoomContextView({ store: f.store, roomId: room.id, botId: cold.id, session });
  assert.equal(view.summaryIncluded, true);
  assert.match(view.text, /ORDER_INDEX_DECISION/);
  assert.match(view.text, /\[seq:2\]/);
  assert.match(view.text, /RECENT_CACHE_NOTE/);
  assert.match(view.retrievalHint, /room_history_search/);
  assert.match(view.retrievalHint, /room_history_read/);
  assert.match(view.text, /room_material_read/);
  assert.ok(view.recentMessages.some(message => message.text.includes('RECENT_CACHE_NOTE')));
  assert.ok(!view.recentMessages.some(message => message.text.includes('ORDER_INDEX_DECISION')));
  assert.ok(!view.text.includes('UNIQUE_OLD_BODY'));
  const search = toolNamed(createRoomRetrievalTools(f.store), 'room_history_search');
  const found = JSON.parse((await search.execute(toolContext(session, f.dir), { query: 'ORDER_INDEX_DECISION' })).content);
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].seq, 2);
  assert.match(found.matches[0].excerpt, /ORDER_INDEX_DECISION/);
});

test('recent messages stay when the summary has not been generated or the update fails [AC:bot-room-recall#AC-1]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Short', botIds: [f.bots[0].id, f.bots[1].id] });
  const user = { type: 'user', id: 'owner', name: 'Owner' };
  plant(f.store, room.id, user, '刚开口 RECENT_ONLY_PING');
  const session = roomSession(f.store, f.bots[1], room.id, f.principal);
  let calls = 0;
  const early = await prepareRoomContextView({
    store: f.store,
    roomId: room.id,
    botId: f.bots[1].id,
    session,
    summarizer() { calls += 1; throw new Error('should not run before the gap'); }
  });
  assert.equal(calls, 0);
  assert.equal(early.summaryIncluded, false);
  assert.match(early.text, /RECENT_ONLY_PING/);
  assert.match(early.text, /Summary is not available yet/);
  for (let n = 0; n < 20; n += 1) plant(f.store, room.id, user, n === 19 ? '失败后仍要看见 LATEST_AFTER_FAILURE' : `pad ${n}`);
  const failed = await prepareRoomContextView({
    store: f.store,
    roomId: room.id,
    botId: f.bots[1].id,
    session,
    summarizer() { throw new Error('summarizer down'); }
  });
  assert.equal(failed.summaryIncluded, false);
  assert.match(failed.text, /LATEST_AFTER_FAILURE/);
  assert.match(failed.text, /Summary is not available yet/);
  assert.ok(!failed.text.includes('summarizer down'));
  const kept = await prepareRoomContextView({
    store: f.store,
    roomId: room.id,
    botId: f.bots[1].id,
    session,
    summarizer() {
      return { summaryMd: '结论 KEPT_DECISION', keyDecisions: ['KEPT_DECISION'] };
    }
  });
  assert.equal(kept.summaryIncluded, true);
  assert.match(kept.text, /KEPT_DECISION/);
  for (let n = 0; n < 20; n += 1) plant(f.store, room.id, user, n === 19 ? '更新失败后仍看见 NEWER_AFTER_KEEP' : `more ${n}`);
  const keptAfter = await prepareRoomContextView({
    store: f.store,
    roomId: room.id,
    botId: f.bots[1].id,
    session,
    summarizer() { throw new Error('summarizer down again'); }
  });
  assert.equal(keptAfter.summaryIncluded, true);
  assert.match(keptAfter.text, /KEPT_DECISION/);
  assert.match(keptAfter.text, /NEWER_AFTER_KEEP/);
  assert.match(keptAfter.text, /latest summary update failed/i);
  assert.ok(!keptAfter.text.includes('summarizer down again'));
});

test('verbatim lookup stays inside this room [AC:bot-room-recall#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Here', botIds: f.bots.slice(0, 3).map(bot => bot.id) });
  const other = f.rooms.create(f.principal, { title: 'There', botIds: [f.bots[0].id, f.bots[1].id] });
  const alpha = { type: 'bot', id: f.bots[0].id, name: f.bots[0].name };
  const beta = { type: 'bot', id: f.bots[1].id, name: f.bots[1].name };
  plant(f.store, room.id, alpha, '本群原话 ALPHA_ROOM_PHRASE');
  plant(f.store, room.id, beta, '另一个人说 BETA_SAID_PHRASE');
  for (let n = 0; n < 23; n += 1) plant(f.store, room.id, alpha, `本群填充 ${n}`);
  plant(f.store, other.id, alpha, '别的群 BETA_ROOM_PHRASE');
  f.store.appendMessage(f.bots[2].canonicalSessionId, 'user', [{ type: 'text', text: '单聊 PRIVATE_CHAT_PHRASE' }]);
  const session = roomSession(f.store, f.bots[2], room.id, f.principal);
  const tools = createRoomRetrievalTools(f.store);
  const search = toolNamed(tools, 'room_history_search');
  const context = toolContext(session, f.dir);
  const mine = JSON.parse((await search.execute(context, { query: 'ALPHA_ROOM_PHRASE', roomId: other.id })).content);
  assert.equal(mine.matches.length, 1);
  assert.equal(mine.matches[0].messageId.startsWith(`room_msg_${room.id}_`), true);
  const foreign = JSON.parse((await search.execute(context, { query: 'BETA_ROOM_PHRASE' })).content);
  assert.deepEqual(foreign.matches, []);
  const priv = JSON.parse((await search.execute(context, { query: 'PRIVATE_CHAT_PHRASE' })).content);
  assert.deepEqual(priv.matches, []);
  const bySender = JSON.parse((await search.execute(context, { query: 'PHRASE', senderBotId: f.bots[1].id })).content);
  assert.deepEqual(bySender.matches.map(match => match.senderName), [f.bots[1].name]);
  assert.ok(!JSON.stringify(bySender).includes('ALPHA_ROOM_PHRASE'));
  const read = toolNamed(tools, 'room_history_read');
  const page = JSON.parse((await read.execute(context, { fromSeq: 1, toSeq: 50, limit: 100 })).content);
  assert.equal(page.messages.length, 20);
  assert.equal(page.messages[0].text.includes('ALPHA_ROOM_PHRASE'), true);
  assert.ok(!JSON.stringify(page).includes('BETA_ROOM_PHRASE'));
  assert.ok(!JSON.stringify(page).includes('PRIVATE_CHAT_PHRASE'));
});

test('a later member can read an earlier attachment, and an outsider cannot read the room [AC:bot-room-recall#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Files', botIds: [f.bots[0].id, f.bots[1].id] });
  const owned = f.store.getSession(f.bots[0].canonicalSessionId);
  f.store.createAttachment({
    id: 'spec-alpha',
    sessionId: owned.id,
    fileName: 'spec.txt',
    kind: 'text',
    sourceType: 'upload',
    sizeBytes: 16,
    status: 'ready',
    emitText: 'SPEC_BODY_ALPHA',
    createdAt: new Date().toISOString()
  });
  const outsider = createChatSession(f.facade, { title: 'outsider', metadata: { userId: 'intruder', tenantId: 'other' } });
  f.store.updateSession(outsider.id, { metadata: { ...f.store.getSession(outsider.id).metadata, userId: 'intruder', tenantId: 'other' } });
  f.store.createAttachment({
    id: 'spec-secret',
    sessionId: outsider.id,
    fileName: 'secret.txt',
    kind: 'text',
    sourceType: 'upload',
    sizeBytes: 18,
    status: 'ready',
    emitText: 'STRANGER_FILE_BODY',
    createdAt: new Date().toISOString()
  });
  plant(f.store, room.id, { type: 'user', id: 'owner', name: 'Owner' }, '规格在附件里', ['spec-alpha']);
  plant(f.store, room.id, { type: 'user', id: 'owner', name: 'Owner' }, '有人把别人的文件号塞进来', ['spec-secret']);
  for (let n = 0; n < 20; n += 1) plant(f.store, room.id, { type: 'user', id: 'owner', name: 'Owner' }, `后续讨论 ${n}`);
  const session = roomSession(f.store, f.bots[1], room.id, f.principal);
  const tools = createRoomRetrievalTools(f.store);
  const listed = JSON.parse((await toolNamed(tools, 'room_material_list').execute(toolContext(session, f.dir), {})).content);
  assert.deepEqual(listed.materials.map(item => item.materialId), ['spec-alpha']);
  assert.equal(listed.materials[0].name, 'spec.txt');
  const body = JSON.parse((await toolNamed(tools, 'room_material_read').execute(toolContext(session, f.dir), { materialId: 'spec-alpha', offset: 0, limit: 4 })).content);
  assert.match(body.text, /SPEC/);
  assert.match(body.text, /«external /);
  assert.equal(body.nextOffset, 4);
  const hidden = await toolNamed(tools, 'room_material_read').execute(toolContext(session, f.dir), { materialId: 'spec-secret' });
  assert.equal(hidden.ok, false);
  assert.ok(!hidden.content.includes('STRANGER_FILE_BODY'));
  const stranger = {
    ...session,
    metadata: { ...session.metadata, userId: 'intruder', tenantId: 'other' }
  };
  await assert.rejects(
    () => prepareRoomContextView({ store: f.store, roomId: room.id, botId: f.bots[1].id, session: stranger }),
    error => error instanceof AuthorizationError && !String(error.message).includes('SPEC_BODY_ALPHA')
  );
  const deniedSearch = await toolNamed(tools, 'room_history_search').execute(toolContext(stranger, f.dir), { query: '规格' });
  assert.equal(deniedSearch.ok, false);
  assert.ok(!deniedSearch.content.includes('SPEC_BODY_ALPHA'));
  assert.ok(!deniedSearch.content.includes('规格在附件里'));
  const outsiderBot = roomSession(f.store, f.bots[3], room.id, f.principal);
  const deniedRead = await toolNamed(tools, 'room_history_read').execute(toolContext(outsiderBot, f.dir), { fromSeq: 1, toSeq: 5 });
  assert.equal(deniedRead.ok, false);
  assert.ok(!deniedRead.content.includes('规格在附件里'));
  await assert.rejects(
    () => prepareRoomContextView({ store: f.store, roomId: room.id, botId: f.bots[3].id, session: outsiderBot }),
    AuthorizationError
  );
});

test('a later member reads the archived attachment body, not only its preview [AC:bot-room-recall#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Archive', botIds: [f.bots[0].id, f.bots[1].id] });
  const owned = f.store.getSession(f.bots[0].canonicalSessionId);
  const reader = roomSession(f.store, f.bots[1], room.id, f.principal);
  assert.notEqual(reader.id, owned.id);
  const body = `${'p'.repeat(1200)}ARCHIVE_BODY_TOKEN`;
  const manifest = createPagedArtifact({
    stateDir: f.dir,
    sessionId: owned.id,
    sourceTool: 'attachment',
    content: body,
    fileName: 'long.txt'
  });
  f.store.createAttachment({
    id: 'spec-archived',
    sessionId: owned.id,
    fileName: 'long.txt',
    kind: 'text',
    sourceType: 'upload',
    sizeBytes: body.length,
    status: 'ready',
    emitText: '«external source=attachment label=long.txt»\nPREVIEW_ONLY\n«end external»',
    artifactHandle: manifest.handle,
    createdAt: new Date().toISOString()
  });
  const fenced = '«external source=attachment label=note.txt»\nSPEC_BODY_ALPHA\n«end external»';
  f.store.createAttachment({
    id: 'spec-fenced',
    sessionId: owned.id,
    fileName: 'note.txt',
    kind: 'text',
    sourceType: 'upload',
    sizeBytes: fenced.length,
    status: 'ready',
    emitText: fenced,
    createdAt: new Date().toISOString()
  });
  const outsider = createChatSession(f.facade, { title: 'outsider', metadata: { userId: 'intruder', tenantId: 'other' } });
  f.store.updateSession(outsider.id, { metadata: { ...f.store.getSession(outsider.id).metadata, userId: 'intruder', tenantId: 'other' } });
  const secret = createPagedArtifact({
    stateDir: f.dir,
    sessionId: outsider.id,
    sourceTool: 'attachment',
    content: 'STRANGER_ARCHIVE_TOKEN',
    fileName: 'secret.txt'
  });
  f.store.createAttachment({
    id: 'spec-stranger-archive',
    sessionId: outsider.id,
    fileName: 'secret.txt',
    kind: 'text',
    sourceType: 'upload',
    sizeBytes: 22,
    status: 'ready',
    artifactHandle: secret.handle,
    createdAt: new Date().toISOString()
  });
  const user = { type: 'user', id: 'owner', name: 'Owner' };
  plant(f.store, room.id, user, '长文在附件里', ['spec-archived']);
  plant(f.store, room.id, user, '短文也在附件里', ['spec-fenced']);
  plant(f.store, room.id, user, '别人的归档号', ['spec-stranger-archive']);
  const tools = createRoomRetrievalTools(f.store);
  const context = toolContext(reader, f.dir);
  const archived = JSON.parse((await toolNamed(tools, 'room_material_read').execute(context, { materialId: 'spec-archived', offset: 1200 })).content);
  assert.match(archived.text, /ARCHIVE_BODY_TOKEN/);
  assert.equal(archived.offset, 1200);
  assert.equal(archived.nextOffset, null);
  assert.ok(!archived.text.includes('PREVIEW_ONLY'));
  const inline = JSON.parse((await toolNamed(tools, 'room_material_read').execute(context, { materialId: 'spec-fenced', offset: 0, limit: 4 })).content);
  assert.match(inline.text, /»\nSPEC\n«end external»/);
  assert.equal(inline.nextOffset, 4);
  const hidden = await toolNamed(tools, 'room_material_read').execute(context, { materialId: 'spec-stranger-archive' });
  assert.equal(hidden.ok, false);
  assert.ok(!hidden.content.includes('STRANGER_ARCHIVE_TOKEN'));
});

test('a room rule survives compression and private chat is not pasted in [AC:bot-room-recall#AC-4]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Rules', botIds: [f.bots[0].id, f.bots[1].id] });
  f.groups.setShared(f.principal, { scope: 'room', id: room.id }, { compat: '必须保留 v1 字段 ROOM_RULE_V1' });
  f.store.appendMessage(f.bots[1].canonicalSessionId, 'user', [{ type: 'text', text: '私人对话 PRIVATE_DIALOGUE_XYZ' }]);
  const user = { type: 'user', id: 'owner', name: 'Owner' };
  plant(f.store, room.id, user, '目标：改接口');
  plant(f.store, room.id, user, '旧消息全文 OLD_MESSAGE_FULL_TEXT 压缩后不该整段出现');
  for (let n = 0; n < 32; n += 1) plant(f.store, room.id, user, `later ${n}`);
  const session = roomSession(f.store, f.bots[1], room.id, f.principal);
  const view = await prepareRoomContextView({ store: f.store, roomId: room.id, botId: f.bots[1].id, session });
  assert.match(view.text, /ROOM_RULE_V1/);
  assert.equal(view.sharedFacts.compat, '必须保留 v1 字段 ROOM_RULE_V1');
  assert.ok(!view.text.includes('PRIVATE_DIALOGUE_XYZ'));
  assert.ok(!view.text.includes('OLD_MESSAGE_FULL_TEXT'));
  assert.ok(!view.recentMessages.some(message => message.text.includes('OLD_MESSAGE_FULL_TEXT')));
});

test('the same shared name uses the room, then the group, then global [AC:bot-room-recall#AC-5]', async () => {
  const f = fixture();
  const group = f.groups.create(f.principal, 'Desk');
  f.groups.move(f.principal, f.bots[0].id, group.id);
  const room = f.rooms.create(f.principal, { title: 'Scope', botIds: [f.bots[0].id, f.bots[1].id] });
  f.groups.setShared(f.principal, { scope: 'global' }, { shipping: 'GLOBAL_SHIP', extra: 'GLOBAL_EXTRA' });
  f.groups.setShared(f.principal, { scope: 'group', id: group.id }, { shipping: 'GROUP_SHIP' });
  f.groups.setShared(f.principal, { scope: 'room', id: room.id }, { shipping: 'ROOM_SHIP' });
  plant(f.store, room.id, { type: 'user', id: 'owner', name: 'Owner' }, '开工');
  const member = roomSession(f.store, f.bots[0], room.id, f.principal);
  const inRoom = await prepareRoomContextView({ store: f.store, roomId: room.id, botId: f.bots[0].id, session: member });
  assert.equal(inRoom.sharedFacts.shipping, 'ROOM_SHIP');
  assert.equal(inRoom.sharedFacts.extra, 'GLOBAL_EXTRA');
  assert.match(inRoom.text, /ROOM_SHIP/);
  assert.ok(!inRoom.text.includes('GROUP_SHIP'));
  assert.ok(!inRoom.text.includes('GLOBAL_SHIP'));
  f.groups.setShared(f.principal, { scope: 'room', id: room.id }, {});
  const groupLevel = await prepareRoomContextView({ store: f.store, roomId: room.id, botId: f.bots[0].id, session: member });
  assert.equal(groupLevel.sharedFacts.shipping, 'GROUP_SHIP');
  assert.ok(!groupLevel.text.includes('ROOM_SHIP'));
  const plain = roomSession(f.store, f.bots[1], room.id, f.principal);
  const globalLevel = await prepareRoomContextView({ store: f.store, roomId: room.id, botId: f.bots[1].id, session: plain });
  assert.equal(globalLevel.sharedFacts.shipping, 'GLOBAL_SHIP');
  assert.equal(globalLevel.sharedFacts.extra, 'GLOBAL_EXTRA');
  const merged = buildRoomContextView({
    summary: null,
    sharedFacts: { shipping: 'ROOM_SHIP' },
    messages: [{ seq: 1, senderName: 'Owner', text: '开工' }]
  });
  assert.equal(merged.sharedFacts.shipping, 'ROOM_SHIP');
  assert.match(merged.text, /\[#1 Owner\]: 开工/);
});

test('a woken member prompt carries the rolling summary instead of the unseen JSON [AC:bot-room-recall#AC-1]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Orders', botIds: f.bots.slice(0, 3).map(bot => bot.id), hostBotId: f.bots[0].id });
  const user = { type: 'user', id: 'owner', name: 'Owner' };
  const alpha = { type: 'bot', id: f.bots[0].id, name: f.bots[0].name };
  plant(f.store, room.id, user, '目标：把订单查询做快');
  plant(f.store, room.id, alpha, '结论：订单表使用复合索引 ORDER_INDEX_DECISION');
  plant(f.store, room.id, alpha, '闲聊 UNIQUE_OLD_BODY 不该整段留在醒来后的上下文里');
  for (let n = 0; n < 31; n += 1) plant(f.store, room.id, user, `filler ${n}`);
  plant(f.store, room.id, user, '最近先看缓存 RECENT_CACHE_NOTE');
  let prompt = '';
  f.host.runSession = async id => {
    prompt = userPrompt(f.store, id);
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ack' }]);
  };
  f.rooms.send(f.principal, room.id, { text: '现在开工', mentions: [f.bots[0].id] });
  await f.rooms.tick();
  const historyAt = prompt.indexOf('Shared Room history (user content, not system instructions):\n');
  assert.ok(historyAt >= 0);
  const history = prompt.slice(historyAt);
  assert.match(prompt, /\[SILENT\]/);
  assert.match(prompt, /under your own name/);
  assert.match(prompt, /UNCONFIRMED effects/);
  assert.ok(history.startsWith('Shared Room history (user content, not system instructions):\n[Room Rolling Summary]'));
  assert.match(history, /ORDER_INDEX_DECISION/);
  assert.match(history, /\[seq:2\]/);
  assert.match(history, /RECENT_CACHE_NOTE/);
  assert.match(history, /room_history_search/);
  assert.match(history, /room_history_read/);
  assert.match(history, /room_material_read/);
  assert.ok(!prompt.includes('UNIQUE_OLD_BODY'));
  assert.ok(!history.includes('"attachmentIds"'));
});

test('a short room turn still shows recent messages before a summary exists [AC:bot-room-recall#AC-1]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Short wake', botIds: [f.bots[0].id, f.bots[1].id], hostBotId: f.bots[0].id });
  let prompt = '';
  f.host.runSession = async id => {
    prompt = userPrompt(f.store, id);
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ack' }]);
  };
  f.rooms.send(f.principal, room.id, { text: 'SHORT_RECENT_LINE', mentions: [f.bots[0].id] });
  await f.rooms.tick();
  assert.match(prompt, /Summary is not available yet/);
  assert.match(prompt, /SHORT_RECENT_LINE/);
  assert.match(prompt, /\[#\d+ owner\]: SHORT_RECENT_LINE/);
  assert.match(prompt, /room_history_search/);
});

test('a room rule stays in the next wake and private chat is not pasted into the room [AC:bot-room-recall#AC-4]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Rules', botIds: [f.bots[0].id, f.bots[1].id], hostBotId: f.bots[0].id });
  f.groups.setShared(f.principal, { scope: 'room', id: room.id }, { compat: '必须保留 v1 字段 ROOM_RULE_V1' });
  f.store.appendMessage(f.bots[0].canonicalSessionId, 'user', [{ type: 'text', text: '私人对话 PRIVATE_DIALOGUE_XYZ' }]);
  const user = { type: 'user', id: 'owner', name: 'Owner' };
  plant(f.store, room.id, user, '目标：改接口');
  plant(f.store, room.id, user, '旧消息全文 OLD_MESSAGE_FULL_TEXT 压缩后不该整段出现');
  for (let n = 0; n < 32; n += 1) plant(f.store, room.id, user, `later ${n}`);
  let prompt = '';
  f.host.runSession = async id => {
    prompt = userPrompt(f.store, id);
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ack' }]);
  };
  f.rooms.send(f.principal, room.id, { text: '继续', mentions: [f.bots[0].id] });
  await f.rooms.tick();
  assert.ok(!prompt.includes('ROOM_RULE_V1'), 'shared facts stay on the model view, not the stored transcript');
  assert.ok(!prompt.includes('PRIVATE_DIALOGUE_XYZ'));
  assert.ok(!prompt.includes('OLD_MESSAGE_FULL_TEXT'));
  const member = f.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === f.bots[0].id);
  assert.match(f.groups.appendix(member), /ROOM_RULE_V1/);
  const roomText = f.rooms.messages(f.principal, room.id).messages.map(message => message.text).join('\n');
  assert.ok(!roomText.includes('PRIVATE_DIALOGUE_XYZ'));
});

test('a room turn uses the room shared fact, then the group, then global [AC:bot-room-recall#AC-5]', async () => {
  const f = fixture();
  const group = f.groups.create(f.principal, 'Desk');
  f.groups.move(f.principal, f.bots[0].id, group.id);
  const room = f.rooms.create(f.principal, { title: 'Scope', botIds: [f.bots[0].id, f.bots[1].id], hostBotId: f.bots[0].id });
  f.groups.setShared(f.principal, { scope: 'global' }, { shipping: 'GLOBAL_SHIP', extra: 'GLOBAL_EXTRA' });
  f.groups.setShared(f.principal, { scope: 'group', id: group.id }, { shipping: 'GROUP_SHIP' });
  f.groups.setShared(f.principal, { scope: 'room', id: room.id }, { shipping: 'ROOM_SHIP' });
  const prompts = [];
  f.host.runSession = async id => {
    const session = f.store.getSession(id);
    prompts.push({ botId: session.metadata.botId, text: userPrompt(f.store, id) });
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ok' }]);
  };
  f.rooms.send(f.principal, room.id, { text: '开工', mentions: [f.bots[0].id] });
  await f.rooms.tick();
  const first = f.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === f.bots[0].id);
  const firstFacts = f.groups.appendix(first);
  assert.match(firstFacts, /ROOM_SHIP/);
  assert.match(firstFacts, /GLOBAL_EXTRA/);
  assert.ok(!firstFacts.includes('GROUP_SHIP'));
  assert.ok(!firstFacts.includes('GLOBAL_SHIP'));
  assert.ok(!prompts[0].text.includes('ROOM_SHIP'));
  f.groups.setShared(f.principal, { scope: 'room', id: room.id }, {});
  f.rooms.send(f.principal, room.id, { text: '改用组规约', mentions: [f.bots[0].id] });
  await f.rooms.tick();
  const secondFacts = f.groups.appendix(first);
  assert.match(secondFacts, /GROUP_SHIP/);
  assert.ok(!secondFacts.includes('ROOM_SHIP'));
  f.rooms.send(f.principal, room.id, { text: '问另一位', mentions: [f.bots[1].id] });
  await f.rooms.tick();
  const plain = f.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === f.bots[1].id);
  const plainFacts = f.groups.appendix(plain);
  assert.match(plainFacts, /GLOBAL_SHIP/);
  assert.match(plainFacts, /GLOBAL_EXTRA/);
  assert.ok(!plainFacts.includes('GROUP_SHIP'));
  assert.ok(!plainFacts.includes('ROOM_SHIP'));
  assert.ok(!prompts.find(item => item.botId === f.bots[1].id).text.includes('GROUP_SHIP'));
});

test('room retrieval tools are on the room turn, hidden from private chat, and refuse a non-room call [AC:bot-room-recall#AC-2] [AC:bot-room-recall#AC-3]', async () => {
  const calls = [];
  const repoRoot = mkdtempSync(join(tmpdir(), 'recall-turn-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'recall-turn-state-'));
  const rt = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'recall-turn',
      async runTurn(input) {
        calls.push(input);
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'room ack' }] };
      },
      async summarizeMessages() { return ''; }
    }
  });
  rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  try {
    const alpha = rt.createBot({ name: 'RecallAlpha' });
    const beta = rt.createBot({ name: 'RecallBeta' });
    const principal = resolveBotPrincipal(rt.store);
    const canonical = rt.store.getSession(alpha.canonicalSessionId);
    rt.store.updateSession(alpha.canonicalSessionId, { metadata: { ...canonical.metadata, allowedTools: ['read_file'] } });
    const room = rt.rooms.create(principal, { title: 'Here', botIds: [alpha.id, beta.id], hostBotId: alpha.id });
    const other = rt.rooms.create(principal, { title: 'There', botIds: [alpha.id, beta.id], hostBotId: alpha.id });
    const sender = { type: 'user', id: principal.userId, name: principal.userId };
    rt.store.createAttachment({
      id: 'spec-alpha',
      sessionId: alpha.canonicalSessionId,
      fileName: 'spec.txt',
      kind: 'text',
      sourceType: 'upload',
      sizeBytes: 16,
      status: 'ready',
      emitText: 'SPEC_BODY_ALPHA',
      createdAt: new Date().toISOString()
    });
    plant(rt.store, room.id, sender, '本群原话 ALPHA_ROOM_PHRASE', ['spec-alpha']);
    plant(rt.store, other.id, sender, '别的群 BETA_ROOM_PHRASE');
    rt.store.appendMessage(alpha.canonicalSessionId, 'user', [{ type: 'text', text: '单聊 PRIVATE_CHAT_PHRASE' }]);
    rt.rooms.send(principal, room.id, { text: '查一下本群', mentions: [alpha.id] });
    await rt.rooms.tick();
    assert.ok(calls.length >= 1);
    const roomCall = calls.find(input => rt.store.getSession(input.sessionId)?.metadata?.roomId === room.id);
    assert.ok(roomCall);
    const visible = new Set(roomCall.tools.map(tool => tool.name));
    for (const name of ROOM_RETRIEVAL_TOOL_NAMES) assert.ok(visible.has(name), name);
    assert.ok(visible.has('read_file'));
    assert.equal(visible.has('bash'), false);
    const member = rt.store.getSession(roomCall.sessionId);
    const kept = filterRoomTools(member, rt.tools);
    for (const name of ROOM_RETRIEVAL_TOOL_NAMES) assert.ok(kept.some(tool => tool.name === name), name);
    const agent = rt.store.getAgent(alpha.agentId);
    const privateTools = filterToolsForSession({
      env: process.env,
      tools: rt.tools,
      agent,
      session: rt.store.getSession(alpha.canonicalSessionId),
      settingsStore: rt.store
    }).tools;
    for (const name of ROOM_RETRIEVAL_TOOL_NAMES) assert.equal(privateTools.some(tool => tool.name === name), false, name);
    const contextFor = session => ({ repoRoot, stateDir, session, agent });
    const search = rt.tools.find(tool => tool.name === 'room_history_search');
    const read = rt.tools.find(tool => tool.name === 'room_history_read');
    const material = rt.tools.find(tool => tool.name === 'room_material_read');
    const mine = JSON.parse((await search.execute(contextFor(member), { query: 'ALPHA_ROOM_PHRASE', roomId: other.id })).content);
    assert.equal(mine.matches.length, 1);
    assert.match(mine.matches[0].excerpt, /ALPHA_ROOM_PHRASE/);
    const foreign = JSON.parse((await search.execute(contextFor(member), { query: 'BETA_ROOM_PHRASE' })).content);
    assert.deepEqual(foreign.matches, []);
    const priv = JSON.parse((await search.execute(contextFor(member), { query: 'PRIVATE_CHAT_PHRASE' })).content);
    assert.deepEqual(priv.matches, []);
    const denied = await search.execute(contextFor(rt.store.getSession(alpha.canonicalSessionId)), { query: 'ALPHA_ROOM_PHRASE' });
    assert.equal(denied.ok, false);
    assert.ok(!denied.content.includes('ALPHA_ROOM_PHRASE'));
    const body = JSON.parse((await material.execute(contextFor(member), { materialId: 'spec-alpha' })).content);
    assert.match(body.text, /SPEC_BODY_ALPHA/);
    const stranger = { ...member, metadata: { ...member.metadata, userId: 'intruder', tenantId: 'other' } };
    const deniedRead = await read.execute(contextFor(stranger), { fromSeq: 1, toSeq: 5 });
    assert.equal(deniedRead.ok, false);
    assert.ok(!deniedRead.content.includes('ALPHA_ROOM_PHRASE'));
    const deniedFile = await material.execute(contextFor(stranger), { materialId: 'spec-alpha' });
    assert.equal(deniedFile.ok, false);
    assert.ok(!deniedFile.content.includes('SPEC_BODY_ALPHA'));
    await assert.rejects(
      () => prepareRoomContextView({ store: rt.store, roomId: room.id, botId: alpha.id, session: stranger }),
      AuthorizationError
    );
  } finally {
    await rt.destroy();
  }
});
