import test from 'node:test';
import assert from 'node:assert/strict';
import { BotGoalService } from '@ppeng/agent-core';
import { botGoalsRoutes } from '../dist/routes/bot-goals.js';

test('goal endpoints enforce session isolation and persist live settings [AC:bot-multi-goal-coordination#AC-14]', async () => {
 const values=new Map();
 const store={getDaemonControl:(key:string)=>values.get(key),setDaemonControl:(key:string,value:unknown)=>values.set(key,value)};
 const session={id:'s',metadata:{canonicalBotChat:true,botId:'b',userId:'alice'}};
 const runtime={store,getSession:(id:string)=>id==='s'?session:undefined};
 const routes=botGoalsRoutes(runtime as never);
 let body:unknown;
 const ctx={requireParam:()=> 'b',url:new URL('http://local/api/bots/b/goals?sessionId=s'),auth:{isolate:false},response:{setHeader(){},end(text:string){body=JSON.parse(text);}},readBody:async()=>({sessionId:'s',maxConcurrent:2})};
 await routes.find(r=>r.method==='PATCH')!.handler(ctx as never);
 assert.equal((body as {settings:{maxConcurrent:number}}).settings.maxConcurrent,2);
 assert.equal(new BotGoalService(store,Date.now,'s').readSettings().maxConcurrent,2);
 await assert.rejects(async()=>routes.find(r=>r.method==='GET')!.handler({...ctx,url:new URL('http://local/api/bots/b/goals?sessionId=other')} as never));
});

test('goal funding and recovery reject another user and preserve waiting execution [AC:bot-goal-lifecycle-boundaries#AC-6] [AC:bot-goal-lifecycle-boundaries#AC-7]', async () => {
 const values=new Map();const store={getDaemonControl:(key:string)=>structuredClone(values.get(key)),setDaemonControl:(key:string,value:unknown)=>values.set(key,structuredClone(value))};
 const session={id:'s',metadata:{canonicalBotChat:true,botId:'b',userId:'alice',tenantId:'tenant-a'}};
 const runtime={store,getSession:(id:string)=>id==='s'?session:undefined,cancelSession(){}};
 const service=new BotGoalService(store,Date.now,'s');const goal=service.create({botId:'b',sessionId:'s',title:'work',objective:'work'});
 const execution=service.claim('b',goal.id,{strategy:'subagent'})!;service.report('b',execution.id,{kind:'waiting',summary:'running',wait:{source:'session',correlationId:'worker'}});
 const action=botGoalsRoutes(runtime as never).find(r=>r.method==='POST')!;
 const context={requireParam:(key:string)=>key==='id'?'b':goal.id,url:new URL('http://local/'),auth:{isolate:true,userId:'bob',tenantId:'tenant-b'},response:{setHeader(){},end(){}},readBody:async()=>({sessionId:'s',action:'extend',additionalBudgetUsd:2})};
 await assert.rejects(()=>action.handler(context as never),/access denied/i);
 assert.equal(service.get('b',goal.id)!.budgetUsd,10);
 await assert.rejects(()=>action.handler({...context,auth:{isolate:false},readBody:async()=>({sessionId:'s',action:'resume'})} as never),/waiting/i);
 assert.equal(service.get('b',goal.id)!.wait!.correlationId,'worker');
 await action.handler({...context,auth:{isolate:false}} as never);
 assert.equal(service.get('b',goal.id)!.budgetUsd,12);assert.equal(service.get('b',goal.id)!.status,'waiting');
});
