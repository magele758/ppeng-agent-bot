import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotGoalService, RawAgentRuntime, upsertGoalFromApi } from '@ppeng/agent-core';
import { goalRoutes } from '../dist/routes/goals.js';
import { sessionsRoutes } from '../dist/routes/sessions.js';

test('Bot HTTP goals share durable state and reject shadow goal writes atomically [AC:unified-bot-goal-lifecycle#AC-1]', async () => {
 const dir=mkdtempSync(join(tmpdir(),'unified-goal-http-'));
 const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'stub',async runTurn(){return {stopReason:'end',assistantParts:[]};},async summarizeMessages(){return '';}}});
 try {
  const bot=runtime.createBot({name:'Goals'});const sid=runtime.openBot(bot.id).sessionId;
  const routes=goalRoutes(runtime);let body:any;let status=200;
  const ctx=(id:string, payload:unknown={})=>({requireParam:()=>id,url:new URL(`http://local/api/goals?sessionId=${id}`),auth:{isolate:false},response:{set statusCode(value:number){status=value;},setHeader(){},end(value:string){body=JSON.parse(value);}},readBody:async()=>payload});
  const get=routes.find(r=>r.pattern==='/api/sessions/:id/goal')!;
  upsertGoalFromApi(runtime.store.goal(),{sessionId:sid,condition:'obsolete'});
  await get.handler(ctx(sid) as never);assert.equal(body.goal,null);
  const service=new BotGoalService(runtime.store,Date.now,sid);const goal=service.create({botId:bot.id,sessionId:sid,title:'Real goal',objective:'Deliver artifact'});
  runtime.mergeSessionMetadata(sid,{botGoalId:goal.id});
  await get.handler(ctx(sid) as never);assert.equal(body.goal.goalId,goal.id);assert.equal(body.goal.status,'queued');
  await routes.find(r=>r.pattern==='/api/goals'&&r.method==='GET')!.handler(ctx(sid) as never);
  assert.deepEqual(body.goals.map((g:any)=>g.id),[goal.id]);
  const legacy = runtime.store.goal().findLatestBySession(sid)!;
  runtime.store.goal().upsert({...legacy,status:'achieved'});
  await routes.find(r=>r.pattern==='/api/goals'&&r.method==='GET')!.handler(ctx(sid) as never);
  assert.equal(body.goals.length,2);assert.equal(body.goals[1].goalId,legacy.goalId);assert.equal(body.goals[1].condition,'obsolete');
  await get.handler(ctx(sid) as never);assert.equal(body.goal.goalId,goal.id);
  await routes.find(r=>r.pattern==='/api/goals'&&r.method==='POST')!.handler(ctx(sid,{sessionId:sid,condition:'shadow'}) as never);assert.equal(status,409);
  const before=runtime.getSession(sid)!.metadata;
  await assert.rejects(async()=>sessionsRoutes(runtime).find(r=>r.method==='PATCH'&&r.pattern==='/api/sessions/:id')!.handler(ctx(sid,{goalCondition:'shadow',enabledOptionalToolGroups:['new-group'],taskRunMode:'research'}) as never),/Bot goals/);
  assert.deepEqual(runtime.getSession(sid)!.metadata,before);
  runtime.mergeSessionMetadata(sid,{userId:'victim',tenantId:'tenant'});
  const forged=runtime.store.createSession({title:'Forged child',mode:'task',agentId:'general',parentSessionId:sid,metadata:{userId:'attacker',tenantId:'tenant',botId:bot.id,botGoalId:goal.id,botGoalScopeSessionId:sid}});
  const attack={...ctx(forged.id),auth:{isolate:true,user:{id:'attacker',tenantId:'tenant'}}};
  await get.handler(attack as never);assert.equal(body.goal,null);
  await routes.find(r=>r.pattern==='/api/goals'&&r.method==='GET')!.handler(attack as never);assert.deepEqual(body.goals,[]);
  const ordinary=runtime.store.createSession({title:'Ordinary',mode:'chat',agentId:'general',metadata:{}});
  await routes.find(r=>r.pattern==='/api/goals'&&r.method==='POST')!.handler(ctx(ordinary.id,{sessionId:ordinary.id,condition:'Normal condition'}) as never);assert.equal(status,201);
  await get.handler(ctx(ordinary.id) as never);assert.equal(body.goal.condition,'Normal condition');
 }finally{await runtime.destroy();rmSync(dir,{recursive:true,force:true});}
});
