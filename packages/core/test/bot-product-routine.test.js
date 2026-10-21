import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {createBot} from '../dist/bots/bot-facade.js';
import {createCronJob} from '../dist/cron/cron-facade.js';
import {CronJobStore} from '../dist/cron/cron-store.js';
import * as runtime from '../dist/cron/routine-runtime.js';
import {BotRoomService} from '../dist/rooms/index.js';

test('routine persists sources and notification rules, approves exact output once, suppresses unchanged output and alerts at failure threshold [AC:bot-product-p2#AC-7]',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'product-routine-'));let store=new SqliteStateStore(join(stateDir,'state.db'));
 let reply='Daily report';let failure=false;let executions=0;
 const host={store,stateDir,setCronStore(s){this.cronStore=s;},runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},log:{warn(){},info(){}},async runSession(id){executions++;if(failure)throw new Error('provider unavailable');store.appendMessage(id,'assistant',[{type:'text',text:reply}]);}};
 const bot=createBot(host,{name:'Reporter'});const principal={userId:'alice'};
 store.updateSession(bot.canonicalSessionId,{metadata:{...store.getSession(bot.canonicalSessionId).metadata,...principal}});
 let rooms=new BotRoomService({store,createChatSession(){},async runSession(){},cancelSession(){}});
 const room=rooms.create(principal,{title:'Reports',botIds:[bot.id]});
 try{
 const policy={inputSources:'Read the project changelog',changesOnly:true,failureThreshold:2,approvalBeforeSend:true};
 const job=createCronJob(host,{botId:bot.id,userId:'alice',name:'Daily',prompt:'Summarize project',cron:'0 9 * * *',timezone:'Asia/Shanghai',roomId:room.id,deliveryPolicy:policy});
 assert.deepEqual(new CronJobStore(stateDir).get(job.id).metadata.deliveryPolicy,policy);
 let runs=new runtime.RoutineRunStore(store);
 const run=async(key)=>{const r=runs.enqueue(job,new Date().toISOString(),{key});await runtime.drainRoutineRuns(host);await new Promise(setImmediate);await runtime.drainRoutineRuns(host);return runs.get(r.id);};
 const first=await run('first');assert.equal(first.publication,'pending');assert.equal(rooms.messages(principal,room.id).messages.length,0);
 assert.ok(store.listMessages(job.sessionId).some(m=>JSON.stringify(m).includes(policy.inputSources)));
 store.db.close();store=new SqliteStateStore(join(stateDir,'state.db'));host.store=store;
 runs=new runtime.RoutineRunStore(store);rooms=new BotRoomService({store,createChatSession(){},async runSession(){},cancelSession(){}});
 await runtime.drainRoutineRuns(host);assert.equal(runs.get(first.id).publication,'pending');assert.equal(executions,1);
 runtime.decideRoutinePublication(host,first.id,true);runtime.decideRoutinePublication(host,first.id,true);
 assert.equal(rooms.messages(principal,room.id).messages.length,1);assert.equal(executions,1);
 const same=await run('same');assert.equal(same.notificationReason,'unchanged');assert.equal(same.publication,undefined);
 reply='Changed report';const changed=await run('changed');assert.equal(changed.publication,'pending');runtime.decideRoutinePublication(host,changed.id,false);
 assert.equal(rooms.messages(principal,room.id).messages.length,1);
 failure=true;const fail1=await run('fail1');assert.equal(fail1.notificationReason,'below_failure_threshold');
 const fail2=await run('fail2');assert.ok(fail2.summaryMessageId);assert.equal(fail2.status,'failed');
 assert.throws(()=>createCronJob(host,{botId:bot.id,userId:'alice',name:'Invalid',prompt:'x',cron:'0 9 * * *',deliveryPolicy:{...policy,failureThreshold:0}}),/failureThreshold/);
 }finally{store.db.close();rmSync(stateDir,{recursive:true,force:true});}
});
