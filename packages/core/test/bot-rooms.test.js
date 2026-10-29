import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService, writeRoomSettings } from '../dist/rooms/index.js';
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
  assert.deepEqual(defaultTurn.botIds, []);
  assert.equal(defaultTurn.mentionedBotIds, undefined);
  const email = f.rooms.send(f.principal,room.id,{text:'email owner@example.com'}).turn;
  assert.deepEqual(email.botIds,[]);
  assert.equal(email.mentionedBotIds, undefined);
  const unknown = f.rooms.send(f.principal,room.id,{text:'@NoSuchMember do work'}).turn;
  assert.deepEqual(unknown.botIds,[]);
  assert.deepEqual(unknown.mentionedBotIds, []);
  const onlyBeta = f.rooms.send(f.principal,room.id,{text:`only @${f.b.name}`}).turn;
  assert.deepEqual(onlyBeta.botIds,[f.b.id]);
  assert.deepEqual(onlyBeta.mentionedBotIds,[f.b.id]);
  const stranger = f.rooms.send(f.principal,room.id,{text:`@${f.a.name} @Stranger`}).turn;
  assert.deepEqual(stranger.botIds,[f.a.id]);
  assert.deepEqual(stranger.mentionedBotIds,[f.a.id]);
});

test('a spaced display name is one mention and does not add outsiders [AC:bot-rooms#AC-2]', () => {
  const f = fixture();
  const superBot = createBot(f.facade, { name: 'Super Bot' });
  f.store.updateSession(superBot.canonicalSessionId, { metadata: { ...f.store.getSession(superBot.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Names', botIds: [f.a.id, superBot.id], hostBotId: f.a.id });
  const spaced = f.rooms.send(f.principal, room.id, { text: 'hi @Super Bot now' }).turn;
  assert.deepEqual(spaced.botIds, [superBot.id]);
  assert.deepEqual(spaced.mentionedBotIds, [superBot.id]);
  const outsider = f.rooms.send(f.principal, room.id, { text: '@Super Bot @Nope' }).turn;
  assert.deepEqual(outsider.botIds, [superBot.id]);
  assert.deepEqual(outsider.mentionedBotIds, [superBot.id]);
  const everyone = f.rooms.send(f.principal, room.id, { text: 'all of you' }).turn;
  assert.deepEqual(everyone.botIds, []);
  assert.equal(everyone.mentionedBotIds, undefined);
});

test('budget, pause, stop, leave and resume constrain actual scheduling [AC:bot-rooms#AC-4]', async () => {
  const f = fixture();
  const c = createBot(f.facade, { name: 'Gamma' });
  f.store.updateSession(c.canonicalSessionId, { metadata: { ...f.store.getSession(c.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Budget', botIds: [f.a.id, f.b.id, c.id], maxBotTurns: 1 });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  assert.equal(f.rooms.turns(f.principal, room.id)[0].terminationReason, 'budget');
  f.rooms.patch(f.principal, room.id, { status: 'paused' });
  f.rooms.send(f.principal, room.id, { text: 'later', mentions: [f.b.id, f.a.id] });
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
  const room = f.rooms.create(f.principal, { title: 'Reliable', botIds: [f.a.id, f.b.id] });
  let release;
  f.host.runSession = id => new Promise(resolve => { release = () => { f.store.appendMessage(id, 'assistant', [{type:'text',text:'done'}]); f.store.updateSession(id, { status: 'idle' }); resolve(); }; });
  f.rooms.send(f.principal, room.id, { text: 'first', idempotencyKey: 'one', mentions: [f.a.id] });
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
  const room = f.rooms.create(f.principal, { title: 'Pages', botIds: [f.a.id, f.b.id] });
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
  const room=f.rooms.create(f.principal,{title:'Stop',botIds:[f.a.id,f.b.id]});
  let finish;const cancelled=[];
  f.host.runSession=id=>new Promise(resolve=>{finish=()=>{f.store.appendMessage(id,'assistant',[{type:'text',text:'late'}]);resolve();};});
  f.host.cancelSession=id=>cancelled.push(id);
  f.rooms.send(f.principal,room.id,{text:'work',mentions:[f.a.id]});
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
    const peer=rt.createBot({name:'RoomPeer'});
    rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'PRIVATE_NOT_SHARED'}]);
    const principal=resolveBotPrincipal(rt.store);
    saveSemanticFact(rt.store.agentMemory(),{userId:principal.userId,agentId:bot.id,category:'fact',content:'PRIVATE_MEMORY_NEVER_SHARE alpha quota 9876'});
    const textAttachment=await rt.ingestAttachmentBase64(bot.canonicalSessionId,{fileName:'shared.txt',mimeType:'text/plain',dataBase64:Buffer.from('SHARED_ATTACHMENT_CONTENT').toString('base64')});
    const imageAttachment=await rt.ingestAttachmentBase64(bot.canonicalSessionId,{fileName:'shared.png',mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLl0AAAAASUVORK5CYII='});
    const rooms=rt.rooms??new BotRoomService({store:rt.store,createChatSession:input=>rt.createChatSession(input),runSession:id=>rt.runSession(id),cancelSession:id=>rt.cancelSession(id)});
    const room=rooms.create(principal,{title:'Real runtime',botIds:[bot.id,peer.id],hostBotId:bot.id});
    rooms.send(principal,room.id,{text:'Please answer in the Room',mentions:[bot.id],attachmentIds:[textAttachment.attachment.id,imageAttachment.attachment.id]});
    await rooms.tick();
    assert.equal(rooms.turns(principal,room.id)[0].status,'completed');
    assert.equal(rooms.messages(principal,room.id).messages.at(-1).text,'Actual runtime Room result');
    assert.ok(calls.length>=1);
    assert.ok(calls.every(input=>input.sessionId!==bot.canonicalSessionId&&!JSON.stringify(input.messages).includes('PRIVATE_NOT_SHARED')));
    assert.ok(calls.some(input=>JSON.stringify(input.messages).includes('PRIVATE_MEMORY_NEVER_SHARE')),'this bot can use its private fact in the room turn');
    assert.ok(calls.every(input=>!input.systemPrompt.includes('PRIVATE_MEMORY_NEVER_SHARE')));
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
  const room=f.rooms.create(f.principal,{title:'Tools',botIds:[f.a.id,f.b.id],maxToolCalls:1});
  f.rooms.send(f.principal,room.id,{text:'tools',mentions:[f.a.id]});await f.rooms.tick();
  assert.equal(cancelled,1);
  assert.equal(f.rooms.turns(f.principal,room.id)[0].terminationReason,'tool_budget');
  f.host.runSession=async(id,options)=>{
    const session=f.store.getSession(id);f.store.updateSession(id,{metadata:{...session.metadata,usageCostUsd:2}});
    await options.onEvent({type:'model_done',stopReason:'end',assistant:{parts:[{type:'text',text:'cost'}]}});
    f.store.updateSession(id,{status:'idle'});
  };
  f.rooms.send(f.principal,room.id,{text:'cost',mentions:[f.a.id]});await f.rooms.tick();
  assert.equal(cancelled,2);
  assert.equal(f.rooms.turns(f.principal,room.id).at(-1).terminationReason,'cost_budget');
});

test('aborted partial output is not success and reused Room contexts refresh canonical policy [AC:bot-rooms#AC-4] [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture(),seen=[];
  const room=f.rooms.create(f.principal,{title:'Live policy',botIds:[f.a.id,f.b.id]});
  f.host.runSession=async id=>{seen.push(f.store.getSession(id).metadata.permissionMode);f.store.appendMessage(id,'assistant',[{type:'text',text:'partial'}]);f.store.updateSession(id,{status:'idle',metadata:{...f.store.getSession(id).metadata,outcome:{kind:'aborted',reason:'user_abort'}}});};
  f.rooms.send(f.principal,room.id,{text:'first',mentions:[f.a.id]});await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal,room.id)[0].status,'cancelled');
  assert.equal(f.rooms.messages(f.principal,room.id).messages.filter(message=>message.sender.type==='bot').length,0);
  const canonical=f.store.getSession(f.a.canonicalSessionId);
  f.store.updateSession(canonical.id,{metadata:{...canonical.metadata,permissionMode:'plan',allowedTools:['read_file'],allowedSkills:['limited-skill'],modelOverride:{providerId:'p',modelId:'m'}}});
  f.host.runSession=async id=>{const metadata=f.store.getSession(id).metadata;seen.push(metadata.permissionMode);assert.deepEqual(metadata.allowedTools,['read_file']);assert.deepEqual(metadata.allowedSkills,['limited-skill']);assert.deepEqual(metadata.modelOverride,{providerId:'p',modelId:'m'});f.store.appendMessage(id,'assistant',[{type:'text',text:'safe new result'}]);};
  f.rooms.send(f.principal,room.id,{text:'second',mentions:[f.a.id]});await f.rooms.tick();
  assert.deepEqual(seen,['auto','plan']);
  assert.equal(f.rooms.turns(f.principal,room.id).at(-1).status,'completed');
});

test('unconfirmed software effects override assistant success and preserve the partial evidence [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture();const room=f.rooms.create(f.principal,{title:'Unconfirmed effects',botIds:[f.a.id,f.b.id]});
  const checks=[];f.host.hasUnconfirmedEffects=(id,startedAt)=>{checks.push({id,startedAt});return true;};
  f.rooms.send(f.principal,room.id,{text:'write to software',mentions:[f.a.id]});await f.rooms.tick();
  const turn=f.rooms.turns(f.principal,room.id)[0];
  assert.equal(turn.status,'unknown');assert.equal(turn.terminationReason,'external_effect_unconfirmed');
  assert.ok(turn.partialResult.includes('reply:'));assert.ok(f.store.listMessages(turn.currentSessionId).some(message=>message.role==='assistant'));
  assert.equal(checks[0].startedAt,turn.startedAt);
  assert.equal(f.rooms.messages(f.principal,room.id).messages.filter(message=>message.sender.type==='bot').length,0);
});

test('Bot background pause and disable apply to Room work and preserve pending input [AC:bot-rooms#AC-4] [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture(),room=f.rooms.create(f.principal,{title:'Controlled',botIds:[f.a.id,f.b.id]});
  setBotWorkControl(f.host,f.principal,f.a.id,{paused:true,disabled:true});
  f.rooms.send(f.principal,room.id,{text:'keep pending',mentions:[f.a.id]});await f.rooms.tick();
  assert.equal(f.runs.length,0);assert.equal(f.rooms.turns(f.principal,room.id)[0].status,'queued');assert.equal(f.rooms.turns(f.principal,room.id)[0].terminationReason,'bot_disabled');
  setBotWorkControl(f.host,f.principal,f.a.id,{paused:false,disabled:false});await f.rooms.tick();
  assert.equal(f.runs.length,1);assert.equal(f.rooms.turns(f.principal,room.id)[0].status,'completed');
});

test('approving the handed-off step in the private chat does not rerun it in the room [AC:bot-rooms#AC-8] [AC:bot-rooms#AC-3]',async()=>{
  let executions=0;
  const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'room-approval-repo-')),stateDir:mkdtempSync(join(tmpdir(),'room-approval-state-')),extraTools:[{name:'room_approval_probe',description:'Approval probe',inputSchema:{type:'object',properties:{}},approvalMode:'always',sideEffectLevel:'workspace',async execute(){executions++;return {ok:true,content:'APPROVED_PROBE_RESULT'};}}],modelAdapter:{name:'room-approval-scripted',async runTurn(input){if(input.messages.some(message=>message.parts.some(part=>part.type==='tool_result'&&part.name==='room_approval_probe')))return {stopReason:'end',assistantParts:[{type:'text',text:'Verified approved work finished'}]};return {stopReason:'tool_use',assistantParts:[{type:'text',text:'Pending work, not complete'},{type:'tool_call',toolCallId:'approval-probe',name:'room_approval_probe',input:{}}]};},async summarizeMessages(){return '';}}});
  rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  try {
    const bot=rt.createBot({name:'ApprovalMember'}),peer=rt.createBot({name:'ApprovalPeer'}),principal=resolveBotPrincipal(rt.store),room=rt.rooms.create(principal,{title:'Actual approval',botIds:[bot.id,peer.id]});
    rt.rooms.send(principal,room.id,{text:'Run the approved action',mentions:[bot.id]});await rt.rooms.tick();
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
  rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  try {
    const bot=rt.createBot({name:'BusyMember'}),peer=rt.createBot({name:'BusyPeer'}),principal=resolveBotPrincipal(rt.store);
    rt.store.updateSession(bot.canonicalSessionId,{status:'running'});
    const room=rt.rooms.create(principal,{title:'Busy approval',botIds:[bot.id,peer.id],hostBotId:bot.id});
    rt.rooms.send(principal,room.id,{text:'Run the approved action',mentions:[bot.id]});
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

test('a mixed assistant message keeps the paired call and moves only the pending one [AC:bot-rooms#AC-8]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Mixed', botIds: [f.a.id, f.b.id] });
  f.host.runSession = async id => {
    const session = f.store.getSession(id);
    f.store.appendMessage(id, 'assistant', [
      { type: 'text', text: 'did the first step' },
      { type: 'tool_call', toolCallId: 'done-call', name: 'read_file', input: { path: 'notes.txt' } },
      { type: 'tool_call', toolCallId: 'pending-call', name: 'write_file', input: { path: 'secret.env', token: 'MOVED_SECRET_ARGS' } }
    ]);
    f.store.appendMessage(id, 'tool', [{ type: 'tool_result', toolCallId: 'done-call', name: 'read_file', content: 'PAIRED_READ_RESULT', ok: true }]);
    f.store.createApproval({ sessionId: id, toolName: 'write_file', reason: 'needs a person', args: { path: 'secret.env' } });
    f.store.updateSession(id, { status: 'waiting_approval', metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval', approvalIds: ['x'] }, outcome: { kind: 'waiting_approval' } } });
  };
  f.rooms.send(f.principal, room.id, { text: 'needs a person', mentions: [f.a.id] });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  const member = f.store.listSessions().find(session => session.metadata?.roomId === room.id);
  const memberMessages = f.store.listMessages(member.id);
  const assistant = memberMessages.find(message => message.role === 'assistant');
  assert.ok(assistant);
  assert.deepEqual(assistant.parts.map(part => part.toolCallId ?? part.type), ['text', 'done-call']);
  assert.equal(memberMessages.some(message => message.parts.some(part => part.type === 'tool_result' && part.toolCallId === 'done-call' && part.content === 'PAIRED_READ_RESULT')), true);
  assert.equal(JSON.stringify(memberMessages).includes('MOVED_SECRET_ARGS'), false);
  assert.equal(JSON.stringify(memberMessages).includes('pending-call'), false);
  const history = f.store.listHistory(member.id, { query: 'MOVED_SECRET_ARGS' });
  assert.equal(history.messages.length, 0);
  const privateCalls = f.store.listMessages(f.a.canonicalSessionId).flatMap(message => message.parts).filter(part => part.type === 'tool_call');
  assert.deepEqual(privateCalls.map(part => part.toolCallId), ['pending-call']);
  const approval = f.store.listApprovals({ status: 'pending' })[0];
  assert.equal(approval.sessionId, f.a.canonicalSessionId);
  assert.deepEqual(f.store.getSession(f.a.canonicalSessionId).metadata.interrupt.approvalIds, [approval.id]);
  f.host.runSession = async id => { f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'second room turn' }]); f.store.updateSession(id, { status: 'idle' }); };
  f.rooms.send(f.principal, room.id, { text: 'continue after the hand-off', mentions: [f.a.id] });
  await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal, room.id).at(-1).status, 'completed');
  assert.equal(f.rooms.messages(f.principal, room.id).messages.at(-1).text, 'second room turn');
});

test('a private chat that still owes its own approval defers the hand-off until that approval is resolved [AC:bot-rooms#AC-8]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Leftover', botIds: [f.a.id, f.b.id] });
  const leftover = f.store.createApproval({ sessionId: f.a.canonicalSessionId, toolName: 'bash', reason: 'older private step', args: {} });
  const privateMeta = f.store.getSession(f.a.canonicalSessionId).metadata;
  f.store.updateSession(f.a.canonicalSessionId, { status: 'idle', metadata: { ...privateMeta, interrupt: { kind: 'waiting_approval', approvalIds: [leftover.id] } } });
  f.host.runSession = async id => {
    const session = f.store.getSession(id);
    if (session.agentId !== f.a.id) { f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'beta continues' }]); f.store.updateSession(id, { status: 'idle' }); return; }
    f.store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'room-call', name: 'write_file', input: { path: 'out.txt' } }]);
    f.store.createApproval({ sessionId: id, toolName: 'write_file', reason: 'needs a person', args: { path: 'out.txt' } });
    f.store.updateSession(id, { status: 'waiting_approval', metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval' }, outcome: { kind: 'waiting_approval' } } });
  };
  f.rooms.send(f.principal, room.id, { text: 'needs a person', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  const waiting = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(waiting.handedOffBotIds, undefined);
  assert.equal(waiting.cursor, 0);
  const member = f.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === f.a.id);
  const roomApproval = f.store.listApprovals({ status: 'pending' }).find(approval => approval.id !== leftover.id);
  assert.equal(roomApproval.sessionId, member.id);
  assert.equal(f.store.getApproval(leftover.id).sessionId, f.a.canonicalSessionId);
  assert.deepEqual(f.store.getSession(f.a.canonicalSessionId).metadata.interrupt.approvalIds, [leftover.id]);
  assert.equal(JSON.stringify(f.store.listMessages(f.a.canonicalSessionId)).includes('Leftover'), false);
  assert.equal(JSON.stringify(f.store.listMessages(member.id)).includes('room-call'), true);
  await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'waiting_approval');
  f.store.updateApproval(leftover.id, 'approved');
  f.store.updateSession(f.a.canonicalSessionId, { status: 'idle', metadata: { ...f.store.getSession(f.a.canonicalSessionId).metadata, interrupt: undefined } });
  await f.rooms.tick();
  const handed = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(handed.status, 'completed');
  assert.notEqual(handed.status, 'unknown');
  assert.deepEqual(handed.handedOffBotIds, [f.a.id]);
  assert.equal(handed.currentSessionId, undefined);
  assert.match(f.rooms.messages(f.principal, room.id).messages.map(message => message.text).join('\n'), /beta continues/);
  const moved = f.store.listApprovals({ status: 'pending' }).find(approval => approval.id === roomApproval.id);
  assert.equal(moved.sessionId, f.a.canonicalSessionId);
  assert.deepEqual(f.store.getSession(f.a.canonicalSessionId).metadata.interrupt.approvalIds, [roomApproval.id]);
  assert.equal(f.store.getSession(member.id).status, 'idle');
});

test('a failed private chat takes the hand-off and the room continues [AC:bot-rooms#AC-8]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Failed chat', botIds: [f.a.id, f.b.id] });
  f.store.updateSession(f.a.canonicalSessionId, { status: 'failed' });
  f.host.runSession = async id => {
    const session = f.store.getSession(id);
    if (session.agentId !== f.a.id) { f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'beta continues' }]); f.store.updateSession(id, { status: 'idle' }); return; }
    f.store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'room-call', name: 'write_file', input: { path: 'secret.env', token: 'FAILED_CHAT_SECRET' } }]);
    f.store.createApproval({ sessionId: id, toolName: 'write_file', reason: 'needs a person', args: { path: 'secret.env', token: 'FAILED_CHAT_SECRET' } });
    f.store.updateSession(id, { status: 'waiting_approval', metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval' }, outcome: { kind: 'waiting_approval' } } });
  };
  f.rooms.send(f.principal, room.id, { text: 'needs a person', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.notEqual(turn.status, 'unknown');
  assert.notEqual(turn.status, 'waiting_approval');
  assert.deepEqual(turn.handedOffBotIds, [f.a.id]);
  const pending = f.store.listApprovals({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, f.a.canonicalSessionId);
  assert.equal(f.store.getSession(f.a.canonicalSessionId).status, 'waiting_approval');
  const roomText = f.rooms.messages(f.principal, room.id).messages.map(message => message.text).join('\n');
  assert.match(roomText, /私聊/);
  assert.match(roomText, /beta continues/);
  assert.equal(roomText.includes('FAILED_CHAT_SECRET'), false);
  const member = f.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === f.a.id);
  assert.equal(member.status, 'idle');
  assert.equal(JSON.stringify(f.store.listMessages(member.id)).includes('FAILED_CHAT_SECRET'), false);
});

test('a deferred hand-off resumes the room instead of leaving the turn unknown [AC:bot-rooms#AC-8]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Deferred', botIds: [f.a.id, f.b.id] });
  f.store.updateSession(f.a.canonicalSessionId, { status: 'running' });
  f.host.runSession = async id => {
    const session = f.store.getSession(id);
    if (session.agentId !== f.a.id) { f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'beta after hand-off' }]); f.store.updateSession(id, { status: 'idle' }); return; }
    f.store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'room-call', name: 'write_file', input: { path: 'out.txt' } }]);
    f.store.createApproval({ sessionId: id, toolName: 'write_file', reason: 'needs a person', args: { path: 'out.txt' } });
    f.store.updateSession(id, { status: 'waiting_approval', metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval' }, outcome: { kind: 'waiting_approval' } } });
  };
  f.rooms.send(f.principal, room.id, { text: 'needs a person', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'waiting_approval');
  f.store.updateSession(f.a.canonicalSessionId, { status: 'idle' });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.notEqual(turn.status, 'unknown');
  assert.equal(turn.currentSessionId, undefined);
  assert.deepEqual(turn.handedOffBotIds, [f.a.id]);
  assert.match(f.rooms.messages(f.principal, room.id).messages.map(message => message.text).join('\n'), /beta after hand-off/);
  const member = f.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === f.a.id);
  assert.equal(f.store.listApprovals({ status: 'pending' })[0].sessionId, f.a.canonicalSessionId);
  assert.equal(member.status, 'idle');
});

test('a failed hand-off commit leaves the in-memory turn recoverable on the next tick [AC:bot-rooms#AC-8]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Atomic', botIds: [f.a.id, f.b.id] });
  const db = f.store.db;
  const originalExec = db.exec.bind(db);
  let memberSessionId;
  let failCommit = false;
  db.exec = sql => { if (failCommit && sql === 'COMMIT') throw new Error('commit failed'); return originalExec(sql); };
  f.host.runSession = async id => {
    memberSessionId = id;
    const session = f.store.getSession(id);
    f.store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'kept', name: 'write_file', input: { path: 'secret.env' } }]);
    f.store.createApproval({ sessionId: id, toolName: 'write_file', reason: 'needs a person', args: { path: 'secret.env' } });
    f.store.updateSession(id, { status: 'waiting_approval', metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval', approvalIds: ['x'] }, outcome: { kind: 'waiting_approval' } } });
    failCommit = true;
  };
  f.rooms.send(f.principal, room.id, { text: 'needs a person', mentions: [f.a.id] });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'waiting_approval');
  assert.equal(turn.currentSessionId, memberSessionId);
  assert.equal(turn.cursor, 0);
  assert.equal(typeof turn.startSeq, 'number');
  assert.equal(turn.handedOffBotIds, undefined);
  const approval = f.store.listApprovals({ status: 'pending' })[0];
  const member = f.store.listSessions().find(session => session.metadata?.roomId === room.id);
  assert.equal(approval.sessionId, member.id);
  assert.equal(member.status, 'waiting_approval');
  assert.equal(JSON.stringify(f.store.listMessages(member.id)).includes('kept'), true);
  assert.equal(JSON.stringify(f.store.listMessages(f.a.canonicalSessionId)).includes('Atomic'), false);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.some(message => message.sender.type === 'bot'), false);
  failCommit = false;
  f.host.runSession = async () => {};
  await f.rooms.tick();
  const retried = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(retried.status, 'completed');
  assert.deepEqual(retried.handedOffBotIds, [f.a.id]);
  assert.equal(retried.currentSessionId, undefined);
  assert.equal(f.store.listApprovals({ status: 'pending' })[0].sessionId, f.a.canonicalSessionId);
  assert.equal(f.store.getSession(member.id).status, 'idle');
});

test('room hand-off to private chat still advances the member read position like a silent turn [AC:bot-rooms#AC-8]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Read position', botIds: [f.a.id, f.b.id] });
  const prompts = [];
  f.host.runSession = async id => {
    prompts.push(promptTexts(f.store, id).at(-1));
    const session = f.store.getSession(id);
    f.store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'needs-person', name: 'write_file', input: { path: 'out.txt' } }]);
    f.store.createApproval({ sessionId: id, toolName: 'write_file', reason: 'needs a person', args: { path: 'out.txt' } });
    f.store.updateSession(id, { status: 'waiting_approval', metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval' }, outcome: { kind: 'waiting_approval' } } });
  };
  f.rooms.send(f.principal, room.id, { text: 'SEEN_BEFORE_HANDOFF', mentions: [f.a.id] });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.deepEqual(turn.handedOffBotIds, [f.a.id]);
  const earlier = f.store.listApprovals({ status: 'pending' }).find(approval => approval.sessionId === f.a.canonicalSessionId);
  const seen = f.rooms.messages(f.principal, room.id).messages.filter(message => message.text === 'SEEN_BEFORE_HANDOFF');
  assert.equal(seen.length, 1);
  const member = f.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === f.a.id);
  assert.ok(member.metadata.roomDelivery.throughSeq >= seen[0].seq, 'the hand-off keeps the read position executeMember already advanced');
  assert.ok(historyOf(prompts[0]).some(message => message.text === 'SEEN_BEFORE_HANDOFF'));

  const db = f.store.db;
  const originalExec = db.exec.bind(db);
  let failCommit = false;
  db.exec = sql => { if (failCommit && sql === 'COMMIT') throw new Error('commit failed'); return originalExec(sql); };
  f.host.runSession = async id => {
    prompts.push(promptTexts(f.store, id).at(-1));
    const session = f.store.getSession(id);
    assert.ok(session.metadata.roomDelivery.throughSeq >= seen[0].seq);
    f.store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'needs-person-again', name: 'write_file', input: { path: 'again.txt' } }]);
    f.store.createApproval({ sessionId: id, toolName: 'write_file', reason: 'needs a person', args: { path: 'again.txt' } });
    f.store.updateSession(id, { status: 'waiting_approval', metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval' }, outcome: { kind: 'waiting_approval' } } });
    failCommit = true;
  };
  f.rooms.send(f.principal, room.id, { text: 'SEEN_THEN_ROLLED_BACK', mentions: [f.a.id] });
  await f.rooms.tick();
  const waiting = f.rooms.turns(f.principal, room.id).at(-1);
  assert.equal(waiting.status, 'waiting_approval');
  const afterRollback = f.store.getSession(member.id).metadata.roomDelivery;
  const rolled = f.rooms.messages(f.principal, room.id).messages.find(message => message.text === 'SEEN_THEN_ROLLED_BACK');
  assert.ok(afterRollback.throughSeq >= rolled.seq, 'a rolled-back hand-off does not undo the read position');
  assert.ok(historyOf(prompts[1]).some(message => message.text === 'SEEN_BEFORE_HANDOFF'), 'the recent window still shows the earlier room line');
  assert.ok(historyOf(prompts[1]).some(message => message.text === 'SEEN_THEN_ROLLED_BACK'));
  failCommit = false;
  // A failed COMMIT can leave the private chat mid-write. The retry waits until it is idle, then only moves the step; it does not run the member again.
  // The earlier hand-off still owes its own decision. Resolve that one so this retry is about the rolled-back step, not a chat that already has a pending approval.
  f.store.updateApproval(earlier.id, 'approved');
  const parked = f.store.getSession(f.a.canonicalSessionId);
  const parkedMeta = { ...parked.metadata };
  delete parkedMeta.interrupt;
  delete parkedMeta.outcome;
  f.store.updateSession(f.a.canonicalSessionId, { status: 'idle', metadata: parkedMeta });
  f.host.runSession = async () => { throw new Error('the retry must not run the member again'); };
  await f.rooms.tick();
  const retried = f.rooms.turns(f.principal, room.id).at(-1);
  assert.equal(retried.status, 'completed');
  assert.deepEqual(retried.handedOffBotIds, [f.a.id]);
  assert.equal(f.store.getSession(member.id).metadata.roomDelivery.throughSeq, afterRollback.throughSeq, 'retrying the hand-off does not move or undo the read position');

  f.host.runSession = async id => {
    prompts.push(promptTexts(f.store, id).at(-1));
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'now I speak' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'AFTER_HANDOFF', mentions: [f.a.id] });
  await f.rooms.tick();
  const next = historyOf(prompts.at(-1));
  assert.ok(next.some(message => message.text === 'SEEN_BEFORE_HANDOFF'));
  assert.ok(next.some(message => message.text === 'SEEN_THEN_ROLLED_BACK'));
  assert.ok(next.some(message => message.text === 'AFTER_HANDOFF' && message.sender.type === 'user'), 'the new user line is in the recent window');
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

test('a group turn says the reply is posted as that bot [AC:bot-room-speaker-identity#AC-1] [AC:bot-room-speaker-identity#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Team', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async (id) => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'plan from me' }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  f.rooms.send(f.principal, room.id, { text: 'say the plan', mentions: [f.a.id] });
  await f.rooms.tick();
  const member = f.store.listSessions().find((session) => session.metadata?.roomId === room.id && session.metadata?.botId === f.a.id);
  const prompts = userPrompts(f.store, member.id);
  assert.ok(prompts.some((text) => text.includes('posted in this Room under your own name')));
  assert.ok(prompts.some((text) => text.includes('You do not choose a sender')));
  const posted = f.rooms.messages(f.principal, room.id).messages.filter((message) => message.sender.type === 'bot');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].sender.id, f.a.id);
  assert.equal(posted[0].sender.name, f.a.name);
  assert.equal(posted[0].text, 'plan from me');
});

test('a member replying [SILENT] posts nothing and the next member still speaks [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Silence', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async id => {
    const agentId = f.store.getSession(id).agentId;
    const text = agentId === f.a.id ? '[SILENT]' : `reply:${agentId}`;
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  });
  f.rooms.send(f.principal, room.id, { text: 'anyone?', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.equal(turn.botTurns, 1);
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
  f.rooms.send(f.principal, room.id, { text: 'hello', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.notEqual(turn.terminationReason, 'member_returned_no_result');
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.deepEqual(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').map(message => message.sender.id), [f.b.id]);
});

test('scheduled members are not told this round is a wrap-up', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Wrap', botIds: [f.a.id, f.b.id] });
  f.rooms.send(f.principal, room.id, { text: 'round', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
  for (const id of f.runs) {
    const prompt = userPrompts(f.store, id).at(-1);
    assert.ok(!prompt.includes('本轮收尾'));
    assert.ok(!prompt.includes('wrap-up'));
  }
});

test('maxBotTurns of 1 runs only the first named member', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Budget wrap', botIds: [f.a.id, f.b.id], maxBotTurns: 1 });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  const first = userPrompts(f.store, f.runs[0]).at(-1);
  assert.ok(!first.includes('本轮收尾'));
  assert.ok(!first.includes('wrap-up'));
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.a.id);
});

test('a removed later member is not scheduled [AC:bot-rooms#AC-4]', async () => {
  const f = fixture();
  const c = createBot(f.facade, { name: 'GammaLeave' });
  f.store.updateSession(c.canonicalSessionId, { metadata: { ...f.store.getSession(c.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Leave wrap', botIds: [f.a.id, f.b.id, c.id] });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  f.rooms.removeMember(f.principal, room.id, f.b.id);
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.a.id);
  const first = userPrompts(f.store, f.runs[0]).at(-1);
  assert.ok(!first.includes('wrap-up'));
});

test('a silent member does not spend the speaking budget [AC:bot-rooms#AC-2] [AC:bot-room-sparse-routing#AC-6]', async () => {
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
  assert.equal(f.runs.length, 2);
  assert.equal(f.store.getSession(f.runs[1]).agentId, f.b.id);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');
  assert.equal(turn.botTurns, 1);
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.deepEqual(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').map(message => message.sender.id), [f.b.id]);
});

test('named members are not given a wrap-up silence hint', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Budget covers all', botIds: [f.a.id, f.b.id], maxBotTurns: 2 });
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
  for (const id of f.runs) {
    const prompt = userPrompts(f.store, id).at(-1);
    assert.ok(!prompt.includes('本轮收尾'));
    assert.ok(!prompt.includes('wrap-up'));
  }
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
  assert.equal(turn.botTurns, 0);
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.equal(botQueueUsage(f.store, f.principal).total, 2);
  assert.deepEqual(botQueueUsage(f.store, f.principal).byBot, { [f.b.id]: 1, [c.id]: 1 });
});

test('a failed or aborted member still fails the round [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Still fails', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'partial' }]);
    f.store.updateSession(id, { status: 'idle', metadata: { ...f.store.getSession(id).metadata, outcome: { kind: 'aborted', reason: 'user_abort' } } });
  });
  f.rooms.send(f.principal, room.id, { text: 'go', mentions: [f.a.id] });
  await f.rooms.tick();
  const aborted = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(aborted.status, 'cancelled');
  assert.equal(aborted.terminationReason, 'user_abort');
  assert.equal(f.runs.length, 1);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').length, 0);

  recordingRun(f, async id => { f.store.updateSession(id, { status: 'failed' }); });
  f.rooms.send(f.principal, room.id, { text: 'again', mentions: [f.a.id] });
  await f.rooms.tick();
  const failed = f.rooms.turns(f.principal, room.id).at(-1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.terminationReason, 'member_execution_failed');
  assert.equal(f.runs.length, 2);
});

test('a failed room turn allows the next message to complete [AC:bot-chat-image-compatibility#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Retry', botIds: [f.a.id, f.b.id] });
  recordingRun(f, async id => { f.store.updateSession(id, { status: 'failed', metadata: { ...f.store.getSession(id).metadata, outcome: { kind: 'failed', reason: 'model_error' } } }); });
  f.rooms.send(f.principal, room.id, { text: 'first', mentions: [f.a.id] });
  await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal, room.id).at(-1).status, 'failed');
  recordingRun(f, async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'Recovered' }]);
    f.store.updateSession(id, { status: 'idle', metadata: { ...f.store.getSession(id).metadata, outcome: { kind: 'idle', reason: 'end' } } });
  });
  f.rooms.send(f.principal, room.id, { text: 'try again', mentions: [f.a.id] });
  await f.rooms.tick();
  assert.equal(f.rooms.turns(f.principal, room.id).at(-1).status, 'completed');
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(m => m.sender.type === 'bot').length, 1);
  assert.match(f.rooms.messages(f.principal, room.id).messages.map(m => m.text).join('\n'), /Recovered/);
});

test('a large room where nobody matches posts nothing [AC:bot-room-sparse-routing#AC-4] [AC:bot-room-speaker-pick#AC-5]', async () => {
  const f = fixture();
  const c = createBot(f.facade, { name: 'QuietGamma' });
  const d = createBot(f.facade, { name: 'QuietDelta' });
  for (const bot of [c, d]) f.store.updateSession(bot.canonicalSessionId, { metadata: { ...f.store.getSession(bot.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'All quiet', botIds: [f.a.id, f.b.id, c.id, d.id], hostBotId: f.a.id });
  f.rooms.send(f.principal, room.id, { text: 'anyone?' });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');
  assert.equal(turn.botTurns, 0);
  assert.equal(turn.silentBotIds, undefined);
  assert.equal(f.runs.length, 0);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').length, 0);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.some(message => message.text.includes('我先接住')), false);
});

test('Hello @Beta schedules only Beta [AC:bot-rooms#AC-2] [AC:bot-room-sparse-routing#AC-2]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Order', botIds: [f.a.id, f.b.id] });
  const sent = f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name}` });
  assert.deepEqual(sent.turn.botIds, [f.b.id]);
  assert.deepEqual(sent.turn.mentionedBotIds, [f.b.id]);
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  assert.equal(f.store.getSession(f.runs[0]).agentId, f.b.id);
  assert.ok(!userPrompts(f.store, f.runs[0]).at(-1).includes('not @-mentioned'));
});

test('an unmentioned member is not run [AC:bot-rooms#AC-2]', async () => {
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
  assert.equal(turn.silentBotIds, undefined);
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.deepEqual(posted.map(message => message.sender.id), [f.b.id]);
  assert.ok(!f.runs.some(id => f.store.getSession(id).agentId === f.a.id));
});

test('a message without @ that matches nobody schedules nobody [AC:bot-rooms#AC-2] [AC:bot-room-sparse-routing#AC-4]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Open floor', botIds: [f.a.id, f.b.id], hostBotId: f.a.id });
  const sent = f.rooms.send(f.principal, room.id, { text: 'ordinary question' });
  assert.deepEqual(sent.turn.botIds, []);
  assert.equal(sent.turn.mentionedBotIds, undefined);
  await f.rooms.tick();
  assert.equal(f.runs.length, 0);
});

test('an @ that matches nobody posts a notice and runs nobody [AC:bot-rooms#AC-2] [AC:bot-room-sparse-routing#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Unknown name', botIds: [f.a.id, f.b.id], hostBotId: f.a.id });
  const sent = f.rooms.send(f.principal, room.id, { text: '@NoSuchMember do work' });
  assert.deepEqual(sent.turn.botIds, []);
  assert.deepEqual(sent.turn.mentionedBotIds, []);
  await f.rooms.tick();
  assert.equal(f.runs.length, 0);
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /没有找到/);
  const none = f.rooms.send(f.principal, room.id, { text: 'explicit empty', mentions: [] });
  assert.deepEqual(none.turn.botIds, []);
  assert.deepEqual(none.turn.mentionedBotIds, []);
});

test('retrying the same explicit mentions returns the same receipt [AC:bot-rooms#AC-2]', () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Retry', botIds: [f.a.id, f.b.id] });
  const first = f.rooms.send(f.principal, room.id, { text: 'hello', mentions: [f.b.id], idempotencyKey: 'same' });
  assert.deepEqual(first.turn.botIds, [f.b.id]);
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
  assert.equal(turn.terminationReason, 'members_completed');
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
  assert.equal(turn.terminationReason, 'members_completed');
  assert.equal(turn.botTurns, 0);
  assert.deepEqual(turn.silentBotIds, [f.b.id]);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').length, 0);
});

test('when maxBotTurns equals the mentioned count unmentioned members never run [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const c = createBot(f.facade, { name: 'Gamma' });
  f.store.updateSession(c.canonicalSessionId, { metadata: { ...f.store.getSession(c.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Mentioned fill the budget', botIds: [f.a.id, f.b.id, c.id], maxBotTurns: 2 });
  const sent = f.rooms.send(f.principal, room.id, { text: `Hello @${f.b.name} @${f.a.name}` });
  assert.deepEqual(sent.turn.botIds, [f.b.id, f.a.id]);
  assert.deepEqual(sent.turn.mentionedBotIds, [f.b.id, f.a.id]);
  assert.deepEqual(botQueueUsage(f.store, f.principal).byBot, { [f.b.id]: 1, [f.a.id]: 1 });
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
  assert.deepEqual(f.runs.map(id => f.store.getSession(id).agentId), [f.b.id, f.a.id]);
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');
  assert.equal(turn.botTurns, 2);
  assert.ok(!f.runs.some(id => f.store.getSession(id).agentId === c.id));
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.deepEqual(posted.map(message => message.sender.id), [f.b.id, f.a.id]);
});

test('deleted approval context becomes unknown without blocking or replaying later queued work [AC:bot-rooms#AC-5]',async()=>{
  const f=fixture(),room=f.rooms.create(f.principal,{title:'Missing context',botIds:[f.a.id,f.b.id]});let calls=0;
  let release;
  f.host.runSession=id=>new Promise(resolve=>{calls++;release=()=>{f.store.appendMessage(id,'assistant',[{type:'text',text:'late'}]);f.store.updateSession(id,{status:'idle'});resolve();};});
  f.rooms.send(f.principal,room.id,{text:'UNCONFIRMED_OLD_WORK',mentions:[f.a.id]});
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
  restarted.send(f.principal,room.id,{text:'NEW_SEPARATE_WORK',mentions:[f.a.id]});await restarted.tick();
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
    const room = rt.rooms.create(principal, { title: 'Hop room', botIds: [bots[0].id, bots[1].id], hostBotId: bots[0].id });
    rt.rooms.send(principal, room.id, { text: 'start a chain', mentions: [bots[0].id] });
    await rt.rooms.tick();
    await waitFor(async () => {
      const row = rt.store.db.prepare("SELECT hop, status FROM bot_work_messages WHERE target_bot=? ORDER BY seq DESC LIMIT 1").get(bots[3].id);
      return row && !['pending', 'processing'].includes(row.status) ? row : null;
    });
    const delivered = rt.store.db.prepare('SELECT sender_bot, target_bot, hop, source_room FROM bot_work_messages ORDER BY seq').all();
    for (const row of delivered) hops.push(row.hop);
    assert.deepEqual(hops, [1, 2, 3]);
    assert.equal(delivered[0].source_room, room.id);
    assert.equal(delivered[1].source_room, null);
    const epsilon = rt.store.db.prepare('SELECT id FROM bot_work_messages WHERE target_bot=?').get(bots[4].id);
    assert.equal(epsilon, undefined);
    const blocked = bots.flatMap(bot => rt.store.listMessages(bot.canonicalSessionId)).flatMap(message => message.parts).find(part => part.type === 'tool_result' && String(part.content).includes('HOP_LIMIT'));
    assert.ok(blocked, 'the completed third hop must persist its refusal before assertions');
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
    const room = rt.rooms.create(principal, { title: 'Tight budget', botIds: [alpha.id, beta.id], hostBotId: alpha.id, maxToolCalls: 1 });
    rt.rooms.send(principal, room.id, { text: 'one tool only', mentions: [alpha.id] });
    await rt.rooms.tick();
    assert.equal(rt.rooms.turns(principal, room.id)[0].terminationReason, 'tool_budget');
    const bodies = rt.store.db.prepare('SELECT body FROM bot_work_messages').all().map(row => row.body);
    assert.deepEqual(bodies, []);
    assert.equal(rt.rooms.messages(principal, room.id).messages.some(message => String(message.text).includes('over budget')), false);
  } finally { rt.destroy(); }
});

test('a member that only sends a 1:1 and then answers [SILENT] posts nothing and does not put the private note in the read window [AC:bot-rooms#AC-2] [AC:bot-rooms#AC-7]', async () => {
  const secret = 'PRIVATE_NOTE_NOT_IN_ROOM';
  const adapter = { name: 'room-silent-dm', async summarizeMessages() { return ''; } };
  const rt = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'room-silent-dm-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'room-silent-dm-state-')),
    modelAdapter: adapter
  });
  try {
    const alpha = rt.createBot({ name: 'Alpha' });
    const beta = rt.createBot({ name: 'Beta' });
    const principal = resolveBotPrincipal(rt.store);
    const room = rt.rooms.create(principal, { title: 'Silent side channel', botIds: [alpha.id, beta.id] });
    adapter.runTurn = async input => {
      const session = rt.store.getSession(input.sessionId);
      const done = input.messages.some(message => message.parts.some(part => part.type === 'tool_result'));
      if (session?.metadata?.roomId !== room.id) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'beta private reply' }] };
      if (session.metadata.botId !== alpha.id) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'beta room reply' }] };
      if (done) return { stopReason: 'end', assistantParts: [{ type: 'text', text: '[SILENT]' }] };
      return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'dm', name: 'message_agent', input: { target: 'Beta', message: secret, wake: false } }] };
    };
    rt.rooms.send(principal, room.id, { text: 'tell beta quietly', mentions: [alpha.id] });
    await rt.rooms.tick();
    const turn = rt.rooms.turns(principal, room.id)[0];
    assert.equal(turn.status, 'completed');
    assert.deepEqual(turn.silentBotIds, [alpha.id]);
    assert.equal(turn.terminationReason, 'members_completed');
    const roomMessages = rt.rooms.messages(principal, room.id).messages;
    // Alpha was mentioned and stayed silent. Beta was not mentioned, so it still gets a restrained turn and may post.
    assert.equal(roomMessages.some(message => message.sender.id === alpha.id), false);
    assert.equal(JSON.stringify(roomMessages).includes(secret), false);
    const stored = rt.store.db.prepare('SELECT body, source_room, wake FROM bot_work_messages').all();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].body, secret);
    assert.equal(stored[0].source_room, room.id);
    assert.equal(stored[0].wake, 0);
    const member = rt.store.listSessions().find(session => session.metadata?.roomId === room.id && session.metadata?.botId === alpha.id);
    const prompts = promptTexts(rt.store, member.id);
    assert.equal(prompts.some(text => text.includes(secret)), false);
    const delivery = member.metadata.roomDelivery;
    const kept = historyOf(prompts.at(-1));
    assert.equal(kept.some(message => String(message.text).includes(secret)), false);
    const visibleToAlpha = roomMessages.filter(message => message.seq <= delivery.throughSeq);
    assert.ok(visibleToAlpha.some(message => message.sender.type === 'user'));
    assert.equal(visibleToAlpha.some(message => message.sender.id === alpha.id), false);
    assert.equal((delivery.extraSeqs ?? []).length, 0);
  } finally { rt.destroy(); }
});

function promptTexts(store, sessionId) {
  return store.listMessages(sessionId).filter(message => message.role === 'user').flatMap(message => message.parts).map(part => part.text ?? '').filter(Boolean);
}
function historyOf(text) {
  const marker = '[Recent Room Messages]\n';
  const start = text.indexOf(marker);
  assert.ok(start >= 0, 'prompt carries recent room messages');
  const body = text.slice(start + marker.length);
  const end = body.indexOf('\n\n[Omitted History Retrieval Hint]');
  const block = (end < 0 ? body : body.slice(0, end)).trim();
  if (!block || block === '(no recent messages)') return [];
  return block.split('\n').map(line => {
    const match = /^\[#(\d+) ([^\]]+)\]: (.*)$/.exec(line);
    assert.ok(match, `recent line: ${line}`);
    const name = match[2];
    return {
      seq: Number(match[1]),
      text: match[3],
      sender: { name, id: name, type: name === 'owner' ? 'user' : 'bot' }
    };
  });
}
function triggerText(prompt) {
  const marker = '\nTrigger: ';
  const start = prompt.indexOf(marker);
  assert.ok(start >= 0, 'prompt names its trigger');
  const json = prompt.slice(start + marker.length);
  const end = json.indexOf('\n');
  return JSON.parse(end < 0 ? json : json.slice(0, end)).text;
}

/** History only: a user line with no turn, so gap4 does not schedule restrained speakers for flood text. */
function insertUserLine(f, room, text) {
  const seq = f.store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM bot_room_messages WHERE room_id=?').get(room.id).seq;
  const message = { id: `room_msg_line_${seq}`, roomId: room.id, seq, sender: { type: 'user', id: f.principal.userId, name: f.principal.userId }, text, attachmentIds: [], createdAt: new Date().toISOString() };
  f.store.db.prepare('INSERT INTO bot_room_messages(id,room_id,seq,idem_key,data) VALUES(?,?,?,?,?)').run(message.id, room.id, seq, `line-${room.id}-${seq}`, JSON.stringify(message));
  return message;
}

test('a [SILENT] reply posts nothing, does not use a speaking slot, and the recent window keeps the triggering line', async () => {
  const f = fixture();
  const c = createBot(f.facade, { name: 'CursorGamma' });
  const d = createBot(f.facade, { name: 'CursorDelta' });
  for (const bot of [c, d]) f.store.updateSession(bot.canonicalSessionId, { metadata: { ...f.store.getSession(bot.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Silent cursor', botIds: [f.a.id, f.b.id, c.id, d.id], hostBotId: f.a.id });
  const prompts = [];
  f.host.runSession = async id => {
    prompts.push(promptTexts(f.store, id).at(-1));
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: '[SILENT]' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'SEEN_WHILE_SILENT', mentions: [f.a.id] });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');
  assert.equal(turn.botTurns, 0);
  assert.deepEqual(turn.silentBotIds, [f.a.id]);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').length, 0);
  assert.ok(!f.rooms.messages(f.principal, room.id).messages.some(message => message.text.includes('[SILENT]')));
  assert.ok(historyOf(prompts[0]).some(message => message.text === 'SEEN_WHILE_SILENT'));

  f.host.runSession = async id => {
    prompts.push(promptTexts(f.store, id).at(-1));
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'now I speak' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'AFTER_SILENCE', mentions: [f.a.id] });
  await f.rooms.tick();
  const next = historyOf(prompts[1]);
  assert.ok(next.some(message => message.text === 'SEEN_WHILE_SILENT'), 'the silent turn stays in the recent window');
  assert.ok(next.some(message => message.text === 'AFTER_SILENCE' && message.sender.type === 'user'), 'messages after the silent turn are in the recent window');
  assert.deepEqual(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').map(message => message.text), ['now I speak']);
});

test('a later turn of the same bot still sees the recent room window [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Incremental', botIds: [f.a.id, f.b.id] });
  const prompts = [];
  f.host.runSession = async id => {
    prompts.push(promptTexts(f.store, id).at(-1));
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `reply:${prompts.length}` }]);
  };
  f.rooms.send(f.principal, room.id, { text: 'OLD_TOPIC', mentions: [f.a.id] });
  await f.rooms.tick();
  f.rooms.send(f.principal, room.id, { text: 'NEW_TOPIC', mentions: [f.a.id] });
  await f.rooms.tick();
  const first = historyOf(prompts[0]);
  const second = historyOf(prompts[1]);
  assert.ok(first.some(message => message.text === 'OLD_TOPIC' && message.sender.name === f.principal.userId));
  assert.ok(second.some(message => message.text === 'OLD_TOPIC'), 'the recent window still shows the earlier room line');
  assert.ok(second.some(message => message.text === 'reply:1'), 'the published room reply stays visible in the recent window');
  assert.ok(second.some(message => message.text === 'NEW_TOPIC' && message.sender.name === f.principal.userId && message.sender.type === 'user' && Number.isInteger(message.seq)));
  assert.match(prompts[1], /New messages since your last turn in this Room\. Earlier Room messages were either shown to you earlier in this conversation or explicitly reported as omitted\./);
  assert.match(prompts[0], /Recent Room history \(first turn in this Room context\)/);
});

test('a later turn sees the other member reply and does not receive its own reply again [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Same turn', botIds: [f.a.id, f.b.id] });
  const byBot = {};
  f.host.runSession = async id => {
    const session = f.store.getSession(id);
    const text = promptTexts(f.store, id).at(-1);
    const key = byBot[session.agentId] ? `${session.agentId}:next` : session.agentId;
    byBot[key] = text;
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `said:${session.agentId}` }]);
  };
  f.rooms.send(f.principal, room.id, { text: 'discuss', mentions: [f.a.id, f.b.id] });
  await f.rooms.tick();
  const beta = historyOf(byBot[f.b.id]);
  const alpha = historyOf(byBot[f.a.id]);
  assert.ok(beta.some(message => message.text === 'discuss' && message.sender.type === 'user'));
  assert.ok(alpha.some(message => message.text === 'discuss' && message.sender.type === 'user'));
  assert.ok(!beta.some(message => message.text === `said:${f.a.id}`), 'a parallel prompt is built before the other member posts');
  f.rooms.send(f.principal, room.id, { text: 'again', mentions: [f.b.id] });
  await f.rooms.tick();
  const again = historyOf(byBot[`${f.b.id}:next`]);
  assert.ok(again.some(message => message.text === `said:${f.b.id}` && message.sender.name === 'Beta'), 'the recent window includes this bot\'s earlier room post');
  assert.ok(again.some(message => message.text === 'again'));
  assert.ok(again.some(message => message.text === `said:${f.a.id}` && message.sender.name === 'Alpha'));
});

test('a user message queued after the prompts are built is delivered on its own turn [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Queued later', botIds: [f.a.id, f.b.id] });
  const prompts = [];
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  f.host.runSession = id => {
    const agentId = f.store.getSession(id).agentId;
    prompts.push({ id, text: promptTexts(f.store, id).at(-1) });
    return gate.then(() => {
      f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `turn-reply:${agentId}` }]);
    });
  };
  f.rooms.send(f.principal, room.id, { text: 'MESSAGE_A', mentions: [f.a.id, f.b.id] });
  const running = f.rooms.tick();
  assert.ok(await waitFor(() => prompts.length >= 2));
  f.rooms.send(f.principal, room.id, { text: 'MESSAGE_B', mentions: [f.b.id] });
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(entry => !historyOf(entry.text).some(message => message.text === 'MESSAGE_B')), 'a message that arrives after the prompt is built is not in that prompt');
  assert.ok(prompts.every(entry => historyOf(entry.text).some(message => message.text === 'MESSAGE_A')));
  open();
  await running;
  await f.rooms.tick();
  const follow = prompts.find(entry => f.store.getSession(entry.id).agentId === f.b.id && triggerText(entry.text) === 'MESSAGE_B');
  assert.ok(follow);
  const delivered = historyOf(follow.text);
  assert.ok(delivered.some(message => message.text === 'MESSAGE_B' && message.sender.name === f.principal.userId && message.sender.type === 'user'));
  assert.ok(delivered.some(message => message.text === 'MESSAGE_A'), 'MESSAGE_A stays in the recent window');
  assert.ok(delivered.some(message => message.text === `turn-reply:${f.a.id}` && message.sender.name === 'Alpha'));
});

test('a user message already seen still schedules its own turn and gets a reply [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Seen but still answered', botIds: [f.a.id, f.b.id] });
  const prompts = [];
  f.host.runSession = async id => {
    prompts.push({ sessionId: id, text: promptTexts(f.store, id).at(-1) });
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `said:${f.store.getSession(id).agentId}` }]);
  };
  f.rooms.send(f.principal, room.id, { text: 'MESSAGE_A', mentions: [f.a.id, f.b.id] });
  f.rooms.send(f.principal, room.id, { text: 'MESSAGE_B', mentions: [f.a.id] });
  await f.rooms.tick();
  assert.equal(prompts.length, 2);
  assert.ok(historyOf(prompts[0].text).some(message => message.text === 'MESSAGE_B' && message.sender.type === 'user'), 'Alpha sees MESSAGE_B while answering MESSAGE_A');
  const alphaFollowUp = f.rooms.turns(f.principal, room.id).find(turn => turn.messageId !== f.rooms.turns(f.principal, room.id)[0].messageId && turn.botIds.includes(f.a.id));
  assert.equal(alphaFollowUp.status, 'queued', 'MESSAGE_B still gives Alpha its own turn');
  await f.rooms.tick();
  const followUp = prompts.find(entry => f.store.getSession(entry.sessionId).agentId === f.a.id && triggerText(entry.text) === 'MESSAGE_B').text;
  assert.match(followUp, /Trigger:/);
  assert.ok(followUp.includes('MESSAGE_B'), 'the follow-up trigger is MESSAGE_B');
  assert.ok(historyOf(followUp).some(message => message.text === 'MESSAGE_B' && message.sender.type === 'user'), 'MESSAGE_B stays in the recent window');
  assert.ok(historyOf(followUp).some(message => message.sender.name === 'Alpha'), 'Alpha\'s earlier room post stays in the recent window');
  assert.ok(historyOf(followUp).some(message => message.sender.name === 'Beta'), 'the other member reply stays in the recent window');
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.id === f.a.id).at(-1).text, `said:${f.a.id}`, 'Alpha still publishes a reply to MESSAGE_B');
  assert.equal(f.rooms.turns(f.principal, room.id).every(turn => turn.status === 'completed'), true);
});

test('a fresh, new-member, or replaced context session gets the recent window again [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Fresh window', botIds: [f.a.id, f.b.id] });
  const seen = [];
  f.host.runSession = async id => { seen.push({ sessionId: id, text: promptTexts(f.store, id).at(-1) }); f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'kept' }]); };
  f.rooms.send(f.principal, room.id, { text: 'FIRST_WINDOW', mentions: [f.a.id] });
  await f.rooms.tick();
  const contextId = f.store.db.prepare('SELECT session_id FROM bot_room_contexts WHERE room_id=? AND bot_id=?').get(room.id, f.a.id).session_id;
  f.store.updateSession(contextId, { status: 'unknown' });
  f.rooms.send(f.principal, room.id, { text: 'AFTER_REPLACE', mentions: [f.a.id] });
  await f.rooms.tick();
  const replaced = seen.at(-1).text;
  assert.match(replaced, /Recent Room history \(first turn in this Room context\)/);
  assert.ok(historyOf(replaced).some(message => message.text === 'FIRST_WINDOW'));
  assert.ok(historyOf(replaced).some(message => message.text === 'kept' && message.sender.name === 'Alpha'));
  const c = createBot(f.facade, { name: 'Gamma' });
  f.store.updateSession(c.canonicalSessionId, { metadata: { ...f.store.getSession(c.canonicalSessionId).metadata, ...f.principal } });
  f.rooms.addMember(f.principal, room.id, c.id);
  f.rooms.send(f.principal, room.id, { text: 'WELCOME', mentions: [c.id] });
  await f.rooms.tick();
  const joined = seen.find(entry => f.store.getSession(entry.sessionId).agentId === c.id).text;
  assert.match(joined, /first turn in this Room context/);
  assert.ok(historyOf(joined).some(message => message.text === 'FIRST_WINDOW'));
  assert.ok(historyOf(joined).some(message => message.text === 'WELCOME' && message.sender.type === 'user'));
});

test('an oversized delta keeps the newest messages and reports how many were omitted [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Capped', botIds: [f.a.id, f.b.id] });
  let prompt = '';
  f.host.runSession = async id => { prompt = promptTexts(f.store, id).at(-1); f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ack' }]); };
  for (let i = 0; i < 205; i++) insertUserLine(f, room, `BULK_${String(i).padStart(3, '0')}_${'x'.repeat(800)}`);
  f.rooms.send(f.principal, room.id, { text: 'READ_NOW', mentions: [f.a.id] });
  await f.rooms.tick();
  const history = historyOf(prompt);
  assert.equal(history.length, 30);
  assert.match(prompt, /older unseen Room messages were omitted and are NOT in this conversation/);
  assert.match(prompt, /Earlier messages \(#/);
  assert.equal(history.at(-1).text, 'READ_NOW');
  assert.ok(!history.some(message => message.text.startsWith('BULK_000')));
  assert.ok(history.some(message => message.sender.name === f.principal.userId));
});

test('more than 200 unseen messages between two turns report the overflow outside the window [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Busy catch-up', botIds: [f.a.id, f.b.id] });
  const prompts = [];
  f.host.runSession = async id => { prompts.push(promptTexts(f.store, id).at(-1)); f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `ack:${prompts.length}` }]); };
  f.rooms.send(f.principal, room.id, { text: 'SEEN_ONCE', mentions: [f.a.id] });
  await f.rooms.tick();
  const flood = 230;
  for (let i = 0; i < flood; i++) insertUserLine(f, room, `FLOOD_${String(i).padStart(3, '0')}`);
  f.rooms.send(f.principal, room.id, { text: 'CATCH_UP', mentions: [f.a.id] });
  await f.rooms.tick();
  const second = prompts.at(-1);
  const history = historyOf(second);
  assert.equal(history.length, 30);
  assert.match(second, /older unseen Room messages were omitted and are NOT in this conversation/);
  assert.match(second, /New messages since your last turn in this Room\. Earlier Room messages were either shown to you earlier in this conversation or explicitly reported as omitted\./);
  assert.match(second, /Earlier messages \(#/);
  assert.equal(history.at(-1).text, 'CATCH_UP');
  assert.ok(!history.some(message => message.text === 'SEEN_ONCE' || message.text === 'ack:1' || message.text === 'FLOOD_000'));
  const sessionId = f.store.db.prepare('SELECT session_id FROM bot_room_contexts WHERE room_id=? AND bot_id=?').get(room.id, f.a.id).session_id;
  const atPrompt = f.store.db.prepare('SELECT seq FROM bot_room_messages WHERE room_id=? AND json_extract(data,\'$.text\')=?').get(room.id, 'CATCH_UP').seq;
  assert.equal(f.store.getSession(sessionId).metadata.roomDelivery.throughSeq, atPrompt, 'the cursor advances to the newest seq present when the prompt was built, past the skipped overflow');
  assert.ok(f.store.getSession(sessionId).metadata.roomDelivery.extraSeqs.every(seq => seq > atPrompt), 'only the reply published after the prompt sits past the cursor');
});

test('messages dropped by the character budget are counted as omitted and not in the conversation [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Char budget', botIds: [f.a.id, f.b.id] });
  let prompt = '';
  f.host.runSession = async id => { prompt = promptTexts(f.store, id).at(-1); f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ack' }]); };
  const bulky = 'y'.repeat(20000);
  for (let i = 0; i < 8; i++) insertUserLine(f, room, `HEAVY_${i}_${bulky}`);
  f.rooms.send(f.principal, room.id, { text: 'READ_HEAVY', mentions: [f.a.id] });
  await f.rooms.tick();
  const history = historyOf(prompt);
  assert.equal(history.length, 9);
  assert.equal(history.at(-1).text, 'READ_HEAVY');
  assert.ok(history.every(message => message.text.length <= 2000), 'each recent line is clipped');
  assert.ok(!prompt.includes(bulky), 'the full heavy body is not pasted into the prompt');
  assert.match(prompt, /older unseen Room messages were omitted and are NOT in this conversation/);
});

test('an already delivered unknown turn still warns on the next turn [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Still unknown', botIds: [f.a.id, f.b.id] });
  f.host.hasUnconfirmedEffects = () => true;
  f.rooms.send(f.principal, room.id, { text: 'RISKY_OLD', mentions: [f.a.id] });
  await f.rooms.tick();
  const unknown = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(unknown.status, 'unknown');
  delete f.host.hasUnconfirmedEffects;
  let prompt = '';
  f.host.runSession = async id => { prompt = promptTexts(f.store, id).at(-1); f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'careful' }]); };
  f.rooms.send(f.principal, room.id, { text: 'NEXT_AFTER_UNKNOWN', mentions: [f.a.id] });
  await f.rooms.tick();
  assert.match(prompt, /UNCONFIRMED effects/);
  assert.ok(prompt.includes(unknown.id));
  assert.ok(historyOf(prompt).some(message => message.text === 'RISKY_OLD'), 'the warning sits beside the recent window');
});

test('a newer turn reply is visible to an older turn member that has not built its prompt yet [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Out of order replies', botIds: [f.a.id, f.b.id] });
  const older = f.rooms.send(f.principal, room.id, { text: 'OLDER_ASK', mentions: [f.a.id, f.b.id] });
  const newer = f.rooms.send(f.principal, room.id, { text: 'NEWER_ASK', mentions: [f.b.id] });
  const seq = f.store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM bot_room_messages WHERE room_id=?').get(room.id).seq;
  const reply = { id: 'room_msg_newer_reply', roomId: room.id, seq, sender: { type: 'bot', id: f.b.id, name: 'Beta' }, text: 'NEWER_REPLY', attachmentIds: [], turnId: newer.turn.id, createdAt: new Date().toISOString() };
  f.store.db.prepare('INSERT INTO bot_room_messages(id,room_id,seq,idem_key,data) VALUES(?,?,?,?,?)').run(reply.id, room.id, seq, 'planted-newer-reply', JSON.stringify(reply));
  const prompts = [];
  f.host.runSession = async id => {
    prompts.push({ sessionId: id, text: promptTexts(f.store, id).at(-1) });
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `said:${f.store.getSession(id).agentId}` }]);
  };
  await f.rooms.tick();
  const alphaPrompt = prompts.find(entry => f.store.getSession(entry.sessionId).agentId === f.a.id && triggerText(entry.text) === 'OLDER_ASK').text;
  const betaPrompt = prompts.find(entry => f.store.getSession(entry.sessionId).agentId === f.b.id && triggerText(entry.text) === 'OLDER_ASK').text;
  const alpha = historyOf(alphaPrompt);
  assert.ok(alpha.some(message => message.text === 'NEWER_REPLY' && message.sender.name === 'Beta'), 'a newer-turn reply already in the room is visible');
  assert.ok(alpha.some(message => message.text === 'NEWER_ASK' && message.sender.type === 'user'), 'a later queued user message is visible too');
  assert.ok(alpha.some(message => message.text === 'OLDER_ASK'));
  const parallelBeta = historyOf(betaPrompt);
  assert.ok(parallelBeta.some(message => message.text === 'NEWER_REPLY' && message.sender.name === 'Beta'));
  assert.ok(!parallelBeta.some(message => message.sender.name === 'Alpha' && message.text.startsWith('said:')), 'a parallel prompt is built before the other member posts');
  const alphaSession = f.store.db.prepare('SELECT session_id FROM bot_room_contexts WHERE room_id=? AND bot_id=?').get(room.id, f.a.id).session_id;
  const alphaDelivery = f.store.getSession(alphaSession).metadata.roomDelivery;
  assert.equal(alphaDelivery.throughSeq, seq, 'the cursor covers every message present when the prompt was built');
  const ownReply = f.rooms.messages(f.principal, room.id).messages.find(message => message.sender.id === f.a.id && message.text.startsWith('said:'));
  assert.deepEqual(alphaDelivery.extraSeqs, [ownReply.seq], 'only this bot\'s own reply, published after the prompt, is tracked past the cursor');
  await f.rooms.tick();
  const betaNext = prompts.find(entry => f.store.getSession(entry.sessionId).agentId === f.b.id && triggerText(entry.text) === 'NEWER_ASK').text;
  assert.match(betaNext, /NEWER_ASK/);
  assert.ok(historyOf(betaNext).some(message => message.text === 'NEWER_REPLY' && message.sender.name === 'Beta'));
  assert.ok(historyOf(betaNext).some(message => message.sender.name === 'Alpha' && message.text.startsWith('said:')), 'Alpha posted after the parallel snapshot, so the next turn still shows it');
  assert.equal(f.rooms.turns(f.principal, room.id).find(turn => turn.id === older.turn.id).status, 'completed');
  assert.equal(f.rooms.turns(f.principal, room.id).find(turn => turn.id === newer.turn.id).status, 'completed');
});

test('a message that arrives while the bot is running is delivered on its next turn [AC:bot-rooms#AC-3]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Arrives while running', botIds: [f.a.id, f.b.id] });
  const prompts = [];
  let release;
  f.host.runSession = id => new Promise(resolve => {
    prompts.push(promptTexts(f.store, id).at(-1));
    release = () => {
      f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'first-reply' }]);
      resolve();
    };
  });
  f.rooms.send(f.principal, room.id, { text: 'TRIGGER_ONE', mentions: [f.a.id] });
  const running = f.rooms.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts.length, 1, 'the prompt is built before the run returns');
  f.rooms.send(f.principal, room.id, { text: 'ARRIVED_WHILE_RUNNING', mentions: [f.a.id] });
  assert.ok(!historyOf(prompts[0]).some(message => message.text === 'ARRIVED_WHILE_RUNNING'));
  const sessionId = f.store.db.prepare('SELECT session_id FROM bot_room_contexts WHERE room_id=? AND bot_id=?').get(room.id, f.a.id).session_id;
  const built = f.store.getSession(sessionId).metadata.roomDelivery;
  assert.ok(built.throughSeq < f.rooms.messages(f.principal, room.id).messages.at(-1).seq, 'the cursor stops at prompt-build time');
  release();
  await running;
  f.host.runSession = async id => {
    prompts.push(promptTexts(f.store, id).at(-1));
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'second-reply' }]);
  };
  await f.rooms.tick();
  const next = historyOf(prompts.at(-1));
  assert.ok(next.some(message => message.text === 'ARRIVED_WHILE_RUNNING' && message.sender.type === 'user' && message.sender.name === f.principal.userId), 'the late message is in the next recent window');
  assert.ok(next.some(message => message.text === 'TRIGGER_ONE'), 'the earlier trigger stays in the recent window');
  assert.ok(next.some(message => message.text === 'first-reply'), 'the published reply stays in the recent window');
  assert.equal(f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot').at(-1).text, 'second-reply');
  assert.equal(f.rooms.turns(f.principal, room.id).length, 2);
});

test('runtime exposes and executes owner delegation and evidence verification tools [AC:room-task-collaboration#AC-2] [AC:room-task-collaboration#AC-3]', async () => {
  let owner;
  let peer;
  let room;
  let principal;
  let ownerCalls = 0;
  const rt = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'room-task-runtime-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'room-task-runtime-state-')),
    modelAdapter: {
      name: 'task-runtime',
      async runTurn(input) {
        assert.ok(input.tools.some(tool => tool.name === 'room_route_turn'), 'actual model must see the routing tool');
        const botId = rt.store.getSession(input.sessionId).metadata.botId;
        if (botId === peer.id) return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Observed fixture result: passed' }] };
        ownerCalls++;
        if (ownerCalls === 1) return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'assign', name: 'room_route_turn', input: { botIds: [peer.id], mode: 'assign_tasks', assignments: [{ botId: peer.id, task: 'Check fixture', evidence: 'Observed fixture result' }] } }] };
        if (ownerCalls === 3) {
          const board = rt.rooms.turns(principal, room.id)[0].collaboration;
          assert.equal(board.tasks[0].status, 'waiting_approval');
          return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'verify', name: 'room_route_turn', input: { botIds: [], reviewedTaskIds: [board.tasks[0].id], completeGoal: true, verificationSummary: 'Observed result matches the required fixture outcome', evidenceMessageIds: board.tasks[0].materialIds } }] };
        }
        const results = input.messages.flatMap(message => message.parts).filter(part => part.type === 'tool_result' && part.name === 'room_route_turn');
        assert.ok(results.length > 0);
        assert.ok(results.every(result => result.ok !== false), JSON.stringify(results));
        if (ownerCalls === 4) assert.equal(rt.rooms.turns(principal, room.id)[0].collaboration.goal.status, 'completed');
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: ownerCalls === 2 ? 'Assigned fixture inspection' : 'Verified fixture result' }] };
      },
      async summarizeMessages() { return ''; }
    }
  });
  try {
    owner = rt.createBot({ name: 'TaskOwner' });
    peer = rt.createBot({ name: 'TaskPeer' });
    principal = resolveBotPrincipal(rt.store);
    room = rt.rooms.create(principal, { title: 'Runtime tasks', botIds: [owner.id, peer.id], hostBotId: owner.id });
    rt.rooms.patch(principal, room.id, { replyMode: 'task-collaboration' });
    rt.rooms.send(principal, room.id, { text: 'Inspect fixture and verify result' });
    await rt.rooms.tick();
    const turn = rt.rooms.turns(principal, room.id)[0];
    assert.equal(turn.status, 'completed');
    assert.equal(turn.collaboration.goal.status, 'completed');
    assert.equal(turn.collaboration.tasks[0].status, 'completed');
    assert.equal(ownerCalls, 4);
  } finally { rt.destroy(); }
});

test('a new room does not stop conversation rounds when the cap switch is off [AC:unlimited-bot-rounds#AC-1]', async () => {
  const f = fixture();
  const extra = [];
  for (let i = 0; i < 7; i += 1) {
    const bot = createBot(f.facade, { name: `Open${i}` });
    f.store.updateSession(bot.canonicalSessionId, { metadata: { ...f.store.getSession(bot.canonicalSessionId).metadata, ...f.principal } });
    extra.push(bot);
  }
  writeRoomSettings(f.store, { maxWaveSpeakers: 10 });
  const ids = [f.a.id, f.b.id, ...extra.map(bot => bot.id)];
  const room = f.rooms.create(f.principal, { title: 'Open', botIds: ids, hostBotId: f.a.id });
  assert.equal(room.maxBotTurns, 0);
  assert.notEqual(room.turnCapEnabled, true);
  assert.equal(room.maxToolCalls, 100);
  assert.equal(room.maxCostUsd, 1);
  assert.equal(room.toolCapEnabled, true);
  assert.equal(room.costCapEnabled, true);
  const sent = f.rooms.send(f.principal, room.id, { text: 'keep going', mentions: ids });
  assert.equal(sent.turn.maxBotTurns, 0);
  await f.rooms.tick();
  assert.equal(f.runs.length, ids.length);
});

test('an explicit conversation cap of 2 stops that round [AC:unlimited-bot-rounds#AC-2]', async () => {
  const f = fixture();
  const c = createBot(f.facade, { name: 'CapGamma' });
  f.store.updateSession(c.canonicalSessionId, { metadata: { ...f.store.getSession(c.canonicalSessionId).metadata, ...f.principal } });
  const room = f.rooms.create(f.principal, { title: 'Capped', botIds: [f.a.id, f.b.id, c.id], hostBotId: f.a.id, maxBotTurns: 2 });
  assert.equal(room.maxBotTurns, 2);
  assert.equal(room.turnCapEnabled, true);
  f.rooms.send(f.principal, room.id, { text: 'cap', mentions: [f.a.id, f.b.id, c.id] });
  await f.rooms.tick();
  assert.equal(f.runs.length, 2);
});
