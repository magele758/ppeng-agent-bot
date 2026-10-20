import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteStateStore} from '../dist/storage.js';
import {createCronJob} from '../dist/cron/cron-facade.js';
import {RoutineHealthStore,classifyRoutineFailure} from '../dist/cron/routine-health.js';
import {RoutineRunStore,materializeRoutineOccurrences,drainRoutineRuns} from '../dist/cron/routine-runtime.js';
import {cronRoutes} from '../../../apps/daemon/dist/routes/cron.js';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'routine-health-'));const store=new SqliteStateStore(join(dir,'db'));
 const parent=store.createSession({title:'owner',mode:'chat',agentId:'general',metadata:{userId:'owner'}});
 let calls=0;const host={store,stateDir:dir,log:{warn(){},info(){}},setCronStore(s){this.cronStore=s;},async runSession(id){calls++;store.appendMessage(id,'assistant',[{type:'text',text:'done'}]);}};
 const job=createCronJob(host,{sessionId:parent.id,name:'health',prompt:'inspect',intervalMs:60000});
 const health=new RoutineHealthStore(store);let seq=0;
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 return {store,dir,host,job,health,get calls(){return calls;},observe(status='failed',failureClass='hard',now=Date.now()){
  const run={id:`run-${++seq}`,attempt:1,routineId:job.id,job,status,error:'test failure',failureClass};health.observe(run,now);return run;
 }};
}
test('policy validates atomically and persists [AC:routine-failure-governance#AC-1]',t=>{
 const f=fixture(t);assert.equal(f.health.get(f.job.id).policy.hardFailureThreshold,7);
 f.health.configure(f.job.id,{hardFailureThreshold:3,maxBackoffMs:300000,notificationCooldownMs:900000});
 assert.throws(()=>f.health.configure(f.job.id,{hardFailureThreshold:0}));
 const reopened=new SqliteStateStore(join(f.dir,'db'));try{assert.equal(new RoutineHealthStore(reopened).get(f.job.id).policy.hardFailureThreshold,3);}finally{reopened.db.close();}
});
test('backoff blocks future automatic executions with capped delay [AC:routine-failure-governance#AC-2]',async t=>{
 const f=fixture(t),now=Date.now();f.health.configure(f.job.id,{hardFailureThreshold:100});
 f.observe('failed','transient',now);assert.equal(f.health.get(f.job.id).nextEligibleAt,undefined);
 for(let n=2;n<=9;n++){f.observe('failed','transient',now);assert.equal(f.health.get(f.job.id).nextEligibleAt,now+Math.min(120000*2**(n-2),3600000));}
 const due={...f.job,nextRunAt:new Date(now-1000).toISOString()};assert.deepEqual(materializeRoutineOccurrences(f.host,f.host.cronStore,due,now),[]);
 const runs=new RoutineRunStore(f.store);runs.enqueue(f.job,new Date(now).toISOString());await drainRoutineRuns(f.host);assert.equal(f.calls,0);
});
test('transient versus hard failure classification [AC:routine-failure-governance#AC-3]',t=>{
 const f=fixture(t);for(const err of [{status:429},{status:503},{code:'ETIMEDOUT'},{code:'ECONNRESET'}])assert.equal(classifyRoutineFailure(err),'transient');
 for(const err of [{status:401},{status:402},new Error('Precheck invalid')])assert.equal(classifyRoutineFailure(err),'hard');
 f.observe();f.observe('failed','transient');assert.equal(f.health.get(f.job.id).hardFailures,1);assert.equal(f.health.get(f.job.id).failures,2);
});
test('threshold pauses without generating further runs [AC:routine-failure-governance#AC-4]',t=>{
 const f=fixture(t);for(let i=0;i<7;i++)f.observe();const state=f.health.get(f.job.id);assert.equal(state.paused,true);assert.ok(state.pauseReason);
 assert.deepEqual(materializeRoutineOccurrences(f.host,f.host.cronStore,{...f.job,nextRunAt:new Date(0).toISOString()},Date.now()+86400000),[]);
});
test('private failure notices deduplicate incidents and cooldown [AC:routine-failure-governance#AC-5]',t=>{
 const f=fixture(t),now=Date.now();f.observe('failed','hard',now);f.observe('failed','hard',now+1000);assert.equal(f.health.get(f.job.id).notices.length,1);
 f.observe('completed','hard',now+2000);f.observe('failed','hard',now+3000);assert.equal(f.health.get(f.job.id).notices.filter(n=>n.kind==='failure').length,1);
 assert.equal(f.store.listMessages(f.job.sessionId).length,0);
});
test('successful recovery clears counters and publishes once [AC:routine-failure-governance#AC-6]',t=>{
 const f=fixture(t);f.observe();f.observe();const run=f.observe('completed');f.health.observe(run);f.observe('completed');const state=f.health.get(f.job.id);
 assert.equal(state.failures,0);assert.equal(state.hardFailures,0);assert.equal(state.nextEligibleAt,undefined);assert.equal(state.notices.filter(n=>n.kind==='recovery').length,1);
});
test('neutral states preserve failure episode [AC:routine-failure-governance#AC-7]',t=>{
 const f=fixture(t);f.observe();const before=f.health.get(f.job.id);
 for(const status of ['skipped','silent','cancelled','waiting_approval','unknown'])f.observe(status);
 assert.deepEqual(f.health.get(f.job.id),before);
});
test('explicit resume drops missed triggers without catchup [AC:routine-failure-governance#AC-8]',t=>{
 const f=fixture(t),now=Date.now();f.health.configure(f.job.id,{hardFailureThreshold:1});f.observe();f.health.resume(f.job.id,now);
 const state=f.health.get(f.job.id);assert.equal(state.paused,false);assert.equal(state.failures,0);
 const old={...f.job,missedPolicy:'catch_up',nextRunAt:new Date(now-86400000).toISOString()};assert.deepEqual(materializeRoutineOccurrences(f.host,f.host.cronStore,old,now),[]);
 assert.ok(Date.parse(f.host.cronStore.get(f.job.id).nextRunAt)>now);
});
test('restart and peer processing retain pause and deduplicate outcomes [AC:routine-failure-governance#AC-9]',async t=>{
 const f=fixture(t);f.health.configure(f.job.id,{hardFailureThreshold:1});const run=f.observe();
 const peer=new SqliteStateStore(join(f.dir,'db'));try{const health=new RoutineHealthStore(peer);health.observe(run);assert.equal(health.get(f.job.id).hardFailures,1);assert.equal(health.get(f.job.id).paused,true);assert.equal(health.get(f.job.id).notices.length,1);}finally{peer.db.close();}
 const runs=new RoutineRunStore(f.store);const unknown=runs.enqueue(f.job,new Date().toISOString(),{status:'unknown'});await drainRoutineRuns(f.host);assert.equal(runs.get(unknown.id).status,'unknown');assert.equal(f.calls,0);
});
test('foreign users cannot read notices configure or resume [AC:routine-failure-governance#AC-10] [AC:routine-strict-precheck#AC-8]',async t=>{
 const f=fixture(t);f.observe();const before=f.health.get(f.job.id);
 const runtime={...f.host,getSession:id=>f.store.getSession(id),getCronJob:id=>f.host.cronStore.get(id),listCronJobs:()=>f.host.cronStore.list()};
 for(const [method,pattern] of [['GET','/api/cron/jobs/:id/health'],['PATCH','/api/cron/jobs/:id/health'],['POST','/api/cron/jobs/:id/resume']]){
  const route=cronRoutes(runtime).find(r=>r.method===method&&r.pattern===pattern);assert.ok(route);let status;
  await route.handler({auth:{isolate:true,user:{id:'other'}},requireParam:()=>f.job.id,readBody:async()=>({hardFailureThreshold:1}),response:{setHeader(){},set statusCode(s){status=s;},end(){}}});assert.equal(status,404);
 }
 assert.deepEqual(f.health.get(f.job.id),before);
 const runs=new RoutineRunStore(f.store),run=runs.enqueue(f.job,new Date().toISOString());runs.update(run.id,{precheckState:{privateCursor:123}});
 const read=cronRoutes(runtime).find(r=>r.method==='GET'&&r.pattern==='/api/cron/runs/:id');let status,payload;
 await read.handler({auth:{isolate:true,user:{id:'other'}},requireParam:()=>run.id,response:{setHeader(){},set statusCode(value){status=value;},end(value){payload=value;}}});
 assert.equal(status,404);assert.ok(!payload.includes('privateCursor'));
});
test('real execution failure and successful retry update governance [AC:routine-failure-governance#AC-3] [AC:routine-failure-governance#AC-6]',async t=>{
 const f=fixture(t);const runs=new RoutineRunStore(f.store);f.host.runSession=async()=>{throw Object.assign(new Error('upstream unavailable'),{status:503});};
 const first=runs.enqueue(f.job,new Date().toISOString());await drainRoutineRuns(f.host);await new Promise(r=>setImmediate(r));
 assert.equal(runs.get(first.id).failureClass,'transient');assert.equal(f.health.get(f.job.id).hardFailures,0);assert.equal(f.health.get(f.job.id).notices.length,1);
 f.host.runSession=async id=>{f.store.appendMessage(id,'assistant',[{type:'text',text:'recovered'}]);};
 const {retryRoutineRun}=await import('../dist/cron/routine-runtime.js');retryRoutineRun(f.host,first.id);await drainRoutineRuns(f.host);await new Promise(r=>setImmediate(r));
 assert.equal(runs.get(first.id).status,'completed');assert.equal(f.health.get(f.job.id).failures,0);assert.equal(f.health.get(f.job.id).notices.at(-1).kind,'recovery');
});
test('adapter error messages retain upstream and billing classification [AC:routine-failure-governance#AC-3]',()=>{
 assert.equal(classifyRoutineFailure(new Error('Remote adapter request failed with 503: unavailable')),'transient');
 assert.equal(classifyRoutineFailure({status:429,code:'insufficient_quota'}),'hard');
 assert.equal(classifyRoutineFailure(new Error('OpenAI stream failed 429: insufficient_quota')),'hard');
 assert.equal(classifyRoutineFailure({name:'TimeoutError'}),'transient');
 const a={};const b={cause:a};a.cause=b;assert.equal(classifyRoutineFailure(a),'hard');
});
