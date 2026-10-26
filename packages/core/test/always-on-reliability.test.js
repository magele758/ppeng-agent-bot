import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRecovery } from '../dist/session/durable-recovery.js';
import { notificationDecision, factFingerprint } from '../dist/cron/notification-decision.js';
import { diagnosePrompt } from '../dist/session/cache-diagnostics.js';
import { updateTaskContract, contractAppendix } from '../dist/session/task-contract.js';

test('closed checkpoint resumes but unknown writes remain quarantined [AC:always-on-reliability#AC-1]',()=>{
 const checkpoint={seq:2,id:'c'};
 assert.equal(decideRecovery({checkpoint,hasUnconfirmedEffects:false,messages:[{seq:2,parts:[]}]}).resume,true);
 assert.equal(decideRecovery({checkpoint,hasUnconfirmedEffects:true,messages:[{seq:2,parts:[]}]}).resume,false);
 assert.equal(decideRecovery({checkpoint,hasUnconfirmedEffects:false,messages:[{seq:2,parts:[]},{seq:3,parts:[{type:'tool_call',name:'bash',toolCallId:'x',input:{}}]}]}).resume,false);
 assert.equal(decideRecovery({messages:[]}).resume,false);
});
test('facts ignore prose and quiet hours defer notifications [AC:always-on-reliability#AC-2]',()=>{
 assert.equal(factFingerprint({price:12,status:'ok'}),factFingerprint({status:'ok',price:12}));
 const policy={changesOnly:true,quietStart:22,quietEnd:8,dailyBudget:2};
 assert.equal(notificationDecision({policy,now:Date.parse('2026-10-25T23:00:00Z'),timezone:'UTC',sentToday:0,changed:true}).action,'digest');
 assert.equal(notificationDecision({policy,now:0,timezone:'UTC',sentToday:0,changed:false}).action,'silent');
 assert.equal(notificationDecision({policy:{dailyBudget:1},now:0,timezone:'UTC',sentToday:1,changed:true}).reason,'budget');
});
test('cache diagnostics detect schema changes and never invent usage [AC:always-on-reliability#AC-4]',()=>{
 const a=diagnosePrompt(undefined,{system:'s',tools:[{name:'t',inputSchema:{type:'string'}}],stable:'x'});
 const b=diagnosePrompt(a,{system:'s',tools:[{name:'t',inputSchema:{type:'number'}}],stable:'x'});
 assert.deepEqual(b.changed,['tools']);assert.equal(b.cachedInputTokens,null);
 assert.equal(diagnosePrompt(b,{system:'s',tools:[],stable:'x'},0).cachedInputTokens,0);
});
test('latest contract survives two lossy summaries with provenance [AC:always-on-reliability#AC-5]',()=>{
 const a=updateTaskContract(undefined,{objective:'write email',constraints:['draft only'],todos:['review'],evidence:['message:1']},'user');
 const b=updateTaskContract(a,{objective:'write email',constraints:['do not send'],todos:[],evidence:['message:2']},'user');
 assert.equal(b.version,2);assert.equal(b.source,'user');
 for(const summary of ['old: send it','short summary']){const appendix=contractAppendix(b,summary);assert.match(appendix,/do not send/);assert.doesNotMatch(appendix,/draft only/);assert.match(appendix,/message:2/);}
 assert.throws(()=>updateTaskContract(b,{objective:12},'user'));
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createCronJob, updateCronJob } from '../dist/cron/cron-facade.js';
import { RoutineRunStore, drainRoutineRuns } from '../dist/cron/routine-runtime.js';
import { saveStepCheckpoint } from '../dist/session/checkpoint.js';
import { parseRoutineDeliveryPolicy } from '../dist/cron/routine-delivery-policy.js';
function fixture(t){
 const stateDir=mkdtempSync(join(tmpdir(),'always-on-'));let store=new SqliteStateStore(join(stateDir,'state.db'));
 const parent=store.createSession({title:'owner',mode:'chat',agentId:'general',background:false,metadata:{userId:'alice'}});
 const host={store,stateDir,cronStore:undefined,setCronStore(s){this.cronStore=s},log:{warn(){},info(){}},hasUnconfirmedEffects:()=>false,runSession:async id=>{host.store.appendMessage(id,'assistant',[{type:'text',text:'report'}]);host.store.updateSession(id,{status:'idle'});}};
 t.after(()=>{host.store.db.close();rmSync(stateDir,{recursive:true,force:true});});
 return {host,parent,reopen(){host.store.db.close();host.store=new SqliteStateStore(join(stateDir,'state.db'));return host.store;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const policy={inputSources:'',changesOnly:true,failureThreshold:1,approvalBeforeSend:false,comparison:'facts'};

test('restart resumes original session and preserves completed work [AC:always-on-reliability#AC-1]',async t=>{
 const f=fixture(t);const {host,parent}=f;
 const job=createCronJob(host,{sessionId:parent.id,name:'restart',prompt:'continue',intervalMs:60000});
 const worker=host.store.createSession({title:'worker',mode:'task',agentId:'general',background:true,metadata:{}});
 host.store.appendMessage(worker.id,'user',[{type:'text',text:'read then report'}]);
 assert.equal(saveStepCheckpoint(host.store,worker.id,{label:'read complete'}).ok,true);
 let runs=new RoutineRunStore(host.store);const queued=runs.enqueue(job,new Date().toISOString());runs.claim(queued.id,worker.id);
 host.store.updateSession(worker.id,{status:'running'});f.reopen();
 const {recoverInterruptedSessions}=await import('../dist/runtime/restart-recovery.js');recoverInterruptedSessions(host.store);assert.equal(host.store.getSession(worker.id).status,'failed');
 let calls=[];host.runSession=async id=>{calls.push(id);host.store.appendMessage(id,'assistant',[{type:'text',text:'resumed report'}]);host.store.updateSession(id,{status:'idle'});};
 await drainRoutineRuns(host);await settle();runs=new RoutineRunStore(host.store);
 assert.deepEqual(calls,[worker.id]);assert.equal(runs.get(queued.id).status,'completed');assert.equal(runs.get(queued.id).recovery.resume,true);
 await drainRoutineRuns(host);assert.equal(calls.length,1);
});

test('fact comparison persists across restart and quiet results merge on policy update [AC:always-on-reliability#AC-2]',async t=>{
 const {host,parent,reopen}=fixture(t);
 const job=createCronJob(host,{sessionId:parent.id,name:'watch',prompt:'report',intervalMs:60000,deliveryPolicy:policy});
 let runs=new RoutineRunStore(host.store);
 const complete=(n,result)=>{const r=runs.enqueue(job,new Date(Date.now()+n).toISOString());runs.update(r.id,{status:'completed',result});return r;};
 const first=complete(1,JSON.stringify({facts:{status:'ok'},report:'first wording'}));await drainRoutineRuns(host);
 assert.equal(runs.get(first.id).notificationSent,true);
 reopen();runs=new RoutineRunStore(host.store);
 const same=complete(2,JSON.stringify({facts:{status:'ok'},report:'different wording'}));await drainRoutineRuns(host);
 assert.equal(runs.get(same.id).notificationReason,'unchanged');
 updateCronJob(host,job.id,{deliveryPolicy:{...policy,dailyBudget:1}});
 const a=complete(3,JSON.stringify({facts:{status:'a'}}));const b=complete(4,JSON.stringify({facts:{status:'b'}}));await drainRoutineRuns(host);
 assert.equal(runs.get(a.id).notificationReason,'budget');assert.equal(runs.get(b.id).notificationSent,undefined);
 updateCronJob(host,job.id,{deliveryPolicy:policy});await drainRoutineRuns(host);
 assert.equal(runs.get(a.id).notificationReason,'merged');assert.equal(runs.get(b.id).digestRunIds.length,1);
 assert.equal(host.store.listMessages(parent.id).filter(m=>m.role==='assistant').length,2);
 assert.throws(()=>parseRoutineDeliveryPolicy({...policy,quietStart:22}));
 assert.throws(()=>parseRoutineDeliveryPolicy({...policy,dailyBudget:0}));
});

test('seven-day time travel detects lifecycle regressions [AC:always-on-reliability#AC-3]',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T12:00:00Z')});
 const f=fixture(t);const {host,parent}=f;
 const job=createCronJob(host,{sessionId:parent.id,name:'seven days',prompt:'monitor',intervalMs:86400000,deliveryPolicy:policy});
 let contract=updateTaskContract(undefined,{objective:'report',constraints:['draft only'],todos:['check'],evidence:['user:1']},'user');
 let reports=0;
 host.runSession=async id=>{reports++;host.store.appendMessage(id,'assistant',[{type:'text',text:JSON.stringify({facts:{status:reports<4?'ok':'changed'},report:`wording ${reports}`})}]);host.store.updateSession(id,{status:'idle'});};
 const ids=new Set();
 for(let day=0;day<7;day++){
  if(day===2){f.reopen();contract=updateTaskContract(contract,{objective:'report',constraints:['never send'],todos:['check'],evidence:['user:2']},'user');}
  if(day===3||day===5){host.store.updateSession(parent.id,{summary:'lossy old summary: send it',metadata:{taskContract:contract}});assert.match(contractAppendix(host.store.getSession(parent.id).metadata.taskContract),/never send/);}
  const runs=new RoutineRunStore(host.store);const date=new Date().toISOString();const run=runs.enqueue(job,date,{key:`event:${day}`});
  assert.equal(runs.enqueue(job,date,{key:`event:${day}`}).id,run.id);ids.add(run.id);
  if(day===4){runs.update(run.id,{status:'failed',error:'child failed'});}
  await drainRoutineRuns(host);await settle();await drainRoutineRuns(host);
  t.mock.timers.tick(86400000);
 }
 assert.equal(ids.size,7);assert.equal(reports,6);
 const runs=new RoutineRunStore(host.store).list(job.id);
 assert.equal(runs.filter(r=>r.status==='failed').length,1);
 assert.equal(runs.filter(r=>r.notificationReason==='unchanged').length,4);
 assert.equal(host.store.listMessages(parent.id).filter(m=>m.role==='assistant').length,3);
});

test('real model boundary restores latest contract after repeated persisted compression and records provider usage [AC:always-on-reliability#AC-4] [AC:always-on-reliability#AC-5]',async t=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');
 const {bindTurnKernelHost}=await import('../dist/runtime/l5-bindings.js');
 const dir=mkdtempSync(join(tmpdir(),'contract-model-'));let delivered;
 const rt=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'scripted',runTurn:async input=>{delivered=input;return {stopReason:'end',assistantParts:[{type:'text',text:'done'}],usage:{inputTokens:100,cachedInputTokens:60}}},summarizeMessages:async()=> 'old plan says send; all constraints omitted'}});
 t.after(()=>{rt.store.db.close();rmSync(dir,{recursive:true,force:true});});rt.emitTrace=async()=>{};
 const session=rt.store.createSession({title:'task',mode:'chat',agentId:'general',background:false,metadata:{}});
 let contract=updateTaskContract(undefined,{objective:'email',constraints:['draft only'],todos:['review'],evidence:['user:original']},'user');
 const host=bindTurnKernelHost(rt.l5());
 for(let round=0;round<2;round++){
  if(round)contract=updateTaskContract(contract,{objective:'email',constraints:['never send'],todos:[],evidence:['user:correction']},'user');
  rt.mergeSessionMetadata(session.id,{taskContract:contract});
  for(let n=0;n<72;n++)rt.store.appendMessage(session.id,n%2?'assistant':'user',[{type:'text',text:`old ${n} ${'x'.repeat(50)}`}]);
  rt.store.appendMessage(session.id,'user',[{type:'text',text:'continue'}]);
  const compacted=await rt.compactCanonicalSession(session.id);assert.ok(compacted.replaced);
  await host.runTurnWithRetries({sessionId:session.id,agent:{id:'general',name:'general',systemPrompt:''},systemPrompt:'stable',messages:rt.store.foldMessages(session.id),tools:[]});
  const text=JSON.stringify(delivered.messages);assert.match(text,new RegExp(round?'never send':'draft only'));assert.match(text,new RegExp(`task-contract version=${round+1}`));
  assert.equal((text.match(/\[task-contract version=/g)??[]).length,1);
 }
 const history=rt.store.getSession(session.id).metadata.cacheDiagnostics;
 assert.equal(rt.store.getSession(session.id).metadata.taskContractAudit.version,2);assert.ok(rt.store.getSession(session.id).metadata.taskContractAudit.missing.includes('constraint:0'));
 assert.equal(history.length,2);assert.equal(history[1].cachedInputTokens,60);assert.equal(history[1].inputTokens,100);
});

test('restart never replays an unconfirmed external action or a cancelled session [AC:always-on-reliability#AC-1]',async t=>{
 for(const cancelled of [false,true]){
  const f=fixture(t);const {host,parent}=f;
  const job=createCronJob(host,{sessionId:parent.id,name:'unsafe',prompt:'work',intervalMs:60000});
  const worker=host.store.createSession({title:'worker',mode:'task',agentId:'general',background:true,metadata:{}});
  host.store.appendMessage(worker.id,'user',[{type:'text',text:'work'}]);saveStepCheckpoint(host.store,worker.id,{label:'before send'});
  const runs=new RoutineRunStore(host.store);const run=runs.enqueue(job,new Date().toISOString());runs.claim(run.id,worker.id);
  if(cancelled)host.store.updateSession(worker.id,{status:'idle',metadata:{...host.store.getSession(worker.id).metadata,outcome:{kind:'aborted',reason:'user_abort'}}});
  else host.hasUnconfirmedEffects=()=>true;
  let calls=0;host.runSession=async()=>{calls++;};
  await drainRoutineRuns(host);await settle();assert.equal(calls,0);
  assert.equal(runs.get(run.id).status,cancelled?'failed':'unknown');
 }
});
