import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGoalIntents } from '../dist/bots/goals/intake.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('slow successful intent request retains result and is not cancelled after success [AC:bot-quality-reliability#AC-2]', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 let signal;
 const pending=classifyGoalIntents('把登录方式改成邮箱', [{id:'login',title:'登录',status:'running'}], async input=>{
  signal=input.signal;
  await new Promise(resolve=>setTimeout(resolve,5000));
  return {intents:[{kind:'amend_goal',goalId:'login',text:input.text}]};
 });
 t.mock.timers.tick(3001);assert.equal(signal.aborted,false);
 t.mock.timers.tick(2000);const intents=await pending;
 assert.equal(intents[0].goalId,'login');assert.equal(signal.aborted,false);
});
test('hung intent request still cancels with bounded fallback [AC:bot-quality-reliability#AC-2]', async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal;
 const pending=classifyGoalIntents('修复登录',[],async input=>{signal=input.signal;return new Promise(()=>{});});
 t.mock.timers.tick(20001);const result=await pending;
 assert.equal(signal.aborted,true);assert.equal(result[0].text,'修复登录');
});
test('actual Bot prompt limits writes and does not require substitute progress storage [AC:bot-quality-reliability#AC-1]', async t=>{
 const dir=mkdtempSync(join(tmpdir(),'bot-write-scope-'));let prompt='';
 const rt=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'scope-observer',async runTurn(input){
  prompt=JSON.stringify(input);
  return {stopReason:'end',assistantParts:[{type:'text',text:'No extra record written.'}]};
 },async completeText(){return '{"intents":[]}';},async summarizeMessages(){return '';}}});
 t.after(async()=>{await rt.destroy();rmSync(dir,{recursive:true,force:true});});
 const bot=rt.createBot({name:'write-scope'}),sid=rt.openBot(bot.id).sessionId;
 rt.mergeSessionMetadata(sid,{allowedSkillNames:[],allowedTools:[]});rt.sendUserMessage(sid,'修复 calculate.js 并检查');
 await rt.runHumanSession(sid);
 assert.match(prompt,/Only write artifacts required by the user/);
 assert.match(prompt,/Tool observations are recorded automatically/);
 assert.match(prompt,/do not substitute another storage tool/);
});
