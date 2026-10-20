import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import { createCronJob, updateCronJob } from '../dist/cron/cron-facade.js';
import { CronJobStore } from '../dist/cron/cron-store.js';
import { RoutineRunStore, drainRoutineRuns } from '../dist/cron/routine-runtime.js';
import { evaluateRoutinePrecheck, readStoredPrecheck } from '../dist/cron/routine-precheck.js';
function fixture(t){
 const stateDir=mkdtempSync(join(tmpdir(),'strict-precheck-'));let store=new SqliteStateStore(join(stateDir,'db'));let count=0,seq=0;
 const parent=store.createSession({title:'owner',mode:'chat',agentId:'general',metadata:{userId:'u1'}});
 const host={store,stateDir,log:{warn(){},info(){}},setCronStore(s){this.cronStore=s;},async runSession(id){count++;host.store.appendMessage(id,'assistant',[{type:'text',text:'done'}]);}};
 const job=createCronJob(host,{sessionId:parent.id,name:'check',prompt:'inspect',intervalMs:60000,precheck:{kind:'predicate',source:'{"wakeAgent":true}'}});
 t.after(()=>{host.store.db.close();rmSync(stateDir,{recursive:true,force:true});});
 return {host,job,get count(){return count;},reopen(){host.store.db.close();host.store=new SqliteStateStore(join(stateDir,'db'));},async run(source){
  const current=source===undefined?host.cronStore.get(job.id):updateCronJob(host,job.id,{precheck:{kind:'predicate',source,mode:'strict'}});
  const runs=new RoutineRunStore(host.store),run=runs.enqueue(current,new Date(Date.now()+seq++).toISOString());
  await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));return runs.get(run.id);
 }};
}
test('new prechecks strict, legacy preserved and explicit upgrade persisted [AC:routine-strict-precheck#AC-1]',t=>{
 const f=fixture(t);assert.equal(readStoredPrecheck(f.job.metadata).mode,'strict');
 const legacy=new CronJobStore(f.host.stateDir).create({...f.job,metadata:{precheck:{kind:'predicate',source:'log'}}});
 assert.equal(readStoredPrecheck(legacy.metadata).mode,'compat');
 updateCronJob(f.host,legacy.id,{precheck:{kind:'predicate',source:'log',mode:'strict'}});
 assert.equal(readStoredPrecheck(new CronJobStore(f.host.stateDir).get(legacy.id).metadata).mode,'strict');
});
test('valid true runs with inherited permission [AC:routine-strict-precheck#AC-2]',async t=>{
 const f=fixture(t),run=await f.run();assert.equal(f.count,1);assert.equal(run.status,'completed');assert.equal(f.host.store.getSession(run.sessionId).metadata.permissionMode,'ask');
 assert.equal(readStoredPrecheck(run.job.metadata).mode,'strict');
});
test('false is no-change not failure [AC:routine-strict-precheck#AC-3]',async t=>{
 const f=fixture(t),run=await f.run('{"wakeAgent":false}');assert.equal(f.count,0);assert.equal(run.status,'skipped');assert.equal(run.precheckOutcome,'no_change');
});
test('invalid output never wakes [AC:routine-strict-precheck#AC-4]',async t=>{
 for(const source of ['log','{}','{"wakeAgent":"true"}','null']){const f=fixture(t);const run=await f.run(source);assert.equal(run.status,'failed');assert.match(run.error,/Precheck/);}
 const empty=await evaluateRoutinePrecheck({kind:'predicate',source:'',mode:'strict'});assert.equal(empty.wakeAgent,false);assert.ok(empty.reason);
});
test('process failure overrides a true result and keeps isolation [AC:routine-strict-precheck#AC-5]',async()=>{
 for(const source of ['printf \'{"wakeAgent":true}\'; exit 2','kill -TERM $$']){const gate=await evaluateRoutinePrecheck({kind:'script',source,mode:'strict'});assert.equal(gate.wakeAgent,false);assert.ok(gate.reason);}
 const gate=await evaluateRoutinePrecheck({kind:'script',source:'printf \'{"wakeAgent":false}\'',mode:'strict'});assert.equal(gate.wakeAgent,false);
});
test('cursor persists after no-change, restart and absent update [AC:routine-strict-precheck#AC-6]',async t=>{
 const f=fixture(t);await f.run('{"wakeAgent":false,"state":{"offset":42}}');f.reopen();
 const r=await f.run('{"wakeAgent":false}');assert.deepEqual(r.precheckState,{offset:42});
 const job=updateCronJob(f.host,f.job.id,{precheck:{kind:'script',mode:'strict',source:'test "$PPENG_PRECHECK_STATE" = \'{"offset":42}\' && printf \'{"wakeAgent":true}\''}});
 const runs=new RoutineRunStore(f.host.store),run=runs.enqueue(job,new Date(Date.now()+1000).toISOString());await drainRoutineRuns(f.host);await new Promise(r=>setImmediate(r));assert.equal(runs.get(run.id).status,'completed');
});
test('failed state writes or oversized cursors retain prior state [AC:routine-strict-precheck#AC-7]',async t=>{
 const f=fixture(t);await f.run('{"wakeAgent":false,"state":7}');
 const oversized=await evaluateRoutinePrecheck({kind:'predicate',mode:'strict',source:JSON.stringify({wakeAgent:true,state:'x'.repeat(17000)})});assert.equal(oversized.wakeAgent,false);assert.ok(oversized.reason);
 f.host.store.db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE ON routine_precheck_state BEGIN SELECT RAISE(ABORT,'write failed'); END");
 const failed=await f.run('{"wakeAgent":true,"state":8}');assert.equal(failed.status,'failed');assert.equal(f.count,0);
 f.host.store.db.exec('DROP TRIGGER reject_cursor');const next=await f.run('{"wakeAgent":false}');assert.equal(next.precheckState,7);
});
test('different tasks do not share cursor progress [AC:routine-strict-precheck#AC-8]',async t=>{
 const f=fixture(t);await f.run('{"wakeAgent":false,"state":123}');
 const other=createCronJob(f.host,{sessionId:f.job.sessionId,name:'other',prompt:'inspect',intervalMs:60000,precheck:{kind:'predicate',source:'{"wakeAgent":false}'}});
 const runs=new RoutineRunStore(f.host.store),run=runs.enqueue(other,new Date().toISOString());await drainRoutineRuns(f.host);assert.equal(runs.get(run.id).precheckState,undefined);
 assert.equal(runs.get(run.id).precheckOutcome,'no_change');
});
test('manual retry cannot bypass a failed strict precheck [AC:routine-strict-precheck#AC-4]',async t=>{
 const f=fixture(t);const failed=await f.run('invalid');
 const {retryRoutineRun}=await import('../dist/cron/routine-runtime.js');retryRoutineRun(f.host,failed.id);
 await drainRoutineRuns(f.host);await new Promise(r=>setImmediate(r));
 assert.equal(f.count,0);assert.equal(new RoutineRunStore(f.host.store).get(failed.id).status,'failed');
});
test('timeout remains failure even when script traps termination and exits zero [AC:routine-strict-precheck#AC-5]',async()=>{
 const gate=await evaluateRoutinePrecheck({kind:'script',mode:'strict',source:`trap 'printf '\''{"wakeAgent":true}'\''; exit 0' TERM; while :; do sleep 1; done`});
 assert.equal(gate.wakeAgent,false);assert.ok(gate.reason);
});
