import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ANONYMOUS_AUTH, resolveBotPrincipal, setBotWorkControl, updateBotWorkSettings } from '@ppeng/agent-core';
import { botRoomsRoutes } from '../../apps/daemon/dist/routes/bot-rooms.js';
import { waitFor } from '../../packages/core/test/helpers/settle.js';

async function call(rt,method,pattern,params={},body={},auth=ANONYMOUS_AUTH,query='') {
  const route=botRoomsRoutes(rt).find(item=>item.method===method&&item.pattern===pattern);assert.ok(route);
  const out={};const response={statusCode:200,setHeader(){},end(text){out.status=this.statusCode;out.body=JSON.parse(String(text));}};
  await route.handler({request:{method,headers:{}},response,url:new URL(`http://localhost${pattern}${query}`),parts:[],params,requireParam:name=>params[name],readBody:async()=>body,auth});
  return out;
}
function runtime(){return new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'room-http-repo-')),stateDir:mkdtempSync(join(tmpdir(),'room-http-state-')),modelAdapter:{name:'room-api-scripted',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'Room API executed result'}]};},async summarizeMessages(){return '';}}});}

test('Room API creates, accepts, executes, pages, pauses and stops actual runtime work [AC:bot-rooms#AC-1] [AC:bot-rooms#AC-2] [AC:bot-rooms#AC-3] [AC:bot-rooms#AC-4]',async()=>{
  const rt=runtime();try{
    const bot=rt.createBot({name:'HTTPWorker'});
    const created=await call(rt,'POST','/api/bot-rooms',{}, {title:'HTTP Room',botIds:[bot.id],maxToolCalls:5,maxCostUsd:2});assert.equal(created.status,201);
    const id=created.body.room.id;assert.equal(created.body.room.maxToolCalls,5);
    const sent=await call(rt,'POST','/api/bot-rooms/:id/messages',{id},{text:'Answer',mentions:[bot.id],idempotencyKey:'one'});assert.equal(sent.status,202);
    const done=await waitFor(async()=>{const turns=(await call(rt,'GET','/api/bot-rooms/:id/turns',{id})).body.turns;return turns.find(turn=>turn.id===sent.body.turn.id&&turn.status==='completed');});assert.ok(done);
    const page=await call(rt,'GET','/api/bot-rooms/:id/messages',{id},{},ANONYMOUS_AUTH,'?limit=1');assert.equal(page.body.messages[0].text,'Room API executed result');assert.equal(page.body.hasMore,true);
    const older=await call(rt,'GET','/api/bot-rooms/:id/messages',{id},{},ANONYMOUS_AUTH,`?limit=1&beforeSeq=${page.body.nextCursor}`);assert.equal(older.body.messages[0].text,'Answer');
    await call(rt,'PATCH','/api/bot-rooms/:id',{id},{status:'paused'});
    const queued=await call(rt,'POST','/api/bot-rooms/:id/messages',{id},{text:'Do not run yet'});assert.equal(queued.body.turn.status,'queued');
    await call(rt,'POST','/api/bot-rooms/:id/stop',{id});
    const turns=(await call(rt,'GET','/api/bot-rooms/:id/turns',{id})).body.turns;assert.equal(turns.at(-1).status,'cancelled');
    await call(rt,'POST','/api/bot-rooms/:id/resume',{id});
    await call(rt,'DELETE','/api/bot-rooms/:id/members/:botId',{id,botId:bot.id});
    assert.deepEqual((await call(rt,'GET','/api/bot-rooms/:id',{id})).body.room.botIds,[]);
  }finally{rt.destroy();}
});

test('Room API denies another principal and invalid members and cursors [AC:bot-rooms#AC-6]',async()=>{
  const rt=runtime();try{
    const bot=rt.createBot({name:'OwnerWorker'});const id=(await call(rt,'POST','/api/bot-rooms',{}, {title:'Private',botIds:[bot.id]})).body.room.id;
    const intruder={isolate:true,labProxy:true,user:{id:'intruder',tenantId:'other'}};
    assert.deepEqual((await call(rt,'GET','/api/bot-rooms',{}, {},intruder)).body.rooms,[]);
    await assert.rejects(call(rt,'GET','/api/bot-rooms/:id',{id},{},intruder),/Forbidden/);
    await assert.rejects(call(rt,'POST','/api/bot-rooms/:id/messages',{id},{text:'no',mentions:['not-member']}),/member/);
    await assert.rejects(call(rt,'GET','/api/bot-rooms/:id/messages',{id},{},ANONYMOUS_AUTH,'?limit=1000'),/page limit/);
  }finally{rt.destroy();}
});

test('Room API capacity rejection is explicitly retryable and does not accept the overflow [AC:bot-rooms#AC-5]',async()=>{
  const rt=runtime();try{
    const bot=rt.createBot({name:'CapacityWorker'}),principal=resolveBotPrincipal(rt.store);
    updateBotWorkSettings(rt.store,{perBot:1,perPrincipal:2});
    setBotWorkControl({store:rt.store,runSession:id=>rt.runSession(id),log:{info(){},warn(){},error(){},debug(){}}},principal,bot.id,{paused:true,disabled:false});
    const id=(await call(rt,'POST','/api/bot-rooms',{}, {title:'Capacity',botIds:[bot.id]})).body.room.id;
    assert.equal((await call(rt,'POST','/api/bot-rooms/:id/messages',{id},{text:'accepted',idempotencyKey:'first'})).status,202);
    const rejected=await call(rt,'POST','/api/bot-rooms/:id/messages',{id},{text:'overflow'});
    assert.equal(rejected.status,429);assert.equal(rejected.body.accepted,false);assert.equal(rejected.body.retryable,true);assert.equal(rejected.body.error_code,'QUEUE_FULL');
    const messages=(await call(rt,'GET','/api/bot-rooms/:id/messages',{id})).body.messages;
    assert.equal(messages.length,1);assert.equal(messages[0].text,'accepted');
  }finally{rt.destroy();}
});
