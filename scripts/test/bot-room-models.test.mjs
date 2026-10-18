import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RawAgentRuntime,ANONYMOUS_AUTH,resolveBotPrincipal,upsertProvider,setCatalogDefaultRef} from '@ppeng/agent-core';
import {botRoomsRoutes} from '../../apps/daemon/dist/routes/bot-rooms.js';
function runtime(){return new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'room-model-repo-')),stateDir:mkdtempSync(join(tmpdir(),'room-model-state-')),modelAdapter:{name:'test',async runTurn(){return {stopReason:'end',assistantParts:[]};},async summarizeMessages(){return '';}}});}
async function get(rt,id,auth=ANONYMOUS_AUTH){let output;const response={setHeader(){},end(value){output=JSON.parse(value);}};await botRoomsRoutes(rt).find(r=>r.method==='GET'&&r.pattern==='/api/bot-rooms/:id').handler({response,auth,requireParam:()=>id});return output;}

test('Room shows each member model source and updates the global default without changing a Bot pin [AC:global-default-model-clarity#AC-4]',async()=>{
 const rt=runtime();try{
 const p=upsertProvider(rt.store,{name:'Test provider',kind:'openai-compatible',baseUrl:'https://models.invalid/v1',apiKey:'dummy-not-a-real-key',models:[{id:'first',enabled:true},{id:'second',enabled:true}]});
 const ref=modelId=>({providerId:p.id,modelId});setCatalogDefaultRef(rt.store,ref('first'));
 const a=rt.createBot({name:'DefaultBot'}),b=rt.createBot({name:'PinnedBot'});rt.updateBot(b.id,{modelOverride:ref('first')});
 const room=rt.rooms.create(resolveBotPrincipal(rt.store),{title:'Models',botIds:[a.id,b.id]});
 let data=await get(rt,room.id);
 assert.equal(data.models.defaultModel.modelId,'first');
 assert.equal(data.models.members.find(m=>m.botId===a.id).source,'global');
 assert.equal(data.models.members.find(m=>m.botId===b.id).source,'bot');
 setCatalogDefaultRef(rt.store,ref('second'));data=await get(rt,room.id);
 assert.equal(data.models.defaultModel.modelId,'second');
 assert.equal(data.models.members.find(m=>m.botId===a.id).model.modelId,'second');
 assert.equal(data.models.members.find(m=>m.botId===b.id).model.modelId,'first');
 assert.ok(!JSON.stringify(data.models).includes('dummy-not-a-real-key'));
 await assert.rejects(get(rt,room.id,{isolate:true,user:{id:'other',tenantId:'different'}}));
 }finally{rt.destroy();}
});

test('a room without a usable real model clearly reports unconfigured rather than a builtin demo [AC:global-default-model-clarity#AC-5]',async()=>{
 const rt=runtime();try{
 const bot=rt.createBot({name:'UnconfiguredBot'}),room=rt.rooms.create(resolveBotPrincipal(rt.store),{title:'Empty models',botIds:[bot.id]});
 const data=await get(rt,room.id);
 assert.equal(data.models.defaultModel,null);
 assert.equal(data.models.members[0].model,null);
 assert.equal(data.models.members[0].source,'unconfigured');
 }finally{rt.destroy();}
});
