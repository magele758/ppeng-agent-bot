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

test('mentions wake only named members and a message without @ wakes every member [AC:bot-rooms#AC-2] [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  f.store.appendMessage(f.a.canonicalSessionId, 'user', [{ type: 'text', text: 'PRIVATE_SECRET' }]);
  const room = f.rooms.create(f.principal, { title: 'Team', botIds: [f.a.id, f.b.id], hostBotId: f.a.id });
  const sent = f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name} @${f.a.name}` });
  assert.deepEqual(sent.turn.botIds, [f.b.id, f.a.id]);
  await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'completed');
  const messages = f.rooms.messages(f.principal, room.id).messages;
  assert.deepEqual(messages.filter(m => m.sender.type === 'bot').map(m => m.sender.id), [f.b.id, f.a.id]);
  assert.ok(f.runs.every(id => id !== f.a.canonicalSessionId && id !== f.b.canonicalSessionId));
  for (const id of f.runs) assert.ok(!JSON.stringify(f.store.listMessages(id)).includes('PRIVATE_SECRET'));
  assert.equal(f.store.listMessages(f.a.canonicalSessionId).length, 1);
  const defaultTurn = f.rooms.send(f.principal, room.id, { text: 'ordinary question' }).turn;
  assert.deepEqual(defaultTurn.botIds, [f.a.id, f.b.id]);
  assert.deepEqual(f.rooms.send(f.principal,room.id,{text:'email owner@example.com'}).turn.botIds,[f.a.id, f.b.id]);
  assert.deepEqual(f.rooms.send(f.principal,room.id,{text:'@NoSuchMember do work'}).turn.botIds,[]);
  assert.deepEqual(f.rooms.send(f.principal,room.id,{text:`only @${f.b.name}`}).turn.botIds,[f.b.id]);
  assert.deepEqual(f.rooms.send(f.principal,room.id,{text:`@${f.a.name} @Stranger`}).turn.botIds,[f.a.id]);
});

test('a spaced display name is one mention and does not add outsiders [AC:bot-rooms#AC-2]', () => {
  const f = fixture();
  const superBot = createBot(f.facade, { name: 'Super Bot' });
  f.store.updateSession(superBot.canonicalSessionId, { metadata: { ...f.store.getSession(superBot.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Names', botIds: [f.a.id, superBot.id], hostBotId: f.a.id });
  assert.deepEqual(f.rooms.send(f.principal, room.id, { text: 'hi @Super Bot now' }).turn.botIds, [superBot.id]);
  assert.deepEqual(f.rooms.send(f.principal, room.id, { text: '@Super Bot @Nope' }).turn.botIds, [superBot.id]);
  assert.deepEqual(f.rooms.send(f.principal, room.id, { text: 'all of you' }).turn.botIds, [f.a.id, superBot.id]);
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
  assert.equal(f.runs.length, 1);
  f.rooms.send(f.principal, room.id, { text: 'stop this', mentions: [f.a.id] });
  f.rooms.stop(f.principal, room.id);
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
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

test('a member step that needs a person leaves the room for the private chat and does not fail the turn [AC:bot-rooms#AC-8]', async () => {
  const f=fixture();
  const room=f.rooms.create(f.principal,{title:'Approval',botIds:[f.a.id,f.b.id]});
  let calls=0;
  f.host.runSession=async id=>{
    calls++;
    const session=f.store.getSession(id);
    if(session.agentId!==f.a.id){f.store.appendMessage(id,'assistant',[{type:'text',text:'beta continues'}]);return;}
    f.store.createApproval({sessionId:id,toolName:'write_file',reason:'needs a person',args:{path:'secret.env',token:'SECRET_CREDENTIAL'}});
    f.store.updateSession(id,{status:'waiting_approval',metadata:{...session.metadata,interrupt:{kind:'waiting_approval',approvalIds:['x']},outcome:{kind:'waiting_approval'}}});
  };
  f.rooms.send(f.principal,room.id,{text:'needs a person',mentions:[f.a.id,f.b.id]});
  await f.rooms.tick();
  const turn=f.rooms.turns(f.principal,room.id)[0];
  assert.equal(turn.status,'completed');
  assert.notEqual(turn.status,'failed');
  assert.deepEqual(turn.handedOffBotIds,[f.a.id]);
  assert.equal(calls,2);
  const roomText=f.rooms.messages(f.principal,room.id).messages.map(message=>message.text).join('\n');
  assert.match(roomText,/私聊/);
  assert.equal(roomText.includes('SECRET_CREDENTIAL'),false);
  assert.equal(roomText.includes('write_file'),false);
  assert.equal(roomText.includes('secret.env'),false);
  assert.match(roomText,/beta continues/);
  const pending=f.store.listApprovals({status:'pending'});
  assert.equal(pending.length,1);
  assert.equal(pending[0].sessionId,f.a.canonicalSessionId);
  const privateText=f.store.listMessages(f.a.canonicalSessionId).map(message=>message.parts.map(part=>part.text??'').join('')).join('\n');
  assert.match(privateText,/Approval/);
  assert.equal(privateText.includes('SECRET_CREDENTIAL'),false);
  const member=f.store.listSessions().find(session=>session.metadata?.roomId===room.id&&session.metadata?.botId===f.a.id);
  assert.equal(member.status,'idle');
  assert.equal(member.metadata.interrupt,undefined);
  const memberText=JSON.stringify(f.store.listMessages(member.id));
  assert.equal(memberText.includes('SECRET_CREDENTIAL'),false);
  assert.equal(memberText.includes('write_file'),false);
  assert.equal(memberText.includes('secret.env'),false);
  f.store.appendMessage(f.a.canonicalSessionId,'assistant',[{type:'text',text:'PRIVATE_APPROVAL_RESULT'}]);
  f.store.updateSession(f.a.canonicalSessionId,{status:'idle'});
  await f.rooms.tick();
  const after=f.rooms.messages(f.principal,room.id).messages.map(message=>message.text).join('\n');
  assert.equal(after.includes('PRIVATE_APPROVAL_RESULT'),false);
  assert.equal(calls,2);
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
    for(const input of calls)for(const name of ['bot_delegate','spawn_subagent','spawn_teammate','send_message','task_create'])assert.ok(!input.tools.some(tool=>tool.name===name),`${name} cannot bypass Room scheduling`);
    assert.ok(calls.some(input=>input.tools.some(tool=>tool.name==='message_agent')),'a Room member may send one bot a private 1:1');
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

test('approving the handed-off step in the private chat does not rerun it in the room [AC:bot-rooms#AC-8] [AC:bot-rooms#AC-3]',async()=>{
  let executions=0;
  const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'room-approval-repo-')),stateDir:mkdtempSync(join(tmpdir(),'room-approval-state-')),extraTools:[{name:'room_approval_probe',description:'Approval probe',inputSchema:{type:'object',properties:{}},approvalMode:'always',sideEffectLevel:'workspace',async execute(){executions++;return {ok:true,content:'APPROVED_PROBE_RESULT'};}}],modelAdapter:{name:'room-approval-scripted',async runTurn(input){if(input.messages.some(message=>message.parts.some(part=>part.type==='tool_result'&&part.name==='room_approval_probe')))return {stopReason:'end',assistantParts:[{type:'text',text:'Verified approved work finished'}]};return {stopReason:'tool_use',assistantParts:[{type:'text',text:'Pending work, not complete'},{type:'tool_call',toolCallId:'approval-probe',name:'room_approval_probe',input:{}}]};},async summarizeMessages(){return '';}}});
  try {
    const bot=rt.createBot({name:'ApprovalMember'}),principal=resolveBotPrincipal(rt.store),room=rt.rooms.create(principal,{title:'Actual approval',botIds:[bot.id]});
    rt.rooms.send(principal,room.id,{text:'Run the approved action'});await rt.rooms.tick();
    const turn=rt.rooms.turns(principal,room.id)[0];
    assert.equal(turn.status,'completed');assert.deepEqual(turn.handedOffBotIds,[bot.id]);assert.notEqual(turn.status,'failed');assert.equal(executions,0);
    const roomText=rt.rooms.messages(principal,room.id).messages.map(message=>message.text).join('\n');
    assert.match(roomText,/私聊/);
    assert.equal(roomText.includes('room_approval_probe'),false);
    assert.equal(roomText.includes('Pending work'),false);
    const approval=rt.store.listApprovals({status:'pending'})[0];
    assert.ok(approval);assert.equal(approval.sessionId,bot.canonicalSessionId);
    const member=rt.store.listSessions().find(session=>session.metadata?.roomId===room.id);
    assert.equal(member.status,'idle');
    await rt.approve(approval.id,'approved');
    await rt.runSession(bot.canonicalSessionId);
    await rt.rooms.tick();
    assert.equal(executions,1);
    const after=rt.rooms.messages(principal,room.id).messages.map(message=>message.text).join('\n');
    assert.equal(after.includes('APPROVED_PROBE_RESULT'),false);
    assert.equal(after.includes('Verified approved work finished'),false);
    assert.equal(rt.rooms.turns(principal,room.id)[0].status,'completed');
    const privateText=JSON.stringify(rt.store.listMessages(bot.canonicalSessionId));
    assert.match(privateText,/APPROVED_PROBE_RESULT/);
    const memberText=JSON.stringify(rt.store.listMessages(member.id));
    assert.equal(memberText.includes('tool_result'),false);
    assert.equal(memberText.includes('room_approval_probe'),false);
    assert.equal(member.status,'idle');
  }finally{rt.destroy();}
});

test('a busy private chat keeps the step in the room until it is idle, then runs it once there [AC:bot-rooms#AC-8]',async()=>{
  let executions=0;
  const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'room-busy-repo-')),stateDir:mkdtempSync(join(tmpdir(),'room-busy-state-')),extraTools:[{name:'room_approval_probe',description:'Approval probe',inputSchema:{type:'object',properties:{}},approvalMode:'always',sideEffectLevel:'workspace',async execute(){executions++;return {ok:true,content:'APPROVED_PROBE_RESULT'};}}],modelAdapter:{name:'room-busy-scripted',async runTurn(input){if(input.messages.some(message=>message.parts.some(part=>part.type==='tool_result'&&part.name==='room_approval_probe')))return {stopReason:'end',assistantParts:[{type:'text',text:'Verified approved work finished'}]};return {stopReason:'tool_use',assistantParts:[{type:'text',text:'Pending work, not complete'},{type:'tool_call',toolCallId:'approval-probe',name:'room_approval_probe',input:{}}]};},async summarizeMessages(){return '';}}});
  try {
    const bot=rt.createBot({name:'BusyMember'}),principal=resolveBotPrincipal(rt.store);
    rt.store.updateSession(bot.canonicalSessionId,{status:'running'});
    const room=rt.rooms.create(principal,{title:'Busy approval',botIds:[bot.id]});
    rt.rooms.send(principal,room.id,{text:'Run the approved action'});
    await rt.rooms.tick();
    const waiting=rt.rooms.turns(principal,room.id)[0];
    assert.equal(waiting.status,'waiting_approval');
    assert.equal(waiting.handedOffBotIds,undefined);
    assert.equal(rt.store.listApprovals({status:'pending'}).every(approval=>approval.sessionId!==bot.canonicalSessionId),true);
    assert.equal(JSON.stringify(rt.store.listMessages(bot.canonicalSessionId)).includes('Busy approval'),false);
    assert.equal(executions,0);
    await rt.rooms.tick();
    assert.equal(rt.rooms.turns(principal,room.id)[0].status,'waiting_approval');
    rt.store.updateSession(bot.canonicalSessionId,{status:'idle'});
    await rt.rooms.tick();
    const handed=rt.rooms.turns(principal,room.id)[0];
    assert.equal(handed.status,'completed');
    assert.deepEqual(handed.handedOffBotIds,[bot.id]);
    const approval=rt.store.listApprovals({status:'pending'})[0];
    assert.equal(approval.sessionId,bot.canonicalSessionId);
    await rt.approve(approval.id,'approved');
    await rt.runSession(bot.canonicalSessionId);
    assert.equal(executions,1);
    const member=rt.store.listSessions().find(session=>session.metadata?.roomId===room.id);
    assert.equal(JSON.stringify(rt.store.listMessages(member.id)).includes('tool_result'),false);
    assert.equal(rt.rooms.messages(principal,room.id).messages.map(message=>message.text).join('\n').includes('APPROVED_PROBE_RESULT'),false);
  }finally{rt.destroy();}
});

test('a failed hand-off transaction leaves the approval, the turn and the member unchanged [AC:bot-rooms#AC-8]',async()=>{
  const f=fixture();
  const room=f.rooms.create(f.principal,{title:'Atomic',botIds:[f.a.id]});
  f.host.runSession=async id=>{
    const session=f.store.getSession(id);
    f.store.appendMessage(id,'assistant',[{type:'tool_call',toolCallId:'kept',name:'write_file',input:{path:'secret.env'}}]);
    f.store.createApproval({sessionId:id,toolName:'write_file',reason:'needs a person',args:{path:'secret.env'}});
    f.store.updateSession(id,{status:'waiting_approval',metadata:{...session.metadata,interrupt:{kind:'waiting_approval',approvalIds:['x']},outcome:{kind:'waiting_approval'}}});
  };
  const db=f.store.db,original=db.prepare.bind(db);
  db.prepare=(sql,...rest)=>{
    const statement=original(sql,...rest);
    if(typeof sql==='string'&&sql.includes('INSERT INTO session_messages')&&sql.includes('parts_json')){
      const run=statement.run.bind(statement);
      statement.run=(...args)=>{if(args[0]===f.a.canonicalSessionId||args[1]===f.a.canonicalSessionId)throw new Error('private write failed');return run(...args);};
    }
    return statement;
  };
  f.rooms.send(f.principal,room.id,{text:'needs a person'});
  await f.rooms.tick();
  const turn=f.rooms.turns(f.principal,room.id)[0];
  assert.equal(turn.status,'waiting_approval');
  const approval=f.store.listApprovals({status:'pending'})[0];
  const member=f.store.listSessions().find(session=>session.metadata?.roomId===room.id);
  assert.equal(approval.sessionId,member.id);
  assert.equal(member.status,'waiting_approval');
  assert.equal(JSON.stringify(f.store.listMessages(f.a.canonicalSessionId)).includes('Atomic'),false);
  assert.equal(f.rooms.messages(f.principal,room.id).messages.some(message=>message.sender.type==='bot'),false);
});

test('Room receive observes shared private-work capacity atomically without dropping accepted input [AC:bot-rooms#AC-5]',()=>{
  const f=fixture(),room=f.rooms.create(f.principal,{title:'Shared capacity',botIds:[f.a.id,f.b.id]});
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

test('deleted approval context becomes unknown without blocking or replaying later queued work [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture(),room=f.rooms.create(f.principal,{title:'Missing context',botIds:[f.a.id]});let calls=0;
  let release;
  f.host.runSession=id=>new Promise(resolve=>{calls++;release=()=>{f.store.appendMessage(id,'assistant',[{type:'text',text:'late'}]);f.store.updateSession(id,{status:'idle'});resolve();};});
  f.rooms.send(f.principal,room.id,{text:'UNCONFIRMED_OLD_WORK'});
  const running=f.rooms.tick();
  await new Promise(resolve=>setImmediate(resolve));
  const old=f.rooms.turns(f.principal,room.id)[0];assert.equal(old.status,'running');
  const contextId=old.currentSessionId;
  release();await running;
  const done=f.rooms.turns(f.principal,room.id)[0];
  f.store.db.prepare("UPDATE bot_room_turns SET status='running',data=? WHERE id=?").run(JSON.stringify({...done,status:'running',currentSessionId:contextId}),done.id);
  f.store.deleteSession(contextId);
  const restarted=new BotRoomService(f.host);
  assert.equal(restarted.turns(f.principal,room.id)[0].status,'unknown');
  f.host.runSession=async id=>{calls++;const text=f.store.listMessages(id).flatMap(message=>message.parts).map(part=>part.text??'').join('');assert.ok(text.includes('UNCONFIRMED effects'));f.store.appendMessage(id,'assistant',[{type:'text',text:'only new work completed'}]);};
  restarted.send(f.principal,room.id,{text:'NEW_SEPARATE_WORK'});await restarted.tick();
  assert.equal(calls,2);assert.equal(restarted.turns(f.principal,room.id)[0].status,'unknown');assert.equal(restarted.turns(f.principal,room.id)[1].status,'completed');
  assert.equal(restarted.turns(f.principal,room.id)[0].terminationReason,'execution_context_missing');
});

test('a Room member can privately message another bot, with or without waking it, and the note stays out of the Room [AC:bot-rooms#AC-7]', async () => {
  const privateReply = 'PRIVATE_REPLY_STAYS_OUT';
  const adapter = { name: 'room-dm', nextWake: true, async summarizeMessages() { return ''; } };
  const rt = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'room-dm-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'room-dm-state-')),
    modelAdapter: adapter
  });
  try {
    const alpha = rt.createBot({ name: 'Alpha' });
    const beta = rt.createBot({ name: 'Beta' });
    const principal = resolveBotPrincipal(rt.store);
    const room = rt.rooms.create(principal, { title: 'Side channel', botIds: [alpha.id, beta.id] });
    adapter.runTurn = async input => {
      const latestUser = input.messages.findLast(message => message.role === 'user');
      const latestIndex = input.messages.lastIndexOf(latestUser);
      const done = input.messages.slice(latestIndex + 1).some(message => message.parts.some(part => part.type === 'tool_result'));
      if (done) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'told them privately' }] };
      const session = rt.store.getSession(input.sessionId);
      if (session?.metadata?.roomId !== room.id) return { stopReason: 'end', assistantParts: [{ type: 'text', text: privateReply }] };
      if (session.metadata.botId !== alpha.id) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'beta stays in the room' }] };
      assert.ok(input.tools.some(tool => tool.name === 'message_agent'));
      const wake = adapter.nextWake;
      return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'dm', name: 'message_agent', input: { target: 'Beta', message: `note wake=${wake}`, wake } }] };
    };

    adapter.nextWake = true;
    rt.rooms.send(principal, room.id, { text: 'ask beta privately', mentions: [alpha.id] });
    await rt.rooms.tick();
    await waitFor(async () => rt.store.listMessages(beta.canonicalSessionId).some(message => message.role === 'assistant') ? true : null);
    const woken = rt.store.listMessages(beta.canonicalSessionId).filter(message => message.role === 'user').map(message => message.parts.map(part => part.text ?? '').join('')).join('\n');
    assert.match(woken, new RegExp(`from room ${room.id}`));
    assert.match(woken, /note wake=true/);
    const stored = rt.store.db.prepare('SELECT source_room, wake, hop FROM bot_work_messages WHERE sender_bot=?').all(alpha.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source_room, room.id);
    assert.equal(stored[0].wake, 1);
    assert.equal(stored[0].hop, 1);
    assert.equal(rt.store.getSession(beta.canonicalSessionId).metadata.approvalWake.kind, 'unattended');
    const roomText = rt.rooms.messages(principal, room.id).messages.map(message => message.text).join('\n');
    assert.equal(roomText.includes(privateReply), false);
    assert.equal(roomText.includes('note wake=true'), false);

    adapter.nextWake = false;
    rt.rooms.send(principal, room.id, { text: 'leave a note', mentions: [alpha.id] });
    await rt.rooms.tick();
    const quietRow = rt.store.db.prepare('SELECT source_room, wake, status FROM bot_work_messages WHERE body=?').get('note wake=false');
    assert.equal(quietRow.source_room, room.id);
    assert.equal(quietRow.wake, 0);
    assert.equal(quietRow.status, 'processed');
    const betaRuns = rt.store.listMessages(beta.canonicalSessionId).filter(message => message.role === 'assistant');
    assert.equal(betaRuns.length, 1);
    assert.equal(rt.rooms.messages(principal, room.id).messages.some(message => message.text.includes('note wake=false')), false);

    adapter.runTurn = async input => {
      const latestUser = input.messages.findLast(message => message.role === 'user');
      const done = input.messages.slice(input.messages.lastIndexOf(latestUser) + 1).some(message => message.parts.some(part => part.type === 'tool_result'));
      if (done) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'unknown target refused' }] };
      return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'miss', name: 'message_agent', input: { target: 'Nobody', message: 'should not land' } }] };
    };
    rt.rooms.send(principal, room.id, { text: 'message a stranger', mentions: [alpha.id] });
    await rt.rooms.tick();
    const member = rt.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === alpha.id);
    const missed = rt.store.listMessages(member.id).flatMap(message => message.parts).filter(part => part.type === 'tool_result').at(-1);
    assert.equal(JSON.parse(missed.content).error_code, 'UNKNOWN_TARGET');
    assert.equal(rt.store.db.prepare("SELECT id FROM bot_work_messages WHERE body='should not land'").get(), undefined);
  } finally { rt.destroy(); }
});

test('a Room private message still stops at three hops and a full tool budget blocks another one [AC:bot-rooms#AC-7]', async () => {
  const hops = [];
  const adapter = {
    name: 'room-hop',
    async runTurn(input) {
      const session = rt.store.getSession(input.sessionId);
      const done = input.messages.some(message => message.parts.some(part => part.type === 'tool_result' || (part.type === 'text' && String(part.text).includes('Relay hop limit'))));
      if (session?.metadata?.canonicalBotChat === true) {
        const hop = session.metadata.relayHop ?? 0;
        if (done) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'chain ended' }] };
        if (hop >= 3) return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'hop', name: 'message_agent', input: { target: 'Epsilon', message: 'one too many' } }] };
        const order = ['Alpha', 'Beta', 'Gamma', 'Delta'];
        const name = rt.store.getBot(session.metadata.botId)?.name;
        const next = order[order.indexOf(name) + 1];
        return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'hop', name: 'message_agent', input: { target: next, message: `forward ${hop}` } }] };
      }
      if (done) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'room done' }] };
      return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'hop', name: 'message_agent', input: { target: 'Beta', message: 'from the room' } }] };
    },
    async summarizeMessages() { return ''; }
  };
  const rt = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'room-hop-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'room-hop-state-')),
    modelAdapter: adapter
  });
  try {
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
    const bots = names.map(name => rt.createBot({ name }));
    const principal = resolveBotPrincipal(rt.store);
    const room = rt.rooms.create(principal, { title: 'Hop room', botIds: [bots[0].id] });
    rt.rooms.send(principal, room.id, { text: 'start a chain' });
    await rt.rooms.tick();
    await waitFor(async () => {
      const row = rt.store.db.prepare("SELECT hop, status FROM bot_work_messages WHERE target_bot=? ORDER BY seq DESC LIMIT 1").get(bots[3].id);
      return row && row.status !== 'pending' ? row : null;
    });
    const delivered = rt.store.db.prepare('SELECT sender_bot, target_bot, hop, source_room FROM bot_work_messages ORDER BY seq').all();
    for (const row of delivered) hops.push(row.hop);
    assert.deepEqual(hops, [1, 2, 3]);
    assert.equal(delivered[0].source_room, room.id);
    assert.equal(delivered[1].source_room, null);
    const epsilon = rt.store.db.prepare('SELECT id FROM bot_work_messages WHERE target_bot=?').get(bots[4].id);
    assert.equal(epsilon, undefined);
    const blocked = bots.flatMap(bot => rt.store.listMessages(bot.canonicalSessionId)).flatMap(message => message.parts).find(part => part.type === 'tool_result' && String(part.content).includes('HOP_LIMIT'));
    assert.equal(JSON.parse(blocked.content).error_code, 'HOP_LIMIT');
    const roomText = rt.rooms.messages(principal, room.id).messages.map(message => message.text).join('\n');
    assert.equal(roomText.includes('forward'), false);
    assert.equal(roomText.includes('chain ended'), false);
  } finally { rt.destroy(); }
});

test('a Room turn that has used its tool budget cannot send another private message [AC:bot-rooms#AC-7]', async () => {
  const adapter = {
    name: 'room-budget',
    async runTurn(input) {
      const over = input.messages.some(message => message.parts.some(part => part.type === 'tool_result'));
      if (over) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'should not get another turn' }] };
      return {
        stopReason: 'tool_use',
        assistantParts: [
          { type: 'tool_call', toolCallId: 'dm1', name: 'message_agent', input: { target: 'Beta', message: 'over budget one', wake: false } },
          { type: 'tool_call', toolCallId: 'dm2', name: 'message_agent', input: { target: 'Beta', message: 'over budget two', wake: false } }
        ]
      };
    },
    async summarizeMessages() { return ''; }
  };
  const rt = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'room-budget-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'room-budget-state-')),
    modelAdapter: adapter
  });
  try {
    const alpha = rt.createBot({ name: 'Alpha' });
    const beta = rt.createBot({ name: 'Beta' });
    const principal = resolveBotPrincipal(rt.store);
    const room = rt.rooms.create(principal, { title: 'Tight budget', botIds: [alpha.id], maxToolCalls: 1 });
    rt.rooms.send(principal, room.id, { text: 'one tool only' });
    await rt.rooms.tick();
    assert.equal(rt.rooms.turns(principal, room.id)[0].terminationReason, 'tool_budget');
    const bodies = rt.store.db.prepare('SELECT body FROM bot_work_messages').all().map(row => row.body);
    assert.deepEqual(bodies, []);
    assert.equal(rt.rooms.messages(principal, room.id).messages.some(message => String(message.text).includes('over budget')), false);
  } finally { rt.destroy(); }
});
