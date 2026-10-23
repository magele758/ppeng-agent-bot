import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';

test('a rejected competing writer cannot settle the active Bot goal [AC:bot-multi-goal-coordination#AC-10]', async () => {
 const root=mkdtempSync(join(tmpdir(),'goal-peer-'));
 let entered,release;
 const started=new Promise(resolve=>{entered=resolve;});
 const held=new Promise(resolve=>{release=resolve;});
 const modelAdapter={name:'goal-peer',async runTurn(){entered();await held;return {stopReason:'end',assistantParts:[{type:'text',text:'Partial work'}]};},async summarizeMessages(){return '';}};
 const owner=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),modelAdapter});
 const peer=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),modelAdapter});
 let running;
 try {
  const bot=owner.createBot({name:'Peer goal'});const sid=owner.openBot(bot.id).sessionId;
  owner.sendUserMessage(sid,'修复登录问题');running=owner.runHumanSession(sid);await started;
  const service=new BotGoalService(owner.store,Date.now,sid);const before=service.list(bot.id)[0];
  assert.equal(before.status,'running');
  await assert.rejects(peer.runSession(sid),/writer claim mismatch/i);
  const after=service.get(bot.id,before.id);
  assert.equal(after.status,'running');assert.equal(after.activeExecutionId,before.activeExecutionId);
 }finally{release();await running;await peer.destroy();await owner.destroy();}
});

test('real Bot execution retains independently tracked work and never accepts unverified return as completion [AC:bot-multi-goal-coordination#AC-1] [AC:bot-multi-goal-coordination#AC-7]', async () => {
 const runtime = new RawAgentRuntime({ repoRoot:mkdtempSync(join(tmpdir(),'goal-repo-')),stateDir:mkdtempSync(join(tmpdir(),'goal-state-')),modelAdapter:{name:'goal-test',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'I stopped before finishing.'}]};},async summarizeMessages(){return 'summary';}} });
 try {
  const bot=runtime.createBot({name:'Goal test'});const sessionId=runtime.openBot(bot.id).sessionId;
  runtime.sendUserMessage(sessionId,'修复登录问题',{autoRun:true});await runtime.runHumanSession(sessionId);
  const service=new BotGoalService(runtime.store,Date.now,sessionId);
  const goals=service.list(bot.id);assert.equal(goals.length,1);assert.notEqual(goals[0].status,'completed');
  runtime.sendUserMessage(sessionId,'现在进度怎么样？',{autoRun:true});await runtime.runHumanSession(sessionId);
  assert.equal(service.list(bot.id).length,1);
 } finally {await runtime.destroy();}
});

test('real runtime continues an unfinished goal after a returned turn and verifies the final result [AC:bot-multi-goal-coordination#AC-7]', async () => {
 let parent;
 const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'goal-resume-repo-')),stateDir:mkdtempSync(join(tmpdir(),'goal-resume-state-')),modelAdapter:{
  name:'goal-resume',async runTurn(input){return {stopReason:'end',assistantParts:[{type:'text',text:input.sessionId===parent?'Partial calculation saved':'Verified answer: 4'}]};},
  async completeText(input){if(input.system.startsWith('Evaluate'))return JSON.stringify({met:input.user.includes('Verified answer: 4'),advanced:true,reason:'Calculation checked',evidence:input.user.includes('Verified answer: 4')?['Verified answer: 4']:[]});return '{"intents":[]}';},async summarizeMessages(){return 'summary';}
 }});
 try {
  const bot=runtime.createBot({name:'Goal resume'});parent=runtime.openBot(bot.id).sessionId;
  runtime.sendUserMessage(parent,'Calculate two plus two',{autoRun:true});await runtime.runHumanSession(parent);
  const service=new BotGoalService(runtime.store,Date.now,parent);
  assert.equal(service.list(bot.id)[0].status,'queued');
  await tickBotGoals(runtime.goalRuntimeHost());
  for(let n=0;n<100&&service.list(bot.id)[0].status!=='completed';n++)await new Promise(resolve=>setTimeout(resolve,10));
  const goal=service.list(bot.id)[0];assert.equal(goal.status,'completed');assert.equal(goal.attempts,2);assert.ok(goal.evidence.includes('Verified answer: 4'));
  await tickBotGoals(runtime.goalRuntimeHost());assert.equal(service.list(bot.id)[0].attempts,2);
 }finally{await runtime.destroy();}
});

test('goal checkpoints validate assignment and authorized waits before preserving evidence', async () => {
 const {createGoalCheckpointTool}=await import('../dist/bots/goals/runtime-host.js');
 const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'checkpoint-repo-')),stateDir:mkdtempSync(join(tmpdir(),'checkpoint-state-'))});
 try {
  const bot=runtime.createBot({name:'Checkpoint'});const sid=runtime.openBot(bot.id).sessionId;
  const service=new BotGoalService(runtime.store,Date.now,sid);
  const goal=service.create({botId:bot.id,sessionId:sid,title:'Check',objective:'Verify result'});
  const tool=createGoalCheckpointTool(runtime.store);
  const invoke=args=>tool.execute({session:runtime.getSession(sid)},args);
  assert.equal((await invoke({kind:'progress',summary:'no assignment'})).ok,false);
  runtime.store.updateSession(sid,{metadata:{...runtime.getSession(sid).metadata,botGoalId:goal.id}});
  assert.equal((await invoke({kind:'invalid',summary:'invalid'})).ok,false);
  assert.equal((await invoke({kind:'progress',summary:'Measured result',evidence:['proof',123],nextStep:'Verify'})).ok,true);
  const checkpoint=runtime.getSession(sid).metadata.botGoalCheckpoint;
  assert.deepEqual(checkpoint.evidence,['proof']);assert.equal(checkpoint.nextStep,'Verify');
  assert.equal((await invoke({kind:'waiting',summary:'untrusted',wait:{source:'session',correlationId:'foreign'}})).ok,false);
  assert.deepEqual(runtime.getSession(sid).metadata.botGoalCheckpoint,checkpoint);
  runtime.store.updateSession(sid,{metadata:{...runtime.getSession(sid).metadata,botGoalAuthorizedWaits:[{goalId:goal.id,source:'session',correlationId:'worker'}]}});
  assert.equal((await invoke({kind:'waiting',summary:'Waiting for worker',wait:{source:'session',correlationId:'worker'}})).ok,true);
  assert.deepEqual(runtime.getSession(sid).metadata.botGoalCheckpoint.wait,{source:'session',correlationId:'worker'});
  assert.equal(service.get(bot.id,goal.id).status,'queued','a checkpoint alone never completes a goal');
 }finally{await runtime.destroy();}
});

test('goal intake coordinates queries, ambiguous references and controls of active executions', async () => {
 const {prepareGoalIntake}=await import('../dist/bots/goals/runtime-host.js');
 const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'intake-repo-')),stateDir:mkdtempSync(join(tmpdir(),'intake-state-'))});
 try {
  const bot=runtime.createBot({name:'Intake'});const sid=runtime.openBot(bot.id).sessionId;
  const service=new BotGoalService(runtime.store,Date.now,sid);
  const goal=service.create({botId:bot.id,sessionId:sid,title:'Fix',objective:'Fix login'});
  const execution=service.claim(bot.id,goal.id,{strategy:'direct'});
  const worker=runtime.store.createSession({title:'Worker',mode:'subagent',agentId:bot.agentId,parentSessionId:sid,metadata:{botId:bot.id,botGoalScopeSessionId:sid}});
  service.updateExecution(bot.id,execution.id,{sessionId:worker.id});
  const cancelled=[];
  const host={store:runtime.store,cancel:id=>cancelled.push(id)};
  async function intake(text){runtime.sendUserMessage(sid,text,{autoRun:true});await prepareGoalIntake(host,runtime.getSession(sid));}
  await intake(`[goal:${goal.id}] 不要修改已有数据`);
  assert.deepEqual(cancelled,[worker.id]);assert.deepEqual(service.get(bot.id,goal.id).constraints,['不要修改已有数据']);
  await intake(`[goal:${goal.id}] 暂停`);
  assert.deepEqual(cancelled,[worker.id,worker.id]);assert.equal(service.get(bot.id,goal.id).status,'paused');
  await intake('现在进度怎么样？');
  await intake('[goal:missing] 修改部署配置');
  const steers=runtime.store.listUnclaimedInbox(sid);
  assert.ok(steers.some(s=>s.text.includes('[goal status]')));
  assert.ok(steers.some(s=>s.text.includes('ambiguous goal reference')));
  assert.equal(service.list(bot.id).length,1);
 }finally{await runtime.destroy();}
});

test('a legacy session condition cannot override the durable Bot verdict [AC:unified-bot-goal-lifecycle#AC-1]', async () => {
 let turns=0;const judgements=[];
 const runtime=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'goal-single-repo-')),stateDir:mkdtempSync(join(tmpdir(),'goal-single-state-')),modelAdapter:{
  name:'goal-single',async runTurn(){turns++;return {stopReason:'end',assistantParts:[{type:'text',text:'Verified answer: 4'}]};},
  async completeText(input){judgements.push(input.system);if(input.system.startsWith('Evaluate'))return JSON.stringify({met:true,advanced:true,reason:'Checked',evidence:['4']});return JSON.stringify({met:false,reason:'Old contradictory condition'});},async summarizeMessages(){return '';}
 }});
 try {
  const bot=runtime.createBot({name:'Single verdict'});const sid=runtime.openBot(bot.id).sessionId;
  runtime.mergeSessionMetadata(sid,{goalEnabled:true,goalCondition:'An obsolete unrelated condition',goalMaxTurns:2});
  runtime.sendUserMessage(sid,'Calculate two plus two');await runtime.runHumanSession(sid);
  const goals=new BotGoalService(runtime.store,Date.now,sid).list(bot.id);
  assert.equal(goals[0].status,'completed');assert.equal(turns,1);
  assert.equal(judgements.filter(system=>system.startsWith('Evaluate')).length,1);
  assert.equal(runtime.store.goal().findLatestBySession(sid),null);
 }finally{await runtime.destroy();}
});
