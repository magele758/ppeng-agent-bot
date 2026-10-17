import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { resolveBotPrincipal } from '../dist/bots/bot-identity.js';
import { saveSemanticFact } from '../dist/memory/memory-writer.js';
import { setBotWorkControl, updateBotWorkSettings, enqueueBotMessage, botQueueUsage } from '../dist/bots/bot-work.js';
import { waitFor } from './helpers/settle.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-room-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const a = createBot(facade, { name: 'Alpha' });
  const b = createBot(facade, { name: 'Beta' });
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of [a,b]) store.updateSession(bot.canonicalSessionId,{metadata:{...store.getSession(bot.canonicalSessionId).metadata,...principal}});
  const runs = [];
  const host = { store, createChatSession: input => createChatSession(facade, input),
    runSession: async id => { runs.push(id); store.appendMessage(id, 'assistant', [{ type: 'text', text: `reply:${store.getSession(id).agentId}` }]); store.updateSession(id, { status: 'idle' }); }, cancelSession: id => store.updateSession(id, { status: 'idle' }) };
  return { store, facade, host, rooms: new BotRoomService(host), a, b, runs, principal };
}

test('create and reopen a durable room with its members [AC:bot-rooms#AC-1]', () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Team', botIds: [f.a.id, f.b.id], hostBotId: f.a.id });
  const reopened = new BotRoomService(f.host);
  assert.deepEqual(reopened.get(f.principal, room.id).botIds, [f.a.id, f.b.id]);
  assert.equal(reopened.list(f.principal).length, 1);
});

test('mentioned members speak first and everyone else still gets a restrained turn [AC:bot-rooms#AC-2] [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  f.store.appendMessage(f.a.canonicalSessionId, 'user', [{ type: 'text', text: 'PRIVATE_SECRET' }]);
  const room = f.rooms.create(f.principal, { title: 'Team', botIds: [f.a.id, f.b.id], hostBotId: f.a.id });
  const sent = f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name} @${f.a.name}` });
  assert.deepEqual(sent.turn.botIds, [f.b.id, f.a.id]);
  assert.deepEqual(sent.turn.mentionedBotIds, [f.b.id, f.a.id]);
  await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'completed');
  const messages = f.rooms.messages(f.principal, room.id).messages;
  assert.deepEqual(messages.filter(m => m.sender.type === 'bot').map(m => m.sender.id), [f.b.id, f.a.id]);
  assert.ok(f.runs.every(id => id !== f.a.canonicalSessionId && id !== f.b.canonicalSessionId));
  for (const id of f.runs) assert.ok(!JSON.stringify(f.store.listMessages(id)).includes('PRIVATE_SECRET'));
  assert.equal(f.store.listMessages(f.a.canonicalSessionId).length, 1);
  const defaultTurn = f.rooms.send(f.principal, room.id, { text: 'ordinary question' }).turn;
  assert.deepEqual(defaultTurn.botIds, [f.a.id, f.b.id]);
  assert.equal(defaultTurn.mentionedBotIds, undefined);
  const email = f.rooms.send(f.principal,room.id,{text:'email owner@example.com'}).turn;
  assert.deepEqual(email.botIds,[f.a.id, f.b.id]);
  assert.equal(email.mentionedBotIds, undefined);
  const unknown = f.rooms.send(f.principal,room.id,{text:'@NoSuchMember do work'}).turn;
  assert.deepEqual(unknown.botIds,[f.a.id, f.b.id]);
  assert.deepEqual(unknown.mentionedBotIds, []);
  const onlyBeta = f.rooms.send(f.principal,room.id,{text:`only @${f.b.name}`}).turn;
  assert.deepEqual(onlyBeta.botIds,[f.b.id, f.a.id]);
  assert.deepEqual(onlyBeta.mentionedBotIds,[f.b.id]);
  const stranger = f.rooms.send(f.principal,room.id,{text:`@${f.a.name} @Stranger`}).turn;
  assert.deepEqual(stranger.botIds,[f.a.id, f.b.id]);
  assert.deepEqual(stranger.mentionedBotIds,[f.a.id]);
});

test('a spaced display name is one mention and does not add outsiders [AC:bot-rooms#AC-2]', () => {
  const f = fixture();
  const superBot = createBot(f.facade, { name: 'Super Bot' });
  f.store.updateSession(superBot.canonicalSessionId, { metadata: { ...f.store.getSession(superBot.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Names', botIds: [f.a.id, superBot.id], hostBotId: f.a.id });
  const spaced = f.rooms.send(f.principal, room.id, { text: 'hi @Super Bot now' }).turn;
  assert.deepEqual(spaced.botIds, [superBot.id, f.a.id]);
  assert.deepEqual(spaced.mentionedBotIds, [superBot.id]);
  const outsider = f.rooms.send(f.principal, room.id, { text: '@Super Bot @Nope' }).turn;
  assert.deepEqual(outsider.botIds, [superBot.id, f.a.id]);
  assert.deepEqual(outsider.mentionedBotIds, [superBot.id]);
  const everyone = f.rooms.send(f.principal, room.id, { text: 'all of you' }).turn;
  assert.deepEqual(everyone.botIds, [f.a.id, superBot.id]);
  assert.equal(everyone.mentionedBotIds, undefined);
});

test('budget, pause, stop, leave and resume constrain actual scheduling [AC:bot-rooms#AC-4]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Budget', botIds: [f.a.id, f.b.id], maxBotTurns: 1 });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  assert.equal(f.rooms.turns(f.principal, room.id)[0].terminationReason, 'budget');
  f.rooms.patch(f.principal, room.id, { status: 'paused' });
  f.rooms.send(f.principal, room.id, { text: 'later', mentions: [f.b.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  f.rooms.removeMember(f.principal, room.id, f.b.id);
  f.rooms.resume(f.principal, room.id);
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
  assert.equal(f.store.getSession(f.runs[1]).agentId, f.a.id);
  f.rooms.send(f.principal, room.id, { text: 'stop this', mentions: [f.a.id] });
  f.rooms.stop(f.principal, room.id);
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
  assert.equal(f.rooms.turns(f.principal, room.id).at(-1).status, 'cancelled');
});

test('concurrent input is durable; restart distinguishes queued and unconfirmed running work [AC:bot-rooms#AC-5]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Reliable', botIds: [f.a.id] });
  let release;
  f.host.runSession = id => new Promise(resolve => { release = () => { f.store.appendMessage(id, 'assistant', [{type:'text',text:'done'}]); f.store.updateSession(id, { status: 'idle' }); resolve(); }; });
  f.rooms.send(f.principal, room.id, { text: 'first', idempotencyKey: 'one' });
  const running = f.rooms.tick();
  await new Promise(resolve => setImmediate(resolve));
  const second = f.rooms.send(f.principal, room.id, { text: 'second', idempotencyKey: 'two' });
  assert.equal(second.turn.status, 'queued');
  assert.equal(f.rooms.send(f.principal, room.id, { text: 'second', idempotencyKey: 'two' }).message.id, second.message.id);
  assert.throws(()=>f.rooms.send(f.principal,room.id,{text:'changed',idempotencyKey:'two'}),/different Room message/);
  release(); await running;
  f.host.runSession = async id => { f.store.appendMessage(id, 'assistant', [{type:'text',text:'second done'}]); f.store.updateSession(id,{status:'idle'}); };
  await f.rooms.tick();
  assert.ok(f.rooms.turns(f.principal, room.id).every(t => t.status === 'completed'));
  const third = f.rooms.send(f.principal, room.id, { text: 'crash' });
  f.store.db.prepare("UPDATE bot_room_turns SET status='running' WHERE id=?").run(third.turn.id);
  const restart = new BotRoomService(f.host);
  assert.equal(restart.turns(f.principal, room.id).at(-1).status, 'unknown');
});

test('history pages remain stable and attachment refs and principal checks are enforced [AC:bot-rooms#AC-6]', () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Pages', botIds: [f.a.id] });
  f.store.mergeSessionMetadata?.(f.a.canonicalSessionId, { userId: f.principal.userId });
  f.store.updateSession(f.a.canonicalSessionId, { metadata: { ...f.store.getSession(f.a.canonicalSessionId).metadata, ...f.principal } });
  f.store.createAttachment({ id:'attachment',sessionId:f.a.canonicalSessionId,fileName:'notes.txt',kind:'text',sourceType:'upload',sizeBytes:2,status:'ready',emitText:'OK',createdAt:new Date().toISOString() });
  for (let i=0;i<4;i++) f.rooms.send(f.principal,room.id,{text:`m${i}`,attachmentIds:i===0?['attachment']:[]});
  const page = f.rooms.messages(f.principal,room.id,{limit:2});
  f.rooms.send(f.principal,room.id,{text:'new'});
  const older = f.rooms.messages(f.principal,room.id,{limit:2,beforeSeq:page.nextCursor});
  assert.deepEqual(older.messages.map(m=>m.text),['m0','m1']);
  assert.deepEqual(older.messages[0].attachmentIds,['attachment']);
  assert.throws(()=>f.rooms.get({userId:'intruder'},room.id), /Forbidden/);
  assert.throws(()=>f.rooms.send(f.principal,room.id,{text:'bad',mentions:['no-such-bot']}), /member/);
  assert.throws(()=>f.rooms.patch(f.principal,room.id,{maxBotTurns:21}), /budget/);
});

test('waiting approval preserves later turns and result recovery without rerunning the approved work [AC:bot-rooms#AC-5]', async () => {
  const f=fixture();
  const room=f.rooms.create(f.principal,{title:'Approval',botIds:[f.a.id]});
  let calls=0;
  f.host.runSession=async id=>{calls++;f.store.updateSession(id,{status:'waiting_approval'});};
  f.rooms.send(f.principal,room.id,{text:'needs approval'});
  await f.rooms.tick();
  const blocked=f.rooms.turns(f.principal,room.id)[0];
  assert.equal(blocked.status,'waiting_approval');
  f.rooms.send(f.principal,room.id,{text:'later'});
  await f.rooms.tick();
  assert.equal(calls,1);
  f.store.appendMessage(blocked.currentSessionId,'assistant',[{type:'text',text:'approved output'}]);
  f.store.updateSession(blocked.currentSessionId,{status:'idle'});
  await f.rooms.tick();
  assert.equal(calls,1);
  assert.equal(f.rooms.turns(f.principal,room.id)[0].status,'completed');
  assert.equal(f.rooms.messages(f.principal,room.id).messages.at(-1).text,'approved output');
});

test('stopping an in-flight member cancels and fences its late reply [AC:bot-rooms#AC-4]', async () => {
  const f=fixture();
  const room=f.rooms.create(f.principal,{title:'Stop',botIds:[f.a.id]});
  let finish;const cancelled=[];
  f.host.runSession=id=>new Promise(resolve=>{finish=()=>{f.store.appendMessage(id,'assistant',[{type:'text',text:'late'}]);resolve();};});
  f.host.cancelSession=id=>cancelled.push(id);
  f.rooms.send(f.principal,room.id,{text:'work'});
  const pending=f.rooms.tick();
  await new Promise(resolve=>setImmediate(resolve));
  f.rooms.stop(f.principal,room.id);
  assert.equal(cancelled.length,1);
  finish();await pending;
  assert.equal(f.rooms.messages(f.principal,room.id).messages.filter(m=>m.sender.type==='bot').length,0);
  assert.equal(f.rooms.turns(f.principal,room.id)[0].status,'cancelled');
});

test('real Agent runtime executes isolated Room contexts and returns shared replies [AC:bot-rooms#AC-3]', async () => {
  const calls=[];
  const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'room-runtime-repo-')),stateDir:mkdtempSync(join(tmpdir(),'room-runtime-state-')),modelAdapter:{name:'room-scripted',async runTurn(input){calls.push(input);return {stopReason:'end',assistantParts:[{type:'text',text:'Actual runtime Room result'}]};},async summarizeMessages(){return '';}}});
  try {
    const bot=rt.createBot({name:'RoomMember'});
    rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'PRIVATE_NOT_SHARED'}]);
    const principal=resolveBotPrincipal(rt.store);
    saveSemanticFact(rt.store.agentMemory(),{userId:principal.userId,agentId:bot.id,category:'fact',content:'PRIVATE_MEMORY_NEVER_SHARE alpha quota 9876'});
    const textAttachment=await rt.ingestAttachmentBase64(bot.canonicalSessionId,{fileName:'shared.txt',mimeType:'text/plain',dataBase64:Buffer.from('SHARED_ATTACHMENT_CONTENT').toString('base64')});
    const imageAttachment=await rt.ingestAttachmentBase64(bot.canonicalSessionId,{fileName:'shared.png',mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLl0AAAAASUVORK5CYII='});
    const rooms=rt.rooms??new BotRoomService({store:rt.store,createChatSession:input=>rt.createChatSession(input),runSession:id=>rt.runSession(id),cancelSession:id=>rt.cancelSession(id)});
    const room=rooms.create(principal,{title:'Real runtime',botIds:[bot.id]});
    rooms.send(principal,room.id,{text:'Please answer in the Room',attachmentIds:[textAttachment.attachment.id,imageAttachment.attachment.id]});
    await rooms.tick();
    assert.equal(rooms.turns(principal,room.id)[0].status,'completed');
    assert.equal(rooms.messages(principal,room.id).messages.at(-1).text,'Actual runtime Room result');
    assert.ok(calls.length>=1);
    assert.ok(calls.every(input=>input.sessionId!==bot.canonicalSessionId&&!JSON.stringify(input.messages).includes('PRIVATE_NOT_SHARED')));
    assert.ok(calls.every(input=>!JSON.stringify(input).includes('PRIVATE_MEMORY_NEVER_SHARE')),'private Bot fact must not enter Room model input');
    assert.ok(calls.some(input=>JSON.stringify(input.messages).includes('SHARED_ATTACHMENT_CONTENT')),'shared attachment text reaches actual model input');
    assert.ok(calls.some(input=>input.messages.flatMap(message=>message.parts).some(part=>part.type==='image'&&part.assetId===imageAttachment.imageAsset.id)),'shared image part reaches actual model input');
    for(const input of calls)for(const name of ['message_agent','bot_delegate','spawn_subagent','spawn_teammate','send_message','task_create'])assert.ok(!input.tools.some(tool=>tool.name===name),`${name} cannot bypass Room scheduling`);
    assert.equal(rt.store.listMessages(bot.canonicalSessionId).length,1);
  } finally {rt.destroy();}
});

test('tool and cost limits stop before further member tool execution [AC:bot-rooms#AC-4]', async () => {
  const f=fixture();let cancelled=0;
  f.host.cancelSession=()=>cancelled++;
  f.host.runSession=async(id,options)=>{
    await options.onEvent({type:'model_done',stopReason:'tool_use',assistant:{parts:[{type:'tool_call',toolCallId:'x',name:'bash',input:{}},{type:'tool_call',toolCallId:'y',name:'bash',input:{}}]}});
    f.store.updateSession(id,{status:'idle'});
  };
  const room=f.rooms.create(f.principal,{title:'Tools',botIds:[f.a.id],maxToolCalls:1});
  f.rooms.send(f.principal,room.id,{text:'tools'});await f.rooms.tick();
  assert.equal(cancelled,1);
  assert.equal(f.rooms.turns(f.principal,room.id)[0].terminationReason,'tool_budget');
  f.host.runSession=async(id,options)=>{
    const session=f.store.getSession(id);f.store.updateSession(id,{metadata:{...session.metadata,usageCostUsd:2}});
    await options.onEvent({type:'model_done',stopReason:'end',assistant:{parts:[{type:'text',text:'cost'}]}});
    f.store.updateSession(id,{status:'idle'});
  };
  f.rooms.send(f.principal,room.id,{text:'cost'});await f.rooms.tick();
  assert.equal(cancelled,2);
  assert.equal(f.rooms.turns(f.principal,room.id).at(-1).terminationReason,'cost_budget');
});

test('aborted partial output is not success and reused Room contexts refresh canonical policy [AC:bot-rooms#AC-4] [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture(),seen=[];
  const room=f.rooms.create(f.principal,{title:'Live policy',botIds:[f.a.id]});
  f.host.runSession=async id=>{seen.push(f.store.getSession(id).metadata.permissionMode);f.store.appendMessage(id,'assistant',[{type:'text',text:'partial'}]);f.store.updateSession(id,{status:'idle',metadata:{...f.store.getSession(id).metadata,outcome:{kind:'aborted',reason:'user_abort'}}});};
  f.rooms.send(f.principal,room.id,{text:'first'});await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal,room.id)[0].status,'cancelled');
  assert.equal(f.rooms.messages(f.principal,room.id).messages.filter(message=>message.sender.type==='bot').length,0);
  const canonical=f.store.getSession(f.a.canonicalSessionId);
  f.store.updateSession(canonical.id,{metadata:{...canonical.metadata,permissionMode:'plan',allowedTools:['read_file'],allowedSkills:['limited-skill'],modelOverride:{providerId:'p',modelId:'m'}}});
  f.host.runSession=async id=>{const metadata=f.store.getSession(id).metadata;seen.push(metadata.permissionMode);assert.deepEqual(metadata.allowedTools,['read_file']);assert.deepEqual(metadata.allowedSkills,['limited-skill']);assert.deepEqual(metadata.modelOverride,{providerId:'p',modelId:'m'});f.store.appendMessage(id,'assistant',[{type:'text',text:'safe new result'}]);};
  f.rooms.send(f.principal,room.id,{text:'second'});await f.rooms.tick();
  assert.deepEqual(seen,['auto','plan']);
  assert.equal(f.rooms.turns(f.principal,room.id).at(-1).status,'completed');
});

test('unconfirmed software effects override assistant success and preserve the partial evidence [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture();const room=f.rooms.create(f.principal,{title:'Unconfirmed effects',botIds:[f.a.id]});
  const checks=[];f.host.hasUnconfirmedEffects=(id,startedAt)=>{checks.push({id,startedAt});return true;};
  f.rooms.send(f.principal,room.id,{text:'write to software'});await f.rooms.tick();
  const turn=f.rooms.turns(f.principal,room.id)[0];
  assert.equal(turn.status,'unknown');assert.equal(turn.terminationReason,'external_effect_unconfirmed');
  assert.ok(turn.partialResult.includes('reply:'));assert.ok(f.store.listMessages(turn.currentSessionId).some(message=>message.role==='assistant'));
  assert.equal(checks[0].startedAt,turn.startedAt);
  assert.equal(f.rooms.messages(f.principal,room.id).messages.filter(message=>message.sender.type==='bot').length,0);
});

test('Bot background pause and disable apply to Room work and preserve pending input [AC:bot-rooms#AC-4] [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture(),room=f.rooms.create(f.principal,{title:'Controlled',botIds:[f.a.id]});
  setBotWorkControl(f.host,f.principal,f.a.id,{paused:true,disabled:true});
  f.rooms.send(f.principal,room.id,{text:'keep pending'});await f.rooms.tick();
  assert.equal(f.runs.length,0);assert.equal(f.rooms.turns(f.principal,room.id)[0].status,'queued');assert.equal(f.rooms.turns(f.principal,room.id)[0].terminationReason,'bot_disabled');
  setBotWorkControl(f.host,f.principal,f.a.id,{paused:false,disabled:false});await f.rooms.tick();
  assert.equal(f.runs.length,1);assert.equal(f.rooms.turns(f.principal,room.id)[0].status,'completed');
});

test('real approve then scheduler resumes Room tools before collecting a final result [AC:bot-rooms#AC-5]',async()=>{
  let executions=0;
  const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'room-approval-repo-')),stateDir:mkdtempSync(join(tmpdir(),'room-approval-state-')),extraTools:[{name:'room_approval_probe',description:'Approval probe',inputSchema:{type:'object',properties:{}},approvalMode:'always',sideEffectLevel:'workspace',async execute(){executions++;return {ok:true,content:'APPROVED_PROBE_RESULT'};}}],modelAdapter:{name:'room-approval-scripted',async runTurn(input){if(input.messages.some(message=>message.parts.some(part=>part.type==='tool_result'&&part.name==='room_approval_probe')))return {stopReason:'end',assistantParts:[{type:'text',text:'Verified approved work finished'}]};return {stopReason:'tool_use',assistantParts:[{type:'text',text:'Pending work, not complete'},{type:'tool_call',toolCallId:'approval-probe',name:'room_approval_probe',input:{}}]};},async summarizeMessages(){return '';}}});
  try {
    const bot=rt.createBot({name:'ApprovalMember'}),principal=resolveBotPrincipal(rt.store),room=rt.rooms.create(principal,{title:'Actual approval',botIds:[bot.id]});
    rt.rooms.send(principal,room.id,{text:'Run the approved action'});await rt.rooms.tick();
    assert.equal(rt.rooms.turns(principal,room.id)[0].status,'waiting_approval');assert.equal(executions,0);
    const approval=rt.store.listApprovals({status:'pending'})[0];assert.ok(approval);
    await rt.approve(approval.id,'approved');
    await rt.runScheduler();
    const done=await waitFor(async()=>{await rt.rooms.tick();const turn=rt.rooms.turns(principal,room.id)[0];return turn.status==='completed'?turn:null;});
    assert.ok(done);assert.equal(executions,1);
    assert.ok(rt.rooms.messages(principal,room.id).messages.at(-1).text.includes('Verified approved work finished'));
  }finally{rt.destroy();}
});

test('Room receive observes shared private-work capacity atomically without dropping accepted input [AC:bot-rooms#AC-5]',()=>{
  const f=fixture(),room=f.rooms.create(f.principal,{title:'Shared capacity',botIds:[f.a.id,f.b.id],maxBotTurns:1});
  updateBotWorkSettings(f.store,{perBot:1,perPrincipal:2});
  setBotWorkControl(f.host,f.principal,f.a.id,{paused:true,disabled:false});
  const accepted=enqueueBotMessage(f.host,{principal:f.principal,senderBotId:f.b.id,targetBotId:f.a.id,message:'accepted private input',idempotencyKey:'private'});
  assert.throws(()=>f.rooms.send(f.principal,room.id,{text:'overflow',mentions:[f.a.id]}),error=>error.code==='QUEUE_FULL'&&error.statusCode===429&&error.retryable);
  assert.equal(f.rooms.messages(f.principal,room.id).messages.length,0);
  assert.equal(f.rooms.turns(f.principal,room.id).length,0);
  const queued=f.rooms.send(f.principal,room.id,{text:'accepted room input',mentions:[f.b.id],idempotencyKey:'room'});
  assert.throws(()=>f.rooms.send(f.principal,room.id,{text:'second overflow',mentions:[f.b.id]}),error=>error.code==='QUEUE_FULL');
  assert.equal(f.rooms.send(f.principal,room.id,{text:'accepted room input',mentions:[f.b.id],idempotencyKey:'room'}).message.id,queued.message.id);
  assert.ok(f.store.db.prepare('SELECT id FROM bot_work_messages WHERE id=?').get(accepted.messageId));
  assert.equal(f.rooms.messages(f.principal,room.id).messages[0].id,queued.message.id);
});

test('leaving a queued group preserves capacity accounting for remaining speakers within the budget [AC:bot-rooms#AC-4] [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture(),c=createBot(f.facade,{name:'Gamma'});
  const room=f.rooms.create(f.principal,{title:'Remaining members',botIds:[f.a.id,f.b.id,c.id],maxBotTurns:2});
  f.rooms.send(f.principal,room.id,{text:'all',mentions:[f.a.id,f.b.id,c.id]});
  assert.deepEqual(botQueueUsage(f.store,f.principal).byBot,{[f.a.id]:1,[f.b.id]:1});
  f.rooms.removeMember(f.principal,room.id,f.a.id);
  assert.deepEqual(botQueueUsage(f.store,f.principal).byBot,{[f.b.id]:1,[c.id]:1});
  await f.rooms.tick();
  assert.equal(f.runs.length,2);assert.equal(botQueueUsage(f.store,f.principal).total,0);
});

function userPrompts(store, sessionId) {
  return store.listMessages(sessionId).filter(message => message.role === 'user').flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text));
}

/** Tests that replace runSession still need the fixture's run log. */
function recordingRun(f, body) {
  f.host.runSession = async (id, options) => { f.runs.push(id); return body(id, options); };
}

test('a member replying [SILENT] posts nothing and the next member still speaks [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Silence', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async id => {
    const agentId = f.store.getSession(id).agentId;
    const text = agentId === f.a.id ? '[SILENT]' : `reply:${agentId}`;
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  f.rooms.send(f.principal, room.id, { text: 'anyone?' });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.equal(turn.botTurns, 2);
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.deepEqual(posted.map(message => message.sender.id), [f.b.id]);
  assert.ok(!posted.some(message => message.text.includes('[SILENT]')));
});

test('an empty assistant reply stays silent instead of failing the round [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Empty', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async id => {
    const agentId = f.store.getSession(id).agentId;
    if (agentId === f.a.id) f.store.appendMessage(id, 'assistant', [{ type: 'text', text: '   ' }]);
    else f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `reply:${agentId}` }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  f.rooms.send(f.principal, room.id, { text: 'hello' });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.notEqual(turn.terminationReason, 'member_returned_no_result');
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.deepEqual(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').map(message => message.sender.id), [f.b.id]);
});

test('only the last scheduled member is told this is the wrap-up turn [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Wrap', botIds: [f.a.id, f.b.id] });
  f.rooms.send(f.principal, room.id, { text: 'round' });
  await f.rooms.tick();
  const alpha = userPrompts(f.store, f.runs[0]).at(-1);
  const beta = userPrompts(f.store, f.runs[1]).at(-1);
  assert.ok(!alpha.includes('本轮收尾'));
  assert.ok(!alpha.includes('wrap-up'));
  assert.ok(beta.includes('本轮收尾'));
  assert.ok(beta.includes('wrap-up'));
});

test('maxBotTurns of 1 gives the wrap-up signal to the only member that runs [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Budget wrap', botIds: [f.a.id, f.b.id], maxBotTurns: 1 });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  const first = userPrompts(f.store, f.runs[0]).at(-1);
  assert.ok(first.includes('本轮收尾'));
  assert.ok(first.includes('wrap-up'));
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.a.id);
});

test('removing a later scheduled member makes the preceding member the wrap-up member [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Leave wrap', botIds: [f.a.id, f.b.id] });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  f.rooms.removeMember(f.principal, room.id, f.b.id);
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  const first = userPrompts(f.store, f.runs[0]).at(-1);
  assert.ok(first.includes('本轮收尾'));
  assert.ok(first.includes('wrap-up'));
});

test('a silent member still uses one speaking-budget slot [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Budget silence', botIds: [f.a.id, f.b.id], maxBotTurns: 1 });
  recordingRun(f, async id => {
    const agentId = f.store.getSession(id).agentId;
    const text = agentId === f.a.id ? '[SILENT]' : `reply:${agentId}`;
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(f.runs.length, 1);
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.a.id);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'budget');
  assert.equal(turn.botTurns, 1);
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').length, 0);
});

test('when the budget covers every member only the last one gets the wrap-up signal [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Budget covers all', botIds: [f.a.id, f.b.id], maxBotTurns: 2 });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
  const first = userPrompts(f.store, f.runs[0]).at(-1);
  const last = userPrompts(f.store, f.runs[1]).at(-1);
  assert.ok(!first.includes('本轮收尾'));
  assert.ok(!first.includes('wrap-up'));
  assert.ok(last.includes('本轮收尾'));
  assert.ok(last.includes('wrap-up'));
});

test('queue usage counts only budgeted member runs and drops after a silent run [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const c = createBot(f.facade, { name: 'Gamma' });
  f.store.updateSession(c.canonicalSessionId, { metadata: { ...f.store.getSession(c.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Capacity silence', botIds: [f.a.id, f.b.id, c.id], maxBotTurns: 2 });
  f.rooms.send(f.principal, room.id, { text: 'all', mentions: [f.a.id, f.b.id, c.id] });
  assert.equal(botQueueUsage(f.store, f.principal).total, 2);
  assert.deepEqual(botQueueUsage(f.store, f.principal).byBot, { [f.a.id]: 1, [f.b.id]: 1 });
  setBotWorkControl(f.host, f.principal, f.b.id, { paused: true, disabled: false });
  recordingRun(f, async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: '[SILENT]' }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(f.runs.length, 1);
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.a.id);
  assert.equal(turn.status, 'queued');
  assert.equal(turn.terminationReason, 'bot_paused');
  assert.equal(turn.botTurns, 1);
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.equal(botQueueUsage(f.store, f.principal).total, 1);
  assert.deepEqual(botQueueUsage(f.store, f.principal).byBot, { [f.b.id]: 1 });
});

test('a failed or aborted member still fails the round [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Still fails', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'partial' }]);
    f.store.updateSession(id, { status: 'idle', metadata: { ...f.store.getSession(id).metadata, outcome: { kind: 'aborted', reason: 'user_abort' } } });
  });
  f.rooms.send(f.principal, room.id, { text: 'go' });
  await f.rooms.tick();
  const aborted = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(aborted.status, 'cancelled');
  assert.equal(aborted.terminationReason, 'user_abort');
  assert.equal(f.runs.length, 1);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').length, 0);

  recordingRun(f, async id => { f.store.updateSession(id, { status: 'failed' }); });
  f.rooms.send(f.principal, room.id, { text: 'again' });
  await f.rooms.tick();
  const failed = f.rooms.turns(f.principal, room.id).at(-1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.terminationReason, 'member_execution_failed');
  assert.equal(f.runs.length, 2);
});

test('a round where every member stays silent still completes [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'All quiet', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: '[SILENT]' }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  f.rooms.send(f.principal, room.id, { text: 'anyone?' });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');
  assert.equal(turn.botTurns, 2);
  assert.deepEqual(turn.silentBotIds, [f.a.id, f.b.id]);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').length, 0);
});

test('Hello @Beta schedules Beta first and tells Alpha to stay quiet unless necessary [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Order', botIds: [f.a.id, f.b.id] });
  const sent = f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name}` });
  assert.deepEqual(sent.turn.botIds, [f.b.id, f.a.id]);
  assert.deepEqual(sent.turn.mentionedBotIds, [f.b.id]);
  await f.rooms.tick();
  const beta = userPrompts(f.store, f.runs[0]).at(-1);
  const alpha = userPrompts(f.store, f.runs[1]).at(-1);
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.b.id);
  assert.ok(!beta.includes('not @-mentioned'));
  assert.ok(alpha.includes('not @-mentioned'));
  assert.ok(alpha.includes('[SILENT]'));
});

test('an unmentioned member replying [SILENT] leaves only the mentioned post [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Quiet extra', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async id => {
    const agentId = f.store.getSession(id).agentId;
    const text = agentId === f.a.id ? '[SILENT]' : `reply:${agentId}`;
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name}` });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.deepEqual(posted.map(message => message.sender.id), [f.b.id]);
});

test('a message without @ schedules every member with no restraint text [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Open floor', botIds: [f.a.id, f.b.id] });
  const sent = f.rooms.send(f.principal, room.id, { text: 'ordinary question' });
  assert.deepEqual(sent.turn.botIds, [f.a.id, f.b.id]);
  assert.equal(sent.turn.mentionedBotIds, undefined);
  await f.rooms.tick();
  for (const id of f.runs) assert.ok(!userPrompts(f.store, id).at(-1).includes('not @-mentioned'));
});

test('an @ that matches nobody schedules every member with restraint and adds no outsider [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Unknown name', botIds: [f.a.id, f.b.id] });
  const sent = f.rooms.send(f.principal, room.id, { text: '@NoSuchMember do work' });
  assert.deepEqual(sent.turn.botIds, [f.a.id, f.b.id]);
  assert.deepEqual(sent.turn.mentionedBotIds, []);
  assert.ok(!sent.turn.botIds.includes('NoSuchMember'));
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
  for (const id of f.runs) assert.ok(userPrompts(f.store, id).at(-1).includes('not @-mentioned'));
  const none = f.rooms.send(f.principal, room.id, { text: 'explicit empty', mentions: [] });
  assert.deepEqual(none.turn.botIds, [f.a.id, f.b.id]);
  assert.deepEqual(none.turn.mentionedBotIds, []);
});

test('retrying the same explicit mentions returns the same receipt [AC:bot-rooms#AC-2]', () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Retry', botIds: [f.a.id, f.b.id] });
  const first = f.rooms.send(f.principal, room.id, { text: 'hello', mentions: [f.b.id], idempotencyKey: 'same' });
  assert.deepEqual(first.turn.botIds, [f.b.id, f.a.id]);
  assert.deepEqual(first.turn.mentionedBotIds, [f.b.id]);
  const retry = f.rooms.send(f.principal, room.id, { text: 'hello', mentions: [f.b.id], idempotencyKey: 'same' });
  assert.equal(retry.message.id, first.message.id);
  assert.equal(retry.turn.id, first.turn.id);
  assert.throws(() => f.rooms.send(f.principal, room.id, { text: 'hello', mentions: [f.a.id], idempotencyKey: 'same' }), /different Room message/);
});

test('maxBotTurns of 1 lets the mentioned member post and never runs the unmentioned member [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Mention budget', botIds: [f.a.id, f.b.id], maxBotTurns: 1 });
  f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name}` });
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.b.id);
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'budget');
  assert.equal(turn.botTurns, 1);
  assert.deepEqual(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').map(message => message.sender.id), [f.b.id]);
  assert.ok(!f.runs.some(id => f.store.getSession(id).agentId === f.a.id));
});

test('a silent mentioned member spends the only budget slot so the unmentioned member never runs [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Silent mention budget', botIds: [f.a.id, f.b.id], maxBotTurns: 1 });
  recordingRun(f, async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: '[SILENT]' }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name}` });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(f.runs.length, 1);
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.b.id);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'budget');
  assert.equal(turn.botTurns, 1);
  assert.deepEqual(turn.silentBotIds, [f.b.id]);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').length, 0);
});

test('when maxBotTurns equals the mentioned count unmentioned members never run [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const c = createBot(f.facade, { name: 'Gamma' });
  f.store.updateSession(c.canonicalSessionId, { metadata: { ...f.store.getSession(c.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Mentioned fill the budget', botIds: [f.a.id, f.b.id, c.id], maxBotTurns: 2 });
  const sent = f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name} @${f.a.name}` });
  assert.deepEqual(sent.turn.botIds, [f.b.id, f.a.id, c.id]);
  assert.deepEqual(sent.turn.mentionedBotIds, [f.b.id, f.a.id]);
  assert.deepEqual(botQueueUsage(f.store, f.principal).byBot, { [f.b.id]: 1, [f.a.id]: 1 });
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
  assert.deepEqual(f.runs.map(id => f.store.getSession(id).agentId), [f.b.id, f.a.id]);
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'budget');
  assert.equal(turn.botTurns, 2);
  assert.ok(!f.runs.some(id => f.store.getSession(id).agentId === c.id));
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.deepEqual(posted.map(message => message.sender.id), [f.b.id, f.a.id]);
});

test('deleted approval context becomes unknown without blocking or replaying later queued work [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture(),room=f.rooms.create(f.principal,{title:'Missing context',botIds:[f.a.id]});let calls=0;
  f.host.runSession=async id=>{calls++;f.store.createApproval({sessionId:id,toolName:'write_file',args:{},reason:'pending'});f.store.updateSession(id,{status:'waiting_approval'});};
  f.rooms.send(f.principal,room.id,{text:'UNCONFIRMED_OLD_WORK'});await f.rooms.tick();
  const old=f.rooms.turns(f.principal,room.id)[0];assert.equal(old.status,'waiting_approval');
  f.store.deleteSession(old.currentSessionId);
  const restarted=new BotRoomService(f.host);
  assert.equal(restarted.turns(f.principal,room.id)[0].status,'unknown');
  f.host.runSession=async id=>{calls++;const text=f.store.listMessages(id).flatMap(message=>message.parts).map(part=>part.text??'').join('');assert.ok(text.includes('UNCONFIRMED effects'));f.store.appendMessage(id,'assistant',[{type:'text',text:'only new work completed'}]);};
  restarted.send(f.principal,room.id,{text:'NEW_SEPARATE_WORK'});await restarted.tick();
  assert.equal(calls,2);assert.equal(restarted.turns(f.principal,room.id)[0].status,'unknown');assert.equal(restarted.turns(f.principal,room.id)[1].status,'completed');
  assert.equal(restarted.turns(f.principal,room.id)[0].terminationReason,'execution_context_missing');
});
