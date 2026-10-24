import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {BotGoalService} from '../dist/bots/goals/service.js';
import {createRuntimeGoalDispatchTool} from '../dist/bots/goals/runtime-dispatch.js';
function fixture(t,approvalMode='never'){
 const dir=mkdtempSync(join(tmpdir(),'goal-route-'));const store=new SqliteStateStore(join(dir,'state.db'));t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true})});
 let starts=0,creates=0;
 const session=store.createSession({title:'Bot',mode:'chat',agentId:'general',metadata:{botId:'b',canonicalBotChat:true,permissionMode:'auto'}});
 const service=new BotGoalService(store,Date.now,session.id);const goal=service.create({botId:'b',sessionId:session.id,title:'Plan',objective:'Implement dependency plan'});const execution=service.claim('b',goal.id,{strategy:'team_dag'});service.updateExecution('b',execution.id,{sessionId:session.id,runRef:`session:${session.id}`});store.updateSession(session.id,{metadata:{...session.metadata,botGoalId:goal.id,botGoalExecutionId:execution.id}});
 const tools=['lab_team_plan_create','lab_team_plan_start'].map(name=>({name,description:name,inputSchema:{type:'object'},approvalMode:name.endsWith('start')?approvalMode:'never',sideEffectLevel:'write',execute:async()=>{if(name.endsWith('create'))creates++;else starts++;return {ok:true,content:JSON.stringify({plan:{id:'plan-ref'}})}}}));
 const deps={store,tools,envApprovalPolicy:undefined,maxParallelToolCalls:1,modelAdapter:{name:'fixture'},stateDir:dir,emitTrace(){}};
 const goalHost={store,isRunning:()=>true,cancel(){},run:async()=>{},capabilities:()=>({registeredTools:tools.map(t=>t.name),enabledStrategies:['direct','team_dag'],hasWorkspace:true})};
 const host={store,goalHost,deps:()=>deps,filePolicy:async()=>undefined,authorizedTools:()=>tools};const tool=createRuntimeGoalDispatchTool(host);
 const context=()=>({session:store.getSession(session.id),agent:{id:'general',instructions:'',capabilities:[]},repoRoot:dir,stateDir:dir});
 return {host,store,service,goal,execution,session,tool,context,starts:()=>starts,creates:()=>creates};
}
test('runtime dispatch records real run wait and prevents second launch [AC:bot-multi-goal-coordination#AC-5]',async t=>{
 const f=fixture(t);assert.equal((await f.tool.execute(f.context(),{preferredStrategy:'team_dag'})).ok,true);
 const meta=f.store.getSession(f.session.id).metadata;assert.equal(meta.botGoalCheckpoint.wait.correlationId,'plan-ref');assert.equal(meta.botGoalCheckpoint.wait.source,'team_dag');assert.equal(meta.botGoalAuthorizedWaits[0].correlationId,'plan-ref');assert.equal(f.service.executions('b',f.goal.id)[0].runRef,'team_dag:plan-ref');
 await f.tool.execute(f.context(),{preferredStrategy:'team_dag'});assert.equal(f.creates(),1);assert.equal(f.starts(),1);
});
test('approval retry reuses created plan and cannot switch request [AC:bot-multi-goal-coordination#AC-6]',async t=>{
 const f=fixture(t,'always');const staleContext=f.context();const first=JSON.parse((await f.tool.execute(staleContext,{preferredStrategy:'team_dag'})).content);assert.equal(first.waitingApproval,true);assert.equal(f.starts(),0);
 assert.equal((await f.tool.execute(f.context(),{preferredStrategy:'swarm'})).ok,false);
 const approval=f.store.listApprovals()[0];f.store.updateApproval(approval.id,'approved');
 const result=await f.tool.execute(staleContext,{preferredStrategy:'team_dag'});assert.equal(result.ok,true);assert.equal(f.creates(),1);assert.equal(f.starts(),1);
});
test('cancelled or revised goal cannot dispatch stale work',async t=>{
 const f=fixture(t);f.service.control('b',f.goal.id,'cancel');assert.equal((await f.tool.execute(f.context(),{preferredStrategy:'team_dag'})).ok,false);assert.equal(f.creates(),0);
});
test('nested dispatch keeps tool audit pairs out of the outer model transcript',async t=>{
 const f=fixture(t);f.store.appendMessage(f.session.id,'assistant',[{type:'tool_call',toolCallId:'outer',name:'goal_dispatch',input:{preferredStrategy:'team_dag'}}]);
 await f.tool.execute(f.context(),{preferredStrategy:'team_dag'});
 const parts=f.store.foldMessages(f.session.id).flatMap(m=>m.parts);
 assert.deepEqual(parts.filter(p=>p.type==='tool_call').map(p=>p.toolCallId),['outer']);
 const audit=f.store.getDaemonControl(`bot.goal-tool-ledger:${f.session.id}:${f.execution.id}`);
 assert.deepEqual(audit.map(m=>m.role),['assistant','tool','assistant','tool']);
});
test('real Runtime subagent dispatch preserves valid outer model tool pairing [AC:ops-session-trace-repair#AC-4] [AC:bot-goal-live-chain#AC-3]',async t=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');
 const dir=mkdtempSync(join(tmpdir(),'goal-route-real-'));let mainSession,dispatched=false,checked=false;
 const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'goal-dispatch-script',async runTurn(input){
  if(input.sessionId===mainSession&&!dispatched){dispatched=true;return {stopReason:'tool',assistantParts:[{type:'tool_call',toolCallId:'outer-dispatch',name:'goal_dispatch',input:{preferredStrategy:'subagent'}}]};}
  if(input.sessionId===mainSession&&dispatched){
   const messages=runtime.store.foldMessages(mainSession);const toolParts=messages.flatMap(m=>m.parts).filter(p=>p.type==='tool_call'||p.type==='tool_result');
   assert.deepEqual(toolParts.map(p=>p.type),['tool_call','tool_result']);assert.ok(toolParts.every(p=>p.toolCallId==='outer-dispatch'));checked=true;
  }
  if(input.sessionId!==mainSession)assert.match(JSON.stringify(input),/already launched for this objective/);
  return {stopReason:'end',assistantParts:[{type:'text',text:'Analysis evidence returned.'}]};
 },async summarizeMessages(){return 'summary';}}});
 t.after(async()=>{await runtime.destroy();rmSync(dir,{recursive:true,force:true})});
 const bot=runtime.createBot({name:'Dispatch review'});mainSession=runtime.openBot(bot.id).sessionId;
 runtime.sendUserMessage(mainSession,'实现一个简单功能',{autoRun:true});await runtime.runHumanSession(mainSession);
 assert.equal(dispatched,true);assert.equal(checked,true);
 const dispatch=runtime.store.getSession(mainSession).metadata.botGoalDispatch;
 assert.equal(dispatch.result.status,'waiting');assert.match(dispatch.result.reference,/^session:/);
 const worker=runtime.store.getSession(dispatch.result.reference.slice(8));assert.equal(worker.metadata.botGoalWorker,true);assert.equal(worker.metadata.taskRunMode,'auto');
 const traces=await runtime.listTraceEvents(worker.parentSessionId,5000);
 assert.ok(traces.some((event)=>event.kind==='child_session'&&event.payload?.childSessionId===worker.id&&event.payload?.source==='bot-goal-worker'),'parent trace should name the goal worker');
});
test('revision change during async policy lookup fences the pending side effect',async t=>{
 const f=fixture(t);f.host.filePolicy=async()=>{f.service.amend('b',f.goal.id,'Do not launch the plan');return undefined};
 const result=await f.tool.execute(f.context(),{preferredStrategy:'team_dag'});
 assert.equal(f.service.get("b",f.goal.id).revision,2);assert.equal(result.ok,false);assert.equal(f.creates(),0);assert.equal(f.starts(),0);
});
test('worker fence permits original running and authorized waiting revision only',async t=>{
 const {isGoalWorkerCurrent}=await import('../dist/bots/goals/worker-fence.js');const f=fixture(t);
 const child=f.store.createSession({title:'worker',mode:'subagent',agentId:'general',parentSessionId:f.session.id,metadata:{botId:'b',botGoalId:f.goal.id,botGoalScopeSessionId:f.session.id,botGoalWorker:true,botGoalWorkerRevision:f.goal.revision,botGoalWorkerExecutionId:f.execution.id,botGoalWorkerFence:f.execution.fence}});
 assert.equal(isGoalWorkerCurrent(f.store,child),true);
 f.store.updateSession(child.id,{metadata:{...child.metadata,botGoalWorkerFence:f.execution.fence+1}});assert.equal(isGoalWorkerCurrent(f.store,child),false);f.store.updateSession(child.id,{metadata:child.metadata});
 const parent=f.store.getSession(f.session.id);f.store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalAuthorizedWaits:[{goalId:f.goal.id,executionId:f.execution.id,source:'session',correlationId:child.id}]}});
 f.service.report('b',f.execution.id,{kind:'waiting',summary:'worker waiting approval',wait:{source:'session',correlationId:child.id}});assert.equal(isGoalWorkerCurrent(f.store,child),true);
 f.service.amend('b',f.goal.id,'New restriction');assert.equal(isGoalWorkerCurrent(f.store,child),false);
});
test('worker fence rejects blocked goals and unrelated parent sessions',async t=>{
 const {isGoalWorkerCurrent}=await import('../dist/bots/goals/worker-fence.js');const f=fixture(t);
 const meta={botId:'b',botGoalId:f.goal.id,botGoalScopeSessionId:f.session.id,botGoalWorker:true,botGoalWorkerRevision:f.goal.revision,botGoalWorkerExecutionId:f.execution.id,botGoalWorkerFence:f.execution.fence};
 const unrelated=f.store.createSession({title:'other',mode:'chat',agentId:'general'});
 const child=f.store.createSession({title:'worker',mode:'subagent',agentId:'general',parentSessionId:unrelated.id,metadata:meta});assert.equal(isGoalWorkerCurrent(f.store,child),false);
 const owned=f.store.createSession({title:'worker',mode:'subagent',agentId:'general',parentSessionId:f.session.id,metadata:meta});f.service.block('b',f.goal.id,'Budget exhausted');assert.equal(isGoalWorkerCurrent(f.store,owned),false);
});
