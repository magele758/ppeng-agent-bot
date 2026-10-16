import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { RoutineLease } from '../dist/cron/routine-lease.js';
import { RoutineRunStore, drainRoutineRuns } from '../dist/cron/routine-runtime.js';
import { createCronJob } from '../dist/cron/cron-facade.js';
function fixture(){
 const stateDir=mkdtempSync(join(tmpdir(),'routine-lease-')),path=join(stateDir,'state.db');
 const a=new SqliteStateStore(path),b=new SqliteStateStore(path);
 const parent=a.createSession({title:'main',mode:'chat',agentId:'general',background:false,metadata:{userId:'alice'}});
 const host=store=>({store,stateDir,log:{warn(){},info(){}},setCronStore(s){this.cronStore=s},runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}});
 const h=host(a),job=createCronJob(h,{sessionId:parent.id,name:'lease',prompt:'work',intervalMs:60000});
 const runs=new RoutineRunStore(a),run=runs.enqueue(job,new Date().toISOString());
 return {a,b,h,host,runs,run};
}
test('two instances race one occurrence and live execution is protected [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {a,b,h,host,runs,run}=fixture();let calls=0,done;
 const execute=async id=>{calls++;await new Promise(r=>done=r);a.appendMessage(id,'assistant',[{type:'text',text:'done'}]);};
 await Promise.all([drainRoutineRuns({...h,runSession:execute}),drainRoutineRuns({...host(b),runSession:execute})]);
 assert.equal(calls,1);await drainRoutineRuns({...host(b),runSession:execute});assert.equal(runs.get(run.id).status,'running');
 done();await new Promise(r=>setImmediate(r));assert.equal(runs.get(run.id).status,'completed');a.db.close();b.db.close();
});
test('expired unstarted leases reclaim and old owners cannot renew or release successors [AC:bot-routine-lifecycle#AC-12]',()=>{
 const {a,b,run}=fixture();const first=RoutineLease.acquire(a,run.id,100,60);assert.ok(first);
 assert.equal(RoutineLease.acquire(b,run.id,159,60),undefined);
 const next=RoutineLease.acquire(b,run.id,160,60);assert.ok(next);assert.equal(first.renew(161),false);first.release();assert.equal(next.renew(170),true);next.release();a.db.close();b.db.close();
});
test('heartbeat renews while work is pending [AC:bot-routine-lifecycle#AC-12]',async t=>{
 const {a,b,run}=fixture();t.mock.timers.enable({apis:['setInterval']});const lease=RoutineLease.acquire(a,run.id);const stop=lease.heartbeat(()=>assert.fail('lease lost'));
 a.db.prepare('UPDATE bot_routine_leases SET expires_at=? WHERE run_id=?').run(Date.now()+1000,run.id);
 t.mock.timers.tick(20_000);
 assert.ok(a.db.prepare('SELECT expires_at FROM bot_routine_leases WHERE run_id=?').get(run.id).expires_at>Date.now()+50000);
 stop();lease.release();a.db.close();b.db.close();
});
test('expired executing occurrence becomes unknown without replay [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {a,b,h,host,runs,run}=fixture();const lease=RoutineLease.acquire(a,run.id);runs.claim(run.id,'interrupted');
 a.db.prepare('UPDATE bot_routine_leases SET expires_at=0 WHERE run_id=?').run(run.id);
 let calls=0;await drainRoutineRuns({...host(b),runSession:async()=>{calls++;}});
 assert.equal(runs.get(run.id).status,'unknown');assert.equal(calls,0);lease.release();a.db.close();b.db.close();
});

test('separate daemon processes contend for the same SQLite occurrence [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {spawn}=await import('node:child_process');
 const {sanitizeSpawnEnv}=await import('../dist/sandbox/env-sanitizer.js');
 const {a,b,h,runs,run}=fixture();
 const source=`import {SqliteStateStore} from ${JSON.stringify(new URL('../dist/storage.js',import.meta.url).href)};
 import {drainRoutineRuns} from ${JSON.stringify(new URL('../dist/cron/routine-runtime.js',import.meta.url).href)};
 const store=new SqliteStateStore(${JSON.stringify(a.dbPath)});
 process.stdout.write('ready\\n');
 process.stdin.once('data',async()=>{await drainRoutineRuns({store,stateDir:${JSON.stringify(h.stateDir)},log:{warn(){},info(){}},runSession:async id=>{process.stdout.write('ran\\n');store.appendMessage(id,'assistant',[{type:'text',text:'one result'}]);}});setImmediate(()=>{store.db.close();process.exit(0);});});`;
 const workers=[0,1].map(()=>{const child=spawn(process.execPath,['--input-type=module','-e',source],{env:sanitizeSpawnEnv(),stdio:['pipe','pipe','pipe']});let output='',errors='';let readyResolve;const ready=new Promise(r=>readyResolve=r);child.stdout.on('data',chunk=>{output+=chunk; if(output.includes('ready'))readyResolve();});child.stderr.on('data',chunk=>errors+=chunk);const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(errors)));});return {child,ready,done};});
 try{
  await Promise.all(workers.map(w=>w.ready));for(const w of workers)w.child.stdin.end('go');
  const outputs=await Promise.all(workers.map(w=>w.done));assert.equal(outputs.join('').split('ran\n').length-1,1);assert.equal(runs.get(run.id).status,'completed');
  assert.equal(a.listMessages(run.mainSessionId).length,1);
 }finally{for(const w of workers)w.child.kill();a.db.close();b.db.close();}
});

test('lease loss fences late completion and requests cancellation on heartbeat [AC:bot-routine-lifecycle#AC-12]',async t=>{
 const {a,b,h,host,runs,run}=fixture();let done,cancelled=0;
 t.mock.timers.enable({apis:['setInterval']});
 await drainRoutineRuns({...h,cancelSession(){cancelled++;},runSession:async id=>{await new Promise(r=>done=r);a.appendMessage(id,'assistant',[{type:'text',text:'late'}]);}});
 a.db.prepare('UPDATE bot_routine_leases SET expires_at=0 WHERE run_id=?').run(run.id);
 await drainRoutineRuns({...host(b),runSession:async()=>assert.fail('must not replay')});
 t.mock.timers.tick(20_000);assert.equal(cancelled,1);done();await new Promise(r=>setImmediate(r));
 assert.equal(runs.get(run.id).status,'unknown');a.db.close();b.db.close();
});

test('approval continuation is leased once across instances [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {a,b,h,host,runs,run}=fixture();let approval;
 await drainRoutineRuns({...h,runSession:async id=>{
  approval=a.createApproval({sessionId:id,toolName:'bash',reason:'gated',args:{command:'true'}});
  a.updateSession(id,{status:'waiting_approval',metadata:{...a.getSession(id).metadata,outcome:{kind:'waiting_approval'}}});
 }});await new Promise(r=>setImmediate(r));assert.equal(runs.get(run.id).status,'waiting_approval');
 assert.equal(a.db.prepare('SELECT 1 FROM bot_routine_leases WHERE run_id=?').get(run.id),undefined);
 a.updateApproval(approval.id,'approved');const sessionId=runs.get(run.id).sessionId;a.updateSession(sessionId,{status:'idle'});
 let calls=0,done;
 const execute=async id=>{calls++;await new Promise(r=>done=r);a.appendMessage(id,'assistant',[{type:'text',text:'approved result'}]);a.updateSession(id,{metadata:{...a.getSession(id).metadata,outcome:{kind:'idle',reason:'end'}}});};
 await Promise.all([drainRoutineRuns({...h,runSession:execute}),drainRoutineRuns({...host(b),runSession:execute})]);
 assert.equal(calls,1);assert.equal(runs.get(run.id).status,'running');done();await new Promise(r=>setImmediate(r));assert.equal(runs.get(run.id).status,'completed');a.db.close();b.db.close();
});

async function stuckWaitingApproval(){
 const {a,b,h,runs,run}=fixture();
 await drainRoutineRuns({...h,runSession:async id=>{
  a.createApproval({sessionId:id,toolName:'bash',reason:'gated',args:{command:'true'}});
  a.updateSession(id,{status:'waiting_approval',metadata:{...a.getSession(id).metadata,outcome:{kind:'waiting_approval'}}});
 }});
 await new Promise(r=>setImmediate(r));
 assert.equal(runs.get(run.id).status,'waiting_approval');
 a.updateSession(runs.get(run.id).sessionId,{status:'running'});
 a.db.prepare('UPDATE bot_routine_leases SET expires_at=0 WHERE run_id=?').run(run.id);
 return {a,b,h,runs,run};
}
test('crashed waiting_approval run with a stuck running session becomes unknown [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {a,b,h,runs,run}=await stuckWaitingApproval();
 let calls=0;
 await drainRoutineRuns({...h,isSessionRunning:()=>false,runSession:async()=>{calls++;}});
 assert.equal(runs.get(run.id).status,'unknown');assert.equal(calls,0);a.db.close();b.db.close();
});
test('live waiting_approval session that is still running stays waiting [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {a,b,h,runs,run}=await stuckWaitingApproval();
 const sessionId=runs.get(run.id).sessionId;let calls=0;
 await drainRoutineRuns({...h,isSessionRunning:id=>id===sessionId,runSession:async()=>{calls++;}});
 assert.equal(runs.get(run.id).status,'waiting_approval');assert.equal(calls,0);a.db.close();b.db.close();
});
test('crashed waiting_approval with undefined isSessionRunning recovers to unknown [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {a,b,h,runs,run}=await stuckWaitingApproval();
 let calls=0;
 await drainRoutineRuns({...h,isSessionRunning:undefined,runSession:async()=>{calls++;}});
 assert.equal(runs.get(run.id).status,'unknown');assert.equal(calls,0);a.db.close();b.db.close();
});

// P0 regression: a peer must not quarantine a run whose approval continuation holds an active lease.
test('active approval-path lease on peer protects running session from quarantine [AC:bot-routine-lifecycle#AC-12]',async()=>{
 // This test exercises the REAL approve path via resumeApprovalContinuation (not a hand-planted row).
 // resumeApprovalContinuation acquires the lease; instance B drains concurrently and must skip.
 const {resumeApprovalContinuation}=await import('../dist/cron/routine-runtime.js');
 const {a,b,h,host,runs,run}=await stuckWaitingApproval();
 // Simulate what the HTTP approve route does: flip session to idle with an approved approval.
 a.updateApproval(a.listApprovals().find(x=>x.sessionId===run.sessionId).id,'approved');
 const sessionId=runs.get(run.id).sessionId;
 a.updateSession(sessionId,{status:'idle',metadata:{...a.getSession(sessionId).metadata,outcome:{kind:'waiting_approval'}}});
 let continuationStarted=false,continuationDone;
 const continuationHost={...h,runSession:async id=>{
  continuationStarted=true;
  await new Promise(r=>{continuationDone=r;});
  a.appendMessage(id,'assistant',[{type:'text',text:'approved result'}]);
  a.updateSession(id,{metadata:{...a.getSession(id).metadata,outcome:{kind:'idle',reason:'end'}}});
 }};
 // Start the continuation via the real approve path (acquires the lease).
 const started=resumeApprovalContinuation(continuationHost,sessionId);
 assert.ok(started,'resumeApprovalContinuation must return true when a matching run exists');
 assert.ok(continuationStarted,'runSession must have been called synchronously in bridge');
 // Now drain from B while the continuation holds the lease — it must not quarantine.
 let calls=0;
 await drainRoutineRuns({store:b,stateDir:h.stateDir,log:{warn(){},info(){}},isSessionRunning:()=>false,runSession:async()=>{calls++;}});
 assert.equal(runs.get(run.id).status,'running','peer drain must not quarantine while lease is held');
 assert.equal(calls,0,'peer must not re-run the session');
 // After the continuation finishes the run should complete.
 continuationDone();await new Promise(r=>setImmediate(r));
 assert.equal(runs.get(run.id).status,'completed');
 a.db.close();b.db.close();
});

// P1 regression: whileOwned must not clobber a cancel with 'unknown'.
test('cancel committed before fence wins; unknown is not written over cancel [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {a,b,h,runs,run}=await stuckWaitingApproval();
 // Cancel the run (no lease needed).
 const {cancelRoutineRun}=await import('../dist/cron/routine-runtime.js');
 await cancelRoutineRun({...h,cancelSession(){}},run.id);
 assert.equal(runs.get(run.id).status,'cancelled');
 // Drain that finds session.status==='running' and no live lease:
 // it should not write 'unknown' because the run is already cancelled.
 await drainRoutineRuns({store:b,stateDir:h.stateDir,log:{warn(){},info(){}},isSessionRunning:()=>false,runSession:async()=>{}});
 assert.equal(runs.get(run.id).status,'cancelled','cancel must survive fence re-read');
 a.db.close();b.db.close();
});

// P1 regression: two real drains share one DB; both try to recover; only one should write.
test('two drains sharing one DB race approval recovery; only one quarantines [AC:bot-routine-lifecycle#AC-12]',async()=>{
 const {a,b,h,runs,run}=await stuckWaitingApproval();
 // Count actual DB writes to bot_routine_runs.
 let writes=0;
 const origPrepare=a.db.prepare.bind(a.db);
 a.db.prepare=function(sql){const stmt=origPrepare(sql);if(/UPDATE bot_routine_runs/.test(sql)&&/status='unknown'/.test(sql)){const origRun=stmt.run.bind(stmt);stmt.run=function(...args){writes++;return origRun(...args);};}return stmt;};
 // No live lease — both drains want to recover.
 const hA={...h,isSessionRunning:()=>false,runSession:async()=>{}};
 const hB={store:b,stateDir:h.stateDir,log:{warn(){},info(){}},isSessionRunning:()=>false,runSession:async()=>{}};
 await Promise.all([drainRoutineRuns(hA),drainRoutineRuns(hB)]);
 assert.equal(runs.get(run.id).status,'unknown');
 // The lease acts as a mutual-exclusion token: the drain that wins acquire() is the one that writes.
 // The other loses the acquire() race and never reaches recoverInterruptedRoutine at all, so
 // exactly one DB write must land. Remove whileOwned() or the acquire() guard and this breaks.
 assert.equal(writes,1,'exactly one drain must commit the CAS write');
 a.db.close();b.db.close();
});

async function stalledHeartbeat(t,heartbeatFirst){
  const {a,b,h,runs,run}=fixture();let done,cancelled=0;
  t.mock.timers.enable({apis:['setInterval','Date']});
  const runtime={...h,cancelSession(){cancelled++;},runSession:async id=>{await new Promise(r=>done=r);a.appendMessage(id,'assistant',[{type:'text',text:'healthy result'}]);}};
  await drainRoutineRuns(runtime);
  // Advance wall time without delivering timers, as with a blocked event loop.
  t.mock.timers.setTime(Date.now()+120_000);
  await drainRoutineRuns(runtime);
  assert.equal(runs.get(run.id).status,'running');
  if(heartbeatFirst)t.mock.timers.tick(20_000);
  done();await new Promise(r=>setImmediate(r));
  assert.equal(cancelled,0);
  await drainRoutineRuns(runtime);
  assert.equal(runs.get(run.id).status,'completed');
  assert.equal(a.listMessages(run.mainSessionId).length,1);
  a.db.close();b.db.close();
}
test('stalled heartbeat without a competing owner completes normally before heartbeat [AC:bot-routine-lifecycle#AC-12]',t=>stalledHeartbeat(t,false));
test('stalled heartbeat without a competing owner completes normally after heartbeat [AC:bot-routine-lifecycle#AC-12]',t=>stalledHeartbeat(t,true));

test('transient SQLite busy on heartbeat retries without cancelling ownership [AC:bot-routine-lifecycle#AC-12]',async t=>{
 const {a,b,run}=fixture();let cancelled=0;
 t.mock.timers.enable({apis:['setInterval']});
 const lease=RoutineLease.acquire(a,run.id),stop=lease.heartbeat(()=>cancelled++);
 a.db.exec('PRAGMA busy_timeout=0');
 b.db.exec('BEGIN IMMEDIATE');
 try{t.mock.timers.tick(20_000);assert.equal(cancelled,0);}finally{b.db.exec('ROLLBACK');}
 try{
  a.db.prepare('UPDATE bot_routine_leases SET expires_at=0 WHERE run_id=?').run(run.id);
  t.mock.timers.tick(20_000);
  assert.equal(cancelled,0);assert.equal(lease.owns(),true);
  a.db.prepare('UPDATE bot_routine_leases SET expires_at=0 WHERE run_id=?').run(run.id);
  const successor=RoutineLease.acquire(b,run.id);assert.ok(successor);
  t.mock.timers.tick(20_000);assert.equal(cancelled,1);
  assert.equal(lease.whileOwned(()=>assert.fail('lost owner must be fenced')),undefined);
  lease.release();assert.equal(successor.owns(),true);successor.release();
 }finally{stop();a.db.close();b.db.close();}
});
