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
