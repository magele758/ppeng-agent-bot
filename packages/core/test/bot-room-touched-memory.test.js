import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { saveSemanticFact } from '../dist/memory/memory-writer.js';
import { resolveBotMemoryAgentId } from '../dist/memory/bot-memory-scope.js';
import { resolveBotPrincipal } from '../dist/bots/bot-identity.js';
import { ROOM_HUMAN_STEP_NOTICE } from '../dist/rooms/human-step.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { compileTurnAppendix } from '../dist/session/context-compiler.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import {
  formatTouchedForPrivateChat,
  privateFactsVisibleInRoomTurn,
  privateMemoryAgentId,
  queryTouchedForPrivateChat,
  recordOwnPost,
  recordPushedContext,
  recordRetrieved,
  roomHistoryAfterPrivateDecision,
  roomHistoryKeepingPrivateTranscriptOut
} from '../dist/rooms/touched-memory.js';

const FACT = '阿尔法记住的单聊事实：支付网关回滚顺序是先停写入';
const PRIVATE_TRANSCRIPT = 'PRIVATE_SECRET 只存在于阿尔法单聊原文里的一整段话';
const SUMMARY = '纪要：登录超时先查连接池，不要改表结构';
const RECENT = '最近消息：今晚先看登录超时';
const EARLIER = '更早原话：订单表索引还没建';
const ATTACHMENT = '附件正文：CREATE INDEX idx_orders_user';
const UNREAD_ATTACHMENT = 'UNREAD_ATTACHMENT_BODY 没人用工具读过的附件';
const OWN_POST = '我在群里说过：索引可以后补';
const UNPUSHED = '未推送的群消息：密码轮换计划只在群记录里';
const ONLY_FOR_ALPHA = '只推送给阿尔法的群消息：缓存键要带租户';
const APPROVAL_RESULT = 'PRIVATE_APPROVAL_RESULT 已在私聊里批准并执行';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'touched-mem-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions: () => {},
    wakeAgentSessions: () => {}
  };
  const alpha = createBot(facade, { name: 'Alpha' });
  const beta = createBot(facade, { name: 'Beta' });
  return { store, alpha, beta, close: () => store.db.close() };
}

function roomSession(bot, roomId = 'room_1') {
  return {
    id: `room-session-${bot.id}`,
    agentId: bot.agentId,
    metadata: { botId: bot.id, roomId, userId: 'owner' }
  };
}

function privateBlock(store, botId, roomId) {
  return formatTouchedForPrivateChat(queryTouchedForPrivateChat(store.db, {
    botId,
    ...(roomId ? { roomId } : {})
  }));
}

test('群内发言能用自己的单聊事实，单聊原文不进群，其他成员看不到这份单聊 [AC:bot-room-touched-memory#AC-1]', () => {
  const f = fixture();
  try {
    const saved = saveSemanticFact(f.store.agentMemory(), {
      userId: 'owner',
      category: 'fact',
      content: FACT,
      agentId: f.alpha.agentId
    });
    assert.ok(saved, 'private fact was stored');

    const alphaRoom = roomSession(f.alpha);
    const betaRoom = roomSession(f.beta);
    const child = {
      id: 'child-session',
      mode: 'subagent',
      parentSessionId: alphaRoom.id,
      agentId: 'model-picked-name',
      metadata: { userId: 'owner' }
    };
    const lookup = {
      getBot: (id) => f.store.getBot(id),
      listBots: (opts) => f.store.listBots(opts),
      getSession: (id) => (id === alphaRoom.id ? alphaRoom : undefined)
    };

    assert.equal(privateMemoryAgentId(alphaRoom, lookup), f.alpha.agentId);
    assert.equal(privateMemoryAgentId(child, lookup), f.alpha.agentId);
    assert.equal(resolveBotMemoryAgentId(alphaRoom, lookup), `room:room_1:${f.alpha.agentId}`);
    assert.notEqual(privateMemoryAgentId(alphaRoom, lookup), resolveBotMemoryAgentId(alphaRoom, lookup));

    const memory = f.store.agentMemory();
    assert.ok(privateFactsVisibleInRoomTurn(memory, alphaRoom, lookup).includes(FACT));
    assert.ok(privateFactsVisibleInRoomTurn(memory, child, lookup).includes(FACT));
    assert.equal(privateFactsVisibleInRoomTurn(memory, betaRoom, lookup).includes(FACT), false);
    assert.equal(
      memory.search({
        scope: 'user.memory',
        agentId: `room:room_1:${f.alpha.agentId}`,
        userId: 'owner',
        limit: 10
      }).some((row) => row.value.includes(FACT)),
      false
    );

    const roomMessages = [{ id: 'room-hello', text: '大家好' }];
    const transcript = [
      { id: 'private-1', text: PRIVATE_TRANSCRIPT },
      { id: 'private-2', text: FACT }
    ];
    const visible = roomHistoryKeepingPrivateTranscriptOut(roomMessages, transcript);
    assert.deepEqual(visible.map((message) => message.text), ['大家好']);
    assert.equal(JSON.stringify(visible).includes('PRIVATE_SECRET'), false);
    assert.equal(JSON.stringify(visible).includes(FACT), false);

    assert.equal(privateBlock(f.store, f.alpha.id), '');
    assert.equal(privateBlock(f.store, f.beta.id), '');
    assert.equal(privateBlock(f.store, f.beta.id).includes(PRIVATE_TRANSCRIPT), false);
    assert.equal(privateBlock(f.store, f.beta.id).includes(FACT), false);
  } finally {
    f.close();
  }
});

test('单聊能用上推送的纪要和最近消息、取回的原话和附件，以及自己发过的群消息 [AC:bot-room-touched-memory#AC-2]', () => {
  const f = fixture();
  try {
    const pushed = {
      roomId: 'room_1',
      botId: f.alpha.id,
      turnId: 'turn_1',
      summary: SUMMARY,
      messages: [{
        id: 'msg-recent',
        seq: 8,
        senderId: 'user',
        text: RECENT,
        attachmentIds: ['att-unread']
      }]
    };
    recordPushedContext(f.store.db, pushed);
    recordPushedContext(f.store.db, pushed);
    recordRetrieved(f.store.db, {
      roomId: 'room_1',
      botId: f.alpha.id,
      turnId: 'turn_1',
      message: { id: 'msg-old', seq: 2, text: EARLIER }
    });
    recordRetrieved(f.store.db, {
      roomId: 'room_1',
      botId: f.alpha.id,
      turnId: 'turn_1',
      attachment: { id: 'att-read', name: 'schema.sql', text: ATTACHMENT }
    });
    recordOwnPost(f.store.db, {
      roomId: 'room_1',
      botId: f.alpha.id,
      turnId: 'turn_1',
      message: { id: 'msg-own', seq: 9, text: OWN_POST }
    });

    const records = queryTouchedForPrivateChat(f.store.db, { botId: f.alpha.id });
    assert.equal(records.filter((record) => record.body.includes(RECENT)).length, 1);
    const block = formatTouchedForPrivateChat(records);
    for (const text of [SUMMARY, RECENT, EARLIER, ATTACHMENT, OWN_POST]) {
      assert.ok(block.includes(text), text);
    }
    assert.equal(block.includes(UNREAD_ATTACHMENT), false);
    assert.equal(block.includes(UNPUSHED), false);
    assert.ok(records.some((record) => record.kind === 'summary' && record.body.includes(SUMMARY)));
    assert.ok(records.some((record) => record.kind === 'recent_message' && record.body.includes(RECENT)));
    assert.ok(records.some((record) => record.kind === 'retrieved_message' && record.body.includes(EARLIER)));
    assert.ok(records.some((record) => record.kind === 'retrieved_attachment' && record.body.includes(ATTACHMENT)));
    assert.ok(records.some((record) => record.kind === 'own_post' && record.body.includes(OWN_POST)));
  } finally {
    f.close();
  }
});

test('没推送也没查阅的群消息不进入单聊 [AC:bot-room-touched-memory#AC-3]', () => {
  const f = fixture();
  try {
    const roomCatalog = [
      { id: 'old-1', text: UNPUSHED },
      { id: 'old-2', text: '未入选的群消息：机房门禁卡号' },
      { id: 'old-3', text: '未入选的群消息：另一位成员的草稿' },
      { id: 'kept', text: RECENT }
    ];
    assert.equal(privateBlock(f.store, f.alpha.id, 'room_1'), '');
    recordPushedContext(f.store.db, {
      roomId: 'room_1',
      botId: f.alpha.id,
      turnId: 'turn_2',
      messages: roomCatalog.filter((message) => message.id === 'kept')
    });
    const block = privateBlock(f.store, f.alpha.id, 'room_1');
    assert.ok(block.includes(RECENT));
    for (const message of roomCatalog.filter((item) => item.id !== 'kept')) {
      assert.equal(block.includes(message.text), false, message.text);
    }
    assert.equal(block.includes(roomCatalog.map((message) => message.text).join('\n')), false);
  } finally {
    f.close();
  }
});

test('没收到某条群消息的成员，单聊里没有这条消息 [AC:bot-room-touched-memory#AC-4]', () => {
  const f = fixture();
  try {
    recordPushedContext(f.store.db, {
      roomId: 'room_1',
      botId: f.alpha.id,
      turnId: 'turn_3',
      messages: [{ id: 'msg-alpha-only', text: ONLY_FOR_ALPHA }]
    });
    assert.ok(privateBlock(f.store, f.alpha.id).includes(ONLY_FOR_ALPHA));
    assert.equal(privateBlock(f.store, f.beta.id).includes(ONLY_FOR_ALPHA), false);
    assert.equal(privateBlock(f.store, f.beta.id, 'room_1'), '');
    assert.equal(privateBlock(f.store, f.alpha.id, 'room_2').includes(ONLY_FOR_ALPHA), false);
  } finally {
    f.close();
  }
});

test('只在私聊里完成的审批不写进群历史，批准结果也不进群 [AC:bot-room-touched-memory#AC-5]', () => {
  const f = fixture();
  try {
    const roomMessages = [{ id: 'notice', text: ROOM_HUMAN_STEP_NOTICE }];
    const decision = {
      transcript: '用户：批准\n助手：开始执行删除',
      result: APPROVAL_RESULT
    };
    const after = roomHistoryAfterPrivateDecision(roomMessages, decision);
    assert.deepEqual(after.map((message) => message.text), [ROOM_HUMAN_STEP_NOTICE]);
    assert.equal(JSON.stringify(after).includes(APPROVAL_RESULT), false);
    assert.equal(JSON.stringify(after).includes('开始执行删除'), false);
    assert.equal(privateBlock(f.store, f.alpha.id).includes(APPROVAL_RESULT), false);
    assert.equal(privateBlock(f.store, f.alpha.id).includes('开始执行删除'), false);
    assert.equal(privateBlock(f.store, f.alpha.id).includes(ROOM_HUMAN_STEP_NOTICE), false);
  } finally {
    f.close();
  }
});

function roomServiceFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'touched-room-'));
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
  return { dir, store, host, rooms: new BotRoomService(host), bots, principal, close: () => store.db.close() };
}

function plantRoom(store, roomId, sender, text, attachmentIds = []) {
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

function privateAppendix(store, session) {
  return compileTurnAppendix({ session, query: '群里刚才说了什么', store });
}

test('群回合提示能用上自己的单聊事实，单聊原文不进群 [AC:bot-room-touched-memory#AC-1]', async () => {
  const calls = [];
  const rt = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'touch-fact-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'touch-fact-state-')),
    modelAdapter: {
      name: 'touch-fact',
      async runTurn(input) {
        calls.push(input);
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: '收到' }] };
      },
      async summarizeMessages() { return ''; }
    }
  });
  try {
    const alpha = rt.createBot({ name: 'FactAlpha' });
    const beta = rt.createBot({ name: 'FactBeta' });
    const principal = resolveBotPrincipal(rt.store);
    saveSemanticFact(rt.store.agentMemory(), {
      userId: principal.userId,
      category: 'fact',
      content: FACT,
      agentId: alpha.agentId
    });
    rt.store.appendMessage(alpha.canonicalSessionId, 'user', [{ type: 'text', text: PRIVATE_TRANSCRIPT }]);
    const room = rt.rooms.create(principal, { title: 'Facts', botIds: [alpha.id, beta.id], hostBotId: alpha.id });
    rt.rooms.send(principal, room.id, { text: '问一下支付网关', mentions: [alpha.id, beta.id] });
    await rt.rooms.tick();
    const alphaCall = calls.find(input => rt.store.getSession(input.sessionId)?.metadata?.botId === alpha.id);
    const betaCall = calls.find(input => rt.store.getSession(input.sessionId)?.metadata?.botId === beta.id);
    assert.ok(alphaCall);
    assert.ok(betaCall);
    assert.ok(JSON.stringify(alphaCall.messages).includes(FACT));
    assert.ok(!alphaCall.systemPrompt.includes(FACT));
    assert.ok(!JSON.stringify(betaCall.messages).includes(FACT));
    assert.ok(!JSON.stringify(alphaCall.messages).includes(PRIVATE_TRANSCRIPT));
    assert.ok(!JSON.stringify(betaCall.messages).includes(PRIVATE_TRANSCRIPT));
    const roomText = rt.rooms.messages(principal, room.id).messages.map(message => message.text).join('\n');
    assert.ok(!roomText.includes(PRIVATE_TRANSCRIPT));
    assert.ok(!roomText.includes(FACT));
    const alphaRoom = rt.store.getSession(alphaCall.sessionId);
    const betaRoom = rt.store.getSession(betaCall.sessionId);
    assert.ok(privateAppendix(rt.store, alphaRoom).includes(FACT));
    assert.equal(privateAppendix(rt.store, betaRoom).includes(FACT), false);
    assert.equal(privateAppendix(rt.store, rt.store.getSession(beta.canonicalSessionId)).includes(FACT), false);
    assert.equal(privateAppendix(rt.store, rt.store.getSession(beta.canonicalSessionId)).includes(PRIVATE_TRANSCRIPT), false);
  } finally {
    await rt.destroy();
  }
});

test('群回合记下推送、取回和自己的发言，没推送的不进单聊 [AC:bot-room-touched-memory#AC-2] [AC:bot-room-touched-memory#AC-3] [AC:bot-room-touched-memory#AC-4]', async () => {
  const rt = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'touch-read-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'touch-read-state-')),
    modelAdapter: {
      name: 'touch-read',
      async runTurn(input) {
        const done = input.messages.some(message => message.parts.some(part => part.type === 'tool_result'));
        if (done) return { stopReason: 'end', assistantParts: [{ type: 'text', text: OWN_POST }] };
        return {
          stopReason: 'tool_use',
          assistantParts: [
            { type: 'tool_call', toolCallId: 'search-1', name: 'room_history_search', input: { query: 'SEARCH_ONLY_TOKEN' } },
            { type: 'tool_call', toolCallId: 'read-1', name: 'room_history_read', input: { fromSeq: 2, toSeq: 2 } },
            { type: 'tool_call', toolCallId: 'file-1', name: 'room_material_read', input: { materialId: 'spec-touch' } }
          ]
        };
      },
      async summarizeMessages() { return ''; }
    }
  });
  rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  try {
    const alpha = rt.createBot({ name: 'TouchAlpha' });
    const beta = rt.createBot({ name: 'TouchBeta' });
    const principal = resolveBotPrincipal(rt.store);
    const room = rt.rooms.create(principal, { title: 'Touched', botIds: [alpha.id, beta.id], hostBotId: alpha.id });
    const user = { type: 'user', id: principal.userId, name: principal.userId };
    const host = { type: 'bot', id: alpha.id, name: alpha.name };
    rt.store.createAttachment({
      id: 'spec-touch',
      sessionId: alpha.canonicalSessionId,
      fileName: 'schema.sql',
      kind: 'text',
      sourceType: 'upload',
      sizeBytes: 24,
      status: 'ready',
      emitText: ATTACHMENT,
      createdAt: new Date().toISOString()
    });
    plantRoom(rt.store, room.id, user, '目标：先看登录');
    plantRoom(rt.store, room.id, host, EARLIER);
    plantRoom(rt.store, room.id, user, `结论：${SUMMARY}`);
    plantRoom(rt.store, room.id, user, '规格在附件里', ['spec-touch']);
    plantRoom(rt.store, room.id, host, UNPUSHED);
    plantRoom(rt.store, room.id, host, 'SEARCH_ONLY_TOKEN 只被搜索摘录');
    for (let n = 0; n < 30; n += 1) plantRoom(rt.store, room.id, user, `填充 ${n}`);
    plantRoom(rt.store, room.id, user, RECENT);
    rt.rooms.send(principal, room.id, { text: '请根据群里的情况回复', mentions: [alpha.id] });
    await rt.rooms.tick();
    const turn = rt.rooms.turns(principal, room.id)[0];
    assert.equal(turn.status, 'completed');
    const alphaPrivate = privateAppendix(rt.store, rt.store.getSession(alpha.canonicalSessionId));
    for (const text of [SUMMARY, RECENT, EARLIER, ATTACHMENT, OWN_POST]) {
      assert.ok(alphaPrivate.includes(text), text);
    }
    assert.equal(alphaPrivate.includes(UNPUSHED), false);
    assert.equal(alphaPrivate.includes('SEARCH_ONLY_TOKEN'), false);
    const records = queryTouchedForPrivateChat(rt.store.db, { botId: alpha.id });
    assert.ok(records.some(record => record.kind === 'summary' && record.body.includes('不要改表结构')));
    assert.ok(records.some(record => record.kind === 'recent_message' && record.body.includes(RECENT)));
    assert.ok(records.some(record => record.kind === 'retrieved_message' && record.body.includes(EARLIER)));
    assert.ok(records.some(record => record.kind === 'retrieved_attachment' && record.body.includes(ATTACHMENT)));
    assert.ok(records.some(record => record.kind === 'own_post' && record.body.includes(OWN_POST)));
    assert.equal(records.some(record => record.body.includes(UNPUSHED)), false);
    assert.equal(records.some(record => record.body.includes('SEARCH_ONLY_TOKEN')), false);
    const betaPrivate = privateAppendix(rt.store, rt.store.getSession(beta.canonicalSessionId));
    assert.equal(betaPrivate.includes(RECENT), false);
    assert.equal(betaPrivate.includes(EARLIER), false);
    assert.equal(betaPrivate.includes(OWN_POST), false);
    assert.equal(queryTouchedForPrivateChat(rt.store.db, { botId: beta.id }).length, 0);
  } finally {
    await rt.destroy();
  }
});

test('静默不记成触达，推送过的消息会计 [AC:bot-room-touched-memory#AC-2]', async () => {
  const f = roomServiceFixture();
  try {
    const room = f.rooms.create(f.principal, { title: 'Quiet', botIds: f.bots.map(bot => bot.id), hostBotId: f.bots[0].id });
    f.host.runSession = async id => {
      f.store.appendMessage(id, 'assistant', [{ type: 'text', text: '[SILENT]' }]);
      f.store.updateSession(id, { status: 'idle' });
    };
    f.rooms.send(f.principal, room.id, { text: 'PUSHED_SILENCE_TOPIC', mentions: [f.bots[0].id] });
    await f.rooms.tick();
    const roomText = f.rooms.messages(f.principal, room.id).messages.map(message => message.text).join('\n');
    assert.ok(!roomText.includes('[SILENT]'));
    const records = queryTouchedForPrivateChat(f.store.db, { botId: f.bots[0].id });
    assert.ok(records.some(record => record.kind === 'recent_message' && record.body.includes('PUSHED_SILENCE_TOPIC')));
    assert.equal(records.some(record => record.kind === 'own_post'), false);
    assert.equal(records.some(record => record.body.includes('[SILENT]')), false);
    const appendix = privateAppendix(f.store, f.store.getSession(f.bots[0].canonicalSessionId));
    assert.ok(appendix.includes('PUSHED_SILENCE_TOPIC'));
    assert.equal(appendix.includes('[SILENT]'), false);
  } finally {
    f.close();
  }
});

test('私聊审批过程不写进群历史，也不记成触达 [AC:bot-room-touched-memory#AC-5]', async () => {
  const f = roomServiceFixture();
  try {
    const room = f.rooms.create(f.principal, { title: 'Approval', botIds: [f.bots[0].id, f.bots[1].id], hostBotId: f.bots[0].id });
    f.host.runSession = async id => {
      const session = f.store.getSession(id);
      if (session.metadata.botId !== f.bots[0].id) {
        f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'beta continues' }]);
        return;
      }
      f.store.createApproval({
        sessionId: id,
        toolName: 'write_file',
        reason: 'needs a person',
        args: { path: 'secret.env', token: 'SECRET_CREDENTIAL' }
      });
      f.store.updateSession(id, {
        status: 'waiting_approval',
        metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval', approvalIds: ['x'] }, outcome: { kind: 'waiting_approval' } }
      });
    };
    f.rooms.send(f.principal, room.id, { text: 'needs a person', mentions: [f.bots[0].id, f.bots[1].id] });
    await f.rooms.tick();
    f.store.appendMessage(f.bots[0].canonicalSessionId, 'assistant', [{ type: 'text', text: APPROVAL_RESULT }]);
    f.store.updateSession(f.bots[0].canonicalSessionId, { status: 'idle' });
    await f.rooms.tick();
    const roomText = f.rooms.messages(f.principal, room.id).messages.map(message => message.text).join('\n');
    assert.match(roomText, /已转到和我的私聊/);
    assert.ok(!roomText.includes('SECRET_CREDENTIAL'));
    assert.ok(!roomText.includes('write_file'));
    assert.ok(!roomText.includes(APPROVAL_RESULT));
    assert.ok(!roomText.includes('不会写回群'));
    const privateText = f.store.listMessages(f.bots[0].canonicalSessionId).map(message => message.parts.map(part => part.text ?? '').join('')).join('\n');
    assert.match(privateText, /不会写回群/);
    const touched = JSON.stringify(queryTouchedForPrivateChat(f.store.db, { botId: f.bots[0].id }));
    assert.equal(touched.includes('SECRET_CREDENTIAL'), false);
    assert.equal(touched.includes(APPROVAL_RESULT), false);
    assert.equal(touched.includes('不会写回群'), false);
  } finally {
    f.close();
  }
});
