import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createCronJob } from '../dist/cron/cron-facade.js';
import { tickCronJobs } from '../dist/runtime/scheduler-host.js';
import { RoutineRunStore, drainRoutineRuns, cancelRoutineRun, retryRoutineRun, materializeRoutineOccurrences, routineSettings } from '../dist/cron/routine-runtime.js';
import { nextZonedCronRunAt, skippedZonedCronMinutes } from '../dist/cron/cron-next.js';
function fixture() {
 const stateDir = mkdtempSync(join(tmpdir(), 'routine-life-'));
 const store = new SqliteStateStore(join(stateDir,'state.db'));
 const session = store.createSession({title:'private',mode:'chat',agentId:'general',background:false,metadata:{userId:'alice',permissionMode:'standard'}});
 const host={store,stateDir,log:{warn(){},info(){}},cronStore:undefined,setCronStore(s){this.cronStore=s},runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},runSession:async(id)=>{store.appendMessage(id,'assistant',[{type:'text',text:'finished report'}]);return store.getSession(id)}};
 return {store,session,host};
}
test('busy private chat does not lose one-shot independent work [AC:bot-routine-lifecycle#AC-1] [AC:bot-routine-lifecycle#AC-5]',async()=>{
 const {store,session,host}=fixture();store.updateSession(session.id,{status:'waiting_approval'});
 const job=createCronJob(host,{sessionId:session.id,name:'one',prompt:'produce report',onceAt:new Date(Date.now()-1000).toISOString(),timezone:'Asia/Shanghai'});
 await tickCronJobs(host);await new Promise(resolve=>setImmediate(resolve));
 const [run]=new RoutineRunStore(store).list(job.id);
 assert.equal(run.status,'completed');assert.notEqual(run.sessionId,session.id);
 assert.equal(host.cronStore.get(job.id).enabled,false);
 assert.equal(store.getSession(session.id).status,'waiting_approval');
 assert.ok(store.listMessages(run.sessionId).some(m=>JSON.stringify(m).includes('produce report')));
 assert.ok(!store.listMessages(session.id).some(m=>m.role==='user'&&JSON.stringify(m).includes('produce report')));
 assert.equal(store.listMessages(session.id).length,0);
 store.updateSession(session.id,{status:'idle'});await drainRoutineRuns(host);
 assert.ok(store.listMessages(session.id).some(m=>JSON.stringify(m).includes(run.id)));
 store.db.close();
});
test('IANA cron normalizes duplicate DST and skips missing time [AC:bot-routine-lifecycle#AC-2]',()=>{
 assert.equal(nextZonedCronRunAt('30 1 * * *','America/New_York',new Date('2026-11-01T04:00:00Z')).toISOString(),'2026-11-01T05:30:00.000Z');
 assert.equal(nextZonedCronRunAt('30 1 * * *','America/New_York',new Date('2026-11-01T05:30:00Z')).toISOString(),'2026-11-02T06:30:00.000Z');
 assert.deepEqual(skippedZonedCronMinutes('30 2 * * *','America/New_York',new Date('2026-03-07T00:00:00Z'),new Date('2026-03-09T00:00:00Z')),[{scheduledAt:'2026-03-08T07:00:00.000Z',wallTime:'2026-03-08T02:30'}]);
 assert.equal(nextZonedCronRunAt('30 2 * * *','America/New_York',new Date('2026-03-08T06:00:00Z')).toISOString(),'2026-03-09T06:30:00.000Z');
});
test('settings support once interval event and default persisted dialog tools [AC:bot-routine-lifecycle#AC-4]',()=>{
 const {store,session,host}=fixture();
 const job=createCronJob(host,{sessionId:session.id,name:'interval',prompt:'read',intervalMs:60000,timezone:'Asia/Shanghai',missedPolicy:'catch_up'});
 assert.equal(job.scheduleKind,'every_ms');assert.equal(job.timezone,'Asia/Shanghai');assert.equal(job.missedPolicy,'catch_up');
 store.db.close();
});
test('queued recovery, unknown interruption, retry and cancellation [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {store,session,host}=fixture();
 const job=createCronJob(host,{sessionId:session.id,name:'r',prompt:'read',intervalMs:60000});
 const runs=new RoutineRunStore(store);
 const queued=runs.enqueue(job,new Date().toISOString());
 await drainRoutineRuns(host);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(runs.get(queued.id).status,'completed');
 const next=runs.enqueue(job,new Date(Date.now()+1).toISOString());
 await cancelRoutineRun(host,next.id);assert.equal(runs.get(next.id).status,'cancelled');
 const retried=retryRoutineRun(host,next.id);assert.equal(retried.status,'queued');assert.equal(retried.attempt,2);
 await drainRoutineRuns(host);await new Promise(resolve=>setImmediate(resolve));assert.equal(runs.get(next.id).status,'completed');
 store.db.close();
});

test('old terminal history cannot starve newly queued work and empty output is failed [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {store,session,host}=fixture();
 const job=createCronJob(host,{sessionId:session.id,name:'history',prompt:'read',intervalMs:60000});
 const runs=new RoutineRunStore(store);
 const insert=store.db.prepare('INSERT INTO bot_routine_runs(id,routine_id,occurrence_key,status,payload,notified) VALUES(?,?,?,?,?,1)');
 store.db.exec('BEGIN');for(let i=0;i<10001;i++)insert.run(`old${i}`,job.id,`old${i}`,'completed',JSON.stringify({id:`old${i}`,status:'completed',notificationSent:true}));store.db.exec('COMMIT');
 const run=runs.enqueue(job,new Date().toISOString());await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));assert.equal(runs.get(run.id).status,'completed');
 host.runSession=async(id)=>store.getSession(id);
 const empty=runs.enqueue(job,new Date(Date.now()+1).toISOString());await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));assert.equal(runs.get(empty.id).status,'failed');assert.match(runs.get(empty.id).error,/without a result/);
 store.db.close();
});
test('approval waiting survives a reopened database and expiration is failed [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {store,session,host}=fixture();
 const job=createCronJob(host,{sessionId:session.id,name:'approval',prompt:'do gated work',onceAt:new Date().toISOString()});
 let approval;
 host.runSession=async(id)=>{approval=store.createApproval({sessionId:id,toolName:'bash',reason:'gated',args:{command:'true'}});store.updateSession(id,{status:'waiting_approval'});return store.getSession(id)};
 const runs=new RoutineRunStore(store);const run=runs.enqueue(job,new Date().toISOString());await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));
 assert.equal(runs.get(run.id).status,'waiting_approval');assert.equal(approval.wakeSource,'routine');assert.ok(approval.expiresAt);
 const path=store.dbPath;store.db.close();const reopened=new SqliteStateStore(path);host.store=reopened;let calls=0;host.runSession=async()=>{calls++;};
 await drainRoutineRuns(host);assert.equal(calls,0);assert.equal(new RoutineRunStore(reopened).get(run.id).status,'waiting_approval');
 const {expireDueUnattendedApprovals}=await import('../dist/approval/unattended-approval.js');expireDueUnattendedApprovals(reopened,Date.parse(approval.expiresAt)+1);await drainRoutineRuns(host);
 assert.equal(new RoutineRunStore(reopened).get(run.id).status,'failed');assert.equal(calls,0);reopened.db.close();
});

test('real worker process exit recovers unstarted work and quarantines interrupted execution [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {execFileSync}=await import('node:child_process');const {sanitizeSpawnEnv}=await import('../dist/sandbox/env-sanitizer.js');
 const {store,session,host}=fixture();
 const job=createCronJob(host,{sessionId:session.id,name:'restart',prompt:'read',intervalMs:60000});
 const runs=new RoutineRunStore(store);const queued=runs.enqueue(job,new Date().toISOString());
 const source=`import {SqliteStateStore} from ${JSON.stringify(new URL('../dist/storage.js',import.meta.url).href)};import {drainRoutineRuns} from ${JSON.stringify(new URL('../dist/cron/routine-runtime.js',import.meta.url).href)};const store=new SqliteStateStore(${JSON.stringify(store.dbPath)});await drainRoutineRuns({store,stateDir:${JSON.stringify(host.stateDir)},log:{warn(){},info(){}},runSession:async(id)=>{store.updateSession(id,{status:'running'});return new Promise(()=>{});}});store.db.close();`;
 execFileSync(process.execPath,['--input-type=module','-e',source],{env:sanitizeSpawnEnv(),timeout:10000});
 const interrupted=runs.get(queued.id);assert.equal(interrupted.status,'running');assert.notEqual(interrupted.ownerPid,process.pid);
 let replay=0;host.runSession=async()=>{replay++};await drainRoutineRuns(host);
 assert.equal(runs.get(queued.id).status,'unknown');assert.equal(replay,0);
 const waiting=runs.enqueue(job,new Date(Date.now()+1).toISOString());await drainRoutineRuns(host);assert.equal(runs.get(waiting.id).status,'queued');
 await cancelRoutineRun(host,queued.id);host.runSession=async(id)=>{store.appendMessage(id,'assistant',[{type:'text',text:'safe result'}]);return store.getSession(id)};
 await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));assert.equal(runs.get(waiting.id).status,'completed');
 store.db.close();
});

test('missed schedules coalesce skip or catch up at most ten with persistent counts [AC:bot-routine-lifecycle#AC-2]',()=>{
 for(const policy of ['coalesce','skip','catch_up']){
  const {store,session,host}=fixture();const now=Date.now();
  const job=createCronJob(host,{sessionId:session.id,name:policy,prompt:'read',intervalMs:60000,missedPolicy:policy});
  const due=host.cronStore.update(job.id,{nextRunAt:new Date(now-19*60000).toISOString()});
  const created=materializeRoutineOccurrences(host,host.cronStore,due,now);
  assert.equal(created.length,policy==='catch_up'?10:1);
  assert.equal(created[0].status,policy==='skip'?'skipped':'queued');
  assert.equal(created[0].missedCount,policy==='catch_up'?10:19);
  assert.ok(Date.parse(host.cronStore.get(job.id).nextRunAt)>now);
  assert.equal(materializeRoutineOccurrences(host,host.cronStore,host.cronStore.get(job.id),now).length,0);
  store.db.close();
 }
});
test('dialog scheduling is mounted by default and its persisted setting applies without restart [AC:bot-routine-lifecycle#AC-4]',async()=>{
 const {assembleOptionalTools}=await import('../dist/runtime/tool-assembly.js');
 const {store,session,host}=fixture();createCronJob(host,{sessionId:session.id,name:'init',prompt:'read',intervalMs:60000});
 const tools=assembleOptionalTools({env:{RAW_AGENT_CRON_TOOLS:'0'},store,stateDir:host.stateDir,getCronStore:()=>host.cronStore});
 const create=tools.find(t=>t.name==='cron_create');assert.ok(create);assert.equal(routineSettings(store).dialogToolsEnabled,true);
 const context={session,agent:{id:'general'},stateDir:host.stateDir,repoRoot:host.stateDir};
 routineSettings(store,{dialogToolsEnabled:false});assert.equal((await create.execute(context,{name:'disabled',prompt:'read',every_ms:60000})).ok,false);
 routineSettings(store,{dialogToolsEnabled:true});const result=await create.execute(context,{name:'enabled',prompt:'read',every_ms:60000,timezone:'Asia/Shanghai'});assert.equal(result.ok,true);assert.equal(JSON.parse(result.content).timezone,'Asia/Shanghai');
 store.db.close();
});

test('unknown retries require explicit verification and attempt history survives [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {store,session,host}=fixture();const job=createCronJob(host,{sessionId:session.id,name:'verify',prompt:'read',intervalMs:60000});const runs=new RoutineRunStore(store);
 const run=runs.enqueue(job,new Date().toISOString());runs.update(run.id,{status:'unknown',error:'possible effects'});
 assert.throws(()=>retryRoutineRun(host,run.id),/confirmUnknown/);
 retryRoutineRun(host,run.id,{confirmUnknown:true});await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));
 assert.equal(runs.get(run.id).status,'completed');assert.equal(runs.get(run.id).attempt,2);assert.equal(runs.get(run.id).attempts[0].status,'completed');
 store.db.close();
});
test('deleted owner chat is repaired only for its explicit principal and paused bots retain work [AC:bot-routine-lifecycle#AC-1] [AC:bot-routine-lifecycle#AC-5]',async()=>{
 const {createBot}=await import('../dist/bots/index.js');const {setBotWorkControl}=await import('../dist/bots/bot-work.js');
 const {store,host}=fixture();const bot=createBot(host,{name:'RepairRoutine'});
 const job=createCronJob(host,{botId:bot.id,userId:'alice',name:'repair',prompt:'read',onceAt:new Date().toISOString()});
 const old=job.sessionId;store.deleteSession(old);
 setBotWorkControl(host,{userId:'alice'},bot.id,{paused:true,disabled:false});
 await tickCronJobs(host);await new Promise(r=>setImmediate(r));const runs=new RoutineRunStore(store);const [waiting]=runs.list(job.id);
 assert.equal(waiting.status,'queued');assert.match(waiting.error,/paused/);assert.notEqual(waiting.mainSessionId,old);assert.equal(store.getSession(waiting.mainSessionId).metadata.userId,'alice');
 setBotWorkControl(host,{userId:'alice'},bot.id,{paused:false,disabled:false});await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));assert.equal(runs.get(waiting.id).status,'completed');
 assert.equal(store.getSession(runs.get(waiting.id).sessionId).metadata.userId,'alice');store.db.close();
});

test('partial output with aborted or exhausted outcome cannot become completed [AC:bot-routine-lifecycle#AC-3]',async()=>{
 for(const outcome of [{kind:'aborted',reason:'abort'},{kind:'idle',reason:'max_turns'}]){
  const {store,session,host}=fixture();const job=createCronJob(host,{sessionId:session.id,name:'partial',prompt:'read',intervalMs:60000});const runs=new RoutineRunStore(store);
  host.runSession=async(id)=>{store.appendMessage(id,'assistant',[{type:'text',text:'partial work'}]);store.updateSession(id,{status:'idle',metadata:{...store.getSession(id).metadata,outcome}});return store.getSession(id)};
  const run=runs.enqueue(job,new Date().toISOString());await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));
  assert.equal(runs.get(run.id).status,'failed');assert.equal(runs.get(run.id).result,'partial work');assert.match(runs.get(run.id).error,new RegExp(outcome.reason));
  store.db.close();
 }
});

test('unconfirmed software writes retain partial output as unknown and block subsequent work [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {store,session,host}=fixture();const job=createCronJob(host,{sessionId:session.id,name:'effect',prompt:'write',intervalMs:60000});const runs=new RoutineRunStore(store);
 host.hasUnconfirmedEffects=()=>true;const run=runs.enqueue(job,new Date().toISOString());await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));
 assert.equal(runs.get(run.id).status,'unknown');assert.equal(runs.get(run.id).result,'finished report');assert.match(runs.get(run.id).error,/unconfirmed/);
 const next=runs.enqueue(job,new Date(Date.now()+1).toISOString());await drainRoutineRuns(host);assert.equal(runs.get(next.id).status,'queued');store.db.close();
});

test('real approve then scheduler resumes Routine before classifying its result [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');const {existsSync}=await import('node:fs');
 const repoRoot=mkdtempSync(join(tmpdir(),'routine-approve-repo-'));const stateDir=mkdtempSync(join(tmpdir(),'routine-approve-state-'));const marker=join(repoRoot,'approved-once');
 const adapter={name:'routine-approve-fixture',async summarizeMessages(){return 'summary'},async runTurn(input){
  const done=input.messages.some(m=>m.parts.some(p=>p.type==='tool_result'&&p.toolCallId==='routine_gate'&&p.ok));
  return done?{stopReason:'end',assistantParts:[{type:'text',text:'approved work completed'}]}:{stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'routine_gate',name:'bash',input:{command:'touch approved-once'}}]};
 }};
 const runtime=new RawAgentRuntime({repoRoot,stateDir,modelAdapter:adapter});
 try{
  const session=runtime.createChatSession({title:'routine owner',metadata:{permissionMode:'ask',userId:'alice'}});
  const job=runtime.createCronJob({sessionId:session.id,name:'approve',prompt:'write marker',onceAt:new Date().toISOString()});
  const runs=new RoutineRunStore(runtime.store);await runtime.runScheduler();
  for(let i=0;i<1000;i++){if(runs.list(job.id)[0]?.status==='waiting_approval')break;await new Promise(r=>setTimeout(r,10));}
  const run=runs.list(job.id)[0];assert.equal(run.status,'waiting_approval');assert.equal(existsSync(marker),false);
  const approval=runtime.listApprovals().find(a=>a.sessionId===run.sessionId&&a.status==='pending');assert.ok(approval);
  await runtime.approve(approval.id,'approved');assert.equal(runtime.getSession(run.sessionId).status,'idle');
  await runtime.runScheduler();
  assert.notEqual(runs.get(run.id).status,'failed');
  for(let i=0;i<1000;i++){if(runs.get(run.id).status==='completed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(runs.get(run.id).status,'completed');assert.equal(runs.get(run.id).result,'approved work completed');assert.equal(existsSync(marker),true);
  const resultCount=runtime.store.listMessages(run.sessionId).filter(m=>m.parts.some(p=>p.type==='tool_result'&&p.toolCallId==='routine_gate'&&p.ok)).length;assert.equal(resultCount,1);
  await runtime.runScheduler();assert.equal(runs.get(run.id).status,'completed');
 }finally{await runtime.destroy();}
});

test('cancelled work with a later unconfirmed write cannot bypass unknown verification [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {store,session,host}=fixture();const job=createCronJob(host,{sessionId:session.id,name:'cancel-effect',prompt:'write',intervalMs:60000});const runs=new RoutineRunStore(store);
 let resolve;const gate=new Promise(r=>{resolve=r});let unresolved=false;host.hasUnconfirmedEffects=()=>unresolved;
 host.runSession=async(id)=>{await gate;store.appendMessage(id,'assistant',[{type:'text',text:'partial cancelled output'}]);return store.getSession(id)};
 const run=runs.enqueue(job,new Date().toISOString());await drainRoutineRuns(host);await cancelRoutineRun(host,run.id);assert.equal(runs.get(run.id).status,'cancelled');
 unresolved=true;resolve();await new Promise(r=>setImmediate(r));assert.equal(runs.get(run.id).status,'unknown');assert.throws(()=>retryRoutineRun(host,run.id),/confirmUnknown/);store.db.close();
});

test('old unknown and active work remain visible while terminal history pages with a stable cursor [AC:bot-routine-lifecycle#AC-3]',()=>{
 const {store,session,host}=fixture();const job=createCronJob(host,{sessionId:session.id,name:'paged',prompt:'read',intervalMs:60000});const runs=new RoutineRunStore(store);
 const oldest=runs.enqueue(job,new Date().toISOString());runs.update(oldest.id,{status:'unknown',notificationSent:true});
 for(let i=1;i<=501;i++){const run=runs.enqueue(job,new Date(Date.now()+i).toISOString());runs.update(run.id,{status:'completed',result:`history ${i}`,notificationSent:true});}
 const first=runs.page(job.id,{limit:100});assert.ok(first.runs.some(r=>r.id===oldest.id));assert.ok(first.nextCursor);
 const created=runs.enqueue(job,new Date(Date.now()+1000).toISOString());
 const second=runs.page(job.id,{before:first.nextCursor,limit:100});assert.ok(second.runs.some(r=>r.id===oldest.id));assert.ok(second.runs.some(r=>r.id===created.id));
 const oldTerminal=new Set(first.runs.filter(r=>r.status==='completed').map(r=>r.id));assert.ok(second.runs.filter(r=>r.status==='completed').every(r=>!oldTerminal.has(r.id)));
 assert.ok(runs.list(job.id).some(r=>r.id===oldest.id));store.db.close();
});

test('shared capacity preserves cron checkpoint and rejected event retry does not consume dedupe [AC:bot-routine-lifecycle#AC-1] [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {updateBotWorkSettings,botQueueUsage}=await import('../dist/bots/bot-work.js');const {acceptEventRoutine}=await import('../dist/cron/event-routine.js');const {createHmac}=await import('node:crypto');
 const {store,session,host}=fixture();updateBotWorkSettings(store,{perBot:1,perPrincipal:1});
 const job=createCronJob(host,{sessionId:session.id,name:'full',prompt:'read',intervalMs:60000});const runs=new RoutineRunStore(store);const blocker=runs.enqueue(job,new Date(Date.now()-1000).toISOString());
 const due=host.cronStore.update(job.id,{nextRunAt:new Date(Date.now()-500).toISOString()});const checkpoint=due.nextRunAt;
 assert.equal(materializeRoutineOccurrences(host,host.cronStore,due).length,0);assert.equal(host.cronStore.get(job.id).nextRunAt,checkpoint);assert.match(host.cronStore.get(job.id).metadata.queueBlockedReason,/capacity/i);assert.equal(runs.get(blocker.id).status,'queued');
 const event=createCronJob(host,{sessionId:session.id,name:'event',prompt:'handle event',event:'github/push',secretEnv:'BOT_CAPACITY_EVENT_SECRET'});
 const raw=JSON.stringify({text:'retryable event'}),secret='fixture-event-secret';let claims=0;
 const delivery='capacity-retry',timestamp=String(Math.floor(Date.now()/1000));
 const input={provider:'github',rawBody:raw,headers:{'x-github-event':'push','x-github-delivery':delivery,'x-github-timestamp':timestamp,'x-hub-signature-256':`sha256=${createHmac('sha256',secret).update(`${timestamp}.${delivery}.${raw}`).digest('hex')}`},env:{BOT_CAPACITY_EVENT_SECRET:secret},claimDelivery(){claims++;return true}};
 const blocked=await acceptEventRoutine(host,input);assert.equal(blocked.outcomes[0].status,'queue_full');assert.equal(claims,0);assert.equal(runs.list(event.id).length,0);
 await cancelRoutineRun(host,blocker.id);const retried=await acceptEventRoutine(host,input);await new Promise(r=>setImmediate(r));assert.equal(retried.outcomes[0].status,'woke');assert.equal(claims,1);assert.equal(runs.list(event.id).length,1);
 const duplicate=await acceptEventRoutine(host,input);assert.equal(duplicate.outcomes[0].status,'duplicate');assert.equal(claims,1);
 const catchup=createCronJob(host,{sessionId:session.id,name:'small capacity catch-up',prompt:'read',intervalMs:60000,missedPolicy:'catch_up'});const now=Date.now();const missed=host.cronStore.update(catchup.id,{nextRunAt:new Date(now-3*60000).toISOString()});const accepted=materializeRoutineOccurrences(host,host.cronStore,missed,now);assert.equal(accepted.length,1);assert.equal(accepted[0].missedCount,0);assert.ok(Date.parse(host.cronStore.get(catchup.id).nextRunAt)<=now);assert.equal(host.cronStore.get(catchup.id).metadata.catchUpPlan.scheduledAts.length,3);
 const receipts=[accepted[0]];await cancelRoutineRun(host,accepted[0].id);
 for(let i=0;i<3;i++){const next=materializeRoutineOccurrences(host,host.cronStore,host.cronStore.get(catchup.id),now);assert.equal(next.length,1);receipts.push(next[0]);await cancelRoutineRun(host,next[0].id);}
 assert.equal(new Set(receipts.map(run=>run.scheduledAt)).size,4);assert.ok(Date.parse(host.cronStore.get(catchup.id).nextRunAt)>now);assert.equal(host.cronStore.get(catchup.id).metadata.catchUpPlan,undefined);
 const once=createCronJob(host,{sessionId:session.id,name:'crash receipt',prompt:'exactly one receipt',onceAt:new Date(now-1000).toISOString()});const saved=runs.enqueue(once,once.nextRunAt);const recovered=materializeRoutineOccurrences(host,host.cronStore,once,now);assert.equal(recovered.length,1);assert.equal(recovered[0].id,saved.id);assert.equal(runs.get(saved.id).status,'queued');assert.equal(host.cronStore.get(once.id).enabled,false);
 store.db.close();
});

test('HTTP run DTOs omit internal event bodies while reopened prechecks still use the durable payload [AC:bot-routine-lifecycle#AC-3] [AC:bot-routine-lifecycle#AC-5]',async()=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');const {cronRoutes}=await import('../../../apps/daemon/dist/routes/cron.js');
 const repoRoot=mkdtempSync(join(tmpdir(),'routine-dto-repo-')),stateDir=mkdtempSync(join(tmpdir(),'routine-dto-state-'));
 let modelCalls=0;const options={repoRoot,stateDir,modelAdapter:{name:'dto-fixture',async summarizeMessages(){return 'summary'},async runTurn(){modelCalls++;return {stopReason:'end',assistantParts:[{type:'text',text:'unexpected model call'}]}}}};
 let runtime=new RawAgentRuntime(options);
 async function request(method,pattern,id,body={}){const route=cronRoutes(runtime).find(r=>r.method===method&&r.pattern===pattern);assert.ok(route);let payload,status;const response={statusCode:200,setHeader(){},end(text){status=this.statusCode;payload=JSON.parse(text)}};await route.handler({request:{headers:{}},response,url:new URL('http://fixture/api/cron'),parts:[],params:{id},requireParam:()=>id,readBody:async()=>body,auth:{isolate:false,labProxy:false,user:null}});assert.equal(status,200);return payload;}
 try{
  const parent=runtime.createChatSession({title:'private',metadata:{userId:'alice'}});
  const job=runtime.createCronJob({sessionId:parent.id,name:'raw precheck',prompt:'public summary only',event:'github/push',secretEnv:'DTO_EVENT_SECRET',precheck:{kind:'script',source:'node -e \'const fs=require("node:fs"); const data=fs.readFileSync(process.env.PPENG_EVENT_FILE,"utf8"); console.log(JSON.stringify({wakeAgent:!data.includes("private-event-tail")}))\''}});
  let ledger=new RoutineRunStore(runtime.store);const raw=JSON.stringify({body:'x'.repeat(13000)+'private-event-tail'});const first=ledger.enqueue(job,new Date().toISOString(),{eventBody:raw});
  for(const payload of [await request('GET','/api/cron/jobs/:id/runs',job.id),await request('GET','/api/cron/runs/:id',first.id),await request('POST','/api/cron/runs/:id/cancel',first.id),await request('POST','/api/cron/runs/:id/retry',first.id)]){const exposed=payload.run??payload.runs[0];assert.equal(Object.hasOwn(exposed,'eventBody'),false);assert.equal(JSON.stringify(payload).includes('x'.repeat(13000)),false);}
  assert.equal(ledger.get(first.id).eventBody,raw);assert.equal(ledger.get(first.id).status,'skipped');
  const pending=ledger.enqueue(job,new Date(Date.now()+1).toISOString(),{eventBody:raw});await runtime.destroy();runtime=new RawAgentRuntime(options);ledger=new RoutineRunStore(runtime.store);assert.equal(ledger.get(pending.id).eventBody,raw);await runtime.runScheduler();
  assert.equal(ledger.get(pending.id).status,'skipped');assert.equal(modelCalls,0);assert.equal(Object.hasOwn((await request('GET','/api/cron/runs/:id',pending.id)).run,'eventBody'),false);
 }finally{await runtime.destroy();}
});

test('deleted working approval context remains unknown and never resumes automatically [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {store,session,host}=fixture();let calls=0;
 host.runSession=async(id)=>{calls++;store.createApproval({sessionId:id,toolName:'bash',reason:'gated',args:{command:'true'}});store.updateSession(id,{status:'waiting_approval'});return store.getSession(id)};
 const job=createCronJob(host,{sessionId:session.id,name:'missing context',prompt:'write',intervalMs:60000});const runs=new RoutineRunStore(store);const run=runs.enqueue(job,new Date().toISOString());
 await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));const waiting=runs.get(run.id);assert.equal(waiting.status,'waiting_approval');
 assert.equal(store.deleteSession(waiting.sessionId),true);await drainRoutineRuns(host);assert.equal(runs.get(run.id).status,'unknown');assert.match(runs.get(run.id).error,/context disappeared/);assert.throws(()=>retryRoutineRun(host,run.id),/confirmUnknown/);await drainRoutineRuns(host);assert.equal(calls,1);store.db.close();
});

test('both synchronous and asynchronous executor failures retain a failed occurrence [AC:bot-routine-lifecycle#AC-3]',async()=>{
 for(const asynchronous of [false,true]){
  const {store,session,host}=fixture();host.runSession=()=>{if(asynchronous)return Promise.reject(new Error('executor rejected'));throw new Error('executor threw')};
  const job=createCronJob(host,{sessionId:session.id,name:'throw',prompt:'read',intervalMs:60000});const runs=new RoutineRunStore(store);const run=runs.enqueue(job,new Date().toISOString());await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));assert.equal(runs.get(run.id).status,'failed');assert.match(runs.get(run.id).error,asynchronous?/rejected/:/threw/);assert.ok(store.listMessages(session.id).some(m=>JSON.stringify(m).includes(run.id)));store.db.close();
 }
});

test('cancelling a recovered unknown occurrence preserves effect verification before retry [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {store,session,host}=fixture();const job=createCronJob(host,{sessionId:session.id,name:'interrupted effect',prompt:'write',intervalMs:60000});const runs=new RoutineRunStore(store);const run=runs.enqueue(job,new Date().toISOString());const working=store.createSession({title:'interrupted',mode:'chat',agentId:'general',metadata:{userId:'alice'}});store.updateSession(working.id,{status:'running'});runs.update(run.id,{status:'running',sessionId:working.id,startedAt:new Date().toISOString()});const path=store.dbPath;store.db.close();
 const reopened=new SqliteStateStore(path);let calls=0;const restored={...host,store:reopened,runSession:async()=>{calls++;}};const ledger=new RoutineRunStore(reopened);await drainRoutineRuns(restored);assert.equal(ledger.get(run.id).status,'unknown');assert.throws(()=>retryRoutineRun(restored,run.id),/confirmUnknown/);
 const cancelled=await cancelRoutineRun(restored,run.id);assert.equal(cancelled.status,'cancelled');assert.throws(()=>retryRoutineRun(restored,run.id),/confirmUnknown/);assert.equal(ledger.get(run.id).status,'cancelled');assert.equal(calls,0);const queued=retryRoutineRun(restored,run.id,{confirmUnknown:true});assert.equal(queued.status,'queued');assert.equal(queued.attempt,2);assert.equal(queued.requiresEffectVerification,false);reopened.db.close();
});

test('deadline stops admission and deletes only after in-flight completion [AC:bot-routine-lifecycle#AC-6]',async()=>{
 const {store,session,host}=fixture();let resolve;host.runSession=async id=>{await new Promise(r=>{resolve=r});store.appendMessage(id,'assistant',[{type:'text',text:'done'}]);};
 const job=createCronJob(host,{sessionId:session.id,name:'expiry',prompt:'check',intervalMs:60000,expiresAt:new Date(Date.now()+3600000).toISOString()});
 const runs=new RoutineRunStore(store);const run=runs.enqueue(job,new Date().toISOString());await drainRoutineRuns(host);
 const expired=host.cronStore.update(job.id,{expiresAt:new Date(Date.now()-1).toISOString(),nextRunAt:new Date(Date.now()-60000).toISOString()});
 assert.deepEqual(materializeRoutineOccurrences(host,host.cronStore,expired),[]);await tickCronJobs(host);assert.ok(host.cronStore.get(job.id));assert.equal(runs.list(job.id).length,1);
 resolve();await new Promise(r=>setImmediate(r));await tickCronJobs(host);assert.equal(host.cronStore.get(job.id),undefined);assert.equal(runs.get(run.id).status,'completed');store.db.close();
});
test('model silence suppresses main-chat notification [AC:bot-routine-lifecycle#AC-7]',async()=>{
 for(const text of ['[NO_UPDATE]','  [NO_UPDATE] no changes  ','ordinary report','prefix [NO_UPDATE]']){
 const {store,session,host}=fixture();host.runSession=async id=>{store.appendMessage(id,'assistant',[{type:'text',text}]);};
 const job=createCronJob(host,{sessionId:session.id,name:'silent',prompt:'check',intervalMs:60000});const runs=new RoutineRunStore(store);const run=runs.enqueue(job,new Date().toISOString());
 await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));await drainRoutineRuns(host);
 const silent=text.trim().startsWith('[NO_UPDATE]');assert.equal(runs.get(run.id).status,silent?'silent':'completed');assert.equal(store.listMessages(session.id).length,silent?0:1);
 assert.ok(store.listMessages(runs.get(run.id).sessionId).some(m=>m.role==='user'&&JSON.stringify(m).includes('[NO_UPDATE]')));store.db.close();
 }
});

test('expired disabled cron is removed on restart without catching up [AC:bot-routine-lifecycle#AC-6]',async()=>{
 const {store,session,host}=fixture();const job=createCronJob(host,{sessionId:session.id,name:'expired',prompt:'check',cron:'* * * * *',expiresAt:new Date(Date.now()+3600000).toISOString(),missedPolicy:'catch_up'});
 host.cronStore.update(job.id,{enabled:false,expiresAt:new Date(Date.now()-1).toISOString(),nextRunAt:new Date(Date.now()-600000).toISOString()});host.cronStore=undefined;
 await tickCronJobs(host);assert.equal(host.cronStore.get(job.id),undefined);assert.equal(new RoutineRunStore(store).list(job.id).length,0);store.db.close();
});
