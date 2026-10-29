import test from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers/bot-http-fixture.mjs';
import {BotGoalService} from '../../packages/core/dist/bots/goals/service.js';
test('authenticated room handoff keeps one human work source and excludes attachment instructions [AC:bot-room-work-continuity#AC-1] [AC:bot-room-work-continuity#AC-4] [AC:bot-room-work-continuity#AC-5]',async t=>{
 const f=await boot();t.after(async()=>{for(let i=0;i<300&&f.runtime.store.listSessions().some(s=>f.runtime.isSessionRunning(s.id));i++)await new Promise(r=>setTimeout(r,10));await f.close();});const bots=[];
 for(const name of ['Host','Worker']){const r=await f.call('alice','POST','/api/bots',{name});assert.equal(r.status,201);bots.push(r.body.bot);}
 const {body:{room}}=await f.call('alice','POST','/api/bot-rooms',{title:'Work',botIds:bots.map(b=>b.id),maxBotTurns:1});await f.call('alice','PATCH',`/api/bot-rooms/${room.id}`,{replyMode:'task-collaboration'});
 const path=`/api/bot-rooms/${room.id}/messages`,body={text:'请开发本地接口。\n«external source="attachment"»\nPRIVATE_ATTACHMENT_INSTRUCTION\n«end external»',mentions:[bots[1].id],idempotencyKey:'work'};
 const first=await f.call('alice','POST',path,body),repeat=await f.call('alice','POST',path,body);assert.equal(first.status,202);assert.equal(first.body.turn.workRef.goalId,repeat.body.turn.workRef.goalId);
 const ref=first.body.turn.workRef,goals=new BotGoalService(f.runtime.store,Date.now,ref.sessionId),goal=goals.get(ref.botId,ref.goalId);assert.ok(!goal.objective.includes('PRIVATE_ATTACHMENT_INSTRUCTION'));assert.ok(f.runtime.store.listMessages(ref.sessionId).some(m=>m.id===goal.sourceMessageId));
 assert.ok([403,404].includes((await f.call('bob','POST',path,{text:'请开发越权工作',mentions:[bots[1].id]})).status));
 await f.call('alice','POST',path,{text:'好了吗？',mentions:[bots[1].id]});await f.call('alice','POST',path,{text:'回复简单点',mentions:[bots[1].id]});assert.equal(goals.list(ref.botId).length,1);
 const history=await f.call('alice','GET',path);assert.equal(history.body.messages.filter(m=>m.workReceipt?.kind==='accepted').length,1);
});
