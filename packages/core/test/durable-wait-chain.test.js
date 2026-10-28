import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {BotGoalService} from '../dist/bots/goals/service.js';
import {tickBotGoals} from '../dist/bots/goals/scheduler.js';
import {settleGoalExecution} from '../dist/bots/goals/runtime-host.js';
import {createWaitForTool} from '../dist/waits/tool.js';
import {DurableWaitStore} from '../dist/waits/index.js';
import {CronJobStore} from '../dist/cron/cron-store.js';
import {RoutineRunStore,drainRoutineRuns,cancelRoutineRun} from '../dist/cron/routine-runtime.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'wait-chain-'));let store=new SqliteStateStore(join(dir,'db'));t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});const parent=store.createSession({title:'owner',mode:'chat',agentId:'general',metadata:{userId:'alice',botId:'b',canonicalBotChat:true}});const child=store.createSession({title:'dependency',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:'alice',botId:'b'}});store.updateSession(child.id,{status:'running'});return {dir,parent,child,get store(){return store;},reopen(){store.db.close();store=new SqliteStateStore(join(dir,'db'));return store;}};}
async function registerWait(f,id,args){
 const callId='wait-'+Math.random();f.store.appendMessage(id,'assistant',[{type:'tool_call',toolCallId:callId,name:'wait_for',input:args}]);
 const out=await createWaitForTool(f.store).execute({session:f.store.getSession(id)},args);
 f.store.appendMessage(id,'tool',[{type:'tool_result',toolCallId:callId,name:'wait_for',...out}]);return out;
}
const args=f=>({source:'session',ref:f.child.id,condition:{op:'eq',field:'status',value:'completed'},summary:'Continue from saved checkpoint'});
function assigned(f){const service=new BotGoalService(f.store,Date.now,f.parent.id);const g=service.create({botId:'b',sessionId:f.parent.id,title:'Observe dependency',objective:'Verify result'});const e=service.claim('b',g.id,{strategy:'direct'});service.updateExecution('b',e.id,{sessionId:f.parent.id});f.store.updateSession(f.parent.id,{metadata:{...f.parent.metadata,botGoalId:g.id,botGoalExecutionId:e.id}});return {service,g,e};}
function goalHost(f,runs){return {store:f.store,isRunning:()=>false,cancel:()=>{},run:async id=>{runs.push(id);return new Promise(()=>{});},capabilities:()=>({registeredTools:['read_file'],enabledStrategies:['direct']})};}
test('real Goal settles into durable wait and scheduler resumes once after restart [AC:durable-agent-waits#AC-1]',async t=>{const f=fixture(t),{g}=assigned(f),calls=[];const result=await registerWait(f,f.parent.id,args(f));assert.equal(result.ok,true);await settleGoalExecution(goalHost(f,calls),f.parent.id);assert.equal(new BotGoalService(f.store,Date.now,f.parent.id).get('b',g.id).status,'waiting');f.reopen();for(let i=0;i<3;i++)await tickBotGoals(goalHost(f,calls));assert.equal(calls.length,0);f.store.updateSession(f.child.id,{status:'completed'});await tickBotGoals(goalHost(f,calls));await tickBotGoals(goalHost(f,calls));assert.equal(calls.length,1);const resumed=f.store.getSession(calls[0]);assert.equal(resumed.metadata.botGoalId,g.id);assert.equal(resumed.metadata.userId,'alice');});
test('cancel and changed goal revision invalidate passive waits [AC:durable-agent-waits#AC-3]',async t=>{for(const action of ['cancel','amend']){const f=fixture(t),{service,g}=assigned(f),calls=[];const out=await registerWait(f,f.parent.id,args(f));assert.equal(out.ok,true);const id=JSON.parse(out.content).waitId;await settleGoalExecution(goalHost(f,calls),f.parent.id);if(action==='cancel')service.control('b',g.id,'cancel');else service.amend('b',g.id,'New requirement');f.store.updateSession(f.child.id,{status:'completed'});await tickBotGoals(goalHost(f,calls));assert.equal(new DurableWaitStore(f.store).get(id).status,'cancelled');if(action==='cancel')assert.equal(calls.length,0);else assert.notEqual(service.get('b',g.id).progress,'Condition satisfied');}});
test('Routine resumes the same occurrence from wait evidence without replaying startup [AC:durable-agent-waits#AC-2]',async t=>{const f=fixture(t);const job=new CronJobStore(f.dir).create({sessionId:f.parent.id,agentId:'general',name:'Generic wait',prompt:'Start once',scheduleKind:'every_ms',scheduleValue:'60000',metadata:{botId:'b'}});const r=new RoutineRunStore(f.store).enqueue(job,new Date().toISOString());let calls=0;const host=()=>({store:f.store,stateDir:f.dir,log:{warn(){},info(){}},isSessionRunning:()=>false,runSession:async id=>{calls++;if(calls===1){const out=await registerWait(f,id,args(f));assert.equal(out.ok,true);}else f.store.appendMessage(id,'assistant',[{type:'text',text:'Resumed with evidence'}]);return f.store.getSession(id);}});await drainRoutineRuns(host());await new Promise(setImmediate);assert.equal(new RoutineRunStore(f.store).get(r.id).status,'waiting_condition');f.reopen();await drainRoutineRuns(host());assert.equal(calls,1);f.store.updateSession(f.child.id,{status:'completed'});await drainRoutineRuns(host());await new Promise(setImmediate);await drainRoutineRuns(host());assert.equal(calls,2);assert.equal(new RoutineRunStore(f.store).get(r.id).status,'completed');const messages=f.store.listMessages(f.parent.id);assert.equal(messages.filter(m=>m.parts.some(p=>p.text?.includes('Start once'))).length,1);assert.ok(messages.some(m=>m.parts.some(p=>p.text?.startsWith('[wait resumed]'))));});
test('cancelled Routine cannot resume from a late result [AC:durable-agent-waits#AC-3]',async t=>{const f=fixture(t);const job=new CronJobStore(f.dir).create({sessionId:f.parent.id,agentId:'general',name:'Generic',prompt:'Wait',scheduleKind:'every_ms',scheduleValue:'60000',metadata:{botId:'b'}});const r=new RoutineRunStore(f.store).enqueue(job,new Date().toISOString());let calls=0;const host={store:f.store,stateDir:f.dir,log:{warn(){},info(){}},runSession:async id=>{calls++;await registerWait(f,id,args(f));}};await drainRoutineRuns(host);await new Promise(setImmediate);await cancelRoutineRun(host,r.id);f.store.updateSession(f.child.id,{status:'completed'});await drainRoutineRuns(host);assert.equal(calls,1);});
test('real kernel closes the wait tool pair and stops before another model turn [AC:durable-agent-waits#AC-6]',async t=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');const root=mkdtempSync(join(tmpdir(),'wait-kernel-'));let child,calls=0;
 const runtime=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),modelAdapter:{name:'wait-test',async runTurn(input){calls++;assert.ok(input.tools.some(tool=>tool.name==='wait_for'));if(calls===1)return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'wait-call',name:'wait_for',input:{source:'session',ref:child.id,condition:{op:'eq',field:'status',value:'completed'},summary:'Check dependency result before continuing'}}]};return {stopReason:'end',assistantParts:[{type:'text',text:'Continuation checked'}]};},async summarizeMessages(){return '';}}});
 t.after(async()=>{await runtime.destroy();await new Promise(r=>setTimeout(r,100));rmSync(root,{recursive:true,force:true});});
 const bot=runtime.createBot({name:'Generic waiter'}),sid=runtime.openBot(bot.id).sessionId;const parent=runtime.getSession(sid);
 child=runtime.store.createSession({title:'Dependency',mode:'subagent',agentId:parent.agentId,parentSessionId:sid,metadata:{...parent.metadata,canonicalBotChat:false}});runtime.store.updateSession(child.id,{status:'running'});
 const job=new CronJobStore(runtime.stateDir).create({sessionId:sid,agentId:parent.agentId,name:'Wait',prompt:'Wait for an existing observable',scheduleKind:'every_ms',scheduleValue:'60000',metadata:{botId:bot.id}});
 const run=new RoutineRunStore(runtime.store).enqueue(job,new Date().toISOString());
 const host={store:runtime.store,stateDir:runtime.stateDir,log:{warn(){},info(){}},runSession:id=>runtime.runSession(id),isSessionRunning:id=>runtime.isSessionRunning(id)};
 await drainRoutineRuns(host);for(let i=0;i<100&&new RoutineRunStore(runtime.store).get(run.id).status==='running';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(calls,1,JSON.stringify(runtime.store.foldMessages(sid).flatMap(m=>m.parts).filter(p=>p.type==='tool_result')));assert.equal(new RoutineRunStore(runtime.store).get(run.id).status,'waiting_condition');
 const parts=runtime.store.foldMessages(sid).flatMap(m=>m.parts);assert.equal(parts.filter(p=>p.type==='tool_call'&&p.toolCallId==='wait-call').length,1);assert.equal(parts.filter(p=>p.type==='tool_result'&&p.toolCallId==='wait-call').length,1);
 runtime.store.updateSession(child.id,{status:'completed'});await drainRoutineRuns(host);for(let i=0;i<100&&new RoutineRunStore(runtime.store).get(run.id).status==='running';i++)await new Promise(r=>setTimeout(r,10));assert.equal(calls,2);assert.equal(new RoutineRunStore(runtime.store).get(run.id).status,'completed');
});
test('registration without a closed tool wave cannot resume after a crash [AC:durable-agent-waits#AC-6]',async t=>{
 const f=fixture(t),{g}=assigned(f),calls=[];
 const out=await createWaitForTool(f.store).execute({session:f.store.getSession(f.parent.id)},args(f));assert.equal(out.ok,true);
 await settleGoalExecution(goalHost(f,calls),f.parent.id);
 assert.equal(new BotGoalService(f.store,Date.now,f.parent.id).get('b',g.id).status,'blocked');
 assert.equal(new DurableWaitStore(f.store).get(JSON.parse(out.content).waitId).status,'cancelled');
 f.store.updateSession(f.child.id,{status:'completed'});await tickBotGoals(goalHost(f,calls));assert.equal(calls.length,0);
});
test('cancelling a passive Routine does not interrupt other work in its shared session [AC:durable-agent-waits#AC-3]',async t=>{
 const f=fixture(t);const job=new CronJobStore(f.dir).create({sessionId:f.parent.id,agentId:'general',name:'Wait',prompt:'Wait',scheduleKind:'every_ms',scheduleValue:'60000',metadata:{botId:'b'}});
 const run=new RoutineRunStore(f.store).enqueue(job,new Date().toISOString());let cancelled=0;
 const host={store:f.store,stateDir:f.dir,log:{warn(){},info(){}},runSession:async id=>{await registerWait(f,id,args(f));},cancelSession:()=>cancelled++};
 await drainRoutineRuns(host);await new Promise(setImmediate);assert.equal(new RoutineRunStore(f.store).get(run.id).status,'waiting_condition');
 await cancelRoutineRun(host,run.id);assert.equal(cancelled,0);
});
test('legacy kernel rejects wait registration instead of silently polling the model [AC:durable-agent-waits#AC-6]',async t=>{
 const f=fixture(t);assigned(f);f.store.setDaemonControl('loop_settings',{kernelVariant:'ppeng'});
 const out=await createWaitForTool(f.store).execute({session:f.store.getSession(f.parent.id)},args(f));
 assert.equal(out.ok,false);assert.match(out.content,/agent-loop kernel/);assert.equal(f.store.getSession(f.parent.id).metadata.agentWaitId,undefined);
});
test('wait capability is scoped to an active execution and never bypasses allowlists [AC:durable-agent-waits#AC-3] [AC:durable-agent-waits#AC-6]',async t=>{
 const {filterToolsForSession}=await import('../dist/turn/resolve-turn-tools.js');const f=fixture(t),tool=createWaitForTool(f.store);
 const visible=agent=>filterToolsForSession({env:{},tools:[tool],agent:agent??{id:'general'},session:f.store.getSession(f.parent.id),settingsStore:f.store}).tools.map(t=>t.name);
 assert.deepEqual(visible(),[]);f.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});assert.deepEqual(visible(),[]);
 const job=new CronJobStore(f.dir).create({sessionId:f.parent.id,agentId:'general',name:'Wait',prompt:'Wait',scheduleKind:'every_ms',scheduleValue:'60000',metadata:{botId:'b'}}),runs=new RoutineRunStore(f.store),run=runs.enqueue(job,new Date().toISOString());
 runs.claim(run.id,f.parent.id);assert.deepEqual(visible(),['wait_for']);assert.deepEqual(visible({id:'general',allowedTools:['read_file']}),[]);
 runs.update(run.id,{status:'waiting_condition'});assert.deepEqual(visible(),[]);
});
