import test from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers/bot-http-fixture.mjs';
import {RoutineRunStore} from '../../packages/core/dist/cron/routine-runtime.js';

test('collaboration, task reuse and publication decisions remain owner-scoped [AC:bot-product-p2#AC-5] [AC:bot-product-p2#AC-7]',async()=>{
 const d=await boot();
 try{
 const bot=(await d.call('alice','POST','/api/bots',{name:'Coordinator'})).body.bot;
 const root=(await d.call('alice','POST','/api/bot-work/tasks',{targetBotId:bot.id,input:'Unified goal'})).body.task;
 let done;
 for(let n=0;n<100;n++){done=(await d.call('alice','GET',`/api/bot-work/tasks/${root.id}`)).body.task;if(done.delivery)break;await new Promise(r=>setTimeout(r,10));}
 assert.ok(done.delivery);
 assert.equal((await d.call('alice','POST','/api/bot-work/tasks',{targetBotId:bot.id,requesterBotId:bot.id,parentTaskId:root.id,input:'Part'})).status,202);
 assert.equal((await d.call('alice','GET','/api/bot-work/tasks')).body.collaborations.length,1);
 assert.deepEqual((await d.call('bob','GET','/api/bot-work/tasks')).body.collaborations,[]);
 const input={botId:bot.id,name:'Reuse',prompt:'Repeat with fresh data',cron:'0 9 * * *',sourceDelivery:{taskId:root.id,attempt:1},deliveryPolicy:{inputSources:'Project',changesOnly:true,failureThreshold:3,approvalBeforeSend:true}};
 const created=await d.call('alice','POST','/api/cron/jobs',input);assert.equal(created.status,201);
 assert.notEqual((await d.call('bob','POST','/api/cron/jobs',input)).status,201);
 const job=created.body.job,runs=new RoutineRunStore(d.runtime.store);
 const run=runs.enqueue(job,new Date().toISOString(),{key:'publication',status:'completed'});runs.update(run.id,{result:'Exact report',publication:'pending'});
 assert.equal((await d.call('bob','POST',`/api/cron/runs/${run.id}/publication`,{approved:true})).status,404);
 assert.equal(runs.get(run.id).publication,'pending');
 const accepted=await d.call('alice','POST',`/api/cron/runs/${run.id}/publication`,{approved:true});assert.equal(accepted.status,200);assert.equal(accepted.body.run.publication,'approved');
 assert.equal((await d.call('alice','POST',`/api/cron/runs/${run.id}/publication`,{approved:false})).status,400);
 }finally{await d.close();}
});
