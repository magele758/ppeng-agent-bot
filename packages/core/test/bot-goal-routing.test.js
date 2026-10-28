import test from 'node:test';
import assert from 'node:assert/strict';
import { selectGoalRoute } from '../dist/bots/goals/routing.js';
import { createGoalExecutionAdapters } from '../dist/bots/goals/adapters.js';
const capabilities = { registeredTools: ['spawn_subagent','ptc_exec','bot_delegate','lab_team_plan_create','lab_team_plan_start','lab_swarm_run_create','lab_swarm_run_start'], enabledStrategies:['direct','subagent','bot_delegate','ptc','team_dag','swarm'], ptcEnabled:true, hasWorkspace:true };
test('automatically chooses executable strategy and explains choice [AC:bot-multi-goal-coordination#AC-5]', () => {
  assert.equal(selectGoalRoute({task:'Analyze independently',independentWork:true}, capabilities).strategy,'subagent');
  assert.equal(selectGoalRoute({task:'Aggregate readings',workKind:'batch'}, capabilities).strategy,'ptc');
  assert.equal(selectGoalRoute({task:'Implement dependent changes',workKind:'dependency_plan'}, capabilities).strategy,'team_dag');
  assert.equal(selectGoalRoute({task:'Review through roles',workKind:'role_pipeline'}, capabilities).strategy,'swarm');
  assert.ok(selectGoalRoute({task:'Explain error'}, capabilities).reason);
});
test('unavailable or forbidden routes fall back without widening permissions [AC:bot-multi-goal-coordination#AC-6]', () => {
  const route=selectGoalRoute({task:'Aggregate',workKind:'batch'}, {...capabilities,ptcEnabled:false});
  assert.equal(route.strategy,'direct'); assert.match(route.reason,/ptc/);
  assert.equal(selectGoalRoute({task:'Work',requiredTools:['bash']},capabilities).blocked,true);
  assert.equal(selectGoalRoute({task:'Work',independentWork:true}, {...capabilities,allowedTools:[]}).blocked,true);
  assert.equal(selectGoalRoute({task:'Work'}, {...capabilities,budgetRemaining:0}).blocked,false);
});
test('adapters dispatch real tool sequences and preserve run references [AC:bot-multi-goal-coordination#AC-5]',async()=>{
 const calls=[];
 const host={getCapabilities:()=>capabilities,runSessionExecution:async req=>({status:'candidate_completed',reference:'session-1',content:req.task}),invokeAuthorizedTool:async(name,args)=>{calls.push([name,args]);return {ok:true,content:JSON.stringify(name.includes('team')?{plan:{id:'plan-1'}}:{run:{id:'run-1'}})};}};
 const adapter=createGoalExecutionAdapters(host);
 const result=await adapter.start({goalId:'g1',revision:1,executionId:'e1',task:'build',workKind:'dependency_plan'});
 assert.equal(result.reference,'plan-1');assert.equal(result.status,'waiting');
 assert.deepEqual(calls.map(c=>c[0]),['lab_team_plan_create','lab_team_plan_start']);
 calls.length=0; await adapter.start({goalId:'g2',revision:1,executionId:'e2',task:'pipeline',workKind:'role_pipeline'});
 assert.equal(calls[0][1].strategy,'pipeline');assert.equal(calls[1][0],'lab_swarm_run_start');
});
test('dispatch revalidates live authorization and stops after failed creation [AC:bot-multi-goal-coordination#AC-6]',async()=>{
 let calls=0;
 const adapters=createGoalExecutionAdapters({getCapabilities:()=>({...capabilities,allowedTools:[]}),runSessionExecution:async()=>{throw Error('must not run')},invokeAuthorizedTool:async()=>{calls++;throw Error('must not run')}});
 const blocked=await adapters.start({goalId:'g',revision:1,executionId:'e',task:'parallel',independentWork:true});
 assert.equal(blocked.status,'blocked');assert.equal(calls,0);
 const failed=createGoalExecutionAdapters({getCapabilities:()=>capabilities,runSessionExecution:async()=>{throw Error('must not run')},invokeAuthorizedTool:async()=>{calls++;return {ok:false,content:'denied'}}});
 assert.equal((await failed.start({goalId:'g',revision:1,executionId:'e',task:'plan',workKind:'dependency_plan'})).status,'blocked');assert.equal(calls,1);
});
test('PTC receives execution-local configuration and Bot delegation keeps deduplication key',async()=>{
 const sessions=[],tools=[];
 const adapter=createGoalExecutionAdapters({getCapabilities:()=>capabilities,runSessionExecution:async req=>{sessions.push(req);return {status:'candidate_completed',reference:'isolated-session',content:'result'}},invokeAuthorizedTool:async(name,args)=>{tools.push({name,args});return {ok:true,content:JSON.stringify({id:'task-1'})}}});
 const req={goalId:'g',revision:3,executionId:'exec-stable',task:'read a batch',workKind:'batch'};
 const result=await adapter.start(req);
 assert.equal(result.status,'candidate_completed');
 assert.equal(sessions[0].metadata.orchestrationEngine,'ptc');assert.equal(sessions[0].metadata.goalRevision,3);
 assert.equal(req.metadata,undefined);
 const delegated=await adapter.start({...req,workKind:'general',delegateBotId:'bot-2'});
 assert.equal(delegated.status,'waiting');assert.equal(delegated.reference,'task-1');
 assert.deepEqual(tools[0],{name:'bot_delegate',args:{target:'bot-2',input:'read a batch',idempotencyKey:'exec-stable'}});
});
test('policy revocation between create and start prevents launching a plan',async()=>{
 let reads=0;const calls=[];
 const adapter=createGoalExecutionAdapters({getCapabilities:()=>++reads===1?capabilities:{...capabilities,allowedTools:[]},runSessionExecution:async()=>{throw Error('not used')},invokeAuthorizedTool:async(name)=>{calls.push(name);return {ok:true,content:JSON.stringify({plan:{id:'created-plan'}})}}});
 const result=await adapter.start({goalId:'g',revision:1,executionId:'e',task:'build',workKind:'dependency_plan'});
 assert.equal(result.status,'blocked');assert.equal(result.reference,'created-plan');assert.deepEqual(calls,['lab_team_plan_create']);
});
test('browser and computer modes require real available tools; specialty flows stay unavailable',()=>{
 assert.equal(selectGoalRoute({task:'Browse',workKind:'browser'},capabilities).blocked,true);
 assert.equal(selectGoalRoute({task:'Desktop',workKind:'computer'},capabilities).blocked,true);
 const browser=selectGoalRoute({task:'Browse',workKind:'browser'},{...capabilities,registeredTools:['browser_navigate']});
 assert.equal(browser.taskMode,'browser');assert.equal(browser.blocked,false);
 const specialty=selectGoalRoute({task:'Evolve',preferredStrategy:'evolution'},{...capabilities,enabledStrategies:[...capabilities.enabledStrategies,'evolution']});
 assert.equal(specialty.blocked,true);assert.equal(specialty.strategy,undefined);assert.match(specialty.reason,/unavailable|not enabled/);
});
test('goal dispatch tool binds to current goal and never accepts cross-goal identity',async()=>{
 const {createGoalDispatchTool}=await import('../dist/bots/goals/dispatch-tool.js');
 const calls=[];
 const tool=createGoalDispatchTool({resolveRequest:()=>({goalId:'current-goal',revision:2,executionId:'current-exec',task:'current task'}),getCapabilities:()=>capabilities,runSessionExecution:async()=>({status:'progress',content:'ok'}),invokeAuthorizedTool:async(ctx,name,args,req)=>{calls.push({ctx,name,args,req});return {ok:true,content:JSON.stringify({id:'delegated'})}}});
 const context={session:{metadata:{goalId:'current-goal'}}};
 assert.equal((await tool.execute(context,{goalId:'other',preferredStrategy:'bot_delegate',delegateBotId:'b'})).ok,false);
 assert.equal(calls.length,0);
 const result=await tool.execute(context,{preferredStrategy:'bot_delegate',delegateBotId:'b'});
 assert.equal(result.ok,true);assert.equal(calls[0].req.goalId,'current-goal');assert.equal(calls[0].ctx,context);
 assert.equal(calls[0].args.idempotencyKey,'current-exec');
});
test('uncertain start retains created run reference for reconciliation',async()=>{
 const adapter=createGoalExecutionAdapters({getCapabilities:()=>capabilities,runSessionExecution:async()=>{throw Error('not used')},invokeAuthorizedTool:async name=>{if(name==='lab_team_plan_create')return {ok:true,content:JSON.stringify({plan:{id:'possibly-started'}})};throw Error('network disconnected after start')}});
 const result=await adapter.start({goalId:'g',revision:1,executionId:'e',task:'build',workKind:'dependency_plan'});
 assert.equal(result.status,'blocked');assert.equal(result.reference,'possibly-started');assert.match(result.content,/reconciliation/);
});
test('adapter approval wait remains waiting rather than failed goal',async()=>{
 const adapter=createGoalExecutionAdapters({getCapabilities:()=>capabilities,runSessionExecution:async()=>{throw Error('not used')},invokeAuthorizedTool:async()=>({ok:false,content:'approval needed',waitingApproval:true})});
 const result=await adapter.start({goalId:'g',revision:1,executionId:'e',task:'build',workKind:'dependency_plan'});
 assert.equal(result.status,'waiting');assert.equal(result.waitingApproval,true);
});
