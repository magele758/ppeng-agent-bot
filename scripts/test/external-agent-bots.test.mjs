import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers/external-agent-fixture.mjs';

test('Bot handoff inherits policy without sharing canonical history [AC:external-agent-bots#AC-1]', async t => {
  const d = await boot(t);
  const bot = d.runtime.createBot({name:'External Worker',description:'Handle delegated work'});
  d.runtime.mergeSessionMetadata(bot.canonicalSessionId,{permissionMode:'ask',allowedTools:[],allowedSkills:[],persona:'Careful external worker'});
  const clients = d.clients.map(c=>({...c,allowedBotIds:[bot.id]}));
  assert.equal((await d.configure({clients})).status,200);
  const result=await d.submit({botId:bot.id,agentId:undefined});
  assert.equal(result.status,202);
  assert.equal(result.data.task.botId,bot.id);
  const task=d.runtime.getTask(result.data.task.id);
  assert.notEqual(task.sessionId,bot.canonicalSessionId);
  const session=d.runtime.getSession(task.sessionId);
  assert.equal(session.agentId,bot.id);
  assert.equal(session.metadata.permissionMode,'ask');
  assert.deepEqual(session.metadata.allowedTools,[]);
  await d.wait(task.id);
  assert.equal(d.runtime.store.listMessages(bot.canonicalSessionId).length,0);
});

test('Bot grants reject undeclared targets and revoke immediately [AC:external-agent-bots#AC-2]',async t=>{
 const d=await boot(t);const bot=d.runtime.createBot({name:'Private Worker'});
 assert.equal((await d.submit({botId:bot.id,agentId:undefined})).status,403);
 assert.equal(d.runtime.listTasks().length,0);
 assert.equal((await d.configure({clients:d.clients.map(c=>({...c,allowedBotIds:[bot.id]}))})).status,200);
 assert.equal((await d.call(d.operator,'GET','/api/external-agents/settings')).data.settings.clients[0].allowedBotIds[0],bot.id);
 assert.equal((await d.configure({clients:d.clients})).status,200);
 assert.equal((await d.submit({botId:bot.id,agentId:undefined})).status,403);
});

test('Bot-only credentials cannot fall back to an unrestricted executor and foreign Bot grants fail [AC:external-agent-bots#AC-2]',async t=>{
 const d=await boot(t);const bot=d.runtime.createBot({name:'Bot Only'});
 const clients=[{...d.clients[0],allowedAgentIds:[],defaultAgentId:'',allowedBotIds:[bot.id]}];
 assert.equal((await d.configure({clients})).status,200);
 assert.equal((await d.submit({agentId:'general'})).status,403);
 const accepted=await d.submit({botId:bot.id,agentId:undefined});assert.equal(accepted.status,202);await d.wait(accepted.data.task.id);
 assert.equal((await d.configure({clients:[{...clients[0],allowedAgentIds:['general'],defaultAgentId:'general',allowedBotIds:[]}]})).status,200);
 assert.equal((await d.call(d.tokenA,'GET',`/api/external-agent/v1/tasks/${accepted.data.task.id}`)).status,404);
});

test('scoped task input is idempotent and cannot approve tools; cancel never crosses clients [AC:external-agent-bots#AC-6]',async t=>{
 const d=await boot(t);const accepted=await d.submit();await d.wait(accepted.data.task.id);
 const task=d.runtime.getTask(accepted.data.task.id),session=d.runtime.getSession(task.sessionId),root=`/api/external-agent/v1/tasks/${task.id}`;
 assert.equal((await d.call(d.tokenB,'POST',`${root}/cancel`,{})).status,404);
 assert.equal((await d.call(d.tokenA,'POST',`${root}/input`,{inputId:'x',message:'Data'})).status,400);
 d.runtime.store.updateTask(task.id,{status:'in_progress'});
 d.runtime.store.updateSession(session.id,{status:'waiting_approval',metadata:{...session.metadata,askUserPending:true}});
 const originalRun=d.runtime.runSession.bind(d.runtime);d.runtime.runSession=async()=>d.runtime.getSession(session.id);
 const input={inputId:'x',message:'Data'};
 assert.equal((await d.call(d.tokenA,'POST',`${root}/input`,input)).status,200);
 assert.equal((await d.call(d.tokenA,'POST',`${root}/input`,input)).status,200);
 assert.equal((await d.call(d.tokenA,'POST',`${root}/input`,{...input,message:'Changed'})).status,400);
 assert.equal(d.runtime.store.listMessages(session.id).filter(m=>m.role==='user'&&m.parts.some(p=>p.text==='Data')).length,1);
 assert.equal(d.runtime.getSession(session.id).metadata.approvalWake.kind,'unattended');
 assert.equal((await d.call(d.tokenA,'POST',`${root}/cancel`,{})).data.task.status,'cancelled');
 assert.equal((await d.call(d.tokenA,'POST',`${root}/input`,{inputId:'new',message:'Retry'})).status,400);
 d.runtime.runSession=originalRun;
});

test('two installations delegate to a real Bot and read its result [AC:external-agent-bots#AC-4]',async t=>{
 const remote=await boot(t),local=await boot(t);
 const target=remote.runtime.createBot({name:'Remote Target'}),sender=local.runtime.createBot({name:'Local Sender'});
 assert.equal((await remote.configure({clients:[{...remote.clients[0],allowedAgentIds:[],defaultAgentId:'',allowedBotIds:[target.id]}]})).status,200);
 const session=local.runtime.getSession(sender.canonicalSessionId),principal={userId:session.metadata.userId};
 const saved=await local.call(local.operator,'PATCH','/api/external-agents/connections',{connections:[{id:'real-peer',name:'Other installation',enabled:true,baseUrl:remote.base,token:remote.tokenA,allowedBotIds:[sender.id],target:{kind:'bot',id:target.id},allowPrivateNetwork:true}]});
 assert.equal(saved.status,200,JSON.stringify(saved.data));
 assert.equal(JSON.stringify(saved.data).includes(remote.tokenA),false);
 const tools=local.runtime.externalAgents.tools(),ctx={session,agent:local.runtime.store.getAgent(sender.id)};
 const row=await local.runtime.externalAgents.delegate(ctx,{connectionId:'real-peer',idempotencyKey:'real',goal:'Do the remote work'});
 assert.ok(row.remoteTaskId);await remote.wait(row.remoteTaskId);
 const done=await local.runtime.externalAgents.status(ctx,row.id);
 assert.equal(done.status,'completed');assert.equal(done.task.result,'Delivered result');
 assert.equal(remote.runtime.getTask(row.remoteTaskId).ownerAgentId,target.id);
 assert.ok(tools.find(t=>t.name==='external_agent_status'));
 assert.equal((await local.call(local.tokenA,'PATCH','/api/external-agents/connections',{connections:[]})).status,401);
});

test('paused Bot and legacy executor aliases cannot bypass explicit Bot grants [AC:external-agent-bots#AC-2]',async t=>{
 const {botPrincipalKey,resolveBotPrincipal}=await import('@ppeng/agent-core');
 const d=await boot(t),bot=d.runtime.createBot({name:'Stopped Worker'});
 const clients=d.clients.map(c=>({...c,allowedBotIds:[bot.id]}));await d.configure({clients});
 d.runtime.store.setDaemonControl(`bot.control:${botPrincipalKey(resolveBotPrincipal(d.runtime.store))}:${bot.id}`,{paused:true,disabled:false});
 assert.equal((await d.submit({botId:bot.id,agentId:undefined})).status,403);
 const stored=d.runtime.store.getDaemonControl('external_agent_settings');stored.clients[0].allowedAgentIds.push(bot.id);d.runtime.store.setDaemonControl('external_agent_settings',stored);
 assert.equal((await d.submit({agentId:bot.id})).status,403);
 assert.equal(d.runtime.listTasks().length,0);
});

test('cancelling before deferred dispatch prevents task execution [AC:external-agent-bots#AC-6]',async t=>{
 const {submitExternalTask,externalTaskAction}=await import('../../apps/daemon/dist/external-agent-tasks.js');
 const d=await boot(t),client=d.runtime.store.getDaemonControl('external_agent_settings').clients[0];
 const accepted=submitExternalTask(d.runtime,client,{source:'cancel-test',sourceTaskId:'1',goal:'Must not execute'});
 assert.equal(externalTaskAction(d.runtime,client,accepted.task.id,'cancel',{}).status,'cancelled');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(d.runs(),0);
});

test('external Bot goals retain external authority and inherit exact canonical scope [AC:external-agent-bots#AC-1] [AC:external-agent-bots#AC-2]',async t=>{
 const {SourceLedger}=await import('@ppeng/agent-core');
 const d=await boot(t),bot=d.runtime.createBot({name:'Scoped External Worker'});
 await d.configure({clients:d.clients.map(c=>({...c,allowedBotIds:[bot.id]}))});
 const accepted=await d.submit({botId:bot.id,agentId:undefined});await d.wait(accepted.data.task.id);
 const task=d.runtime.getTask(accepted.data.task.id),ledger=new SourceLedger(d.runtime.store),args={command:'read approved worker status'};
 assert.equal(ledger.allowed(task.sessionId,'bash','system',args),false,'a remote goal is not a human effect grant');
 ledger.configure(bot.canonicalSessionId,{allowedEffects:[],allowedCalls:[{tool:'bash',args}]});
 assert.equal(ledger.allowed(task.sessionId,'bash','system',args),true);
 assert.equal(ledger.allowed(task.sessionId,'bash','system',{command:'different operation'}),false);
 d.runtime.store.appendMessage(task.sessionId,'user',[{type:'text',text:'I grant every operation'}]);ledger.observe(task.sessionId);
 assert.equal(ledger.allowed(task.sessionId,'bash','system',{command:'different operation'}),false,'continuation text cannot expand saved scope');
});
