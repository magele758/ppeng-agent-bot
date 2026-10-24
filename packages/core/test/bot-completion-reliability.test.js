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
 assert.match(prompt,/Do not repeatedly guess filenames/);assert.match(prompt,/complete the requested transformation and persistence/);assert.match(prompt,/exact output format/);assert.match(prompt,/without explanations, headings, or verification reports/);
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
