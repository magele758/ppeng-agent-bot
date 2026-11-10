import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {botCoachingRoutes} from '../dist/routes/bot-coaching.js';
import {enforceRouteAccess} from '../dist/access/enforce.js';
import {buildRoutePolicy} from '../dist/access/policy.js';
test('coaching routes enforce Bot owner before exposing or mutating configuration [AC:bot-coaching-loop#AC-4]',async()=>{
 const values=new Map([['bot.installationPrincipal','installation:user']]);const db=new DatabaseSync(':memory:');const bot={id:'b',canonicalSessionId:'s'};
 const runtime={store:{db,getDaemonControl:(k:string)=>values.get(k),setDaemonControl:(k:string,v:unknown)=>values.set(k,v),getBot:()=>bot,getSession:()=>({metadata:{userId:'alice'}})},getBot:()=>bot,getSession:()=>({metadata:{userId:'alice'}})};
 const policy=buildRoutePolicy({runtime,owners:{}} as never);const routes=botCoachingRoutes(runtime as never);
 for(const route of routes){const access=policy.get(`${route.method} ${route.pattern}`)!;assert.equal(access.kind,'owner');const ctx={requireParam:()=> 'b',auth:{isolate:true,user:{id:'bob'}}};await assert.rejects(()=>enforceRouteAccess(access,ctx as never),/not found/i);await enforceRouteAccess(access,{...ctx,auth:{isolate:true,user:{id:'alice'}}} as never);}
 assert.equal(values.size,1);db.close();
});
test('coaching routes reject invalid evidence and stale saves without changing stored values',async()=>{
 const values=new Map();const runtime={store:{getDaemonControl:(k:string)=>values.get(k),setDaemonControl:(k:string,v:unknown)=>values.set(k,v)},getBot:()=>({id:'b'})};const route=botCoachingRoutes(runtime as never).find(r=>r.method==='PUT')!;let result:unknown;const ctx={requireParam:()=> 'b',response:{setHeader(){},end(s:string){result=JSON.parse(s);}},readBody:async()=>({revision:0,profile:{host:'Ubuntu2'},lessons:[]})};await route.handler(ctx as never);assert.ok(result);await assert.rejects(()=>route.handler(ctx as never),/changed/);assert.equal((values.values().next().value as {revision:number}).revision,1);
});
