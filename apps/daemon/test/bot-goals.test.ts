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
