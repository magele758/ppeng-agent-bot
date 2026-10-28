import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { observeGoalBudget, preserveGoalBudgetReport } from '../dist/bots/goals/budget.js';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'goal-budget-'));const store=new SqliteStateStore(join(dir,'db'));t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});const parent=store.createSession({mode:'chat',agentId:'general',title:'bot',metadata:{botId:'b',canonicalBotChat:true,usageCostUsd:20}});const service=new BotGoalService(store,Date.now,parent.id);service.updateSettings({defaultBudgetUsd:1});const goal=service.create({botId:'b',sessionId:parent.id,title:'work',objective:'work'});const e=service.claim('b',goal.id,{strategy:'direct'});service.updateExecution('b',e.id,{sessionId:parent.id});store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalId:goal.id,botGoalExecutionId:e.id,botGoalScopeSessionId:parent.id,botGoalCostStart:20}});const cancelled=[];const host={store,isRunning:()=>true,cancel:id=>cancelled.push(id),run:async()=>{},capabilities:()=>({registeredTools:[],enabledStrategies:['direct']})};return {store,parent,service,goal,e,host,cancelled};}
test('spent budget does not cancel the session or block the goal [AC:bot-multi-goal-coordination#AC-13]',async t=>{
 const {store,parent,service,goal,e,host,cancelled}=setup(t);const hook=observeGoalBudget(host,parent.id);await hook({type:'model_done'});assert.equal(cancelled.length,0);store.updateSession(parent.id,{metadata:{...store.getSession(parent.id).metadata,usageCostUsd:21.1}});await hook({type:'model_done'});assert.deepEqual(cancelled,[]);assert.equal(service.get('b',goal.id).status,'running');assert.equal(service.get('b',goal.id).blockedReason,undefined);
 const report=preserveGoalBudgetReport(host,parent.id,{kind:'candidate_completed',summary:'done',verified:true,evidence:['done'],costUsd:1.1});assert.equal(report.kind,'candidate_completed');service.report('b',e.id,report);const saved=service.get('b',goal.id);assert.equal(saved.status,'completed');assert.equal(saved.costUsd,1.1);assert.equal(saved.attempts,1);assert.deepEqual(cancelled,[]);
});
test('isolated worker spend does not stop the parent [AC:bot-multi-goal-coordination#AC-13]',async t=>{
 const {store,parent,service,goal,e,host,cancelled}=setup(t);const worker=store.createSession({title:'worker',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{botId:'b',botGoalId:goal.id,botGoalScopeSessionId:parent.id,botGoalWorker:true,usageCostUsd:1.2}});store.createSession({title:'unrelated',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{usageCostUsd:100}});store.updateSession(parent.id,{metadata:{...store.getSession(parent.id).metadata,botGoalAuthorizedWaits:[{goalId:goal.id,executionId:e.id,source:'session',correlationId:worker.id}]}});await observeGoalBudget(host,worker.id)({type:'model_done'});assert.equal(service.get('b',goal.id).status,'running');assert.deepEqual(cancelled,[]);assert.equal(store.getSession(parent.id).metadata.botGoalBudgetExceeded,undefined);
});
test('over-budget observation leaves an external wait running [AC:bot-multi-goal-coordination#AC-13]',async t=>{
 const {store,parent,service,goal,e,host,cancelled}=setup(t);
 const worker=store.createSession({title:'worker',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{botId:'b',botGoalId:goal.id,botGoalScopeSessionId:parent.id,botGoalWorker:true,usageCostUsd:1.2}});
 store.updateSession(parent.id,{metadata:{...store.getSession(parent.id).metadata,botGoalAuthorizedWaits:[{goalId:goal.id,executionId:e.id,source:'session',correlationId:worker.id}]}});
 service.report('b',e.id,{kind:'waiting',summary:'Working externally',wait:{source:'session',correlationId:worker.id}});
 await observeGoalBudget(host,worker.id)({type:'model_done'});
 const waiting=service.get('b',goal.id);assert.equal(waiting.status,'waiting');assert.notEqual(waiting.draining,true);assert.equal(waiting.wait.correlationId,worker.id);assert.deepEqual(cancelled,[]);
});
