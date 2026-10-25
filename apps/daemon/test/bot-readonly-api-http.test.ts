import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, BotGoalService, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { sessionsRoutes } from '../dist/routes/sessions.js';

test('real Bot HTTP response keeps reasoning separate and creates no read-only goal [AC:bot-readonly-api#AC-1] [AC:bot-readonly-api#AC-2]',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'readonly-http-'));let judges=0;
 const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'readonly-http',async summarizeMessages(){return '';},async completeText(){judges++;return '{"intents":[]}';},async runTurn(){return {stopReason:'end',assistantParts:[{type:'reasoning',text:'Compute privately'},{type:'text',text:'42'}]};}}});
 const router=new Router({policy:buildRoutePolicy({runtime,owners:new ResourceOwnerStore(runtime.store.db)}),readBody:async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString());}}).addAll(sessionsRoutes(runtime));
 const server=createServer((req,res)=>{void router.dispatch(req,res,new URL(req.url??'/','http://localhost')).then(found=>{if(!found){res.statusCode=404;res.end();}}).catch(error=>{res.statusCode=500;res.end(String(error));});});
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert.ok(addr&&typeof addr==='object');
  const bot=runtime.createBot({name:'Readonly HTTP'}),sid=runtime.openBot(bot.id).sessionId;
  const service=new BotGoalService(runtime.store,Date.now,sid);
  const existing=service.create({botId:bot.id,sessionId:sid,title:'Existing',objective:'Repair unrelated record'});service.control(bot.id,existing.id,'pause');
  const before=service.list(bot.id);
  const r=await fetch(`http://127.0.0.1:${addr.port}/api/sessions/${sid}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'这是 PR #251 更新后的只读冒烟验证。本轮独立计算 19 + 23，不执行命令、不读写文件、不创建或推进目标任务。只输出数字。'})});
  assert.equal(r.status,200);const body=await r.json();
  assert.equal(body.latestAssistant,'42');assert.equal(body.session.status,'idle');
  assert.deepEqual(body.messages.findLast(m=>m.role==='assistant').parts,[{type:'reasoning',text:'Compute privately'},{type:'text',text:'42'}]);
  await runtime.listTraceEvents(sid);
  assert.deepEqual(service.list(bot.id),before);assert.equal(judges,0);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.destroy();rmSync(dir,{recursive:true,force:true});}
});
