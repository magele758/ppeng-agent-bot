import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';
import { settleGoalExecution } from '../dist/bots/goals/runtime-host.js';
import { createBot } from '../dist/bots/bot-facade.js';
import { createBotManagementTools, tickBotWork } from '../dist/bots/bot-work.js';

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'goal-boundaries-'));
 const store=new SqliteStateStore(join(dir,'db'));
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 const parent=store.createSession({title:'Parent',agentId:'general',mode:'chat',metadata:{botId:'b',canonicalBotChat:true,userId:'owner'}});
 const service=new BotGoalService(store,Date.now,parent.id), running=new Set(), runs=[];
 const host={store,isRunning:id=>running.has(id),cancel:id=>running.delete(id),run:id=>{runs.push(id);running.add(id);return new Promise(()=>{});},capabilities:()=>({registeredTools:[],enabledStrategies:['direct']})};
 const create=(extra={})=>service.create({botId:'b',sessionId:parent.id,title:'Work',objective:'Finish work',...extra});
 return {dir,store,parent,service,host,create,running,runs};
}
function waitFor(f,g,source,id) {
 const e=f.service.claim('b',g.id,{strategy:'subagent'});
 f.service.updateExecution('b',e.id,{sessionId:f.parent.id,runRef:`${source}:${id}`});
 const parent=f.store.getSession(f.parent.id);
 f.store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalAuthorizedWaits:[...(parent.metadata.botGoalAuthorizedWaits??[]),{goalId:g.id,executionId:e.id,source,correlationId:id}]}});
 f.service.report('b',e.id,{kind:'waiting',summary:'working',wait:{source,correlationId:id}});return e;
}

test('waiting and running references never finish a fresh idle child, including after reopen [AC:bot-goal-lifecycle-boundaries#AC-2]',async t=>{
 const f=fixture(t),g=f.create();
 const child=f.store.createSession({title:'child',mode:'subagent',agentId:'general',parentSessionId:f.parent.id,metadata:{botId:'b',botGoalId:g.id,botGoalScopeSessionId:f.parent.id,userId:'owner'}});
 waitFor(f,g,'session',child.id);
 await tickBotGoals(f.host);
 const reopened=new SqliteStateStore(join(f.dir,'db'));
 try{await tickBotGoals({...f.host,store:reopened});}finally{reopened.db.close();}
 assert.equal(f.service.get('b',g.id).status,'waiting');assert.deepEqual(f.runs,[]);assert.deepEqual(f.service.get('b',g.id).evidence,[]);
 f.store.updateSession(child.id,{status:'idle',metadata:{...child.metadata,outcome:{kind:'completed'}}});
 f.store.appendMessage(child.id,'assistant',[{type:'text',text:'Observed final output'}]);
 await tickBotGoals(f.host);assert.equal(f.runs.length,1);assert.match(f.service.get('b',g.id).evidence.join('\n'),/Observed final output/);
 await tickBotGoals(f.host);assert.equal(f.runs.length,1);
});

test('candidate at attempt and cost boundaries remains reviewable through direct and child settlement [AC:bot-goal-lifecycle-boundaries#AC-4]',async t=>{
 const f=fixture(t);f.service.updateSettings({maxAttempts:1,defaultBudgetUsd:1});
 for(const entry of ['report','direct','child']) {
  const g=f.create(),e=f.service.claim('b',g.id,{strategy:'direct'});
  if(entry==='report')f.service.report('b',e.id,{kind:'candidate_completed',summary:'done',evidence:['receipt'],costUsd:1});
  else {
   const child=f.store.createSession({title:entry,mode:'subagent',agentId:'general',parentSessionId:f.parent.id,metadata:{userId:'owner',botId:'b',botGoalId:g.id,botGoalScopeSessionId:f.parent.id,botGoalExecutionId:e.id,outcome:{kind:'completed'},usageCostUsd:1}});
   f.store.appendMessage(child.id,'assistant',[{type:'text',text:'Observed final output'}]);
   f.service.updateExecution('b',e.id,{sessionId:entry==='direct'?child.id:f.parent.id,runRef:`session:${child.id}`});
   const host={...f.host,judge:async()=>{throw new Error('unavailable');}};
   if(entry==='direct')await settleGoalExecution(host,child.id);else await tickBotGoals(host);
  }
  assert.equal(f.service.get('b',g.id).status,'pending_review',entry);
  await tickBotGoals(f.host);assert.equal(f.runs.length,0);
  assert.equal(f.service.control('b',g.id,'verify',{accepted:true}).status,'completed');
 }
});

test('external waits and draining work reserve capacity across strategies and scopes [AC:bot-goal-lifecycle-boundaries#AC-5]',t=>{
 const f=fixture(t);f.service.updateSettings({maxConcurrent:1});
 for(const source of ['session','bot_task','team_dag','swarm']) {
  const a=f.create(),b=f.create(),e=f.service.claim('b',a.id,{strategy:source});
  f.service.report('b',e.id,{kind:'waiting',summary:'running',wait:{source,correlationId:source}});
  assert.equal(f.service.claim('b',b.id,{strategy:'direct'}),undefined,source);
  f.service.control('b',a.id,'pause');assert.equal(f.service.claim('b',b.id,{strategy:'direct'}),undefined,'draining');
  f.service.setDraining('b',a.id,false);
  const next=f.service.claim('b',b.id,{strategy:'direct'});assert.ok(next);
  f.service.report('b',next.id,{kind:'failed',summary:'finished'});
 }
 const other=new BotGoalService(f.store,Date.now,'other');other.updateSettings({maxConcurrent:1});
 const g=other.create({botId:'b',sessionId:'other',title:'Other user',objective:'work'});assert.ok(other.claim('b',g.id,{strategy:'direct'}));
});

test('resume through conversation and control keeps waits and draining references [AC:bot-goal-lifecycle-boundaries#AC-6]',t=>{
 const f=fixture(t),g=f.create();waitFor(f,g,'session','live-child');
 assert.throws(()=>f.service.control('b',g.id,'resume'),/waiting/i);
 assert.throws(()=>f.service.applyIntent('b',{kind:'resume',goalId:g.id,text:'继续'}),/waiting/i);
 assert.equal(f.service.get('b',g.id).wait.correlationId,'live-child');
 f.service.block('b',g.id,'Needs reconciliation');
 assert.throws(()=>f.service.control('b',g.id,'resume'),/wait|reconcil/i);
 f.service.control('b',g.id,'pause');assert.throws(()=>f.service.control('b',g.id,'resume'),/draining/);
 f.service.setDraining('b',g.id,false);assert.equal(f.service.control('b',g.id,'resume').status,'queued');
});

test('explicit per-goal funding and attempts preserve receipts and isolate owners [AC:bot-goal-lifecycle-boundaries#AC-7]',t=>{
 const f=fixture(t);f.service.updateSettings({defaultBudgetUsd:1,maxAttempts:1,maxNoProgress:1});
 const g=f.create(),other=f.create(),e=f.service.claim('b',g.id,{strategy:'direct'});
 f.service.report('b',e.id,{kind:'progress',summary:'partial',advanced:false,evidence:['receipt'],costUsd:1});
 f.service.updateSettings({defaultBudgetUsd:5});
 const foreign=new BotGoalService(f.store,Date.now,'foreign');assert.throws(()=>foreign.extendLimits('b',g.id,{additionalBudgetUsd:2}),/not found/i);
 for(const bad of [{additionalBudgetUsd:-1},{additionalBudgetUsd:Infinity},{additionalAttempts:1.2},{}])assert.throws(()=>f.service.extendLimits('b',g.id,bad));
 f.service.extendLimits('b',g.id,{additionalBudgetUsd:2,additionalAttempts:1});
 const saved=f.service.get('b',g.id);assert.equal(saved.budgetUsd,3);assert.equal(saved.costUsd,1);assert.equal(saved.attempts,1);assert.equal(saved.noProgress,1);assert.deepEqual(saved.evidence,['receipt']);
 assert.equal(f.service.get('b',other.id).budgetUsd,1);assert.equal(f.service.readSettings().defaultBudgetUsd,5);
 f.service.control('b',g.id,'resume');assert.ok(f.service.claim('b',g.id,{strategy:'direct'}));
});

test('queued delegation never stamps other users or overwrites active recipient goals [AC:bot-goal-lifecycle-boundaries#AC-1]',async t=>{
 const f=fixture(t),running=new Set(),runs=[],releases=new Map();
 const host={store:f.store,log:{warn(){},info(){},debug(){},error(){}},runSession:id=>{runs.push(id);running.add(id);return new Promise(resolve=>releases.set(id,resolve));},isSessionRunning:id=>running.has(id),cancelSession(){}};
 const a=createBot(host,{name:'Source'}),b=createBot(host,{name:'Recipient'});
 const source=f.store.getSession(a.canonicalSessionId),target=f.store.getSession(b.canonicalSessionId);
 f.store.updateSession(source.id,{metadata:{...source.metadata,botGoalId:'source-one',botGoalScopeSessionId:source.id}});
 f.store.updateSession(target.id,{metadata:{...target.metadata,botGoalId:'recipient-own'}});
 const outsider=f.store.createSession({title:'Other principal',agentId:b.agentId,mode:'chat',metadata:{botId:b.id,canonicalBotChat:true,userId:'other',tenantId:'other-tenant',botGoalId:'private'}});
 running.add(target.id);
 const tool=createBotManagementTools(host).find(x=>x.name==='bot_delegate');
 const send=key=>tool.execute({session:f.store.getSession(source.id),agent:{id:a.agentId}},{target:b.id,input:'work',idempotencyKey:key});
 const one=await send('one');assert.equal(one.ok,true);const task1=JSON.parse(one.content).id;
 assert.equal(f.store.getSession(outsider.id).metadata.botGoalId,'private');assert.equal(f.store.getSession(outsider.id).metadata.botWorkTaskId,undefined);
 assert.equal(f.store.getSession(target.id).metadata.botGoalId,'recipient-own');assert.equal(f.store.getSession(target.id).metadata.botWorkTaskId,undefined);
 running.delete(target.id);await tickBotWork(host);
 assert.equal(f.store.getSession(target.id).metadata.botWorkTaskId,task1);
 assert.equal(f.store.getSession(target.id).metadata.botDelegatedGoal.id,'source-one');
 f.store.updateSession(source.id,{metadata:{...f.store.getSession(source.id).metadata,botGoalId:'source-two'}});
 const two=await send('two');assert.equal(two.ok,true);
 assert.equal(f.store.getSession(target.id).metadata.botWorkTaskId,task1);assert.equal(f.store.getSession(target.id).metadata.botDelegatedGoal.id,'source-one');
 assert.equal(f.store.getSession(target.id).metadata.botGoalId,'recipient-own');
 f.store.appendMessage(target.id,'assistant',[{type:'text',text:'first delivery receipt'}]);
 f.store.updateSession(target.id,{status:'idle',metadata:{...f.store.getSession(target.id).metadata,outcome:{kind:'completed'}}});
 running.delete(target.id);releases.get(target.id)();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.store.getSession(target.id).metadata.botDelegatedGoal,undefined);
 assert.equal(f.store.getSession(target.id).metadata.botGoalId,'recipient-own');
 await tickBotWork(host);
 assert.equal(f.store.getSession(target.id).metadata.botWorkTaskId,JSON.parse(two.content).id);
 assert.equal(f.store.getSession(target.id).metadata.botDelegatedGoal.id,'source-two');
});

test('retried delegation ignores prior-attempt children and waits for every current child [AC:bot-goal-lifecycle-boundaries#AC-1] [AC:bot-goal-lifecycle-boundaries#AC-2]',async t=>{
 const f=fixture(t);const host={store:f.store,log:{warn(){},info(){},debug(){},error(){}},runSession:()=>new Promise(()=>{}),isSessionRunning:()=>false,cancelSession(){}};
 const source=createBot(host,{name:'Retry source'}),target=createBot(host,{name:'Retry target'});
 const parent=f.store.getSession(source.canonicalSessionId),s=new BotGoalService(f.store,Date.now,parent.id);
 const g=s.create({botId:source.id,sessionId:parent.id,title:'Retry',objective:'finish'}),e=s.claim(source.id,g.id,{strategy:'bot_delegate'});
 s.updateExecution(source.id,e.id,{sessionId:parent.id});f.store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalId:g.id,botGoalScopeSessionId:parent.id}});
 const delegated=await createBotManagementTools(host).find(x=>x.name==='bot_delegate').execute({session:f.store.getSession(parent.id),agent:{id:source.agentId}},{target:target.id,input:'work',idempotencyKey:e.id});
 const taskId=JSON.parse(delegated.content).id;
 f.store.db.prepare("UPDATE bot_work_tasks SET attempt=2,status='running' WHERE id=?").run(taskId);
 const peer=f.store.listSessions().find(x=>x.metadata.botWorkTaskId===taskId);
 const child=attempt=>f.store.createSession({title:'child',mode:'subagent',agentId:target.agentId,parentSessionId:peer.id,metadata:{...peer.metadata,canonicalBotChat:false,botWorkTaskAttempt:attempt,outcome:{kind:'completed'}}});
 const old=child(1);f.store.appendMessage(old.id,'assistant',[{type:'text',text:'OLD attempt receipt'}]);
 f.store.updateSession(parent.id,{metadata:{...f.store.getSession(parent.id).metadata,botGoalAuthorizedWaits:[{goalId:g.id,executionId:e.id,source:'bot_task',correlationId:taskId}]}});
 s.report(source.id,e.id,{kind:'waiting',summary:'retry',wait:{source:'bot_task',correlationId:taskId}});
 await tickBotGoals(f.host);assert.equal(s.get(source.id,g.id).status,'waiting');
 const current=child(2),sibling=child(2);f.running.add(sibling.id);
 f.store.appendMessage(current.id,'assistant',[{type:'text',text:'CURRENT receipt'}]);
 await tickBotGoals(f.host);assert.equal(s.get(source.id,g.id).status,'waiting');
 f.running.delete(sibling.id);await tickBotGoals(f.host);
 assert.doesNotMatch(s.get(source.id,g.id).evidence.join('\n'),/OLD attempt/);assert.match(s.get(source.id,g.id).evidence.join('\n'),/CURRENT receipt/);
});

test('cancelled and failed child outcomes settle both running and waiting entrances [AC:bot-goal-lifecycle-boundaries#AC-2]',async t=>{
 const f=fixture(t);
 for(const entrance of ['running','waiting'])for(const kind of ['failed','aborted']){
  const g=f.create(),child=f.store.createSession({title:'ended',mode:'subagent',agentId:'general',parentSessionId:f.parent.id,metadata:{botId:'b',botGoalId:g.id,botGoalScopeSessionId:f.parent.id,userId:'owner',outcome:{kind}}});
  if(entrance==='waiting')waitFor(f,g,'session',child.id);
  else {const e=f.service.claim('b',g.id,{strategy:'subagent'});f.service.updateExecution('b',e.id,{sessionId:f.parent.id,runRef:`session:${child.id}`});}
  await tickBotGoals(f.host);assert.notEqual(f.service.get('b',g.id).status,'waiting');assert.notEqual(f.service.get('b',g.id).status,'completed');
 }
});

test('last allowed external attempt remains waiting then becomes reviewable without redispatch [AC:bot-goal-lifecycle-boundaries#AC-4] [AC:bot-goal-lifecycle-boundaries#AC-5]',async t=>{
 const f=fixture(t);f.service.updateSettings({maxAttempts:1,maxConcurrent:1});const g=f.create();
 const child=f.store.createSession({title:'last worker',mode:'subagent',agentId:'general',parentSessionId:f.parent.id,metadata:{botId:'b',botGoalId:g.id,botGoalScopeSessionId:f.parent.id,userId:'owner'}});
 waitFor(f,g,'session',child.id);assert.equal(f.service.get('b',g.id).status,'waiting');
 f.store.updateSession(child.id,{metadata:{...child.metadata,outcome:{kind:'completed'}}});f.store.appendMessage(child.id,'assistant',[{type:'text',text:'Final receipt'}]);
 await tickBotGoals(f.host);assert.equal(f.service.get('b',g.id).status,'pending_review');assert.equal(f.runs.length,0);assert.match(f.service.get('b',g.id).evidence.join('\n'),/Final receipt/);
 assert.equal(f.service.control('b',g.id,'verify',{accepted:true}).status,'completed');
});

test('waiting resume message is answered without losing its receipt or retrying workers [AC:bot-goal-lifecycle-boundaries#AC-6]',async t=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');const dir=mkdtempSync(join(tmpdir(),'goal-resume-chat-'));
 const rt=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'resume-test',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'Still waiting for the existing work'}]};},async summarizeMessages(){return '';}}});
 try{
  const bot=rt.createBot({name:'Waiting bot'}),id=rt.openBot(bot.id).sessionId,s=new BotGoalService(rt.store,Date.now,id);
  const g=s.create({botId:bot.id,sessionId:id,title:'Work',objective:'work'}),e=s.claim(bot.id,g.id,{strategy:'direct'});
  s.report(bot.id,e.id,{kind:'waiting',summary:'worker running',wait:{source:'session',correlationId:'worker'}});
  rt.sendUserMessage(id,`[goal:${g.id}] 继续`);await rt.runHumanSession(id);
  assert.equal(s.get(bot.id,g.id).status,'waiting');assert.equal(s.get(bot.id,g.id).wait.correlationId,'worker');assert.equal(s.executions(bot.id,g.id).length,1);
  assert.match(rt.getLatestAssistantText(id),/Still waiting/);
 }finally{await rt.destroy();rmSync(dir,{recursive:true,force:true});}
});

test('recipient task execution cannot checkpoint, settle or charge its unrelated local goal [AC:bot-goal-lifecycle-boundaries#AC-1]',async t=>{
 const f=fixture(t),g=f.create(),e=f.service.claim('b',g.id,{strategy:'direct'});
 f.service.updateExecution('b',e.id,{sessionId:f.parent.id});
 f.store.updateSession(f.parent.id,{metadata:{...f.parent.metadata,botGoalId:g.id,botGoalExecutionId:e.id,botWorkTaskId:'delegated-task',usageCostUsd:100,botGoalCostStart:0}});
 const {createGoalCheckpointTool}=await import('../dist/bots/goals/runtime-host.js');
 const {observeGoalBudget}=await import('../dist/bots/goals/budget.js');
 const result=await createGoalCheckpointTool(f.store).execute({session:f.store.getSession(f.parent.id)},{kind:'candidate_completed',summary:'delegated output'});
 assert.equal(result.ok,false);
 f.store.appendMessage(f.parent.id,'assistant',[{type:'text',text:'Delegated result only'}]);
 await settleGoalExecution(f.host,f.parent.id);await observeGoalBudget(f.host,f.parent.id)({type:'model_done'});
 assert.equal(f.service.get('b',g.id).status,'running');assert.equal(f.service.get('b',g.id).costUsd,0);assert.deepEqual(f.service.get('b',g.id).evidence,[]);
});

test('delegation cancellation keeps capacity until recipient coordinator actually stops [AC:bot-goal-lifecycle-boundaries#AC-1] [AC:bot-goal-lifecycle-boundaries#AC-5] [AC:bot-goal-lifecycle-boundaries#AC-6]',async t=>{
 const f=fixture(t),live=new Set();const host={store:f.store,log:{warn(){},info(){},debug(){},error(){}},runSession:id=>{live.add(id);return new Promise(()=>{});},isSessionRunning:id=>live.has(id),cancelSession(){}};
 const source=createBot(host,{name:'Cancel source'}),target=createBot(host,{name:'Cancel target'}),parent=f.store.getSession(source.canonicalSessionId),s=new BotGoalService(f.store,Date.now,parent.id);
 const g=s.create({botId:source.id,sessionId:parent.id,title:'Work',objective:'work'}),e=s.claim(source.id,g.id,{strategy:'bot_delegate'});s.updateExecution(source.id,e.id,{sessionId:parent.id});
 const result=await createBotManagementTools(host).find(x=>x.name==='bot_delegate').execute({session:parent,agent:{id:source.agentId}},{target:target.id,input:'work',idempotencyKey:e.id});const taskId=JSON.parse(result.content).id;
 f.store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalAuthorizedWaits:[{goalId:g.id,executionId:e.id,source:'bot_task',correlationId:taskId}]}});
 s.report(source.id,e.id,{kind:'waiting',summary:'working',wait:{source:'bot_task',correlationId:taskId}});s.control(source.id,g.id,'pause');
 const ticker={...f.host,isRunning:id=>live.has(id),cancel(){}};await tickBotGoals(ticker);
 assert.equal(s.get(source.id,g.id).draining,true);assert.throws(()=>s.control(source.id,g.id,'resume'),/draining/);
 live.clear();await tickBotGoals(ticker);assert.equal(s.get(source.id,g.id).draining,false);assert.equal(s.get(source.id,g.id).wait,undefined);assert.equal(s.control(source.id,g.id,'resume').status,'queued');
});
