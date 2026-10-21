import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/bot-facade.js';
import * as work from '../dist/bots/bot-work.js';

test('collaboration reports partial delivery and retries only the failed member [AC:bot-product-p2#AC-5] [AC:bot-product-p2#AC-6]', async () => {
 const dir=mkdtempSync(join(tmpdir(),'collaboration-')),store=new SqliteStateStore(join(dir,'state.db'));
 const calls=new Map();let fail=true;
 const host={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},log:{warn(){},info(){},debug(){},error(){}},async runSession(id){const s=store.getSession(id);const bot=s.metadata.botId;calls.set(bot,(calls.get(bot)??0)+1);store.appendMessage(id,'assistant',[{type:'text',text:`Saved result ${bot}`}]);store.updateSession(id,{status:bot===bad.id&&fail?'failed':'completed'});}};
 const boss=createBot(host,{name:'Boss'}),good=createBot(host,{name:'Good'}),bad=createBot(host,{name:'Bad'}),principal=work.resolveBotPrincipal(store);
 try {
 const root=work.dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:boss.id,input:'Unified report'});
 const a=work.dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:good.id,input:'Collect data',parentTaskId:root.id});
 const b=work.dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:bad.id,input:'Verify data',parentTaskId:root.id});
 await work.tickBotWork(host);await new Promise(setImmediate);
 const groups=work.botCollaborations(store,principal);assert.equal(groups.length,1);
 assert.equal(groups[0].goal,'Unified report');assert.equal(groups[0].status,'blocked');assert.equal(groups[0].completed,2);
 assert.deepEqual(groups[0].blockers.map(t=>t.id),[b.id]);assert.match(groups[0].deliveries.find(t=>t.id===a.id).delivery.report,/Saved result/);
 assert.deepEqual(work.botCollaborations(store,{userId:'stranger'}),[]);
 assert.throws(()=>work.dispatchBotTask(host,{principal,requesterBotId:good.id,targetBotId:bad.id,input:'Hijack',parentTaskId:root.id}),/parent/i);
 const saved=work.getBotTask(store,principal,a.id).delivery;
 fail=false;work.retryBotTask(host,principal,b.id);await work.tickBotWork(host);await new Promise(setImmediate);
 assert.equal(work.botCollaborations(store,principal)[0].status,'completed');assert.equal(calls.get(good.id),1);assert.equal(calls.get(bad.id),2);
 assert.deepEqual(work.getBotTask(store,principal,a.id).delivery,saved);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('bot_delegate automatically groups one user goal and preserves each member permissions [AC:bot-product-p2#AC-5]',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'delegate-group-')),store=new SqliteStateStore(join(dir,'state.db'));
 const host={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},log:{warn(){},info(){},debug(){},error(){}},async runSession(id){store.appendMessage(id,'assistant',[{type:'text',text:'Member result'}]);store.updateSession(id,{status:'completed'});}};
 try{
 const boss=createBot(host,{name:'Main'}),a=createBot(host,{name:'Research'}),b=createBot(host,{name:'Review'}),principal=work.resolveBotPrincipal(store);
 const main=work.openBotWorkContext(host,boss.id,principal),worker=work.openBotWorkContext(host,a.id,principal);
 store.updateSession(worker.id,{metadata:{...worker.metadata,allowedTools:['read_file'],permissionMode:'ask'}});
 store.appendMessage(main.id,'user',[{type:'text',text:'Prepare and verify release report'}]);store.updateSession(main.id,{status:'running'});
 host.isSessionRunning=id=>id===main.id;
 const delegate=work.createBotManagementTools(host).find(t=>t.name==='bot_delegate');
 const ctx={session:store.getSession(main.id),agent:{id:boss.agentId}};
 assert.equal((await delegate.execute(ctx,{target:a.id,input:'Research',idempotencyKey:'a'})).ok,true);
 assert.equal((await delegate.execute(ctx,{target:b.id,input:'Review',idempotencyKey:'b'})).ok,true);
 await new Promise(setImmediate);
 const groups=work.botCollaborations(store,principal);assert.equal(groups.length,1);assert.equal(groups[0].goal,'Prepare and verify release report');assert.equal(groups[0].members.length,2);
 assert.deepEqual(store.getSession(worker.id).metadata.allowedTools,['read_file']);assert.equal(store.getSession(worker.id).metadata.permissionMode,'ask');
 const blocked=await delegate.execute({...ctx,session:{...ctx.session,metadata:{...ctx.session.metadata,permissionMode:'plan'}}},{target:a.id,input:'Escalate',idempotencyKey:'plan'});
 assert.equal(blocked.ok,false);assert.equal(work.botCollaborations(store,principal)[0].members.length,2);
 }finally{await new Promise(setImmediate);store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('approval blocker resumes its member once while preserving completed sibling effects [AC:bot-product-p2#AC-6]',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'collaboration-approval-')),store=new SqliteStateStore(join(dir,'state.db'));
 let siblingEffects=0,guardedEffects=0;
 const host={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},log:{warn(){},info(){},debug(){},error(){}},async runSession(id){
  const session=store.getSession(id);
  if(session.metadata.botId===reviewer.id&&!store.listApprovals({status:'approved'}).some(a=>a.sessionId===id)){
   store.createApproval({sessionId:id,toolName:'guarded_send',args:{},reason:'User approval'});
   store.updateSession(id,{status:'waiting_approval',metadata:{...session.metadata,outcome:{kind:'waiting_approval',reason:'waiting_approval'}}});return;
  }
  if(session.metadata.botId===writer.id)siblingEffects++;
  if(session.metadata.botId===reviewer.id)guardedEffects++;
  store.appendMessage(id,'assistant',[{type:'text',text:'Confirmed delivery'}]);store.updateSession(id,{status:'completed',metadata:{...session.metadata,outcome:{kind:'completed',reason:'end'}}});
 }};
 const boss=createBot(host,{name:'Boss'}),writer=createBot(host,{name:'Writer'}),reviewer=createBot(host,{name:'Reviewer'}),principal=work.resolveBotPrincipal(store);
 try{
 const root=work.dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:boss.id,input:'Approved report'});
 work.dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:writer.id,input:'Write',parentTaskId:root.id});
 const guarded=work.dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:reviewer.id,input:'Send',parentTaskId:root.id});
 await work.tickBotWork(host);await new Promise(setImmediate);
 const group=work.botCollaborations(store,principal)[0];assert.equal(group.status,'blocked');assert.equal(group.blockers[0].id,guarded.id);assert.equal(group.blockers[0].status,'waiting_approval');assert.equal(guardedEffects,0);
 const approval=store.listApprovals({status:'pending'})[0];store.updateApproval(approval.id,'approved');store.updateSession(approval.sessionId,{status:'idle'});
 await work.tickBotWork(host);await new Promise(setImmediate);await work.tickBotWork(host);await new Promise(setImmediate);
 assert.equal(work.botCollaborations(store,principal)[0].status,'completed');assert.equal(siblingEffects,1);assert.equal(guardedEffects,1);
 }finally{await new Promise(setImmediate);store.db.close();rmSync(dir,{recursive:true,force:true});}
});
