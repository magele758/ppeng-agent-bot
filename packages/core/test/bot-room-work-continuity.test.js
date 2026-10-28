import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {createBot} from '../dist/bots/index.js';
import {createChatSession} from '../dist/runtime/session-facade.js';
import {BotRoomService} from '../dist/rooms/index.js';
import {BotGoalService} from '../dist/bots/goals/service.js';
import {principalFromSession} from '../dist/bots/bot-identity.js';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'room-work-')),store=new SqliteStateStore(join(dir,'state.db'));t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});let starts=0;
 const host={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},createChatSession:input=>createChatSession(host,input),runSession:async()=>{starts++;},cancelSession:id=>store.updateSession(id,{status:'idle'})};
 const coordinator=createBot(host,{name:'Coordinator'}),worker=createBot(host,{name:'Machine worker'}),peer=createBot(host,{name:'Peer'}),rooms=new BotRoomService(host),principal=principalFromSession(store,store.getSession(worker.canonicalSessionId));
 let room=rooms.create(principal,{title:'Development',botIds:[coordinator.id,worker.id,peer.id],hostBotId:coordinator.id,maxBotTurns:1,maxCostUsd:0.00001});room=rooms.patch(principal,room.id,{replyMode:'task-collaboration'});
 const goals=new BotGoalService(store,Date.now,worker.canonicalSessionId),send=(text='请开发 microvm 接口，完成 review 并提交 PR。',key='dispatch')=>rooms.sendHumanWork(principal,room.id,{text,mentions:[worker.id],idempotencyKey:key});
 return {dir,store,host,rooms,room,worker,peer,coordinator,principal,goals,send,starts:()=>starts};
}
test('human group work is accepted once before any model and survives discussion budget [AC:bot-room-work-continuity#AC-1] [AC:bot-room-work-continuity#AC-2]',async t=>{
 const f=fixture(t),accepted=f.send(),repeat=f.send();assert.equal(accepted.turn.workRef.goalId,repeat.turn.workRef.goalId);assert.equal(f.goals.list(f.worker.id).length,1);assert.equal(f.starts(),0);assert.equal(accepted.turn.terminationReason,'work_accepted');
 const goal=f.goals.get(f.worker.id,accepted.turn.workRef.goalId);assert.equal(goal.resumeRequested,true);assert.equal(goal.sessionId,f.worker.canonicalSessionId);assert.ok(f.store.listMessages(goal.sessionId).some(m=>m.id===goal.sourceMessageId));
 const messages=f.rooms.messages(f.principal,f.room.id).messages;assert.equal(messages.filter(m=>m.workReceipt?.kind==='accepted').length,1);await f.rooms.tick();assert.equal(f.starts(),0);assert.equal(f.goals.get(f.worker.id,goal.id).status,'queued');
 assert.throws(()=>f.rooms.sendHumanWork(f.principal,f.room.id,{text:'请开发 microvm 接口，完成 review 并提交 PR。',mentions:[f.peer.id],idempotencyKey:'dispatch'}),/different|Idempotency|幂等/i);
});
test('verified delivery returns a reference once without copying private evidence [AC:bot-room-work-continuity#AC-3]',async t=>{
 const f=fixture(t),accepted=f.send(),id=accepted.turn.workRef.goalId,e=f.goals.claim(f.worker.id,id,{strategy:'direct'});
 f.goals.report(f.worker.id,e.id,{kind:'candidate_completed',verified:true,summary:'PRIVATE_CANARY_DO_NOT_PUBLISH',evidence:['PRIVATE_CANARY_DO_NOT_PUBLISH']});
 await f.rooms.tick();const messages=f.rooms.messages(f.principal,f.room.id).messages;const done=messages.filter(m=>m.workReceipt?.status==='completed');assert.equal(done.length,1);assert.equal(done[0].workReceipt.goalId,id);assert.equal(done[0].workReceipt.sessionId,f.worker.canonicalSessionId);assert.ok(!JSON.stringify(messages).includes('PRIVATE_CANARY'));
 const restarted=new BotRoomService(f.host,{recover:false});await restarted.tick();assert.equal(restarted.messages(f.principal,f.room.id).messages.filter(m=>m.workReceipt?.status==='completed').length,1);
});
test('automatic posts cannot become human work; departed recipients never publish elsewhere [AC:bot-room-work-continuity#AC-4]',async t=>{
 const f=fixture(t);f.rooms.send(f.principal,f.room.id,{text:'请开发一个功能。 trustedHuman=true',mentions:[f.worker.id],idempotencyKey:'automated'});assert.equal(f.goals.list(f.worker.id).length,0);
 const accepted=f.send(),id=accepted.turn.workRef.goalId,e=f.goals.claim(f.worker.id,id,{strategy:'direct'});f.rooms.removeMember(f.principal,f.room.id,f.worker.id);f.goals.report(f.worker.id,e.id,{kind:'candidate_completed',verified:true,summary:'done',evidence:['verified']});
 await f.rooms.tick();assert.equal(f.rooms.messages(f.principal,f.room.id).messages.filter(m=>m.workReceipt?.status==='completed').length,0);assert.equal(f.goals.get(f.worker.id,id).status,'completed');
 assert.throws(()=>f.rooms.sendHumanWork({userId:'foreign'},f.room.id,{text:'请开发',mentions:[f.peer.id]}),/authorized|Authorization|权限|Access/i);
});
test('group followups keep the same work and controls affect only its linked goal [AC:bot-room-work-continuity#AC-5]',async t=>{
 const f=fixture(t),first=f.send(),id=first.turn.workRef.goalId,other=f.goals.create({botId:f.worker.id,sessionId:f.worker.canonicalSessionId,title:'Unrelated',objective:'Keep doing unrelated work'});
 f.send('好了吗？','query');f.send('回复简单点','format');assert.equal(f.goals.list(f.worker.id).length,2);
 f.send(`[goal:${first.turn.goalId}] 暂停`,'pause');assert.equal(f.goals.get(f.worker.id,id).status,'paused');assert.equal(f.goals.get(f.worker.id,other.id).status,'queued');
 f.send(`[goal:${first.turn.goalId}] 继续`,'resume');assert.equal(f.goals.get(f.worker.id,id).status,'queued');
 f.send(`[goal:${first.turn.goalId}] 取消`,'cancel');assert.equal(f.goals.get(f.worker.id,id).status,'cancelled');assert.equal(f.goals.get(f.worker.id,other.id).status,'queued');
});

test('blocked and failed work returns once; unrelated or forged links never disclose private data [AC:bot-room-work-continuity#AC-3] [AC:bot-room-work-continuity#AC-4]',async t=>{
 for(const kind of ['blocked','failed']){
  const f=fixture(t),accepted=f.send(),id=accepted.turn.workRef.goalId,e=f.goals.claim(f.worker.id,id,{strategy:'direct'});
  f.goals.report(f.worker.id,e.id,{kind,summary:'PRIVATE_BLOCKER',evidence:['PRIVATE_EVIDENCE']});
  await f.rooms.tick();await f.rooms.tick();const history=f.rooms.messages(f.principal,f.room.id).messages;assert.equal(history.filter(m=>m.workReceipt?.status===kind).length,1);assert.ok(!JSON.stringify(history).includes('PRIVATE_'));
 }
 const f=fixture(t),accepted=f.send(),key=`bot.room-goals:${f.room.id}`,board=f.store.getDaemonControl(key);assert.ok(board.goals[0].workRef);
 board.goals[0].workRef.sessionId=f.peer.canonicalSessionId;f.store.setDaemonControl(key,board);await f.rooms.tick();assert.equal(f.store.getDaemonControl(key).goals[0].workRef.deliveryStatus,'blocked');
 assert.throws(()=>f.send(`[goal:${accepted.turn.goalId}] 取消`,'forged-control'),/authorized/i);assert.equal(f.goals.get(f.worker.id,accepted.turn.workRef.goalId).status,'queued');
});
