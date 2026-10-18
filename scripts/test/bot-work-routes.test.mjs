import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ANONYMOUS_AUTH } from '@ppeng/agent-core';
import { botWorkRoutes } from '../../apps/daemon/dist/routes/bot-work.js';

function runtime() { return new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'work-route-repo-')),stateDir:mkdtempSync(join(tmpdir(),'work-route-state-')),modelAdapter:{name:'stub',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'task result'}]};}}}); }
async function call(rt,method,pattern,body={},params={},auth=ANONYMOUS_AUTH) {
 const route=botWorkRoutes(rt).find(r=>r.method===method&&r.pattern===pattern);assert.ok(route);
 let output;const response={statusCode:200,setHeader(){},end(raw){output={status:this.statusCode,body:JSON.parse(raw)};}};
 await route.handler({request:{headers:{}},response,url:new URL('http://test'+pattern),parts:[],params,requireParam:key=>params[key],readBody:async()=>body,auth});return output;
}
test('default Super, status and durable delegated results through daemon routes [AC:default-super-bot#AC-1] [AC:default-super-bot#AC-3] [AC:default-super-bot#AC-5]',async()=>{
 const rt=runtime();const first=await call(rt,'GET','/api/bot-work/default');assert.equal(first.status,200);const again=await call(rt,'GET','/api/bot-work/default');assert.equal(first.body.session.id,again.body.session.id);
 const worker=rt.createBot({name:'Worker'});const accepted=await call(rt,'POST','/api/bot-work/tasks',{targetBotId:worker.id,input:'work',idempotencyKey:'api-key'});assert.equal(accepted.status,202);
 const repeat=await call(rt,'POST','/api/bot-work/tasks',{targetBotId:worker.id,input:'work',idempotencyKey:'api-key'});assert.equal(repeat.body.task.id,accepted.body.task.id);
 for(let i=0;i<100;i++){const task=(await call(rt,'GET','/api/bot-work/tasks/:id',{}, {id:accepted.body.task.id})).body.task;if(task.status==='completed'){assert.match(task.result,/task result/);break;}await new Promise(r=>setTimeout(r,10));if(i===99)assert.fail('Task did not complete');}
 const state=await call(rt,'GET','/api/bot-work/status');assert.ok(state.body.bots.some(b=>b.bot.id===worker.id));assert.equal((await call(rt,'GET','/api/bot-work/tasks')).body.tasks.length,1);
});
test('task lookup prevents cross-user result access',async()=>{
 const rt=runtime();const worker=rt.createBot({name:'Worker'});const auth={...ANONYMOUS_AUTH,user:{id:'owner',tenantId:'t'}};const accepted=await call(rt,'POST','/api/bot-work/tasks',{targetBotId:worker.id,input:'private'}, {},auth);
 await assert.rejects(()=>call(rt,'GET','/api/bot-work/tasks/:id',{}, {id:accepted.body.task.id},{...ANONYMOUS_AUTH,user:{id:'other',tenantId:'t'}}),/Task not found/);
});

test('live Bot work is shared per member and survives concurrent completion [AC:bot-working-animation#AC-2] [AC:bot-working-animation#AC-4]', async () => {
 const rt=runtime();
 const worker=rt.createBot({name:'Motion worker'}), idle=rt.createBot({name:'Idle member'});
 const sessions=[worker,idle,worker].map((bot,index)=>rt.createChatSession({agentId:bot.id,title:`run ${index}`,background:true,metadata:{botId:bot.id,roomId:'room-motion'}}));
 const executing=new Set([sessions[0].id,sessions[2].id]);
 rt.isSessionRunning=id=>executing.has(id);
 sessions.forEach(session=>rt.store.updateSession(session.id,{status:'running'}));
 const snapshot=async()=> (await call(rt,'GET','/api/bot-work/status')).body.bots;
 let rows=await snapshot();
 assert.equal(rows.find(row=>row.bot.id===worker.id).activeWorkCount,2);
 assert.equal(rows.find(row=>row.bot.id===idle.id).activeWorkCount,0);
 executing.delete(sessions[0].id);rt.store.updateSession(sessions[0].id,{status:'completed'});
 rows=await snapshot();assert.equal(rows.find(row=>row.bot.id===worker.id).activeWorkCount,1);
 executing.clear();rows=await snapshot();assert.equal(rows.find(row=>row.bot.id===worker.id).activeWorkCount,0);
});

test('waiting, queued, paused, cancelled and stale running work stays still [AC:bot-working-animation#AC-3]', async () => {
 const rt=runtime(),bot=rt.createBot({name:'Waiting worker'});
 const session=rt.createChatSession({agentId:bot.id,title:'approval',metadata:{botId:bot.id}});
 rt.isSessionRunning=()=>true;
 const count=async()=> (await call(rt,'GET','/api/bot-work/status')).body.bots.find(row=>row.bot.id===bot.id).activeWorkCount;
 for(const status of ['idle','waiting_approval','completed','failed','cancelled']) {
  rt.store.updateSession(session.id,{status});assert.equal(await count(),0,status);
 }
 rt.store.updateSession(session.id,{status:'running'});assert.equal(await count(),1);
 await call(rt,'POST','/api/bot-work/bots/:id/control',{paused:true,disabled:false},{id:bot.id});
 assert.equal(await count(),0);
});

test('active child work and background processes remain visible after parent stops, without cross-owner activity', async () => {
 const rt=runtime(),bot=rt.createBot({name:'Background worker'});
 const parent=rt.createChatSession({agentId:bot.id,title:'Parent',metadata:{botId:bot.id}});
 const child=rt.store.createSession({mode:'subagent',agentId:'general',title:'Child',parentSessionId:parent.id,background:true});
 const foreign=rt.createChatSession({agentId:bot.id,title:'Foreign',metadata:{botId:bot.id,userId:'other-user'}});
 const spoofedChild=rt.store.createSession({mode:'subagent',agentId:'general',title:'Foreign child',parentSessionId:parent.id,metadata:{userId:'other-user'}});
 for(const session of [child,foreign,spoofedChild])rt.store.updateSession(session.id,{status:'running'});
 rt.isSessionRunning=()=>true;
 const count=async()=> (await call(rt,'GET','/api/bot-work/status')).body.bots.find(row=>row.bot.id===bot.id).activeWorkCount;
 assert.equal(await count(),1,'child inherits parent Bot but foreign principal does not');
 rt.store.updateSession(child.id,{status:'completed'});
 const job=rt.store.createBackgroundJob({sessionId:child.id,command:'sleep',status:'running'});
 rt.backgroundJobAborts.set(job.id,new AbortController());
 assert.equal(await count(),1,'background process is independent of the completed foreground');
 rt.store.updateBackgroundJob(job.id,'completed');
 assert.equal(await count(),0);
 rt.store.updateSession(parent.id,{status:'running'});
 rt.store.createApproval({sessionId:parent.id,toolName:'bash',reason:'wait',args:{command:'true'}});
 assert.equal(await count(),0,'pending approval does not animate even during runtime unwind');
});

test('orphaned running background jobs after restart never keep a Bot animated [AC:bot-working-animation#AC-3]', async () => {
 const rt=runtime(),bot=rt.createBot({name:'Restarted worker'});
 const session=rt.createChatSession({agentId:bot.id,title:'Old job',metadata:{botId:bot.id}});
 const job=rt.store.createBackgroundJob({sessionId:session.id,command:'old process',status:'running'});
 const count=async()=> (await call(rt,'GET','/api/bot-work/status')).body.bots.find(row=>row.bot.id===bot.id).activeWorkCount;
 assert.equal(await count(),0,'durable row without a live process controller is orphaned');
 const controller=new AbortController();rt.backgroundJobAborts.set(job.id,controller);
 assert.equal(await count(),1,'actual executing background process animates');
 controller.abort();assert.equal(await count(),0,'aborted process stops before persistence settles');
});
