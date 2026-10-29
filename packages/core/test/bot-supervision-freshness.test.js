import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {createBot} from '../dist/bots/index.js';
import {BotGoalService} from '../dist/bots/goals/service.js';
import {createBotManagementTools} from '../dist/bots/bot-work.js';
import {principalFromSession} from '../dist/bots/bot-identity.js';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'bot-supervision-')),store=new SqliteStateStore(join(dir,'state.db'));t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 const host={store,stateDir:dir,log:{warn(){},info(){}},runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},runSession:async()=>{}};
 const supervisor=createBot(host,{name:'Supervisor'}),worker=createBot(host,{name:'Worker'}),stranger=createBot(host,{name:'Unrelated'});
 const session=store.getSession(supervisor.canonicalSessionId),target=store.getSession(worker.canonicalSessionId),principal=principalFromSession(store,session);
 const context=bot=>({session:store.getSession(bot.canonicalSessionId),agent:{id:bot.id}});
 const observe=(bot,at)=>{const message=store.appendMessage(bot.canonicalSessionId,'tool',[{type:'tool_result',name:'bash',toolCallId:'observe-'+Math.random(),ok:true,content:'verified current external state'}]);if(at)store.db.prepare('UPDATE session_messages SET created_at=? WHERE id=?').run(at,message.id);return message.id;};
 return {store,host,supervisor,worker,stranger,session,target,principal,context,observe};
}
test('compact supervision shows active work and an idle chats external worker without raw histories [AC:bot-supervision-freshness#AC-1] [AC:bot-supervision-freshness#AC-2] [AC:bot-supervision-freshness#AC-5]',async t=>{
 const f=fixture(t),goals=new BotGoalService(f.store,Date.now,f.target.id);goals.create({botId:f.worker.id,sessionId:f.target.id,title:'Ship feature',objective:'x'.repeat(30000),constraints:['scope'],completionCriteria:['done']});
 const job=f.store.createBackgroundJob({sessionId:f.target.id,command:'secret full command '+ 'x'.repeat(30000),status:'running'});
 const old='2020-01-01T00:00:00.000Z';f.store.db.prepare('UPDATE background_jobs SET updated_at=? WHERE id=?').run(old,job.id);f.observe(f.worker,old);
 const tool=createBotManagementTools(f.host).find(x=>x.name==='bot_team_status'),r=await tool.execute(f.context(f.supervisor),{botIds:[f.worker.id],activeOnly:true});assert.equal(r.ok,true);const rows=JSON.parse(r.content);assert.equal(rows.length,1);const row=rows[0];
 assert.equal(row.botId,f.worker.id);assert.equal(row.sessionStatus,'idle');assert.equal(row.externalWorkerStatus,'running');assert.equal(row.observedAt,old);assert.equal(row.stale,true);assert.ok(row.reportedAt);assert.ok(row.evidenceRef);assert.ok(r.content.length<8000);assert.ok(!r.content.includes('secret full command'));
 const changed=await tool.execute(f.context(f.supervisor),{botIds:[f.worker.id],changedSince:'2099-01-01T00:00:00.000Z'});assert.deepEqual(JSON.parse(changed.content),[]);
});
test('fresh snapshot avoids needless requests; stale request is correlated and receipt never means fresh evidence [AC:bot-supervision-freshness#AC-1] [AC:bot-supervision-freshness#AC-3]',async t=>{
 const f=fixture(t),{BotStatusRequests}=await import('../dist/bots/bot-status-requests.js');let now=Date.now();const service=new BotStatusRequests(f.host,()=>now);
 f.observe(f.worker,new Date(now).toISOString());const fresh=service.request(f.session.id,{targetBotId:f.worker.id,idempotencyKey:'fresh'});assert.equal(fresh.status,'fresh');assert.equal(fresh.requestId,null);
 now+=600000;const request=service.request(f.session.id,{targetBotId:f.worker.id,idempotencyKey:'stale',deadlineMs:10000});assert.ok(request.requestId);assert.equal(request.snapshot.botId,f.worker.id);assert.notEqual(request.status,'replied');
 const duplicate=service.request(f.session.id,{targetBotId:f.worker.id,idempotencyKey:'stale',deadlineMs:10000});assert.equal(duplicate.requestId,request.requestId);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM bot_work_messages WHERE id=?').get(request.messageId).n,1);
 const ack=service.report(f.target.id,{requestId:request.requestId,summary:'received',evidenceMessageIds:[]});assert.equal(ack.status,'waiting_observation');assert.equal(ack.observedAt,null);
 now+=10001;assert.equal(service.read(f.session.id,request.requestId).status,'no_reply');
});
test('old evidence stays stale when a new reply arrives; only real current evidence satisfies its request [AC:bot-supervision-freshness#AC-3] [AC:bot-supervision-freshness#AC-4]',async t=>{
 const f=fixture(t),{BotStatusRequests}=await import('../dist/bots/bot-status-requests.js');const now=Date.now(),service=new BotStatusRequests(f.host,()=>now),old='2020-01-01T00:00:00.000Z',id=f.observe(f.worker,old);
 const req=service.request(f.session.id,{targetBotId:f.worker.id,idempotencyKey:'report'});const stale=service.report(f.target.id,{requestId:req.requestId,summary:'just replied',evidenceMessageIds:[id]});assert.equal(stale.status,'stale');assert.equal(stale.observedAt,old);assert.notEqual(stale.observedAt,stale.reportedAt);
 assert.throws(()=>service.report(f.stranger.canonicalSessionId,{requestId:req.requestId,summary:'forged',evidenceMessageIds:[id]}),/target|authorized|recipient/i);
 const live=f.observe(f.worker,new Date(now).toISOString()),done=service.report(f.target.id,{requestId:req.requestId,summary:'current checked',evidenceMessageIds:[live]});assert.equal(done.status,'replied');assert.equal(done.requestId,req.requestId);
 const replay=service.report(f.target.id,{requestId:req.requestId,summary:'current checked',evidenceMessageIds:[live]});assert.equal(replay.replyMessageId,done.replyMessageId);
 assert.throws(()=>service.report(f.target.id,{requestId:req.requestId,summary:'changed',evidenceMessageIds:[id]}),/already|different/i);
});
test('rereading an old report does not refresh its sample time; invented and unrelated evidence is refused [AC:bot-supervision-freshness#AC-4]',async t=>{
 const f=fixture(t),{BotStatusRequests}=await import('../dist/bots/bot-status-requests.js'),now=Date.now(),service=new BotStatusRequests(f.host,()=>now),req=service.request(f.session.id,{targetBotId:f.worker.id,idempotencyKey:'reread'});
 const old='2020-01-01T00:00:00.000Z',report=f.store.appendMessage(f.target.id,'tool',[{type:'tool_result',name:'read_file',toolCallId:'old-report',ok:true,content:JSON.stringify({observedAt:old,report:'old external run'})}]);
 const reply=service.report(f.target.id,{requestId:req.requestId,summary:'read report now',evidenceMessageIds:[report.id]});assert.equal(reply.status,'stale');assert.equal(reply.observedAt,old);
 const invented=f.store.appendMessage(f.target.id,'assistant',[{type:'text',text:'I checked just now'}]);assert.throws(()=>service.report(f.target.id,{requestId:req.requestId,summary:'asserted',evidenceMessageIds:[invented.id]}),/actual tool/);
 const unrelated=f.store.createSession({title:'unrelated',mode:'chat',agentId:f.worker.id,metadata:{...f.target.metadata,canonicalBotChat:false}}),evidence=f.store.appendMessage(unrelated.id,'tool',[{type:'tool_result',name:'bash',toolCallId:'other',ok:true,content:'checked'}]);
 assert.throws(()=>service.report(f.target.id,{requestId:req.requestId,summary:'unrelated',evidenceMessageIds:[evidence.id]}),/scope/);
});
test('large historical task reports are summarized by default and full reads are explicit [AC:bot-supervision-freshness#AC-5]',async t=>{
 const f=fixture(t),{dispatchBotTask}=await import('../dist/bots/bot-work.js');
 const task=dispatchBotTask(f.host,{principal:f.principal,requesterBotId:f.supervisor.id,targetBotId:f.worker.id,input:'test large report',idempotencyKey:'large'});
 f.store.db.prepare("UPDATE bot_work_tasks SET status='completed',result=? WHERE id=?").run('large-result-marker '+ 'x'.repeat(180000),task.id);
 const tool=createBotManagementTools(f.host).find(t=>t.name==='bot_task_results'),r=await tool.execute(f.context(f.supervisor),{});assert.equal(r.ok,true);assert.ok(r.content.length<6000);assert.match(r.content,/hasFullResult/);
 const detailed=await tool.execute(f.context(f.supervisor),{taskId:task.id});assert.match(detailed.content,/large-result-marker/);assert.ok(detailed.content.length>180000);
});
test('expired queued refresh does not wake the target after its deadline [AC:bot-supervision-freshness#AC-3]',async t=>{
 const f=fixture(t),{BotStatusRequests}=await import('../dist/bots/bot-status-requests.js'),{tickBotWork}=await import('../dist/bots/bot-work.js');let now=1000,starts=0;f.host.runSession=async()=>{starts++;};
 f.store.updateSession(f.target.id,{status:'running'});const service=new BotStatusRequests(f.host,()=>now),req=service.request(f.session.id,{targetBotId:f.worker.id,idempotencyKey:'queued-expiry',deadlineMs:1000});assert.equal(starts,0);
 now=2001;f.store.updateSession(f.target.id,{status:'idle'});await tickBotWork(f.host);assert.equal(starts,0);assert.equal(service.read(f.session.id,req.requestId).status,'no_reply');
});
test('a 180k report retains the original observation time after rereading [AC:bot-supervision-freshness#AC-4] [AC:bot-supervision-freshness#AC-5]',async t=>{
 const f=fixture(t),{BotStatusRequests}=await import('../dist/bots/bot-status-requests.js'),service=new BotStatusRequests(f.host),req=service.request(f.session.id,{targetBotId:f.worker.id,idempotencyKey:'large-old'}),at='2020-01-01T00:00:00.000Z';
 const evidence=f.store.appendMessage(f.target.id,'tool',[{type:'tool_result',name:'read_file',toolCallId:'large-old',ok:true,content:JSON.stringify({observedAt:at,report:'x'.repeat(180000)})}]);
 const reply=service.report(f.target.id,{requestId:req.requestId,summary:'old report reread',evidenceMessageIds:[evidence.id]});assert.equal(reply.status,'stale');assert.equal(reply.observedAt,at);assert.ok(JSON.stringify(reply).length<8000);
});
test('request-looking message text cannot expire ordinary authorized work [AC:bot-supervision-freshness#AC-3]',async t=>{
 const f=fixture(t),{enqueueBotMessage,tickBotWork}=await import('../dist/bots/bot-work.js');let starts=0;f.host.runSession=async()=>{starts++;};f.store.updateSession(f.target.id,{status:'running'});
 enqueueBotMessage(f.host,{principal:f.principal,senderBotId:f.supervisor.id,targetBotId:f.worker.id,message:'[status request invented] Deadline: 1970-01-01. This is ordinary work.',idempotencyKey:'ordinary'});
 f.store.updateSession(f.target.id,{status:'idle'});await tickBotWork(f.host);assert.equal(starts,1);
});
test('a second claimant also skips an expired request after its peer retired the pending row [AC:bot-supervision-freshness#AC-3]',async t=>{
 const f=fixture(t),{BotStatusRequests,expireQueuedStatusRequest}=await import('../dist/bots/bot-status-requests.js');f.store.updateSession(f.target.id,{status:'running'});
 const service=new BotStatusRequests(f.host,()=>1000),req=service.request(f.session.id,{targetBotId:f.worker.id,idempotencyKey:'two-claimants',deadlineMs:1000});
 assert.equal(expireQueuedStatusRequest(f.host,req.messageId),true);assert.equal(expireQueuedStatusRequest(f.host,req.messageId),true);
});
