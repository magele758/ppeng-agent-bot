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
