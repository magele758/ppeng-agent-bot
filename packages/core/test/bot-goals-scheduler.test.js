import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'goal-scheduler-'));const store=new SqliteStateStore(join(dir,'db'));t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});const parent=store.createSession({title:'Bot',mode:'chat',agentId:'general',metadata:{canonicalBotChat:true,botId:'b',permissionMode:'ask',allowedTools:['read_file','spawn_subagent'],userId:'owner'}});const service=new BotGoalService(store,Date.now,parent.id);const runs=[],cancelled=[],running=new Set();const host={store,deadSessions:new Set(),isRunning:id=>running.has(id),cancel:id=>{cancelled.push(id);running.delete(id);},run:id=>{runs.push(id);running.add(id);return new Promise(()=>{});},capabilities:()=>({registeredTools:['spawn_subagent','read_file'],enabledStrategies:['direct','subagent']}),executionInterrupted:id=>host.deadSessions.has(id)};const create=(extra={})=>service.create({botId:'b',sessionId:parent.id,title:'Fix',objective:'Fix',...extra});return {store,parent,service,host,create,runs,cancelled,running};}
test('resume dispatch is single and keeps parent authority [AC:bot-multi-goal-coordination#AC-9]',async t=>{
 const {service,host,create,runs,store,parent}=fixture(t);const g=create();const e=service.claim('b',g.id,{strategy:'direct'});service.report('b',e.id,{kind:'blocked',summary:'waiting for user'});service.control('b',g.id,'resume');
 await tickBotGoals(host);await tickBotGoals(host);assert.equal(runs.length,1);const child=store.getSession(runs[0]);assert.equal(child.parentSessionId,parent.id);assert.equal(child.metadata.permissionMode,'ask');assert.deepEqual(child.metadata.allowedTools,['read_file','spawn_subagent']);assert.equal(child.metadata.botGoalId,g.id);assert.equal(service.get('b',g.id).status,'running');
});
test('original human task stays with normal main-session dispatch',async t=>{
 const {host,create,runs}=fixture(t);create({sourceMessageId:'original'});await tickBotGoals(host);assert.deepEqual(runs,[]);
});
test('stopped cancelled executions drain without restart [AC:bot-multi-goal-coordination#AC-12]',async t=>{
 const {host,create,service,store,parent,cancelled,running,runs}=fixture(t);const g=create();const child=store.createSession({title:'worker',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:parent.metadata.userId,botId:'b',botGoalId:g.id,botGoalScopeSessionId:parent.id}});const e=service.claim('b',g.id,{strategy:'subagent'});service.updateExecution('b',e.id,{sessionId:child.id});running.add(child.id);service.control('b',g.id,'cancel');await tickBotGoals(host);await tickBotGoals(host);assert.ok(cancelled.includes(child.id));assert.equal(service.get('b',g.id).draining,false);assert.equal(service.get('b',g.id).status,'cancelled');assert.equal(runs.length,0);
});
test('authorized completed child wakes goal but guessed foreign refs do not [AC:bot-multi-goal-coordination#AC-8]',async t=>{
 const {host,create,service,store,parent,runs}=fixture(t);const g=create();const child=store.createSession({title:'result',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:parent.metadata.userId,botId:'b',botGoalId:g.id,botGoalScopeSessionId:parent.id}});store.updateSession(child.id,{status:'idle',metadata:{...child.metadata,outcome:{kind:'completed'}}});const e=service.claim('b',g.id,{strategy:'subagent'});service.updateExecution('b',e.id,{sessionId:parent.id});store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalAuthorizedWaits:[{goalId:g.id,source:'session',correlationId:child.id}]}});service.report('b',e.id,{kind:'waiting',summary:'wait',wait:{source:'session',correlationId:child.id}});await tickBotGoals(host);assert.equal(runs.length,1);
 const foreign=create({title:'Other'});const e2=service.claim('b',foreign.id,{strategy:'direct'});service.report('b',e2.id,{kind:'waiting',summary:'wait',wait:{source:'session',correlationId:child.id}});await tickBotGoals(host);assert.equal(service.get('b',foreign.id).status,'blocked');assert.equal(runs.length,1);
});
test('running and approval-wait executions renew their leases',async t=>{
 const {host,create,service,store,parent,running}=fixture(t);
 for(const approval of [false,true]){const g=create();const child=store.createSession({title:'worker',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:parent.metadata.userId,botId:'b',botGoalId:g.id,botGoalScopeSessionId:parent.id}});if(approval)store.updateSession(child.id,{status:'waiting_approval'});else running.add(child.id);const e=service.claim('b',g.id,{strategy:'subagent',leaseMs:10000});service.updateExecution('b',e.id,{sessionId:child.id});await tickBotGoals(host);assert.ok(service.executions('b',g.id)[0].leaseUntil>e.leaseUntil);assert.equal(service.get('b',g.id).status,'running');}
});
test('real Swarm completion wakes only its recorded goal',async t=>{
 const {host,create,service,store,parent,runs}=fixture(t);const g=create();const e=service.claim('b',g.id,{strategy:'swarm'});service.updateExecution('b',e.id,{sessionId:parent.id});
 const now=new Date().toISOString();store.swarm().createRun({id:'swarm-test',goal:'work',status:'completed',strategy:'pipeline',budget:{},qualityGate:{},createdAt:now,updatedAt:now});
 store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalAuthorizedWaits:[{goalId:g.id,source:'swarm',correlationId:'swarm-test'}]}});service.report('b',e.id,{kind:'waiting',summary:'wait pipeline',wait:{source:'swarm',correlationId:'swarm-test'}});await tickBotGoals(host);assert.equal(runs.length,1);await tickBotGoals(host);assert.equal(runs.length,1);
});
test('a failed child retries inside the attempt budget instead of ending the goal [AC:bot-multi-goal-coordination#AC-7] [AC:bot-multi-goal-coordination#AC-13]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  const goal = create({ title: 'Write beta' });
  const child = store.createSession({ title: 'beta worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id, outcome: { kind: 'failed' } } });
  store.updateSession(child.id, { status: 'failed' });
  store.appendMessage(child.id, 'assistant', [{ type: 'text', text: 'first write failed' }]);
  const execution = service.claim('b', goal.id, { strategy: 'subagent' });
  service.updateExecution('b', execution.id, { sessionId: parent.id, runRef: `session:${child.id}` });
  await tickBotGoals(host);
  const saved = service.get('b', goal.id);
  assert.equal(saved.status, 'running');
  assert.equal(saved.attempts, 2);
  assert.match(saved.progress, /first write failed/);
  assert.match(saved.nextStep, /Retry the failed child work/);
  assert.equal(saved.evidence.length, 1);
  assert.equal(runs.length, 1);
  await tickBotGoals(host);
  assert.equal(runs.length, 1);
  assert.notEqual(service.get('b', goal.id).status, 'failed');
});

test('a nested approval stays on the waiting goal until the person decides [AC:bot-goal-nested-approval#AC-1]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  const goal = create({ title: 'Write beta' });
  const child = store.createSession({ title: 'beta worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id, outcome: { kind: 'idle' } } });
  store.updateSession(child.id, { status: 'idle' });
  const nested = store.createSession({ title: 'beta grandchild', mode: 'subagent', agentId: 'general', parentSessionId: child.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id } });
  store.updateSession(nested.id, { status: 'waiting_approval' });
  store.createApproval({ sessionId: nested.id, toolName: 'bash', reason: 'Approval required for bash', args: { command: 'rm -rf wrong-path' } });
  const execution = service.claim('b', goal.id, { strategy: 'subagent' });
  service.updateExecution('b', execution.id, { sessionId: parent.id });
  store.updateSession(parent.id, { metadata: { ...parent.metadata, botGoalAuthorizedWaits: [{ goalId: goal.id, source: 'session', correlationId: child.id }] } });
  service.report('b', execution.id, { kind: 'waiting', summary: 'child started', wait: { source: 'session', correlationId: child.id } });
  await tickBotGoals(host);
  const waiting = service.get('b', goal.id);
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.nextStep, /approval of bash/i);
  assert.equal(runs.length, 0);
  const pending = store.listApprovals({ status: 'pending' }).find(item => item.sessionId === nested.id);
  store.updateApproval(pending.id, 'approved');
  store.updateSession(nested.id, { status: 'idle', metadata: { ...store.getSession(nested.id).metadata, outcome: { kind: 'completed' } } });
  store.updateSession(child.id, { status: 'idle', metadata: { ...store.getSession(child.id).metadata, outcome: { kind: 'completed' } } });
  store.appendMessage(child.id, 'assistant', [{ type: 'text', text: 'beta written after approval' }]);
  await tickBotGoals(host);
  const resumed = service.get('b', goal.id);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.attempts, 2);
  assert.ok(resumed.evidence.some(item => item.includes('beta written after approval')));
  assert.match(resumed.nextStep ?? '', /Inspect authorized session result/);
  assert.equal(runs.length, 1);
  await tickBotGoals(host);
  assert.equal(runs.length, 1);
});

test('a goal waiting on nested approval is not requeued when its direct child looks dead [AC:bot-goal-nested-approval#AC-1] [AC:bot-multi-goal-coordination#AC-9]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  const goal = create({ title: 'Write beta' });
  const child = store.createSession({ title: 'beta worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id } });
  store.updateSession(child.id, { status: 'running' });
  const nested = store.createSession({ title: 'beta grandchild', mode: 'subagent', agentId: 'general', parentSessionId: child.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id } });
  store.updateSession(nested.id, { status: 'waiting_approval' });
  store.createApproval({ sessionId: nested.id, toolName: 'bash', reason: 'Approval required for bash', args: { command: 'rm -rf wrong-path' } });
  const execution = service.claim('b', goal.id, { strategy: 'subagent', safeToRetry: true });
  service.updateExecution('b', execution.id, { sessionId: child.id, runRef: `session:${child.id}` });
  const snap = store.getDaemonControl('bot_goals:b');
  const goalRow = snap.goals.find(item => item.id === goal.id);
  goalRow.status = 'waiting';
  goalRow.wait = { source: 'session', correlationId: child.id };
  goalRow.activeExecutionId = undefined;
  store.setDaemonControl('bot_goals:b', snap);
  const childLive = store.getSession(child.id);
  store.updateSession(child.id, { metadata: { ...childLive.metadata, botGoalAuthorizedWaits: [{ goalId: goal.id, executionId: execution.id, source: 'session', correlationId: child.id }] } });
  host.deadSessions.add(child.id);
  await tickBotGoals(host);
  const saved = service.get('b', goal.id);
  assert.equal(saved.status, 'waiting');
  assert.match(saved.nextStep, /approval of bash/i);
  assert.equal(service.executions('b', goal.id).find(item => item.id === execution.id).status, 'running');
  assert.equal(runs.length, 0);
});

test('an unknown child is reconciled instead of retried [AC:bot-multi-goal-coordination#AC-9]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  const goal = create();
  const child = store.createSession({ title: 'unknown worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id } });
  store.updateSession(child.id, { status: 'unknown' });
  const execution = service.claim('b', goal.id, { strategy: 'subagent' });
  service.updateExecution('b', execution.id, { sessionId: parent.id, runRef: `session:${child.id}` });
  await tickBotGoals(host);
  assert.equal(service.get('b', goal.id).status, 'blocked');
  assert.match(service.get('b', goal.id).blockedReason, /unknown|reconcil/i);
  assert.equal(runs.length, 0);
});

test('restart settles an unknown child the way boot recovery leaves it [AC:bot-multi-goal-coordination#AC-9]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  delete host.executionInterrupted;
  const external = create({ title: 'Deploy' });
  const child = store.createSession({ title: 'deploy worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: external.id, botGoalScopeSessionId: parent.id } });
  store.updateSession(child.id, { status: 'unknown', metadata: { ...store.getSession(child.id).metadata, subagentDisposition: 'unknown' } });
  const execution = service.claim('b', external.id, { strategy: 'subagent' });
  service.updateExecution('b', execution.id, { sessionId: child.id, runRef: `session:${child.id}` });
  await tickBotGoals(host);
  assert.equal(service.get('b', external.id).status, 'blocked');
  assert.equal(service.get('b', external.id).attempts, 1);
  assert.match(service.get('b', external.id).blockedReason, /interrupted|reconcil|verify|unknown/i);
  assert.equal(service.executions('b', external.id).find(item => item.id === execution.id).status, 'interrupted');
  assert.equal(runs.length, 0);
  await tickBotGoals(host);
  assert.equal(runs.length, 0);
  assert.equal(service.get('b', external.id).status, 'blocked');
});

test('restart settles a dead execution and resumes only safe local work [AC:bot-multi-goal-coordination#AC-9]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  const safe = create({ title: 'Local file' });
  const safeChild = store.createSession({ title: 'local worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: safe.id, botGoalScopeSessionId: parent.id } });
  const safeExecution = service.claim('b', safe.id, { strategy: 'direct', safeToRetry: true });
  service.updateExecution('b', safeExecution.id, { sessionId: safeChild.id, runRef: `session:${safeChild.id}` });
  const external = create({ title: 'Deploy' });
  const externalChild = store.createSession({ title: 'deploy worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: external.id, botGoalScopeSessionId: parent.id } });
  const externalExecution = service.claim('b', external.id, { strategy: 'subagent' });
  service.updateExecution('b', externalExecution.id, { sessionId: externalChild.id, runRef: `session:${externalChild.id}` });
  host.deadSessions = new Set([safeChild.id, externalChild.id]);
  await tickBotGoals(host);
  assert.equal(service.get('b', safe.id).status, 'running');
  assert.equal(service.get('b', safe.id).attempts, 2);
  assert.equal(service.get('b', external.id).status, 'blocked');
  assert.equal(service.get('b', external.id).attempts, 1);
  assert.match(service.get('b', external.id).blockedReason, /interrupted|reconcil|verify/i);
  assert.equal(runs.length, 1);
  await tickBotGoals(host);
  assert.equal(runs.length, 1);
  assert.equal(service.get('b', external.id).status, 'blocked');
});

test('a deferred source-message child starts when capacity is released',async t=>{
 const {host,create,service,store,parent,runs}=fixture(t);service.updateSettings({maxConcurrent:1});const busy=create();await tickBotGoals(host);assert.equal(runs.length,1);
 const deferred=create({sourceMessageId:'source-2'});store.createSession({title:'deferred',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{botId:'b',botGoalId:deferred.id,botGoalScopeSessionId:parent.id}});
 await tickBotGoals(host);assert.equal(runs.length,1);const e=service.executions('b',busy.id)[0];service.report('b',e.id,{kind:'candidate_completed',summary:'done',verified:true,evidence:['checked']});await tickBotGoals(host);assert.equal(runs.length,2);assert.equal(service.get('b',deferred.id).status,'running');
});
test('cancelling waiting swarm stops future work and drains workers without resurrection [AC:bot-multi-goal-coordination#AC-12]',async t=>{
 const {host,create,service,store,parent,runs,running,cancelled}=fixture(t);const g=create();const e=service.claim('b',g.id,{strategy:'swarm'});service.updateExecution('b',e.id,{sessionId:parent.id});const now=new Date().toISOString();store.swarm().createRun({id:'cancel-swarm',goal:'work',status:'running',strategy:'pipeline',budget:{},qualityGate:{},createdAt:now,updatedAt:now});const worker=store.createSession({title:'swarm worker',mode:'subagent',agentId:'general',metadata:{swarmRunId:'cancel-swarm'}});running.add(worker.id);store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalAuthorizedWaits:[{goalId:g.id,source:'swarm',correlationId:'cancel-swarm'}]}});service.report('b',e.id,{kind:'waiting',summary:'waiting',wait:{source:'swarm',correlationId:'cancel-swarm'}});service.control('b',g.id,'cancel');assert.equal(service.get('b',g.id).draining,true);await tickBotGoals(host);assert.equal(store.swarm().getRun('cancel-swarm').status,'cancelled');assert.ok(cancelled.includes(worker.id));assert.equal(service.get('b',g.id).draining,false);await tickBotGoals(host);assert.equal(runs.length,0);assert.equal(service.get('b',g.id).status,'cancelled');
});
test('completed isolated work contributes evidence and cost once before continuation [AC:bot-multi-goal-coordination#AC-13]',async t=>{
 const {host,create,service,store,parent,runs}=fixture(t);const g=create();const child=store.createSession({title:'result',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{botId:'b',botGoalId:g.id,botGoalScopeSessionId:parent.id,usageCostUsd:11}});store.updateSession(child.id,{status:'idle',metadata:{...child.metadata,outcome:{kind:'completed'}}});store.appendMessage(child.id,'assistant',[{type:'text',text:'Observed build result: passed'}]);const e=service.claim('b',g.id,{strategy:'ptc'});service.updateExecution('b',e.id,{sessionId:parent.id});store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalAuthorizedWaits:[{goalId:g.id,source:'session',correlationId:child.id}]}});service.report('b',e.id,{kind:'waiting',summary:'wait',wait:{source:'session',correlationId:child.id}});await tickBotGoals(host);const saved=service.get('b',g.id);assert.equal(saved.costUsd,11);assert.equal(saved.status,'pending_review');assert.ok(saved.evidence.some(x=>x.includes('build result')));assert.equal(runs.length,0);await tickBotGoals(host);assert.equal(service.get('b',g.id).costUsd,11);
});
test('resolved nested approval resumes same execution once; rejection blocks it',async t=>{
 const {host,create,service,store,parent,runs}=fixture(t);
 for(const decision of ['approved','rejected']) {
  const g=create();const child=store.createSession({title:'approval',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:parent.metadata.userId,botId:'b',botGoalId:g.id,botGoalScopeSessionId:parent.id}});const e=service.claim('b',g.id,{strategy:'swarm'});service.updateExecution('b',e.id,{sessionId:child.id});
  store.updateSession(child.id,{status:'waiting_approval',metadata:{...child.metadata,botGoalExecutionId:e.id,botGoalDispatch:{executionId:e.id,request:{preferredStrategy:'swarm'},result:{waitingApproval:true}}}});
  store.setDaemonControl(`bot.goal-tool-ledger:${child.id}:${e.id}`,[{role:'assistant',parts:[{type:'tool_call',toolCallId:`${e.id}:launch`,name:'launch',input:{run:g.id}}]},{role:'tool',parts:[{type:'tool_result',toolCallId:`${e.id}:launch`,name:'launch',ok:false,content:JSON.stringify({status:'goal_dispatch_waiting_approval',tool:'launch'})}]}]);
  const approval=store.createApproval({sessionId:child.id,toolName:'launch',reason:'Launch requires approval',args:{run:g.id}});await tickBotGoals(host);assert.ok(!runs.includes(child.id));store.updateApproval(approval.id,decision);store.updateSession(child.id,{status:'idle'});await tickBotGoals(host);await tickBotGoals(host);
  if(decision==='approved'){assert.equal(runs.filter(x=>x===child.id).length,1);assert.equal(service.get('b',g.id).activeExecutionId,e.id);}else{assert.ok(!runs.includes(child.id));assert.equal(service.get('b',g.id).status,'blocked');}
 }
});
test('amending a waiting external goal drains old revision before replacement dispatch [AC:bot-multi-goal-coordination#AC-3]',async t=>{
 const {host,create,service,store,parent,runs,running,cancelled}=fixture(t);host.cancel=id=>cancelled.push(id);
 const g=create();const worker=store.createSession({title:'old worker',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:parent.metadata.userId,botId:'b',botGoalId:g.id,botGoalScopeSessionId:parent.id}});running.add(worker.id);const e=service.claim('b',g.id,{strategy:'subagent'});service.updateExecution('b',e.id,{sessionId:parent.id});store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalAuthorizedWaits:[{goalId:g.id,source:'session',correlationId:worker.id}]}});service.report('b',e.id,{kind:'waiting',summary:'worker running',wait:{source:'session',correlationId:worker.id}});service.amend('b',g.id,'Do not change styling');
 assert.equal(service.get('b',g.id).draining,true);assert.equal(service.claim('b',g.id,{strategy:'direct'}),undefined);await tickBotGoals(host);assert.ok(cancelled.includes(worker.id));assert.equal(runs.length,0);
 running.delete(worker.id);store.appendMessage(worker.id,'assistant',[{type:'text',text:'Old partial work preserved'}]);await tickBotGoals(host);assert.equal(runs.length,1);assert.equal(service.get('b',g.id).revision,2);assert.deepEqual(service.get('b',g.id).constraints,['Do not change styling']);assert.ok(service.get('b',g.id).evidence.some(x=>x.includes('Old partial')));assert.equal(service.get('b',g.id).wait,undefined);
 service.report('b',e.id,{kind:'candidate_completed',verified:true,evidence:['old result'],summary:'old completed'});assert.equal(service.get('b',g.id).status,'running');
});
test('a newly created idle child is not settled when its parent stops',async t=>{
 const {host,create,service,store,parent}=fixture(t);const g=create();const child=store.createSession({title:'fresh',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:parent.metadata.userId,botId:'b',botGoalId:g.id,botGoalScopeSessionId:parent.id}});store.appendMessage(child.id,'assistant',[{type:'text',text:'not a finished result'}]);const e=service.claim('b',g.id,{strategy:'subagent'});service.updateExecution('b',e.id,{sessionId:parent.id,runRef:`session:${child.id}`});store.updateSession(parent.id,{status:'idle'});await tickBotGoals(host);assert.equal(service.get('b',g.id).status,'running');assert.equal(service.executions('b',g.id)[0].status,'running');
});
test('finished child text stays unverified until the completion judge accepts it',async t=>{
 const {host,create,service,store,parent,running}=fixture(t);host.judge=async()=>JSON.stringify({met:false,advanced:false,reason:'Still missing the required check',evidence:['judge saw the form']});const g=create();const child=store.createSession({title:'finished',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:parent.metadata.userId,botId:'b',botGoalId:g.id,botGoalScopeSessionId:parent.id}});store.appendMessage(child.id,'assistant',[{type:'text',text:'I finished the form'}]);store.updateSession(child.id,{status:'idle',metadata:{...store.getSession(child.id).metadata,outcome:{kind:'completed'}}});const e=service.claim('b',g.id,{strategy:'subagent'});service.updateExecution('b',e.id,{sessionId:parent.id,runRef:`session:${child.id}`});store.updateSession(parent.id,{status:'idle'});host.isRunning=()=>false;await tickBotGoals(host);const settled=service.get('b',g.id);const settledExecution=service.executions('b',g.id).find(item=>item.id===e.id);assert.equal(settledExecution.status,'finished');assert.notEqual(settled.status,'completed');assert.match(settled.progress,/missing the required check/);assert.ok(settled.evidence.includes('judge saw the form'));
});
function finishedChild(store,parent,goal,text){const child=store.createSession({title:'finished',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:parent.metadata.userId,botId:'b',botGoalId:goal.id,botGoalScopeSessionId:parent.id}});store.appendMessage(child.id,'assistant',[{type:'text',text}]);store.updateSession(child.id,{status:'idle',metadata:{...store.getSession(child.id).metadata,outcome:{kind:'completed'}}});return child;}
test('a finished child stays pending verification when the completion judge throws [AC:bot-goal-conclusion#AC-5]',async t=>{
 const {host,create,service,store,parent,runs}=fixture(t);host.judge=async()=>{throw new Error('judge down');};const g=create();const child=finishedChild(store,parent,g,'Observed result: done');const e=service.claim('b',g.id,{strategy:'subagent'});service.updateExecution('b',e.id,{sessionId:parent.id,runRef:`session:${child.id}`});store.updateSession(parent.id,{status:'idle'});host.isRunning=()=>false;await tickBotGoals(host);const settled=service.get('b',g.id);assert.equal(service.executions('b',g.id).find(item=>item.id===e.id).status,'finished');assert.equal(settled.status,'pending_review');assert.notEqual(settled.status,'blocked');assert.match(settled.blockedReason,/verification/i);assert.match(settled.progress,/Observed result/);assert.ok(settled.evidence.some(item=>item.includes('Observed result')));assert.equal(settled.activeExecutionId,undefined);assert.deepEqual(runs,[]);await tickBotGoals(host);assert.deepEqual(runs,[]);assert.equal(service.get('b',g.id).status,'pending_review');assert.equal(service.get('b',g.id).noProgress,0);assert.throws(()=>service.control('b',g.id,'resume'),/pending verification/);assert.equal(service.get('b',g.id).status,'pending_review');
});
test('a finished child stays pending verification when no completion judge is available [AC:bot-goal-conclusion#AC-5]',async t=>{
 const {host,create,service,store,parent,runs}=fixture(t);const g=create();const child=finishedChild(store,parent,g,'Observed result: done');const e=service.claim('b',g.id,{strategy:'subagent'});service.updateExecution('b',e.id,{sessionId:parent.id,runRef:`session:${child.id}`});store.updateSession(parent.id,{status:'idle'});host.isRunning=()=>false;await tickBotGoals(host);const settled=service.get('b',g.id);assert.equal(service.executions('b',g.id).find(item=>item.id===e.id).status,'finished');assert.equal(settled.status,'pending_review');assert.notEqual(settled.status,'blocked');assert.match(settled.blockedReason,/verification/i);assert.match(settled.progress,/Observed result/);assert.ok(settled.evidence.some(item=>item.includes('Observed result')));assert.equal(settled.activeExecutionId,undefined);assert.deepEqual(runs,[]);await tickBotGoals(host);await tickBotGoals(host);await tickBotGoals(host);assert.deepEqual(runs,[]);assert.equal(service.get('b',g.id).status,'pending_review');assert.equal(service.get('b',g.id).noProgress,0);
});
test('pending completion is consumed by verification and is not resumed as a new task [AC:bot-goal-conclusion#AC-5]',async t=>{
 const {host,create,service,store,parent,runs}=fixture(t);const g=create();const child=finishedChild(store,parent,g,'Observed result: done');const e=service.claim('b',g.id,{strategy:'subagent'});service.updateExecution('b',e.id,{sessionId:parent.id,runRef:`session:${child.id}`});store.updateSession(parent.id,{status:'idle'});host.isRunning=()=>false;await tickBotGoals(host);const pending=service.get('b',g.id);assert.equal(pending.status,'pending_review');assert.throws(()=>service.control('b',g.id,'resume'),/pending verification/);assert.equal(service.get('b',g.id).status,'pending_review');assert.deepEqual(runs,[]);const accepted=service.control('b',g.id,'verify',{accepted:true});assert.equal(accepted.status,'completed');assert.ok(accepted.evidence.some(item=>item.includes('Observed result')));assert.equal(accepted.blockedReason,undefined);await tickBotGoals(host);assert.deepEqual(runs,[]);const other=create({title:'Rejected'});const child2=finishedChild(store,parent,other,'Observed result: partial');const e2=service.claim('b',other.id,{strategy:'subagent'});service.updateExecution('b',e2.id,{sessionId:parent.id,runRef:`session:${child2.id}`});await tickBotGoals(host);assert.equal(service.get('b',other.id).status,'pending_review');const rejected=service.control('b',other.id,'verify',{accepted:false,reason:'Missing the last check'});assert.equal(rejected.status,'queued');assert.match(rejected.nextStep,/Missing the last check/);assert.equal(rejected.resumeRequested,true);await tickBotGoals(host);assert.equal(runs.length,1);assert.equal(service.get('b',other.id).status,'running');
});
test('scheduler block announces one meaningful change without repeated wakes',async t=>{
 const {host,create,service,store,parent}=fixture(t);const g=create();const e=service.claim('b',g.id,{strategy:'direct'});service.report('b',e.id,{kind:'waiting',summary:'waiting unknown source',wait:{source:'unsupported',correlationId:'external'}});await tickBotGoals(host);assert.equal(service.get('b',g.id).status,'blocked');assert.deepEqual(store.dequeueSchedulerWakes(),[]);assert.equal(store.foldMessages(parent.id).filter(m=>m.parts.some(p=>p.text?.startsWith('[goal update]'))).length,1);await tickBotGoals(host);assert.deepEqual(store.dequeueSchedulerWakes(),[]);
});

test('an authorized background job wakes the original work once, with identity-checked evidence [AC:bot-linked-watchers#AC-7]',async t=>{
 const {host,service,store,parent,runs}=fixture(t);
 const g=service.create({botId:'b',sessionId:parent.id,title:'Develop then review',objective:'Develop then review and merge'}),e=service.claim('b',g.id,{strategy:'direct'});
 service.updateExecution('b',e.id,{sessionId:parent.id});
 store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalId:g.id,botGoalExecutionId:e.id,botGoalScopeSessionId:parent.id}});
 const job=store.createBackgroundJob({sessionId:parent.id,command:'authorized background development',status:'running'});
 const {recordBackgroundWaitSource}=await import('../dist/waits/background-source.js');const {createWaitForTool}=await import('../dist/waits/tool.js');
 const spec=recordBackgroundWaitSource(store,parent.id,job);assert.equal(spec.ref,job.id);
 const registered=await createWaitForTool(store).execute({session:store.getSession(parent.id)},{...spec,summary:'Continue review after development'});assert.equal(registered.ok,true,registered.content);const wait={source:'durable_wait',correlationId:JSON.parse(registered.content).waitId};
 service.report('b',e.id,{kind:'waiting',summary:'development running',wait});
 await tickBotGoals(host);assert.equal(service.get('b',g.id).status,'waiting');assert.equal(runs.length,0);
 store.updateBackgroundJob(job.id,'completed','development result: commit abc123; review still required');
 await tickBotGoals(host);const next=service.get('b',g.id);assert.equal(next.status,'running');assert.equal(runs.length,1);assert.ok(next.evidence.some(item=>item.includes(job.id)));assert.match(next.nextStep,/Inspect authorized durable_wait result/);
 await tickBotGoals(host);assert.equal(runs.length,1);
});

test('background waits cannot borrow another job or revive cancelled work [AC:bot-linked-watchers#AC-1] [AC:bot-linked-watchers#AC-7]',async t=>{
 const {host,service,store,parent,runs}=fixture(t),{recordBackgroundWaitSource}=await import('../dist/waits/background-source.js');const {createWaitForTool}=await import('../dist/waits/tool.js');
 const g=service.create({botId:'b',sessionId:parent.id,title:'Background work',objective:'Ship'}),e=service.claim('b',g.id,{strategy:'direct'});service.updateExecution('b',e.id,{sessionId:parent.id});store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalId:g.id,botGoalExecutionId:e.id}});
 const foreign=store.createSession({title:'foreign',mode:'chat',agentId:'general',metadata:{userId:'else'}}),job=store.createBackgroundJob({sessionId:foreign.id,command:'foreign',status:'completed'});
 assert.equal(recordBackgroundWaitSource(store,parent.id,job),undefined);
 const owned=store.createBackgroundJob({sessionId:parent.id,command:'work',status:'running'}),spec=recordBackgroundWaitSource(store,parent.id,owned);const registered=await createWaitForTool(store).execute({session:store.getSession(parent.id)},{...spec,summary:'Continue after work'});assert.equal(registered.ok,true,registered.content);const wait={source:'durable_wait',correlationId:JSON.parse(registered.content).waitId};service.report('b',e.id,{kind:'waiting',summary:'running',wait});service.control('b',g.id,'cancel');
 await tickBotGoals(host);assert.equal(service.get('b',g.id).draining,true);assert.equal(runs.length,0);
 store.updateBackgroundJob(owned.id,'completed','done');await tickBotGoals(host);assert.equal(service.get('b',g.id).status,'cancelled');assert.equal(service.get('b',g.id).draining,false);assert.equal(runs.length,0);
});
test('changed background execution identity stays blocked across a durable-wait check [AC:bot-linked-watchers#AC-1] [AC:bot-linked-watchers#AC-7]',async t=>{
 const {host,service,store,parent,runs}=fixture(t),{recordBackgroundWaitSource}=await import('../dist/waits/background-source.js'),{createWaitForTool}=await import('../dist/waits/tool.js');
 const goal=service.create({botId:'b',sessionId:parent.id,title:'Original',objective:'deliver'}),e=service.claim('b',goal.id,{strategy:'direct'});service.updateExecution('b',e.id,{sessionId:parent.id});store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalId:goal.id,botGoalExecutionId:e.id}});
 const job=store.createBackgroundJob({sessionId:parent.id,command:'build',status:'running'}),spec=recordBackgroundWaitSource(store,parent.id,job),registered=await createWaitForTool(store).execute({session:store.getSession(parent.id)},{...spec,summary:'review after build'});
 assert.equal(registered.ok,true);service.report('b',e.id,{kind:'waiting',summary:'wait',wait:{source:'durable_wait',correlationId:JSON.parse(registered.content).waitId}});
 store.db.prepare("UPDATE background_jobs SET created_at=?,status='completed' WHERE id=?").run('2000-01-01T00:00:00.000Z',job.id);
 await tickBotGoals(host);assert.equal(runs.length,0);assert.notEqual(service.get('b',goal.id).status,'completed');assert.equal(service.get('b',goal.id).status,'waiting');assert.match(service.get('b',goal.id).nextStep,/identity changed/);
});
