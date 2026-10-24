import test from 'node:test';
import assert from 'node:assert/strict';
import {RawAgentRuntime} from '../dist/runtime.js';
import {builtinAgents} from '../dist/builtin-agents.js';
import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';

test('real execution prompt requires source recovery, saving outputs and exact response shape [AC:bot-completion-reliability#AC-3] [AC:bot-completion-reliability#AC-4]',async t=>{
 const root=mkdtempSync(join(tmpdir(),'completion-contract-'));let prompt;
 const rt=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),modelAdapter:{name:'contract',async runTurn(input){prompt=input.systemPrompt;return{stopReason:'end',assistantParts:[{type:'text',text:'DONE'}]};},async completeText(){return '{"intents":[]}';},async summarizeMessages(){return '';}}});
 t.after(async()=>{await rt.destroy();rmSync(root,{recursive:true,force:true});});const bot=rt.createBot({name:'contract'});const sid=rt.openBot(bot.id).sessionId;
 rt.mergeSessionMetadata(sid,{allowedTools:[],allowedSkillNames:[]});rt.sendUserMessage(sid,'读取数据并保存结果，只输出 DONE');await rt.runHumanSession(sid);
 assert.match(prompt,/Resolve bare data identifiers with an exact-key lookup/);assert.match(prompt,/Do not repeatedly guess filenames/);assert.match(prompt,/complete the requested transformation and persistence/);assert.match(prompt,/exact output format/);assert.match(prompt,/without explanations, headings, or verification reports/);
});

test('completion sees final deliverable separately from planning and retains earlier failed evidence [AC:bot-completion-reliability#AC-2]',async t=>{
 const root=mkdtempSync(join(tmpdir(),'completion-final-'));let step=0,fixed=false,packet;
 const tool=(name,execute)=>({name,description:name,inputSchema:{type:'object',properties:{}},approvalMode:'never',sideEffectLevel:'none',execute});
 const rt=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),agents:[{...builtinAgents.find(a=>a.id==='general'),allowedTools:['fixture_check','fixture_fix']}],extraTools:[tool('fixture_check',async()=>({ok:fixed,content:JSON.stringify({exitCode:fixed?0:1})})),tool('fixture_fix',async()=>{fixed=true;return{ok:true,content:'saved'};})],modelAdapter:{name:'completion-final',async summarizeMessages(){return '';},async completeText(input){if(input.system.startsWith('Evaluate')){packet=JSON.parse(input.user);return JSON.stringify({met:packet.finalResponse==='DONE',advanced:true,reason:'Inspect the final deliverable and actual checks',missing:packet.finalResponse==='DONE'?[]:['Final deliverable still includes unfinished planning'],evidenceRefs:packet.observations.filter(o=>o.ok).map(o=>o.ref)});}return JSON.stringify({intents:[{kind:'new_goal',text:'Fix the record and check it'}]});},async runTurn(){step++;return step<4?{stopReason:'tool_use',assistantParts:[{type:'text',text:'Planning next action '+step},{type:'tool_call',toolCallId:'fixture-'+step,name:step===2?'fixture_fix':'fixture_check',input:{}}]}:{stopReason:'end',assistantParts:[{type:'text',text:'DONE'}]};}}});
 t.after(async()=>{await rt.destroy();rmSync(root,{recursive:true,force:true});});const bot=rt.createBot({name:'completion-final'});const sid=rt.openBot(bot.id).sessionId;
 rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
 rt.mergeSessionMetadata(sid,{allowedTools:['fixture_check','fixture_fix'],allowedSkillNames:[],permissionMode:'auto'});rt.sendUserMessage(sid,'Fix the record and check it');await rt.runHumanSession(sid);
 assert.equal(packet.finalResponse,'DONE');assert.equal(packet.observations.length,3);assert.equal(packet.observations[0].ok,false);assert.equal(packet.observations.at(-1).ok,true);
 assert.equal(rt.store.getDaemonControl('bot_goals:'+bot.id).goals.at(-1).status,'completed');
});

test('completion still rejects unsupported or unresolved success claims [AC:bot-completion-reliability#AC-2]',async()=>{
 const {completionReport}=await import('../dist/bots/goals/completion-evidence.js');const goal={objective:'Fix record',completionCriteria:['Fix record'],resources:[]};const packet={finalResponse:'DONE',observations:[{ref:'real',name:'write',ok:false,content:'failed'}]};
 for(const evidenceRefs of [[],['forged'],['real']])assert.equal(completionReport({met:true,evidenceRefs,missing:[]},packet,goal).verified,false);
 assert.equal(completionReport({met:false,reason:'not saved',missing:['save result'],evidenceRefs:[]},packet,goal).verified,false);
});

test('direct goal gets one bounded correction for a rejected final format without replaying writes [AC:bot-completion-reliability#AC-6]',async t=>{
 for(const repairs of [true,false]){
  const root=mkdtempSync(join(tmpdir(),'completion-review-'));let step=0,writes=0,judges=0;
  const rt=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),agents:[{...builtinAgents.find(a=>a.id==='general'),allowedTools:['fixture_save']}],extraTools:[{name:'fixture_save',description:'save requested result',inputSchema:{type:'object',properties:{}},approvalMode:'never',sideEffectLevel:'none',async execute(){writes++;return{ok:true,content:'42 saved'};}}],modelAdapter:{name:'review',async summarizeMessages(){return '';},async completeText(input){if(!input.system.startsWith('Evaluate'))return JSON.stringify({intents:[{kind:'new_goal',text:'Save 42 and only output 42'}]});judges++;const p=JSON.parse(input.user),met=p.finalResponse==='42';return JSON.stringify({met,advanced:true,reason:met?'Saved and exact output':'Output format violated',missing:met?[]:['Only output 42 without explanation'],evidenceRefs:p.observations.filter(o=>o.ok).map(o=>o.ref)});},async runTurn(){step++;return step===1?{stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'save-once',name:'fixture_save',input:{}}]}:{stopReason:'end',assistantParts:[{type:'text',text:repairs&&step>2?'42':'The answer is 42.'}]};}}});
  t.after(async()=>{await rt.destroy();rmSync(root,{recursive:true,force:true});});const bot=rt.createBot({name:'review'}),sid=rt.openBot(bot.id).sessionId;rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});rt.mergeSessionMetadata(sid,{allowedTools:['fixture_save'],allowedSkillNames:[],permissionMode:'auto'});rt.sendUserMessage(sid,'Save 42 and only output 42');await rt.runHumanSession(sid);
  assert.equal(writes,1);assert.equal(step,3,'exactly one correction, without another execution');assert.ok(judges<=2);assert.equal(rt.store.getDaemonControl('bot_goals:'+bot.id).goals.at(-1).status,repairs?'completed':'queued');
 }
});

test('cancelling during pre-completion verification aborts the judge and cannot complete the goal [AC:bot-completion-reliability#AC-6]',{timeout:5000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'completion-cancel-'));let entered,judgeSignal;const ready=new Promise(resolve=>{entered=resolve;});
 const rt=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),modelAdapter:{name:'cancel-review',async summarizeMessages(){return '';},async runTurn(){return{stopReason:'end',assistantParts:[{type:'text',text:'42'}]};},async completeText(input){if(!input.system.startsWith('Evaluate'))return JSON.stringify({intents:[{kind:'new_goal',text:'Calculate 6 times 7'}]});judgeSignal=input.signal;entered();return new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}}});
 t.after(async()=>{await rt.destroy();rmSync(root,{recursive:true,force:true});});const bot=rt.createBot({name:'cancel-review'}),sid=rt.openBot(bot.id).sessionId;rt.mergeSessionMetadata(sid,{allowedTools:[],allowedSkillNames:[]});rt.sendUserMessage(sid,'Calculate 6 times 7');const run=rt.runHumanSession(sid);await ready;rt.cancelSession(sid);await run;assert.equal(judgeSignal.aborted,true);assert.notEqual(rt.store.getDaemonControl('bot_goals:'+bot.id).goals.at(-1).status,'completed');
});

test('new evidence after pre-completion approval invalidates its cached verdict [AC:bot-completion-reliability#AC-2] [AC:bot-completion-reliability#AC-6]',async t=>{
 const root=mkdtempSync(join(tmpdir(),'completion-cache-'));let judges=0,sid;
 const rt=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),modelAdapter:{name:'review-cache',async summarizeMessages(){return '';},async runTurn(){return{stopReason:'end',assistantParts:[{type:'text',text:'42'}]};},async completeText(input){if(!input.system.startsWith('Evaluate'))return JSON.stringify({intents:[{kind:'new_goal',text:'Calculate 6 times 7'}]});judges++;if(judges===1){rt.store.appendMessage(sid,'assistant',[{type:'text',text:'Correction: this result is not yet verified.'}]);return JSON.stringify({met:true,advanced:true,reason:'verified old result',evidence:['42'],missing:[]});}return JSON.stringify({met:false,advanced:false,reason:'new evidence contradicts the earlier claim',missing:['verify corrected result']});}}});
 t.after(async()=>{await rt.destroy();rmSync(root,{recursive:true,force:true});});const bot=rt.createBot({name:'review-cache'});sid=rt.openBot(bot.id).sessionId;rt.mergeSessionMetadata(sid,{allowedTools:[],allowedSkillNames:[]});rt.sendUserMessage(sid,'Calculate 6 times 7');await rt.runHumanSession(sid);assert.equal(judges,2);assert.equal(rt.store.getDaemonControl('bot_goals:'+bot.id).goals.at(-1).status,'queued');
});
