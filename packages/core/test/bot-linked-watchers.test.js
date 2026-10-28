import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {createBot} from '../dist/bots/index.js';
import {BotGoalService} from '../dist/bots/goals/service.js';
import {createCronJob,updateCronJob} from '../dist/cron/cron-facade.js';
import {RoutineRunStore,drainRoutineRuns} from '../dist/cron/routine-runtime.js';

function fixture(t,execute){
 const dir=mkdtempSync(join(tmpdir(),'linked-watch-')),store=new SqliteStateStore(join(dir,'state.db'));
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 let turns=0,sop='CURRENT SOP V1';
 const host={store,stateDir:dir,log:{warn(){},info(){}},setCronStore(s){this.cronStore=s;},runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},loadRoutineSkill:async()=>({content:sop}),runSession:async id=>{turns++;await execute?.(store,id);return store.getSession(id);}};
 const bot=createBot(host,{name:'Worker'}),sid=bot.canonicalSessionId,goals=new BotGoalService(store,Date.now,sid);
 const goal=goals.create({botId:bot.id,sessionId:sid,title:'Ship feature',objective:'Develop, review and merge',constraints:['never replay completed writes']});
 const job=()=>createCronJob(host,{botId:bot.id,name:'watch',prompt:'OLD COPIED SOP',intervalMs:60000,workLink:{goalId:goal.id,sopSkill:'delivery-sop'}});
 async function run(j){const rs=new RoutineRunStore(store),r=rs.enqueue(j,new Date().toISOString(),{key:Math.random().toString()});await drainRoutineRuns(host);await new Promise(resolve=>setImmediate(resolve));return rs.get(r.id);}
 return {host,store,bot,sid,goals,goal,job,run,turns:()=>turns,sop:value=>{sop=value;}};
}
const answer=(store,id,value)=>store.appendMessage(id,'assistant',[{type:'text',text:value}]);
const observe=(store,id,ok=true)=>store.appendMessage(id,'tool',[{type:'tool_result',name:'bg_check',toolCallId:'observation',ok,content:ok?'current observation':'check failed'}]);

test('watch links persist, reject foreign goals and can be cleared [AC:bot-linked-watchers#AC-1] [AC:bot-linked-watchers#AC-6]',async t=>{
 const f=fixture(t);const j=f.job();assert.equal(j.metadata.workLink.goalId,f.goal.id);
 const peer=createBot(f.host,{name:'Other'}),foreign=new BotGoalService(f.store,Date.now,peer.canonicalSessionId).create({botId:peer.id,sessionId:peer.canonicalSessionId,title:'private',objective:'private'});
 assert.throws(()=>createCronJob(f.host,{botId:f.bot.id,name:'bad',prompt:'bad',intervalMs:60000,workLink:{goalId:foreign.id}}),/goal|work/i);
 assert.equal(updateCronJob(f.host,j.id,{workLink:null}).metadata.workLink,undefined);
});
test('verified terminal goals retire only their own watcher [AC:bot-linked-watchers#AC-2]',async t=>{
 const f=fixture(t),j=f.job();const execution=f.goals.claim(f.bot.id,f.goal.id,{strategy:'direct'});
 f.goals.report(f.bot.id,execution.id,{kind:'candidate_completed',summary:'all verified',verified:true,evidence:['confirmed merge']});
 const health=createCronJob(f.host,{botId:f.bot.id,name:'health',prompt:'health',intervalMs:60000});
 const r=await f.run(j);assert.equal(f.turns(),0);assert.equal(r.status,'skipped');
 assert.equal(f.host.cronStore.get(j.id).enabled,false);assert.equal(f.host.cronStore.get(health.id).enabled,true);
 assert.ok(new RoutineRunStore(f.store).get(r.id));
});
test('next execution uses live work revision and SOP with recorded fingerprint [AC:bot-linked-watchers#AC-3]',async t=>{
 const f=fixture(t,(store,id)=>{const prompt=store.listMessages(id).filter(m=>m.role==='user').at(-1).parts[0].text;assert.match(prompt,/CURRENT SOP V2/);assert.match(prompt,/new local constraint/);observe(store,id);answer(store,id,'checked');});
 const j=f.job();f.goals.amend(f.bot.id,f.goal.id,'new local constraint');f.sop('CURRENT SOP V2');
 const r=await f.run(j);assert.equal(r.status,'completed');assert.equal(r.workSnapshot.goalRevision,2);assert.match(r.workSnapshot.sopHash,/^[a-f0-9]{64}$/);
 f.host.loadRoutineSkill=async()=>({error:'revoked'});const failed=await f.run(j);assert.equal(failed.status,'failed');assert.match(failed.error,/revoked/);assert.equal(f.turns(),1);
});
test('quiet without an observation is unverified, real successful observation can be quiet [AC:bot-linked-watchers#AC-4]',async t=>{
 let check=false;const f=fixture(t,(store,id)=>{if(check)observe(store,id);answer(store,id,'[NO_UPDATE]');});const j=f.job();
 const empty=await f.run(j);assert.equal(empty.status,'failed');assert.match(empty.error,/observ/i);
 check=true;const checked=await f.run(j);assert.equal(checked.status,'silent');assert.ok(checked.workSnapshot.observedAt);
});
test('linked external job keeps identity and cannot complete the goal from idle [AC:bot-linked-watchers#AC-5]',async t=>{
 const f=fixture(t,(store,id)=>answer(store,id,'[NO_UPDATE]'));
 const bg=f.store.createBackgroundJob({sessionId:f.sid,command:'external build',status:'running'});
 const j=createCronJob(f.host,{botId:f.bot.id,name:'external watch',prompt:'check',intervalMs:60000,workLink:{goalId:f.goal.id,backgroundJobId:bg.id}});
 const r=await f.run(j);assert.equal(r.workSnapshot.externalJob.id,bg.id);assert.equal(r.workSnapshot.externalJob.createdAt,bg.createdAt);assert.equal(r.workSnapshot.externalJob.status,'running');assert.notEqual(f.goals.get(f.bot.id,f.goal.id).status,'completed');
 f.store.db.prepare('DELETE FROM background_jobs WHERE id=?').run(bg.id);const missing=await f.run(j);assert.equal(missing.status,'failed');assert.match(missing.error,/job/i);
});
test('parked watch refreshes its SOP before it gets the writer [AC:bot-linked-watchers#AC-3]',async t=>{
 const f=fixture(t,(store,id)=>{const prompt=store.listMessages(id).filter(m=>m.role==='user').at(-1).parts[0].text;assert.match(prompt,/CURRENT SOP V3/);assert.equal(store.listUnclaimedInbox(id).length,0);observe(store,id);answer(store,id,'fresh');});
 const j=f.job(),runs=new RoutineRunStore(f.store),r=runs.enqueue(j,new Date().toISOString());
 f.store.updateSession(f.sid,{status:'running'});await drainRoutineRuns(f.host);assert.equal(f.store.listUnclaimedInbox(f.sid).length,1);
 f.sop('CURRENT SOP V3');f.store.updateSession(f.sid,{status:'idle'});await drainRoutineRuns(f.host);await new Promise(resolve=>setImmediate(resolve));assert.equal(runs.get(r.id).result,'fresh');
});
test('queued unlink is live and does not resurrect a copied work reference [AC:bot-linked-watchers#AC-6]',async t=>{
 const f=fixture(t,(store,id)=>answer(store,id,'independent'));const j=f.job(),runs=new RoutineRunStore(f.store),r=runs.enqueue(j,new Date().toISOString());
 updateCronJob(f.host,j.id,{workLink:null});f.host.loadRoutineSkill=async()=>{throw new Error('must not load removed SOP');};
 await drainRoutineRuns(f.host);await new Promise(resolve=>setImmediate(resolve));assert.equal(runs.get(r.id).status,'completed');assert.equal(runs.get(r.id).workSnapshot,undefined);
});
test('work edited while SOP is loading cannot launch an obsolete revision [AC:bot-linked-watchers#AC-3]',async t=>{
 const f=fixture(t,()=>assert.fail('obsolete work must not execute'));const j=f.job(),runs=new RoutineRunStore(f.store),r=runs.enqueue(j,new Date().toISOString());
 f.host.loadRoutineSkill=async()=>{f.goals.amend(f.bot.id,f.goal.id,'latest requirement');return {content:'current SOP'};};
 await drainRoutineRuns(f.host);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.turns(),0);assert.equal(runs.get(r.id).status,'queued');
});
test('a failed current observation cannot hide behind a fresh job record [AC:bot-linked-watchers#AC-4]',async t=>{
 const f=fixture(t,(store,id)=>{observe(store,id,false);answer(store,id,'[NO_UPDATE]');});
 const bg=f.store.createBackgroundJob({sessionId:f.sid,command:'job',status:'running'});
 const j=createCronJob(f.host,{botId:f.bot.id,name:'watch',prompt:'check',intervalMs:60000,workLink:{goalId:f.goal.id,backgroundJobId:bg.id}});
 const r=await f.run(j);assert.equal(r.status,'failed');assert.match(r.error,/observation failed/i);
});
test('background gateway returns the assigned work wait instead of inventing a second goal [AC:bot-linked-watchers#AC-7]',async t=>{
 const f=fixture(t),execution=f.goals.claim(f.bot.id,f.goal.id,{strategy:'direct'});f.goals.updateExecution(f.bot.id,execution.id,{sessionId:f.sid});
 f.store.updateSession(f.sid,{metadata:{...f.store.getSession(f.sid).metadata,botGoalId:f.goal.id,botGoalExecutionId:execution.id}});
 const {createToolServices}=await import('../dist/runtime/tool-services.js');let starts=0;
 const services=createToolServices({store:f.store,stateDir:f.host.stateDir,startBackgroundJob:async(sid,command)=>{starts++;return f.store.createBackgroundJob({sessionId:sid,command,status:'running'});}});
 const result=await services.startBackgroundJob(f.sid,'authorized external job');assert.equal(starts,1);assert.equal(result.waitFor.ref,result.id);assert.equal(result.waitFor.source,'background_job');assert.equal(f.goals.list(f.bot.id).length,1);
});
