import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { classifyGoalIntents } from '../dist/bots/goals/intake.js';
import { announceGoalState, createGoalCheckpointTool, judgeChildCompletion } from '../dist/bots/goals/runtime-host.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'goal-chain-'));
 const store=new SqliteStateStore(join(dir,'db'));
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 const parent=store.createSession({title:'Bot',mode:'chat',agentId:'general',metadata:{canonicalBotChat:true,botId:'b',userId:'alice'}});
 const service=new BotGoalService(store,Date.now,parent.id);
 const goal=service.create({botId:'b',sessionId:parent.id,title:'Write',objective:'Create result using an independent subtask and verify it'});
 const ex=service.claim('b',goal.id,{strategy:'subagent'});
 service.updateExecution('b',ex.id,{sessionId:parent.id});
 store.updateSession(parent.id,{metadata:{...parent.metadata,botGoalId:goal.id,botGoalExecutionId:ex.id,botGoalScopeSessionId:parent.id}});
 return {store,parent,service,goal,ex};
}
function observation(store,id,name,text) {
 const call='call-'+id+'-'+name;
 store.appendMessage(id,'assistant',[{type:'tool_call',toolCallId:call,name,input:{}}]);
 store.appendMessage(id,'tool',[{type:'tool_result',toolCallId:call,name,ok:true,content:text}]);
}

test('linked dispatch and child observations reach completion without unrelated history [AC:bot-goal-live-chain#AC-1]',async t=>{
 const {store,parent,service,goal,ex}=fixture(t);
 const child=store.createSession({title:'worker',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:'alice',botId:'b',botGoalId:goal.id,botGoalScopeSessionId:parent.id}});
 service.updateExecution('b',ex.id,{runRef:'session:'+child.id});
 observation(store,parent.id,'goal_dispatch','launched independent subtask');
 observation(store,child.id,'write_file','result=37');
 let packet;
 const host={store,judge:async input=>{packet=JSON.parse(input.user);return JSON.stringify({met:false,reason:'inspect'});}};
 await judgeChildCompletion(host,goal,child.id,'done');
 assert.deepEqual(packet.observations.map(o=>o.name),['goal_dispatch','write_file']);
 store.updateSession(child.id,{metadata:{...child.metadata,userId:'bob'}});
 await judgeChildCompletion(host,goal,child.id,'done');
 assert.ok(!packet.observations.some(o=>o.content.includes('result=37')));
});

test('sequential deliverable survives fallback and over-splitting judge [AC:bot-goal-live-chain#AC-2]',async()=>{
 const text='请写入 result.json 数值 37，再用 read_file 读取核对；必须交给子任务完成，不要修改其他文件';
 for(const judge of [undefined,async()=>{throw Error('offline');},async()=>({intents:[{kind:'new_goal',text:'请写入 result.json 数值 37'},{kind:'new_goal',text:'再用 read_file 读取核对'}]})]) {
  assert.deepEqual((await classifyGoalIntents(text,[],judge)).map(i=>i.text),[text]);
 }
 assert.deepEqual((await classifyGoalIntents('暂停部署，先修登录',[{id:'g',title:'部署',status:'running'}])).map(i=>i.kind),['pause','new_goal']);
});

test('active goal tools visible by default but never bypass allowlist [AC:bot-goal-live-chain#AC-3]',t=>{
 const {store,parent}=fixture(t);
 const tools=['read_file','goal_dispatch','goal_checkpoint'].map(name=>({name,description:name,inputSchema:{type:'object'},execute:async()=>({ok:true,content:''})}));
 const input={env:{},tools,agent:{id:'general'},session:store.getSession(parent.id),settingsStore:store};
 assert.ok(filterToolsForSession(input).tools.some(t=>t.name==='goal_dispatch'));
 assert.ok(!filterToolsForSession({...input,session:{...input.session,metadata:{...input.session.metadata,allowedTools:['read_file']}}}).tools.some(t=>t.name==='goal_dispatch'));
});

test('terminal notice is durable without scheduling a new turn; stale checkpoint refused [AC:bot-goal-live-chain#AC-4]',async t=>{
 const {store,parent,service,ex}=fixture(t);
 const ended=service.report('b',ex.id,{kind:'candidate_completed',summary:'verified result',verified:true});
 const wakes=[];store.enqueueSchedulerWake=(...args)=>wakes.push(args);
 announceGoalState({store},ended);announceGoalState({store},ended);
 assert.equal(wakes.length,0);
 assert.equal(store.foldMessages(parent.id).filter(m=>m.parts.some(p=>p.text?.startsWith('[goal update]'))).length,1);
 const result=await createGoalCheckpointTool(store).execute({session:store.getSession(parent.id)},{kind:'progress',summary:'still waiting'});
 assert.equal(result.ok,false);
 assert.equal(store.getSession(parent.id).metadata.botGoalCheckpoint,undefined);
});

test('evidence survives continuation and compaction but not retraction or revision [AC:bot-goal-live-chain#AC-1]',async t=>{
 const {goalExecutionEvidence}=await import('../dist/bots/goals/execution-evidence.js');
 const {buildCompletionEvidence}=await import('../dist/bots/goals/completion-evidence.js');
 const {store,parent,service,goal,ex}=fixture(t);
 observation(store,parent.id,'read_file','before boundary');
 const start=store.listSurfaceNodes(parent.id).at(-1).seq;
 service.updateExecution('b',ex.id,{messageStartSeq:start});
 observation(store,parent.id,'write_file','current result');
 const end=store.listSurfaceNodes(parent.id).at(-1).seq;
 service.updateExecution('b',ex.id,{messageEndSeq:end});
 service.report('b',ex.id,{kind:'progress',summary:'verify result'});
 observation(store,parent.id,'read_file','unrelated future');
 const packet=()=>buildCompletionEvidence(service.get('b',goal.id),goalExecutionEvidence(store,service.get('b',goal.id)),'done');
 assert.deepEqual(packet().observations.map(o=>o.content),['current result']);
 store.appendReplacement(parent.id,{startSeq:start+1,endSeq:end,role:'system',parts:[{type:'text',text:'compacted'}],key:'compact-summary'});
 assert.deepEqual(packet().observations.map(o=>o.content),['current result']);
 store.hideRange(parent.id,start+1,end);
 assert.deepEqual(packet().observations,[]);
 service.applyIntent('b',{kind:'amend_goal',goalId:goal.id,text:'Use 38',sessionId:parent.id});
 assert.deepEqual(packet().observations,[]);
});

test('delegated canonical transcript bounded to current attempt and same principal [AC:bot-goal-live-chain#AC-1]',async t=>{
 const {createBot}=await import('../dist/bots/bot-facade.js');
 const {dispatchBotTask}=await import('../dist/bots/bot-work.js');
 const {beginBotDelivery,finishBotDelivery}=await import('../dist/bots/bot-delivery.js');
 const {goalExecutionEvidence}=await import('../dist/bots/goals/execution-evidence.js');
 const {buildCompletionEvidence}=await import('../dist/bots/goals/completion-evidence.js');
 const {store,parent,service}=fixture(t);
 const host={store,createChatSession:input=>store.createSession(input),log:{warn(){},info(){},debug(){},error(){}},runSession:async()=>{}};
 const requester=createBot(host,{name:'Source'}),target=createBot(host,{name:'Target'});
 store.updateSession(parent.id,{metadata:{...parent.metadata,botId:requester.id}});
 const goal=service.create({botId:requester.id,sessionId:parent.id,title:'Delegate',objective:'Create file through delegated bot'});
 const ex=service.claim(requester.id,goal.id,{strategy:'bot_delegate'});
 const task=dispatchBotTask(host,{principal:{userId:'alice'},requesterBotId:requester.id,targetBotId:target.id,input:'Create file',idempotencyKey:ex.id});
 service.updateExecution(requester.id,ex.id,{sessionId:parent.id,runRef:'bot_task:'+task.id});
 const recipient=store.listSessions().find(s=>s.metadata.botId===target.id&&s.metadata.userId==='alice');
 assert.ok(recipient);
 observation(store,recipient.id,'read_file','unrelated before');
 beginBotDelivery(store,task.id,recipient.id,1);
 observation(store,recipient.id,'write_file','actual task file');
 finishBotDelivery(store,{taskId:task.id,sessionId:recipient.id,attempt:1,executionStatus:'completed',report:'done',failureReason:null});
 store.db.prepare("UPDATE bot_work_tasks SET attempt=1,status='completed' WHERE id=?").run(task.id);
 observation(store,recipient.id,'read_file','unrelated after');
 const packet=()=>buildCompletionEvidence(goal,goalExecutionEvidence(store,goal),'done');
 assert.deepEqual(packet().observations.map(o=>o.content),['actual task file']);
 assert.deepEqual(packet().observations[0].source,{kind:'delegated',goalId:goal.id,revision:goal.revision,executionId:ex.id,botId:target.id,taskId:task.id,attempt:1,taskStatus:'completed'});
 const worker=store.createSession({title:'Worker',mode:'subagent',agentId:'general',parentSessionId:recipient.id,metadata:{botId:target.id,userId:'alice',botWorkTaskId:task.id,botWorkTaskAttempt:1}});
 observation(store,worker.id,'read_file','current child');
 const unrelated=store.createSession({title:'Unrelated',mode:'subagent',agentId:'general',metadata:worker.metadata});
 observation(store,unrelated.id,'read_file','forged ancestry');
 assert.deepEqual(packet().observations.map(o=>o.content),['actual task file','current child']);
 store.deleteSession(worker.id);
 store.deleteSession(unrelated.id);
 store.db.prepare('UPDATE bot_work_tasks SET attempt=2 WHERE id=?').run(task.id);
 assert.deepEqual(packet().observations,[],'old attempt is not current evidence');
 store.db.prepare('UPDATE bot_work_tasks SET attempt=1 WHERE id=?').run(task.id);
 store.updateSession(recipient.id,{metadata:{...recipient.metadata,userId:'bob'}});
 assert.deepEqual(packet().observations,[],'another user cannot provide evidence');
});

test('non-running and foreign executions cannot disclose or checkpoint; notice preserves new input [AC:bot-goal-live-chain#AC-3] [AC:bot-goal-live-chain#AC-4]',async t=>{
 const {store,parent,service,goal,ex}=fixture(t);
 const tools=['goal_dispatch','goal_checkpoint'].map(name=>({name,description:name,inputSchema:{type:'object'}}));
 const names=session=>filterToolsForSession({env:{},tools,agent:{id:'general'},session,settingsStore:store}).tools.map(t=>t.name);
 const outsider=store.createSession({title:'Bob',mode:'chat',agentId:'general',metadata:{...store.getSession(parent.id).metadata,userId:'bob'}});
 assert.ok(!names(outsider).includes('goal_dispatch'));
 assert.equal((await createGoalCheckpointTool(store).execute({session:outsider},{kind:'progress',summary:'foreign'})).ok,false);
 const stale=store.getSession(parent.id);
 const pending=service.report('b',ex.id,{kind:'candidate_completed',summary:'result',evidence:['observed'],verified:false});
 announceGoalState({store},pending);
 const newMessage=store.appendMessage(parent.id,'user',[{type:'text',text:'Write a second file'}]);
 const done=service.control('b',goal.id,'verify',{accepted:true});
 announceGoalState({store},done);
 announceGoalState({store},pending);
 const notices=store.foldMessages(parent.id).filter(m=>m.parts.some(p=>p.text?.startsWith('[goal update]')));
 assert.equal(notices.length,2);
 assert.match(notices.at(-1).parts[0].text,/^\[goal update\] Done:/);
 assert.ok(store.foldMessages(parent.id).some(m=>m.id===newMessage.id));
 assert.ok(!names(store.getSession(parent.id)).includes('goal_dispatch'));
 assert.equal((await createGoalCheckpointTool(store).execute({session:stale},{kind:'progress',summary:'stale'})).ok,false);
});

test('timeout preserves full sequential task, independent outcomes remain separate [AC:bot-goal-live-chain#AC-2]',async()=>{
 const text='Write a.json; then read it and verify the result; do not change other files';
 assert.deepEqual((await classifyGoalIntents(text,[],()=>new Promise(()=>{}))).map(i=>i.text),[text]);
 assert.equal((await classifyGoalIntents('请做两件独立的事：写 A；写 B',[])).length,2);
});

test('waiting continuation receives scoped tool observations before model execution [AC:bot-goal-live-chain#AC-1]',async t=>{
 const {tickBotGoals}=await import('../dist/bots/goals/scheduler.js');
 const {store,parent,service,goal,ex}=fixture(t);
 const child=store.createSession({title:'Worker',mode:'subagent',agentId:'general',parentSessionId:parent.id,metadata:{userId:'alice',botId:'b',botGoalId:goal.id,botGoalScopeSessionId:parent.id,outcome:{kind:'completed'}}});
 observation(store,child.id,'write_file','child.json value=37');
 store.updateSession(child.id,{status:'idle'});
 service.updateExecution('b',ex.id,{runRef:'session:'+child.id});
 store.updateSession(parent.id,{metadata:{...store.getSession(parent.id).metadata,botGoalAuthorizedWaits:[{goalId:goal.id,executionId:ex.id,source:'session',correlationId:child.id}]}});
 service.report('b',ex.id,{kind:'waiting',summary:'working',wait:{source:'session',correlationId:child.id}});
 let observed;
 await tickBotGoals({store,isRunning:()=>false,cancel(){},capabilities:()=>({registeredTools:[],enabledStrategies:['direct']}),run:async id=>{
  observed=store.listUnclaimedInbox(id).find(item=>item.key?.startsWith('goal-evidence:'))?.text;
 }});
 assert.match(observed,/"name":"write_file"/);
 assert.match(observed,/child.json value=37/);
 assert.match(observed,/Do not repeat completed operations/);
});

test('meaningful state notifications stay deterministic across terminal and review states [AC:bot-goal-live-chain#AC-4]',t=>{
 const {store,parent,service}=fixture(t);
 for(const kind of ['blocked','failed','candidate_completed']) {
  const goal=service.create({botId:'b',sessionId:parent.id,title:kind,objective:'Do '+kind});
  const execution=service.claim('b',goal.id,{strategy:'direct'});
  const state=service.report('b',execution.id,{kind,summary:'observed',evidence:['observed']});
  announceGoalState({store},state);announceGoalState({store},state);
 }
 const notices=store.foldMessages(parent.id).filter(m=>m.parts.some(p=>p.text?.startsWith('[goal update]')));
 assert.equal(notices.length,3);
 assert.deepEqual(store.dequeueSchedulerWakes(),[]);
 assert.deepEqual(store.listUnclaimedInbox(parent.id),[]);
});

test('notice reads latest state inside its write transaction [AC:bot-goal-live-chain#AC-4]',t=>{
 const {store,parent,service,goal,ex}=fixture(t);
 const pending=service.report('b',ex.id,{kind:'candidate_completed',summary:'result',evidence:['result']});
 const transaction=store.transaction.bind(store);
 let switched=false;
 store.transaction=fn=>transaction(()=>{
  if(!switched){switched=true;service.control('b',goal.id,'verify',{accepted:true});}
  return fn();
 });
 announceGoalState({store},pending);
 const notice=store.foldMessages(parent.id).at(-1);
 assert.match(notice.parts[0].text,/^\[goal update\] Done:/);
});
