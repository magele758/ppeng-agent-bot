import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore, type RequestAuth } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { botDaydreamRoutes } from '../dist/routes/bot-daydream.js';
async function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'daydream-http-'));
 let sourceId='';
 const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'dream-http',async runTurn(){return{stopReason:'end',assistantParts:[]}},async summarizeMessages(){return ''},async completeText(){return JSON.stringify({candidates:[{kind:'memory',content:'Release service uses port 9090.',category:'fact',reason:'User confirmed project setting',evidenceIds:[sourceId],shareable:true}]})}}});
 let auth:RequestAuth={isolate:false,labProxy:false,user:null,admin:true};
 const router=new Router({policy:buildRoutePolicy({runtime,owners:new ResourceOwnerStore(runtime.store.db)}),readBody:async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString()||'{}')}}).addAll(botDaydreamRoutes(runtime));
 const server=createServer((req,res)=>{void router.dispatch(req,res,new URL(req.url??'/','http://localhost'),auth).then(found=>{if(!found){res.statusCode=404;res.end()}}).catch(error=>{res.statusCode=error.statusCode??error.status??400;res.end(JSON.stringify({error:String(error)}))})});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const call=(bot:string,path:string,body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api/bots/${bot}/daydream${path}`,body===undefined?{}:{method:path==='/settings'?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const addMessage=(bot:string,text:string)=>{const b=runtime.getBot(bot);const m=runtime.store.appendMessage(b.canonicalSessionId,'user',[{type:'text',text}]);return m};
 return{runtime,call,addMessage,setSource:(id:string)=>{sourceId=id},setAuth:(value:RequestAuth)=>{auth=value},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.destroy();rmSync(dir,{recursive:true,force:true})}};
}
test('real daydream HTTP configuration, execution and shared publication [AC:bot-daydream-http#AC-1] [AC:bot-daydream-http#AC-2] [AC:bot-daydream-http#AC-3]',async()=>{
 const f=await fixture();try{
 const a=f.runtime.createBot({name:'A'}),b=f.runtime.createBot({name:'B'}),c=f.runtime.createBot({name:'C'}),s=f.runtime.createBot({name:'Super'});
 const initial=await(await f.call(a.id,'/settings')).json();assert.equal(initial.settings.enabled,true);
 assert.equal((await f.call(a.id,'/settings',{settings:{dailyAt:'04:30'},policy:{superBotId:s.id,publishPolicy:'review',sharedBotIds:[b.id]}})).status,200);
 assert.equal((await(await f.call(a.id,'/settings')).json()).settings.dailyAt,'04:30');
 assert.equal((await f.call(a.id,'/runs',{date:'not-a-date'})).status,400);
 assert.equal((await f.call(a.id,'/settings',{settings:{timezone:'not-a-timezone'}})).status,400);
 assert.equal((await f.call(a.id,'/runs',{date:'2026-02-30'})).status,400);
 const source=f.addMessage(a.id,'Release service uses port 9090. This is the confirmed project configuration.');f.setSource(source.id);
 const date=new Date().toISOString().slice(0,10);assert.equal((await f.call(a.id,'/runs',{date})).status,202);
 let runs=[];for(let i=0;i<100;i++){runs=(await(await f.call(a.id,'/runs')).json()).runs;if(runs.some(r=>r.status==='completed'))break;await new Promise(r=>setTimeout(r,10))}assert.equal(runs[0].status,'completed');assert.equal(runs[0].outputs[0].status,'saved');assert.equal(runs[0].inputs,undefined);
 const detail=await(await f.call(a.id,`/runs/${runs[0].id}`)).json();assert.equal(detail.run.id,runs[0].id);assert.equal(detail.run.inputs,undefined);assert.equal((await f.call(a.id,'/runs/missing')).status,404);
 const pending=(await(await f.call(s.id,'/knowledge')).json()).submissions;assert.equal(pending.length,1);
 const decision=await f.call(s.id,`/knowledge/${pending[0].id}/decision`,{decision:'accept'});assert.equal(decision.status,200,await decision.text());
 const shared=(await(await f.call(b.id,'/knowledge')).json()).artifacts;assert.equal(shared.length,1);assert.equal(shared[0].currentVersion,1);assert.equal((await(await f.call(c.id,'/knowledge')).json()).artifacts.length,0);
 const verified=f.addMessage(b.id,'I checked the running release service and confirmed port 9090 works.');
 assert.equal((await f.call(b.id,`/knowledge/${shared[0].id}/feedback`,{version:1,kind:'verified',description:'Confirmed in actual task',messageIds:[verified.id]})).status,200);
 assert.equal((await f.call(b.id,`/knowledge/${shared[0].id}/feedback`,{version:1,kind:'verified',description:'Forged',messageIds:[source.id]})).status,400);
 const queue=(await(await f.call(s.id,'/knowledge')).json()).feedback;assert.equal(queue.length,1);assert.equal(queue[0].available,true);
 assert.equal((await f.call(s.id,`/knowledge/feedback/${queue[0].id}/decision`,{action:'revise',reason:'Verified correction',content:'Release service uses port 9090 with verified health checks.',summary:'Verified release checks',expectedVersion:0})).status,400);
 const revised=await f.call(s.id,`/knowledge/feedback/${queue[0].id}/decision`,{action:'revise',reason:'Verified correction',content:'Release service uses port 9090 with verified health checks.',summary:'Verified release checks',expectedVersion:1});assert.equal(revised.status,200,await revised.text());
 assert.equal((await(await f.call(s.id,'/knowledge')).json()).feedback[0].status,'resolved');
 assert.equal((await f.call(s.id,`/knowledge/${shared[0].id}/revoke`,{version:1})).status,200);assert.equal((await(await f.call(b.id,'/knowledge')).json()).artifacts.some(item=>item.id===shared[0].id),false);
 }finally{await f.close()}
});
test('HTTP denies non-admin writes [AC:bot-daydream-http#AC-4]',async()=>{const f=await fixture();try{const bot=f.runtime.createBot({name:'Owner'});f.setAuth({isolate:true,labProxy:false,user:null,admin:false});assert.notEqual((await f.call(bot.id,'/settings',{settings:{enabled:false}})).status,200);assert.notEqual((await f.call(bot.id,'/knowledge')).status,200);}finally{await f.close()}});
test('isolated user cannot read another Bot evidence [AC:bot-daydream-http#AC-4]',async()=>{const f=await fixture();try{const bot=f.runtime.createBot({name:'Private'});const session=f.runtime.store.getSession(bot.canonicalSessionId)!;f.runtime.store.updateSession(session.id,{metadata:{...session.metadata,userId:'alice',tenantId:'t'}});f.addMessage(bot.id,'Private project knowledge');f.setAuth({isolate:true,labProxy:true,user:{id:'bob',tenantId:'t',email:'bob@example.test'},admin:true});const response=await f.call(bot.id,'/knowledge');assert.notEqual(response.status,200);assert.equal((await response.text()).includes('Private project knowledge'),false);}finally{await f.close()}});
test('settings transaction and removing governor [AC:bot-daydream-http#AC-1]',async()=>{const f=await fixture();try{const a=f.runtime.createBot({name:'A'}),s=f.runtime.createBot({name:'S'});assert.equal((await f.call(a.id,'/settings',{settings:{dailyAt:'05:00'},policy:{superBotId:s.id,publishPolicy:'review',sharedBotIds:[]}})).status,200);assert.equal((await f.call(a.id,'/settings',{settings:{dailyAt:'06:00'},policy:{superBotId:'missing',publishPolicy:'review',sharedBotIds:[]}})).status,400);assert.equal((await(await f.call(a.id,'/settings')).json()).settings.dailyAt,'05:00');assert.equal((await f.call(a.id,'/settings',{policy:{superBotId:'',publishPolicy:'review',sharedBotIds:[]}})).status,200);assert.equal((await(await f.call(a.id,'/settings')).json()).policy.superBotId,'');}finally{await f.close()}});
