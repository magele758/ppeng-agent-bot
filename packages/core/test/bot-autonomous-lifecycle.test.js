import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawAgentRuntime} from '../dist/runtime.js';
import {BotGoalService} from '../dist/bots/goals/service.js';
import {createGoalSelfHealTool} from '../dist/bots/goals/specialty-services.js';
import {tickBotGoals} from '../dist/bots/goals/scheduler.js';
import {goalExecutionTask} from '../dist/bots/goals/runtime-host.js';

function fixture(t,modelAdapter) {
  const dir=mkdtempSync(join(tmpdir(),'bot-auto-lifecycle-'));
  const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:modelAdapter??{name:'fixture',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'Evidence received'}]}},async summarizeMessages(){return 'summary'}}});
  t.after(async()=>{await runtime.destroy();rmSync(dir,{recursive:true,force:true})});
  runtime.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  const bot=runtime.createBot({name:'Autonomous'}),sid=runtime.openBot(bot.id).sessionId;
  const store=runtime.store,service=new BotGoalService(store,Date.now,sid);
  return {runtime,store,service,bot,sid,dir};
}
async function startHeal(f) {
  const goal=f.service.create({botId:f.bot.id,sessionId:f.sid,title:'Heal',objective:'启动自愈修复测试',constraints:['不修改公共接口']});
  const execution=f.service.claim(f.bot.id,goal.id,{strategy:'self_heal'});
  f.service.updateExecution(f.bot.id,execution.id,{sessionId:f.sid});
  const parent=f.store.getSession(f.sid);
  f.store.updateSession(f.sid,{metadata:{...parent.metadata,permissionMode:'ask',allowedTools:['read_file','bash'],botGoalId:goal.id,botGoalExecutionId:execution.id}});
  const tool=createGoalSelfHealTool({store:f.store,selfHeal:f.runtime.selfHeal});
  const result=await tool.execute({session:f.store.getSession(f.sid),agent:f.store.getAgent(f.bot.agentId)},{});
  assert.equal(result.ok,true);const run=JSON.parse(result.content);
  f.store.updateSession(f.sid,{metadata:{...f.store.getSession(f.sid).metadata,botGoalAuthorizedWaits:[{goalId:goal.id,executionId:execution.id,source:'self_heal',correlationId:run.id}]}});
  f.service.report(f.bot.id,execution.id,{kind:'waiting',summary:'Started',wait:{source:'self_heal',correlationId:run.id}});
  return {goal,execution,run};
}
test('self-heal creates a real durable run with inherited restrictions [AC:bot-autonomous-execution-coverage#AC-3]',async t=>{
  const f=fixture(t);const {goal,run}=await startHeal(f);
  assert.equal(f.runtime.getSelfHealRun(run.id).status,'pending');
  assert.equal(run.policy.autoMerge,false);assert.equal(run.policy.allowExternalAiTools,false);
  // Exercise the actual pending -> task/session transition without launching OS test commands.
  await f.runtime.selfHeal.advancePending(run,run.policy);
  const started=f.runtime.getSelfHealRun(run.id),worker=f.store.getSession(started.sessionId);
  assert.equal(worker.agentId,'self-healer');assert.equal(worker.parentSessionId,f.sid);
  assert.equal(worker.metadata.permissionMode,'ask');assert.deepEqual(worker.metadata.allowedTools,['read_file','bash']);
  assert.equal(worker.metadata.botGoalId,goal.id);
  assert.match(JSON.stringify(f.store.foldMessages(worker.id)),/不修改公共接口/);
  assert.equal(f.runtime.goalRuntimeHost().inspectSpecialty(f.store.getSession(f.sid),f.service.get(f.bot.id,goal.id)).status,'running_tests');
});
test('cancel stops the real self-heal lifecycle and late completion cannot restart it [AC:bot-autonomous-execution-coverage#AC-7]',async t=>{
  const f=fixture(t);const {goal,run}=await startHeal(f);
  f.service.control(f.bot.id,goal.id,'cancel');
  await tickBotGoals(f.runtime.goalRuntimeHost());
  assert.equal(f.runtime.getSelfHealRun(run.id).stopped,true);
  assert.equal(f.service.get(f.bot.id,goal.id).draining,false);
  f.store.updateSelfHealRun(run.id,{status:'completed'});
  await tickBotGoals(f.runtime.goalRuntimeHost());
  assert.equal(f.service.get(f.bot.id,goal.id).status,'cancelled');
  assert.equal(f.store.listSessions().length,1);
});
test('amending a self-heal goal drains old work before a continuation [AC:bot-autonomous-execution-coverage#AC-5] [AC:bot-autonomous-execution-coverage#AC-7]',async t=>{
  const f=fixture(t);const {goal,run}=await startHeal(f);const runs=[];
  f.service.amend(f.bot.id,goal.id,'只允许修改测试');
  await tickBotGoals({...f.runtime.goalRuntimeHost(),run:id=>{runs.push(id);return new Promise(()=>{})}});
  assert.equal(f.runtime.getSelfHealRun(run.id).stopped,true);
  assert.equal(runs.length,1);
  const next=f.service.get(f.bot.id,goal.id);
  assert.equal(next.revision,2);assert.ok(next.constraints.includes('只允许修改测试'));
  assert.match(goalExecutionTask(next),/^Verify/);
  assert.match(JSON.stringify(f.store.foldMessages(runs[0])),/只允许修改测试/);
});
test('actual Bot dispatch selects the original specialist and keeps Bot identity [AC:bot-autonomous-execution-coverage#AC-4]',async t=>{
  let sid,dispatched=false;const workers=[];
  const f=fixture(t,{name:'script',async runTurn(input){
    if(input.sessionId===sid&&!dispatched){dispatched=true;return {stopReason:'tool',assistantParts:[{type:'tool_call',toolCallId:'dispatch',name:'goal_dispatch',input:{}}]};}
    if(input.sessionId!==sid)workers.push(input.sessionId);
    return {stopReason:'end',assistantParts:[{type:'text',text:'Planning evidence'}]};
  },async summarizeMessages(){return 'summary'}});sid=f.sid;
  f.runtime.sendUserMessage(sid,'交给规划子代理制定产品规划',{autoRun:true});await f.runtime.runHumanSession(sid);
  const dispatch=f.store.getSession(sid).metadata.botGoalDispatch;
  assert.equal(dispatch.result.status,'waiting');
  const worker=f.store.getSession(dispatch.result.reference.slice(8));
  assert.equal(worker.agentId,'planner');assert.equal(worker.metadata.botId,f.bot.id);
  assert.equal(f.store.getSession(sid).agentId,f.bot.agentId);
  assert.match(f.store.getAgent(worker.agentId).instructions,/product spec/);
});
test('self-heal dispatch waits for normal approval before creating any run [AC:bot-autonomous-execution-coverage#AC-6]',async t=>{
  let dispatched=false;
  const f=fixture(t,{name:'approval-script',async runTurn(){
    if(!dispatched){dispatched=true;return {stopReason:'tool',assistantParts:[{type:'tool_call',toolCallId:'heal-dispatch',name:'goal_dispatch',input:{preferredStrategy:'self_heal'}}]};}
    return {stopReason:'end',assistantParts:[{type:'text',text:'Awaiting approval'}]};
  },async summarizeMessages(){return 'summary'}});
  f.runtime.sendUserMessage(f.sid,'启动自愈修复失败测试',{autoRun:true});await f.runtime.runHumanSession(f.sid);
  const dispatch=f.store.getSession(f.sid).metadata.botGoalDispatch;
  assert.equal(dispatch.result.waitingApproval,true);
  assert.equal(f.runtime.listSelfHealRuns().length,0);
  assert.ok(f.store.listApprovals().some(a=>a.toolName==='goal_self_heal_start'&&a.status==='pending'));
  const approval=f.store.listApprovals().find(a=>a.toolName==='goal_self_heal_start');
  f.store.updateApproval(approval.id,'approved');
  const tool=f.runtime.tools.find(tool=>tool.name==='goal_dispatch');
  const ctx={session:f.store.getSession(f.sid),agent:f.store.getAgent(f.bot.agentId),repoRoot:f.dir,stateDir:join(f.dir,'state')};
  const approved=JSON.parse((await tool.execute(ctx,{preferredStrategy:'self_heal'})).content);
  assert.equal(approved.status,'waiting');assert.equal(f.runtime.listSelfHealRuns().length,1);
  assert.equal(f.store.getSession(f.sid).metadata.botGoalCheckpoint.wait.source,'self_heal');
  await tool.execute(ctx,{preferredStrategy:'self_heal'});
  assert.equal(f.runtime.listSelfHealRuns().length,1);
});
test('a cancelled goal cannot be restarted by resuming its underlying self-heal run [AC:bot-autonomous-execution-coverage#AC-7]',async t=>{
  const f=fixture(t);const {goal,run}=await startHeal(f);
  f.service.control(f.bot.id,goal.id,'cancel');
  await f.runtime.selfHeal.processRuns();
  assert.equal(f.runtime.getSelfHealRun(run.id).stopped,true);
  f.runtime.selfHeal.resumeRun(run.id);
  await f.runtime.selfHeal.processRuns();
  assert.equal(f.runtime.getSelfHealRun(run.id).stopped,true);
  assert.equal(f.runtime.getSelfHealRun(run.id).sessionId,undefined);
});
test('research profile belongs to the worker and cannot disable Bot dispatch [AC:bot-autonomous-execution-coverage#AC-2]',async t=>{
  let sid,dispatched=false;
  const f=fixture(t,{name:'research-script',async runTurn(input){
    if(input.sessionId===sid&&!dispatched){dispatched=true;return {stopReason:'tool',assistantParts:[{type:'tool_call',toolCallId:'research',name:'goal_dispatch',input:{workKind:'research',preferredStrategy:'subagent'}}]};}
    return {stopReason:'end',assistantParts:[{type:'text',text:'Research evidence'}]};
  },async summarizeMessages(){return 'summary'}});sid=f.sid;
  f.runtime.sendUserMessage(sid,'调研可用部署方案',{autoRun:true});await f.runtime.runHumanSession(sid);
  const dispatch=f.store.getSession(sid).metadata.botGoalDispatch;
  assert.equal(dispatch.result.status,'waiting');
  const worker=f.store.getSession(dispatch.result.reference.slice(8));
  assert.equal(worker.agentId,'researcher');assert.equal(worker.metadata.taskRunMode,'deep_research');
});
test('authorized on-demand browser tools count as available without prior disclosure [AC:bot-autonomous-execution-coverage#AC-2]',async t=>{
  let sid,dispatched=false;
  const f=fixture(t,{name:'browser-script',async runTurn(input){
    if(input.sessionId===sid&&!dispatched){dispatched=true;return {stopReason:'tool',assistantParts:[{type:'tool_call',toolCallId:'browser',name:'goal_dispatch',input:{workKind:'browser'}}]};}
    return {stopReason:'end',assistantParts:[{type:'text',text:'Browser result'}]};
  },async summarizeMessages(){return 'summary'}});sid=f.sid;
  f.store.setDaemonControl('browser_settings',{enabled:true});
  f.runtime.tools.push({name:'browser_navigate',description:'Browser fixture',inputSchema:{type:'object'},disclosure:'on_demand',sideEffectLevel:'none',approvalMode:'never',async execute(){return {ok:true,content:'Page loaded'}}});
  f.runtime.sendUserMessage(sid,'使用浏览器读取网页',{autoRun:true});await f.runtime.runHumanSession(sid);
  const dispatch=f.store.getSession(sid).metadata.botGoalDispatch;
  assert.equal(dispatch?.result.status,'waiting');
  assert.equal(f.store.getSession(dispatch.result.reference.slice(8)).metadata.taskRunMode,'browser');
});
test('a selected specialist is not reported completed without an actual dispatch [AC:bot-autonomous-execution-coverage#AC-4]',async t=>{
 const f=fixture(t,{name:'ignores-dispatch',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'Here is the finished product plan.'}]}},async completeText(){return JSON.stringify({met:true,advanced:true,reason:'Plan written',evidence:['Plan text']})},async summarizeMessages(){return ''}});
 f.runtime.sendUserMessage(f.sid,'交给规划子代理制定产品规划',{autoRun:true});await f.runtime.runHumanSession(f.sid);
 const [goal]=f.service.list(f.bot.id);
 assert.notEqual(goal.status,'completed');
 assert.match(goal.nextStep,/goal_dispatch/);
});
test('background execution after writer exit queues evidence without stale writes [AC:bot-autonomous-execution-coverage#AC-7]',async t=>{
 const f=fixture(t);const {startBackgroundJob}=await import('../dist/runtime/spawn-host.js');let finish;
 const host={store:f.store,repoRoot:f.dir,stateDir:join(f.dir,'state'),backgroundJobAborts:new Map(),sandbox:{kind:'native',execute:()=>new Promise(r=>finish=r)}};
 f.store.claimWriter(f.sid,'background-owner');
 const job=await f.store.runWithWriter(f.sid,'background-owner',()=>startBackgroundJob(host,f.sid,'printf evidence'));
 f.store.releaseWriter(f.sid,'background-owner');
 finish({stdout:'evidence',stderr:'',exitCode:0});await new Promise(r=>setTimeout(r,10));
 assert.equal(f.store.getBackgroundJob(job.id).status,'completed');
 assert.ok(f.store.claimInbox(f.sid,'next-step').some(i=>JSON.stringify(i).includes('evidence')));
});
test('cancel reaches a background command even after its model turn is idle [AC:bot-autonomous-execution-coverage#AC-7]',async t=>{
 const f=fixture(t);const {cancelSession}=await import('../dist/runtime/session-control.js');
 const job=f.store.createBackgroundJob({sessionId:f.sid,command:'sleep 30',status:'running'}),ac=new AbortController();
 cancelSession({store:f.store,sessionAbortControllers:new Map(),backgroundJobAborts:new Map([[job.id,ac]]),emitTrace(){}},f.sid);
 assert.equal(ac.signal.aborted,true);
});
test('Bot todo tool exposes the required item contract to real models [AC:bot-autonomous-execution-coverage#AC-1]',t=>{
 const f=fixture(t),schema=f.runtime.tools.find(t=>t.name==='TodoWrite').inputSchema;
 assert.deepEqual(schema.properties.items.items.required,['content','status','activeForm']);
 assert.deepEqual(schema.properties.items.items.properties.status.enum,['pending','in_progress','completed']);
});
test('verification as a final step does not turn simple file work into a specialist task [AC:bot-autonomous-execution-coverage#AC-1]',async()=>{
 const {goalSpecialist}=await import('../dist/bots/goals/routing.js');
 assert.equal(goalSpecialist('执行命令写文件，读取文件验证结果'),undefined);
 assert.equal(goalSpecialist('制定产品规划，给出三项验收条件'),'planner');
 assert.equal(goalSpecialist('审查这个模块的实现'),'evaluator');
});
