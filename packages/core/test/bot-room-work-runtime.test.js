import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawAgentRuntime} from '../dist/runtime.js';
import {BotGoalService} from '../dist/bots/goals/service.js';
import {tickBotGoals} from '../dist/bots/goals/scheduler.js';
import {principalFromSession} from '../dist/bots/bot-identity.js';
test('accepted group work executes once through the existing Goal scheduler after discussion ends [AC:bot-room-work-continuity#AC-2] [AC:bot-room-work-continuity#AC-3]',{timeout:30000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-kernel-')),file=join(dir,'delivery.txt');let runtime,modelTurns=0;
 const adapter={name:'controlled-room',async runTurn(input){
  modelTurns++;const session=runtime.store.getSession(input.sessionId);
  if(!session.metadata.botGoalExecutionId)return {stopReason:'end',assistantParts:[{type:'text',text:'Existing work checked.'}]};
  const result=input.messages.flatMap(m=>m.parts).find(p=>p.type==='tool_result'&&p.toolCallId==='delivery');
  if(!result)return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'delivery',name:'write_file',input:{path:file,content:'verified local delivery'}}]};
  assert.equal(result.ok,true,result.content);return {stopReason:'end',assistantParts:[{type:'text',text:'PRIVATE_DELIVERY: file written and checked.'}]};
 },async completeText(input){const packet=JSON.parse(input.user);if(!Array.isArray(packet.observations))return JSON.stringify({intents:[{kind:'query',text:'好了吗？'}]});const writes=packet.observations.filter(o=>o.name==='write_file'&&o.ok);const met=existsSync(file)&&readFileSync(file,'utf8')==='verified local delivery'&&writes.length===1;return JSON.stringify({met,advanced:met,correctionNeeded:!met,reason:'Observed the real file result',evidence:['verified local file'],evidenceRefs:writes.map(o=>o.ref),missing:met?[]:['local file']});}};
 runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:adapter});runtime.emitTrace=()=>{};t.after(async()=>{await runtime.destroy();rmSync(dir,{recursive:true,force:true});});
 const hostBot=runtime.createBot({name:'Host'}),worker=runtime.createBot({name:'Worker'}),canonical=runtime.store.getSession(worker.canonicalSessionId),principal=principalFromSession(runtime.store,canonical);
 runtime.store.updateSession(canonical.id,{metadata:{...canonical.metadata,permissionMode:'auto'}});
 const rooms=runtime.rooms;let room=rooms.create(principal,{title:'Development',botIds:[hostBot.id,worker.id],maxBotTurns:1,maxCostUsd:0.00001});room=rooms.patch(principal,room.id,{replyMode:'task-collaboration'});
 const accepted=rooms.sendHumanWork(principal,room.id,{text:'请开发本地文件交付：写入 delivery.txt。',mentions:[worker.id],idempotencyKey:'real-work'}),ref=accepted.turn.workRef,service=new BotGoalService(runtime.store,Date.now,ref.sessionId);
 assert.equal(modelTurns,0);const goalHost={store:runtime.store,isRunning:id=>runtime.isSessionRunning(id),cancel:id=>runtime.cancelSession(id),run:id=>runtime.runSession(id),capabilities:()=>({registeredTools:['write_file'],allowedTools:['write_file'],enabledStrategies:['direct']}),judge:input=>adapter.completeText(input)};
 for(let i=0;i<100;i++){await tickBotGoals(goalHost);if(service.get(worker.id,ref.goalId).status==='completed')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(service.get(worker.id,ref.goalId).status,'completed',JSON.stringify(service.get(worker.id,ref.goalId)));assert.equal(readFileSync(file,'utf8'),'verified local delivery');
 await rooms.tick();await rooms.tick();const messages=rooms.messages(principal,room.id).messages;assert.equal(messages.filter(m=>m.workReceipt?.status==='completed').length,1);assert.ok(!JSON.stringify(messages).includes('PRIVATE_DELIVERY'));
 const writes=runtime.store.listSessions().flatMap(s=>runtime.store.listMessages(s.id)).flatMap(m=>m.parts).filter(p=>p.type==='tool_call'&&p.name==='write_file');assert.equal(writes.length,1);
 runtime.sendUserMessage(canonical.id,'好了吗？');await runtime.runSession(canonical.id);assert.equal(service.list(worker.id).length,1);assert.equal(runtime.store.listSessions().flatMap(s=>runtime.store.listMessages(s.id)).flatMap(m=>m.parts).filter(p=>p.type==='tool_call'&&p.name==='write_file').length,1);
});
