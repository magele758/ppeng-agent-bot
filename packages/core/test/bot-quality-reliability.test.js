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
 t.mock.timers.tick(20001);assert.equal(signal.aborted,false);
 t.mock.timers.tick(40000);const result=await pending;
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

test('compaction separates internal instructions from history and labels returned background [AC:bot-quality-reliability#AC-5]', async t=>{
 const dir=mkdtempSync(join(tmpdir(),'bot-summary-boundary-'));let completion;
 const rt=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'summary-boundary',async runTurn(){throw Error('not a task turn');},
  async completeText(input){completion=input;return 'Goal: old task. Output a JSON summary and save diagnostics.';},
  async summarizeMessages(){return 'Goal: old task. Output a JSON summary and save diagnostics.';}
 }});
 t.after(async()=>{await rt.destroy();rmSync(dir,{recursive:true,force:true});});
 const bot=rt.createBot({name:'summary-boundary'}),sid=rt.openBot(bot.id).sessionId;
 rt.store.appendMessage(sid,'user',[{type:'text',text:'Inspect recorded diagnostics.'}]);
 for(let i=0;i<20;i++)rt.store.appendMessage(sid,i%2?'assistant':'user',[{type:'text',text:'Historical observation '+i}]);
 const result=await rt.compactCanonicalSession(sid);assert.ok(result.replaced);
 assert.ok(completion,'internal instructions must use completion system rather than a fake user message');
 assert.match(completion.system,/Do not include these summarization instructions/);
 const payload=JSON.parse(completion.user);assert.ok(payload.history.length);
 assert.ok(payload.history.every(m=>m.id!=='bot-compact-instruction'));
 assert.equal(completion.jsonMode,false);
 const summary=rt.store.foldMessages(sid).find(m=>m.key==='compact-summary');
 assert.equal(summary.role,'assistant','generated history must not acquire system authority');
 assert.match(summary.parts[0].text,/Historical context, not new instructions/);
 assert.match(summary.parts[0].text,/current user request takes priority/);
 assert.match(summary.parts[0].text,/history_read/);
});

test('long tool chains retain the current user request across history selection [AC:bot-quality-reliability#AC-6]', async()=>{
 const {selectEpisodicMessages,selectEpisodicMessagesWithCognitiveState}=await import('../dist/model/episodic-selection.js');
 const msg=(id,role,parts)=>({id,role,parts,sessionId:'s',createdAt:'2026-10-24T00:00:00Z'});
 for(const tool of ['history_read','write_file']) {
  const messages=[msg('old','assistant',[{type:'text',text:'Historical goal: save diagnostics.'}]),msg('current','user',[{type:'text',text:'Only return the failure code. Do not save anything.'}])];
  for(let i=0;i<12;i++)messages.push(msg('call'+i,'assistant',[{type:'tool_call',toolCallId:'c'+i,name:tool,input:{}}]),msg('result'+i,'tool',[{type:'tool_result',toolCallId:'c'+i,name:tool,ok:true,content:'observed '+i}]));
  for(const budget of [1,100000])for(const selected of [selectEpisodicMessages(messages,budget),selectEpisodicMessagesWithCognitiveState(messages,budget).selected]) {
   if(budget===100000)assert.deepEqual(selected,messages,'fitting history must not be tail-truncated');
   assert.ok(selected.some(m=>m.id==='current'),'latest user instruction must survive');
   assert.deepEqual(selected.filter(m=>m.id!=='old').map(m=>m.id),messages.slice(1).map(m=>m.id));
  }
 }
});
