import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANONYMOUS_AUTH, RawAgentRuntime, ValidationError } from '../dist/index.js';
import { sessionsRoutes } from '../../../apps/daemon/dist/routes/sessions.js';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService, deliverBotRoomMessage } from '../dist/rooms/index.js';
import { isRestrainedMember, restraintHint } from '../dist/rooms/scheduling.js';
import { prepareTurnInput } from '../dist/runtime/prepare-turn-input.js';

const FULL_BODY = `FULL-BOT-BODY-${'q'.repeat(300)}-TAIL`;

function makeRuntime(repoRoot, stateDir) {
  return new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'stub',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'should-not-run' }] };
      }
    }
  });
}

function openRuntime() {
  return makeRuntime(
    mkdtempSync(join(tmpdir(), 'reply-quote-repo-')),
    mkdtempSync(join(tmpdir(), 'reply-quote-state-'))
  );
}

async function call(runtime, method, pattern, params, body) {
  const route = sessionsRoutes(runtime).find((item) => item.method === method && item.pattern === pattern);
  assert.ok(route, `${method} ${pattern}`);
  const out = { status: 200, body: undefined };
  const response = {
    statusCode: 200,
    setHeader() {},
    writeHead(code) {
      this.statusCode = code;
    },
    end(text) {
      out.status = this.statusCode;
      out.body = text ? JSON.parse(String(text)) : undefined;
    }
  };
  const path = pattern.replace(':id', params.id ?? '');
  await route.handler({
    request: { method, headers: {} },
    response,
    url: new URL(`http://127.0.0.1${path}`),
    parts: [],
    params,
    requireParam: (name) => {
      const value = params[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
    readBody: async () => body ?? {},
    auth: ANONYMOUS_AUTH
  });
  return out;
}

function userWithText(messages, text) {
  return messages.find(
    (message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text === text)
  );
}

test('quoted user message keeps excerpt and source after reopen [AC:bot-reply-quote#AC-5]', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'reply-quote-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'reply-quote-state-'));
  const runtime = makeRuntime(repoRoot, stateDir);
  const session = runtime.createChatSession({ title: 'quotes' });
  const bot = runtime.store.appendMessage(session.id, 'assistant', [{ type: 'text', text: FULL_BODY }]);
  const excerpt = 'the part about tails';
  const posted = await call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
    message: 'explain that bit',
    autoRun: false,
    replyTo: { messageId: bot.id, botId: 'bot-alpha', excerpt, text: FULL_BODY }
  });
  assert.equal(posted.status, 200);
  const user = userWithText(posted.body.messages, 'explain that bit');
  assert.ok(user);
  assert.deepEqual(user.replyTo, { messageId: bot.id, botId: 'bot-alpha', excerpt });
  assert.equal(JSON.stringify(user).includes('FULL-BOT-BODY-'), false);
  assert.equal(user.parts.map((part) => part.text ?? '').join('\n').includes(FULL_BODY), false);
  const userId = user.id;
  await runtime.destroy();

  const reloaded = makeRuntime(repoRoot, stateDir);
  try {
    const got = await call(reloaded, 'GET', '/api/sessions/:id', { id: session.id });
    assert.equal(got.status, 200);
    const again = got.body.messages.find((message) => message.id === userId);
    assert.ok(again);
    assert.deepEqual(again.replyTo, { messageId: bot.id, botId: 'bot-alpha', excerpt });
    assert.equal(JSON.stringify(again).includes('FULL-BOT-BODY-'), false);
    const stored = reloaded.getSessionMessages(session.id).find((message) => message.id === userId);
    assert.deepEqual(stored.replyTo, { messageId: bot.id, botId: 'bot-alpha', excerpt });
    assert.deepEqual(reloaded.store.foldMessages(session.id).find((message) => message.id === userId).replyTo, stored.replyTo);
    assert.deepEqual(reloaded.store.readHistoryById(session.id, userId).replyTo, stored.replyTo);
  } finally {
    await reloaded.destroy();
  }
});

test('API accepts a quote of an older bot message [AC:bot-reply-quote#AC-6]', async () => {
  const runtime = openRuntime();
  try {
    const session = runtime.createChatSession({ title: 'older quote' });
    const older = runtime.store.appendMessage(session.id, 'assistant', [
      { type: 'text', text: `${FULL_BODY}-OLD` }
    ]);
    runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'a later question' }]);
    const newer = runtime.store.appendMessage(session.id, 'assistant', [
      { type: 'text', text: `${FULL_BODY}-NEW` }
    ]);

    const posted = await call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
      message: 'about the first one',
      autoRun: false,
      replyTo: { messageId: older.id, botId: 'bot-alpha', excerpt: 'older excerpt', body: `${FULL_BODY}-OLD` }
    });
    const olderQuote = userWithText(posted.body.messages, 'about the first one');
    assert.deepEqual(olderQuote.replyTo, {
      messageId: older.id,
      botId: 'bot-alpha',
      excerpt: 'older excerpt'
    });
    assert.equal(JSON.stringify(olderQuote).includes('FULL-BOT-BODY-'), false);

    const recent = await call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
      message: 'about the latest one',
      autoRun: false,
      replyTo: { messageId: newer.id, botId: 'bot-alpha', excerpt: 'newer excerpt' }
    });
    const newerQuote = userWithText(recent.body.messages, 'about the latest one');
    assert.deepEqual(newerQuote.replyTo, {
      messageId: newer.id,
      botId: 'bot-alpha',
      excerpt: 'newer excerpt'
    });
    assert.deepEqual(Object.keys(olderQuote.replyTo).sort(), Object.keys(newerQuote.replyTo).sort());
    assert.notEqual(olderQuote.replyTo.messageId, newerQuote.replyTo.messageId);
  } finally {
    await runtime.destroy();
  }
});

test('replyTo rejects a missing message and a user message', async () => {
  const runtime = openRuntime();
  try {
    const session = runtime.createChatSession({ title: 'reject quote' });
    const mine = runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'my own note' }]);
    runtime.store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'a bot reply' }]);

    await assert.rejects(
      () =>
        call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
          message: 'missing target',
          autoRun: false,
          replyTo: { messageId: 'msg_missing', botId: 'bot-alpha', excerpt: 'gone' }
        }),
      (error) => error instanceof ValidationError && /not found/i.test(error.message)
    );
    await assert.rejects(
      () =>
        call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
          message: 'quote myself',
          autoRun: false,
          replyTo: { messageId: mine.id, botId: 'bot-alpha', excerpt: 'my own note' }
        }),
      (error) => error instanceof ValidationError && /bot reply/i.test(error.message)
    );
    await assert.rejects(
      () =>
        call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
          message: 'too long',
          autoRun: false,
          replyTo: { messageId: mine.id, botId: 'bot-alpha', excerpt: 'x'.repeat(121) }
        }),
      (error) => error instanceof ValidationError && /120/.test(error.message)
    );

    const plain = await call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
      message: 'ordinary',
      autoRun: false
    });
    const ordinary = userWithText(plain.body.messages, 'ordinary');
    assert.equal(ordinary.replyTo, undefined);
    assert.equal(
      runtime.getSessionMessages(session.id).some((message) => message.parts.some((part) => part.text === 'quote myself')),
      false
    );
  } finally {
    await runtime.destroy();
  }
});

const fullReply = `${'quoted body '.repeat(20)}TAIL_MARKER_94`;
const excerpt = fullReply.slice(0, 120);

function sessionRecord(id) {
  return {
    id,
    title: 'bot',
    mode: 'chat',
    status: 'idle',
    agentId: 'bot_a',
    background: false,
    todo: [],
    metadata: {},
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z'
  };
}

test('a quoted bot reply is given in full to the answering bot [AC:bot-reply-quote#AC-1]', async () => {
  assert.ok(!excerpt.includes('TAIL_MARKER_94'));
  const botReply = {
    id: 'msg_bot',
    sessionId: 'sess',
    role: 'assistant',
    parts: [
      { type: 'text', text: fullReply },
      { type: 'reasoning', text: 'PRIVATE_REASONING' }
    ],
    createdAt: '2026-10-19T00:00:00.000Z'
  };
  const plain = {
    id: 'msg_plain',
    sessionId: 'sess',
    role: 'user',
    parts: [{ type: 'text', text: 'unrelated earlier question' }],
    createdAt: '2026-10-19T00:00:01.000Z'
  };
  const quoted = {
    id: 'msg_user',
    sessionId: 'sess',
    role: 'user',
    parts: [{ type: 'text', text: 'what about the second point?' }],
    createdAt: '2026-10-19T00:00:02.000Z',
    replyTo: { messageId: 'msg_bot', botId: 'bot_a', excerpt }
  };
  const packed = await prepareTurnInput('sess', {
    store: {
      getSession: () => sessionRecord('sess'),
      foldMessages: () => [plain, botReply, quoted],
      appendMessage: () => quoted,
      hideByKey: () => 0
    },
    autoCompact: async () => {},
    claimNextStep: () => [],
    prepareView: async (_session, messages) => messages,
    buildAppendix: async () => ''
  });
  const modelUser = packed.messages.find(message => message.id === 'msg_user');
  const shown = modelUser.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.match(shown, /TAIL_MARKER_94/);
  assert.match(shown, /msg_bot/);
  assert.match(shown, /what about the second point\?/);
  assert.match(shown, /quoted/);
  assert.doesNotMatch(shown, /PRIVATE_REASONING/);
  assert.equal(quoted.parts.length, 1);
  assert.equal(quoted.parts[0].text, 'what about the second point?');
  const plainShown = packed.messages.find(message => message.id === 'msg_plain').parts.map(part => part.text).join('\n');
  assert.doesNotMatch(plainShown, /TAIL_MARKER_94/);
  assert.doesNotMatch(plainShown, /msg_bot/);
});

test('prompt assembly loads the quoted reply by messageId when it is outside the fold [AC:bot-reply-quote#AC-1]', async () => {
  const botReply = {
    id: 'msg_old',
    sessionId: 'sess',
    role: 'assistant',
    parts: [{ type: 'text', text: fullReply }],
    createdAt: '2026-10-19T00:00:00.000Z'
  };
  const quoted = {
    id: 'msg_user',
    sessionId: 'sess',
    role: 'user',
    parts: [{ type: 'text', text: 'about that earlier reply' }],
    createdAt: '2026-10-19T00:00:02.000Z',
    replyTo: { messageId: 'msg_old', botId: 'bot_a', excerpt }
  };
  const packed = await prepareTurnInput('sess', {
    store: {
      getSession: () => sessionRecord('sess'),
      foldMessages: () => [quoted],
      readHistoryById: (sessionId, messageId) =>
        sessionId === 'sess' && messageId === 'msg_old' ? botReply : undefined,
      appendMessage: () => quoted,
      hideByKey: () => 0
    },
    autoCompact: async () => {},
    claimNextStep: () => [],
    prepareView: async (_session, messages) => messages,
    buildAppendix: async () => ''
  });
  const shown = packed.messages.find(message => message.id === 'msg_user').parts.map(part => part.text).join('\n');
  assert.match(shown, /TAIL_MARKER_94/);
  assert.match(shown, /msg_old/);
  assert.equal(quoted.parts.length, 1);
  assert.equal(quoted.parts[0].text, 'about that earlier reply');
});

function roomFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-reply-quote-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const alpha = createBot(facade, { name: 'Alpha' });
  const beta = createBot(facade, { name: 'Beta' });
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of [alpha, beta]) {
    const session = store.getSession(bot.canonicalSessionId);
    store.updateSession(bot.canonicalSessionId, { metadata: { ...session.metadata, ...principal } });
  }
  const prompts = [];
  const host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async id => {
      const session = store.getSession(id);
      const text = store.listMessages(id).flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n');
      prompts.push({ botId: session.agentId, text });
      store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ok' }]);
      store.updateSession(id, { status: 'idle' });
    },
    cancelSession: id => store.updateSession(id, { status: 'idle' })
  };
  return { store, rooms: new BotRoomService(host), alpha, beta, prompts, principal };
}

test('quoting one room bot addresses only that bot and keeps the full reply [AC:bot-reply-quote#AC-4]', async () => {
  const f = roomFixture();
  try {
    assert.ok(!excerpt.includes('TAIL_MARKER_94'));
    const room = f.rooms.create(f.principal, { title: 'Team', botIds: [f.alpha.id, f.beta.id], hostBotId: f.alpha.id });
    const delivered = deliverBotRoomMessage(f.store, {
      roomId: room.id,
      botId: f.beta.id,
      principal: f.principal,
      text: fullReply,
      idempotencyKey: 'beta-reply'
    });
    assert.equal(delivered.delivered, true);
    const sent = f.rooms.send(f.principal, room.id, {
      text: 'explain this',
      replyTo: { messageId: delivered.message.id, botId: f.beta.id, excerpt }
    });
    assert.equal(sent.message.text, 'explain this');
    assert.ok(!JSON.stringify(sent.message).includes('TAIL_MARKER_94'));
    assert.deepEqual(sent.message.replyTo, { messageId: delivered.message.id, botId: f.beta.id, excerpt: excerpt.trim() });
    const listed = f.rooms.messages(f.principal, room.id).messages.find(message => message.id === sent.message.id);
    assert.deepEqual(listed.replyTo, sent.message.replyTo);
    assert.ok(!JSON.stringify(listed).includes('TAIL_MARKER_94'));
    assert.deepEqual(sent.turn.mentionedBotIds, [f.beta.id]);
    assert.equal(sent.turn.botIds[0], f.beta.id);
    assert.equal(isRestrainedMember(sent.turn, f.alpha.id), true);
    assert.equal(isRestrainedMember(sent.turn, f.beta.id), false);
    assert.match(restraintHint(sent.turn, f.alpha.id), /\[SILENT\]/);
    assert.equal(restraintHint(sent.turn, f.beta.id), '');
    await f.rooms.tick();
    const betaPrompt = f.prompts.find(prompt => prompt.botId === f.beta.id);
    const alphaPrompt = f.prompts.find(prompt => prompt.botId === f.alpha.id);
    assert.ok(betaPrompt);
    assert.equal(alphaPrompt, undefined);
    const quoted = new RegExp(`\\[reply-quote\\] target=${delivered.message.id}[\\s\\S]*TAIL_MARKER_94`);
    assert.match(betaPrompt.text, quoted);
    assert.doesNotMatch(betaPrompt.text, /not @-mentioned/);

    f.prompts.length = 0;
    const named = f.rooms.send(f.principal, room.id, {
      text: `please @${f.alpha.name} look`,
      replyTo: { messageId: delivered.message.id, botId: f.beta.id, excerpt }
    });
    assert.deepEqual(named.turn.mentionedBotIds, [f.alpha.id]);
    assert.equal(isRestrainedMember(named.turn, f.beta.id), true);
    assert.equal(isRestrainedMember(named.turn, f.alpha.id), false);
    await f.rooms.tick();
    const alphaNamed = f.prompts.find(prompt => prompt.botId === f.alpha.id);
    const betaNamed = f.prompts.find(prompt => prompt.botId === f.beta.id);
    const quotedAgain = new RegExp(`\\[reply-quote\\] target=${delivered.message.id}[\\s\\S]*TAIL_MARKER_94`);
    assert.match(alphaNamed.text, quotedAgain);
    assert.equal(betaNamed, undefined);
  } finally {
    f.store.db.close();
  }
});

for (const kernelVariant of ['ppeng','agent-loop']) {
 test(`${kernelVariant} real runtime loads a quoted reply outside the fold [AC:bot-reply-quote#AC-1] [AC:bot-reply-quote#AC-6]`,async()=>{
  const captured=[];const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'quote-runtime-')),stateDir:mkdtempSync(join(tmpdir(),'quote-state-')),modelAdapter:{name:'quote-runtime',async runTurn(input){captured.push(input.messages);return {stopReason:'end',assistantParts:[{type:'text',text:'done'}]};}}});
  try {
   runtime.store.setDaemonControl('loop_settings',{kernelVariant});
   const session=runtime.createChatSession({title:'real quote'});
   const old=runtime.store.appendMessage(session.id,'assistant',[{type:'text',text:fullReply}],{key:'old-quote'});
   runtime.store.hideByKey(session.id,'old-quote');
   runtime.sendUserMessage(session.id,'please explain',{replyTo:{messageId:old.id,excerpt}});
   await runtime.runSession(session.id);
   assert.ok(captured.length>0);
   assert.match(JSON.stringify(captured),/TAIL_MARKER_94/);
   const stored=runtime.getSessionMessages(session.id).find(m=>m.role==='user');
   assert.equal(JSON.stringify(stored).includes('TAIL_MARKER_94'),false);
  }finally{await runtime.destroy();}
 });
 test(`${kernelVariant} HTTP steer preserves quote through inbox and actual model turn [AC:bot-reply-quote#AC-1] [AC:bot-reply-quote#AC-5]`,async()=>{
  const captured=[];const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'quote-steer-repo-')),stateDir:mkdtempSync(join(tmpdir(),'quote-steer-state-')),modelAdapter:{name:'quote-steer',async runTurn(input){captured.push(input.messages);return {stopReason:'end',assistantParts:[{type:'text',text:'done'}]};}}});
  let sid;
  try {
   runtime.store.setDaemonControl('loop_settings',{kernelVariant});
   const session=runtime.createChatSession({title:'queued quote'});sid=session.id;
   const old=runtime.store.appendMessage(sid,'assistant',[{type:'text',text:fullReply}],{key:'old-quote'});
   runtime.store.hideByKey(sid,'old-quote');runtime.store.claimWriter(sid,'external-running');runtime.store.updateSession(sid,{status:'running'});
   await call(runtime,'POST','/api/sessions/:id/steer',{id:sid},{text:'steer quoted reply',replyTo:{messageId:old.id,excerpt}});
   const queued=runtime.store.listUnclaimedInbox(sid).find(i=>i.text==='steer quoted reply');
   assert.deepEqual(queued?.replyTo,{messageId:old.id,excerpt:excerpt.trim()});
   runtime.store.releaseWriter(sid,'external-running');runtime.store.updateSession(sid,{status:'idle'});
   await runtime.runSession(sid);
   assert.match(JSON.stringify(captured),/TAIL_MARKER_94/);
   const stored=runtime.getSessionMessages(sid).find(m=>m.role==='user'&&m.parts.some(p=>p.text==='steer quoted reply'));
   assert.deepEqual(stored?.replyTo,queued.replyTo);assert.equal(JSON.stringify(stored).includes('TAIL_MARKER_94'),false);
  }finally{if(sid)runtime.store.releaseWriter(sid,'external-running');await runtime.destroy();}
 });
}

test('Room quote derives its addressee from the source and rejects forged authors [AC:bot-reply-quote#AC-4]',()=>{
 const f=roomFixture();try{
  const room=f.rooms.create(f.principal,{title:'bound quote',botIds:[f.alpha.id,f.beta.id],hostBotId:f.alpha.id});
  const source=deliverBotRoomMessage(f.store,{roomId:room.id,botId:f.beta.id,principal:f.principal,text:fullReply,idempotencyKey:'quote-source'}).message;
  assert.throws(()=>f.rooms.send(f.principal,room.id,{text:'forged',replyTo:{messageId:source.id,botId:f.alpha.id,excerpt}}),ValidationError);
  const sent=f.rooms.send(f.principal,room.id,{text:'derived',replyTo:{messageId:source.id,excerpt}});
  assert.equal(sent.message.replyTo.botId,f.beta.id);assert.deepEqual(sent.turn.mentionedBotIds,[f.beta.id]);
 }finally{f.store.db.close();}
});

for (const kernelVariant of ['ppeng','agent-loop']) test(`${kernelVariant} quote cannot recall revoked shared context [AC:bot-reply-quote#AC-1]`,async()=>{
 const captured=[];const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'quote-revoked-')),stateDir:mkdtempSync(join(tmpdir(),'quote-revoked-state-')),modelAdapter:{name:'quote-revoked',async runTurn(input){captured.push(input.messages);return {stopReason:'end',assistantParts:[{type:'text',text:'done'}]};}}});
 try{runtime.store.setDaemonControl('loop_settings',{kernelVariant});const s=runtime.createChatSession({title:'revoked quote'});const old=runtime.store.appendMessage(s.id,'assistant',[{type:'text',text:'REVOKED_PRIVATE_BODY_43'}]);runtime.store.setDaemonControl('bot.sharedExposure:'+s.id,{revoked:[{fromSeq:old.seq,toSeq:old.seq,startedAt:'a',endedAt:'b'}]});runtime.sendUserMessage(s.id,'explain',{replyTo:{messageId:old.id,excerpt:'old'}});await runtime.runSession(s.id);assert.ok(captured.length);assert.doesNotMatch(JSON.stringify(captured),/REVOKED_PRIVATE_BODY_43/);}finally{await runtime.destroy();}
});
test('quoted steer cannot be silently promoted to a child without its source [AC:bot-reply-quote#AC-5]',async()=>{
 const runtime=openRuntime();try{const s=runtime.createChatSession({title:'quote promotion'});const old=runtime.store.appendMessage(s.id,'assistant',[{type:'text',text:fullReply}]);const item=runtime.store.enqueueSteer(s.id,'explain',{replyTo:{messageId:old.id,excerpt}});assert.throws(()=>runtime.promoteSteerToSubagent(s.id,item.id),ValidationError);assert.equal(runtime.store.getUnclaimedInbox(s.id,item.id).replyTo.messageId,old.id);assert.throws(()=>runtime.enqueueSteer(s.id,'explain',{steerMode:'subagent',replyTo:{messageId:old.id,excerpt}}),ValidationError);}finally{await runtime.destroy();}
});

test('quote of a departed Room author does not broadcast [AC:bot-reply-quote#AC-4]',()=>{
 const f=roomFixture();try{
  const facade={store:f.store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}};
  const gamma=createBot(facade,{name:'Gamma'});
  const session=f.store.getSession(gamma.canonicalSessionId);
  f.store.updateSession(gamma.canonicalSessionId,{metadata:{...session.metadata,...f.principal}});
  const room=f.rooms.create(f.principal,{title:'departed quote',botIds:[f.alpha.id,f.beta.id,gamma.id],hostBotId:f.alpha.id});
  const source=deliverBotRoomMessage(f.store,{roomId:room.id,botId:f.beta.id,principal:f.principal,text:fullReply,idempotencyKey:'departed-source'}).message;
  f.rooms.removeMember(f.principal,room.id,f.beta.id);
  const sent=f.rooms.send(f.principal,room.id,{text:'explain this',replyTo:{messageId:source.id,excerpt}});
  assert.deepEqual(sent.turn.mentionedBotIds,[]);
  assert.equal(isRestrainedMember(sent.turn,f.alpha.id),true);
 }finally{f.store.db.close();}
});
for (const kernelVariant of ['ppeng','agent-loop']) test(`${kernelVariant} overflow delivers the exact quoted source to the model [AC:bot-reply-quote#AC-5]`,async()=>{
 const captured=[];const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'quote-overflow-')),stateDir:mkdtempSync(join(tmpdir(),'quote-overflow-state-')),modelAdapter:{name:'quote-overflow',async runTurn(input){captured.push(input.messages);return {stopReason:'end',assistantParts:[{type:'text',text:'done'}]};}}});
 try{runtime.store.setDaemonControl('loop_settings',{kernelVariant,inboxOverflowCap:2});const s=runtime.createChatSession({title:'quote overflow'});const old=runtime.store.appendMessage(s.id,'assistant',[{type:'text',text:fullReply}],{key:'folded-source'});runtime.store.hideByKey(s.id,'folded-source');const quote={messageId:old.id,excerpt};const item=runtime.store.enqueueSteer(s.id,'quoted oldest',{replyTo:quote});for(const text of ['a','b','c','d'])runtime.store.enqueueSteer(s.id,text);assert.deepEqual(runtime.store.listUnclaimedInbox(s.id).find(i=>i.id===item.id)?.replyTo,quote);await runtime.runSession(s.id);assert.ok(captured.length);assert.match(JSON.stringify(captured),/TAIL_MARKER_94/);const delivered=runtime.store.foldMessages(s.id).find(m=>m.role==='user'&&m.parts.some(part=>part.type==='text'&&part.text==='quoted oldest'));assert.deepEqual(delivered.replyTo,{...quote,excerpt:excerpt.trim()});assert.doesNotMatch(JSON.stringify(delivered),/TAIL_MARKER_94/);}finally{await runtime.destroy();}
});

for (const kernelVariant of ['ppeng', 'agent-loop']) test(`${kernelVariant} fork resolves quotes within copied child history [AC:bot-reply-quote#AC-1] [AC:bot-reply-quote#AC-5]`, async () => {
 const captured=[];
 const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'quote-fork-')),stateDir:mkdtempSync(join(tmpdir(),'quote-fork-state-')),modelAdapter:{name:'quote-fork',async runTurn(input){captured.push(input.messages);return {stopReason:'end',assistantParts:[{type:'text',text:'done'}]};}}});
 try {
  runtime.store.setDaemonControl('loop_settings',{kernelVariant});
  const parent=runtime.createChatSession({title:'quoted parent'});
  const original=runtime.store.appendMessage(parent.id,'assistant',[{type:'text',text:fullReply}],{key:'fork-quote-source'});
  runtime.store.appendMessage(parent.id,'user',[{type:'text',text:'explain original'}],{replyTo:{messageId:original.id,excerpt}});
  runtime.store.appendMessage(parent.id,'assistant',[{type:'text',text:'finished'}]);
  const {session:child}=runtime.forkSession(parent.id);
  const copied=runtime.store.foldMessages(child.id).find(m=>m.key==='fork-quote-source');
  runtime.store.hideByKey(child.id,'fork-quote-source');
  runtime.sendUserMessage(child.id,'continue with the quoted original');
  await runtime.runSession(child.id);
  assert.ok(captured.length);
  assert.match(JSON.stringify(captured),/TAIL_MARKER_94/);
  const user=runtime.store.foldMessages(child.id).find(m=>m.parts.some(p=>p.text==='explain original'));
  assert.equal(user.replyTo.messageId,copied.id);
  assert.doesNotMatch(JSON.stringify(user),/TAIL_MARKER_94/);
  assert.equal(runtime.store.foldMessages(parent.id).find(m=>m.role==='user').replyTo.messageId,original.id);
 } finally {await runtime.destroy();}
});

for (const kernelVariant of ['ppeng', 'agent-loop']) for (const exposureKind of ['revoked', 'pending', 'active']) test(`${kernelVariant} fork cannot recover ${exposureKind} shared quote text [AC:bot-functional-groups#AC-9]`, async () => {
 const captured=[];
 const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'quote-fork-scope-')),stateDir:mkdtempSync(join(tmpdir(),'quote-fork-scope-state-')),modelAdapter:{name:'quote-fork-scope',async runTurn(input){captured.push(input.messages);return {stopReason:'end',assistantParts:[{type:'text',text:'done'}]};}}});
 try {
  runtime.store.setDaemonControl('loop_settings',{kernelVariant});
  const parent=runtime.createChatSession({title:'scoped parent'});
  runtime.store.appendMessage(parent.id,'assistant',[{type:'text',text:'PRIVATE_BEFORE_GROUP_72'}]);
  const original=runtime.store.appendMessage(parent.id,'assistant',[{type:'text',text:'WITHDRAWN_FORK_SECRET_91'}],{key:'scoped-quote-source'});
  runtime.store.hideByKey(parent.id,'scoped-quote-source');
  runtime.store.appendMessage(parent.id,'user',[{type:'text',text:'quoted shared point'}],{replyTo:{messageId:original.id,excerpt:'short quote'}});
  runtime.store.appendMessage(parent.id,'assistant',[{type:'text',text:'finished'}]);
  const range={fromSeq:original.seq,toSeq:original.seq,startedAt:'2026-10-19T00:00:00Z',endedAt:'2026-10-19T01:00:00Z',...(exposureKind==='pending'?{pending:true}:{})};
  const exposure=exposureKind==='active'?{active:{groupId:'group-source',fromSeq:original.seq,startedAt:range.startedAt},revoked:[]}:{revoked:[range]};
  runtime.store.setDaemonControl('bot.sharedExposure:'+parent.id,exposure);
  const {session:child}=runtime.forkSession(parent.id);
  runtime.sendUserMessage(child.id,'fresh private question after fork');
  await runtime.runSession(child.id);
  assert.ok(captured.length);
  assert.doesNotMatch(JSON.stringify(captured),/WITHDRAWN_FORK_SECRET_91/);
  assert.match(JSON.stringify(captured),/PRIVATE_BEFORE_GROUP_72/);
  assert.match(JSON.stringify(captured),/fresh private question after fork/);
  assert.deepEqual(runtime.store.getDaemonControl('bot.sharedExposure:'+parent.id),exposure);
 } finally {await runtime.destroy();}
});
