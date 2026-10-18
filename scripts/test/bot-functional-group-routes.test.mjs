import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ANONYMOUS_AUTH, resolveBotPrincipal, setBotDefinitionOwner } from '@ppeng/agent-core';
import { botFunctionalGroupRoutes } from '../../apps/daemon/dist/routes/bot-functional-groups.js';

async function call(rt, method, pattern, params={}, body={}, auth=ANONYMOUS_AUTH, query='') {
 const route=botFunctionalGroupRoutes(rt).find(r=>r.method===method&&r.pattern===pattern);assert.ok(route);
 const out={}; const response={statusCode:200,setHeader(){},end(text){out.status=this.statusCode;out.body=JSON.parse(String(text));}};
 await route.handler({response,url:new URL('http://localhost/'+query),requireParam:key=>params[key],readBody:async()=>body,auth});return out;
}
const makeRuntime=()=>new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'fg-repo-')),stateDir:mkdtempSync(join(tmpdir(),'fg-state-')),modelAdapter:{name:'test',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'ok'}]};},async summarizeMessages(){return '';}}});

test('functional group HTTP CRUD and move persist; scoped sharing enforces caller ownership [AC:bot-functional-groups#AC-6] [AC:bot-functional-groups#AC-7] [AC:bot-functional-groups#AC-9]',async()=>{
 const rt=makeRuntime();try {
 const bot=rt.createBot({name:'GroupWorker'});
 const group=(await call(rt,'POST','/api/bot-functional-groups',{}, {name:'Research'})).body.group;
 await call(rt,'PUT','/api/bots/:id/functional-group',{id:bot.id},{groupId:group.id});
 assert.deepEqual((await call(rt,'GET','/api/bot-functional-groups')).body.groups[0].botIds,[bot.id]);
 await call(rt,'PATCH','/api/bot-functional-groups/:id',{id:group.id},{name:'Writing'});
 assert.equal((await call(rt,'GET','/api/bot-functional-groups')).body.groups[0].name,'Writing');
 await call(rt,'PUT','/api/bot-shared-context',{}, {entries:{language:'Chinese'}},ANONYMOUS_AUTH,`?scope=group&id=${group.id}`);
 assert.deepEqual((await call(rt,'GET','/api/bot-shared-context',{}, {},ANONYMOUS_AUTH,`?scope=group&id=${group.id}`)).body.entries,{language:'Chinese'});
 const stranger={isolate:true,user:{id:'stranger'}};
 assert.deepEqual((await call(rt,'GET','/api/bot-functional-groups',{}, {},stranger)).body.groups,[]);
 await assert.rejects(call(rt,'PATCH','/api/bot-functional-groups/:id',{id:group.id},{name:'hack'},stranger));
 await assert.rejects(call(rt,'PUT','/api/bots/:id/functional-group',{id:bot.id},{groupId:group.id},stranger));
 const privateBot=rt.createBot({name:'PrivateWorker'});
 setBotDefinitionOwner(rt.store,privateBot.id,{userId:'private-owner'});
 await assert.rejects(call(rt,'PUT','/api/bots/:id/functional-group',{id:privateBot.id},{groupId:null},stranger));
 await call(rt,'DELETE','/api/bot-functional-groups/:id',{id:group.id});
 assert.deepEqual((await call(rt,'GET','/api/bot-functional-groups')).body.groups,[]);
 assert.ok(rt.getBot(bot.id));
 } finally {rt.destroy();}
});

test('actual model requests receive current shared facts on both kernels without storing them in private transcripts [AC:bot-functional-groups#AC-8] [AC:bot-functional-groups#AC-9] [AC:bot-functional-groups#AC-10]',async()=>{
 const calls=[];
 const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'fg-model-repo-')),stateDir:mkdtempSync(join(tmpdir(),'fg-model-state-')),modelAdapter:{name:'shared-facts-probe',async runTurn(input){calls.push(input);return {stopReason:'end',assistantParts:[{type:'text',text:'Recorded model input'}]};},async summarizeMessages(){return '';}}});
 try {
  const { BotFunctionalGroupService }=await import('@ppeng/agent-core');
  const service=new BotFunctionalGroupService(rt.store),principal=resolveBotPrincipal(rt.store);
  const a=rt.createBot({name:'Member'}),b=rt.createBot({name:'Other'});
  const group=service.create(principal,'Research');service.move(principal,a.id,group.id);
  service.setShared(principal,{scope:'global'},{location:'GLOBAL',fallback:'FALLBACK'});
  service.setShared(principal,{scope:'group',id:group.id},{location:'GROUP',groupOnly:'GROUP_ONLY'});
  const room=rt.rooms.create(principal,{title:'Shared',botIds:[a.id]});
  service.setShared(principal,{scope:'room',id:room.id},{location:'ROOM'});
  const unrelated=rt.rooms.create(principal,{title:'Other room',botIds:[b.id]});
  service.setShared(principal,{scope:'room',id:unrelated.id},{unrelated:'OTHER_ROOM_ONLY'});
  for (const kernel of ['ppeng','agent-loop']) {
   rt.store.setDaemonControl('loop_settings',{kernelVariant:kernel});
   rt.rooms.send(principal,room.id,{text:'Check current shared facts'});await rt.rooms.tick();
   const input=calls.at(-1),serialized=JSON.stringify(input.messages);
   assert.match(serialized,/ROOM/);assert.match(serialized,/GROUP_ONLY/);assert.match(serialized,/FALLBACK/);
   assert.ok(!serialized.includes('OTHER_ROOM_ONLY'));
   assert.ok(!input.systemPrompt.includes('GROUP_ONLY'),'dynamic facts stay out of cached system prefix');
   assert.ok(!JSON.stringify(rt.store.listMessages(input.sessionId)).includes('GROUP_ONLY'),'facts are model view only');
  }
  service.move(principal,a.id,null);
  rt.rooms.send(principal,room.id,{text:'Check after leaving functional group'});await rt.rooms.tick();
  assert.ok(!JSON.stringify(calls.at(-1).messages).includes('GROUP_ONLY'));
 } finally {rt.destroy();}
});

test('moving an already used bot revokes old shared answers and summaries from model input while preserving visible history [AC:bot-functional-groups#AC-8] [AC:bot-functional-groups#AC-9]',async()=>{
 const {BotFunctionalGroupService}=await import('@ppeng/agent-core');
 for(const kernel of ['ppeng','agent-loop']) {
  const calls=[];let old=true;
  const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'fg-revoke-repo-')),stateDir:mkdtempSync(join(tmpdir(),'fg-revoke-state-')),modelAdapter:{name:'sharing-echo',async runTurn(input){calls.push(input);return {stopReason:'end',assistantParts:[{type:'text',text:old?'old code: ALPHA_PRIVATE_CODE':'current result'}]};},async summarizeMessages(){return 'ALPHA_PRIVATE_CODE';}}});
  try {
   rt.store.setDaemonControl('loop_settings',{kernelVariant:kernel});
   const service=new BotFunctionalGroupService(rt.store),principal=resolveBotPrincipal(rt.store),bot=rt.createBot({name:'ScopeWorker'});
   const a=service.create(principal,'A'),b=service.create(principal,'B');
   service.setShared(principal,{scope:'global'},{city:'GLOBAL_CITY'});
   service.setShared(principal,{scope:'group',id:a.id},{city:'A_CITY',oldCode:'ALPHA_PRIVATE_CODE'});
   service.setShared(principal,{scope:'group',id:b.id},{city:'B_CITY'});
   rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'Personal note before group exposure: likes blue.'}]);
   service.move(principal,bot.id,a.id);
   rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'What is the group code?'}]);await rt.runSession(bot.canonicalSessionId);
   assert.match(JSON.stringify(calls.at(-1).messages),/ALPHA_PRIVATE_CODE/);
   rt.store.updateSession(bot.canonicalSessionId,{summary:'Old shared code ALPHA_PRIVATE_CODE'});
   old=false;service.move(principal,bot.id,b.id);
   rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'What is the current city? Retrieve the old group code if still accessible.'}]);await rt.runSession(bot.canonicalSessionId);
   const input=JSON.stringify(calls.at(-1));
   assert.ok(!input.includes('ALPHA_PRIVATE_CODE'),`${kernel}: prior shared assistant answer or summary must not enter the next model request`);
   assert.match(input,/B_CITY/);assert.match(input,/likes blue/,'unexposed personal history survives');
   assert.match(JSON.stringify(rt.store.listMessages(bot.canonicalSessionId)),/ALPHA_PRIVATE_CODE/,'stored user-visible history stays intact');
   service.move(principal,bot.id,null);
   rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'Current shared city?'}]);await rt.runSession(bot.canonicalSessionId);
   assert.match(JSON.stringify(calls.at(-1).messages),/GLOBAL_CITY/);
   assert.ok(!JSON.stringify(calls.at(-1)).includes('ALPHA_PRIVATE_CODE'));
  } finally {rt.destroy();}
 }
});

test('an old group reply arriving after a move cannot reenter the next model request [AC:bot-functional-groups#AC-9]',async()=>{
 const {BotFunctionalGroupService}=await import('@ppeng/agent-core');
 const calls=[];let release,started;
 const ready=new Promise(resolve=>{started=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'fg-late-repo-')),stateDir:mkdtempSync(join(tmpdir(),'fg-late-state-')),modelAdapter:{name:'late-sharing-reply',async runTurn(input){calls.push(input);if(calls.length===1){started();await gate;}return {stopReason:'end',assistantParts:[{type:'text',text:calls.length===1?'LATE_OLD_GROUP_CODE':'current result'}]};},async summarizeMessages(){return '';}}});
 try {
  const service=new BotFunctionalGroupService(rt.store),principal=resolveBotPrincipal(rt.store),bot=rt.createBot({name:'LateWorker'});
  const a=service.create(principal,'A'),b=service.create(principal,'B');
  service.move(principal,bot.id,a.id);service.setShared(principal,{scope:'group',id:a.id},{code:'LATE_OLD_GROUP_CODE'});
  rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'Group code?'}]);const running=rt.runSession(bot.canonicalSessionId);await ready;
  service.move(principal,bot.id,b.id);release();await running;
  rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'Do you still have prior group information?'}]);await rt.runSession(bot.canonicalSessionId);
  assert.ok(!JSON.stringify(calls.at(-1)).includes('LATE_OLD_GROUP_CODE'),'late old-group output must stay outside the next model request');
 }finally{release();rt.destroy();}
});
