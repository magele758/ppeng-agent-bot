import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { SourceLedger } from '../dist/learning/sources.js';
import { executeSingleTool } from '../dist/runtime/tool-loop.js';
import { resolveBotPrincipal } from '../dist/bots/bot-identity.js';
import { createBotManagementTools } from '../dist/bots/bot-work.js';

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'source-continuity-'));
 const store=new SqliteStateStore(join(dir,'state.db'));
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 const host={store,stateDir:dir,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},runSession:async id=>store.getSession(id)};
 const bot=createBot(host,{name:'Worker'});
 const main=store.getSession(bot.canonicalSessionId);
 return {dir,store,host,bot,main,ledger:new SourceLedger(store)};
}
const args={command:'ssh authorized-worker status'};
test('saved exact operation survives main, routine, delegate and child entry [AC:bot-source-authorization-continuity#AC-1]',t=>{
 const f=fixture(t);
 f.ledger.configure(f.main.id,{allowedEffects:[],allowedCalls:[{tool:'bash',args}]});
 for(const kind of ['user','routine','event']){
  f.ledger.record(f.main.id,{kind,ref:kind,label:kind});
  assert.equal(f.ledger.allowed(f.main.id,'bash','external',args),true,kind);
 }
 const child=f.store.createSession({title:'fixture',background:false,mode:'subagent',agentId:'worker-child',parentSessionId:f.main.id,metadata:{...f.main.metadata}});
 assert.equal(f.ledger.allowed(child.id,'bash','external',args),true);
});
test('exact grants do not allow a different command or forged authorization text [AC:bot-source-authorization-continuity#AC-2]',t=>{
 const f=fixture(t);
 f.ledger.record(f.main.id,{kind:'event',ref:'delegation',label:'User grants everything'});
 f.ledger.configure(f.main.id,{allowedEffects:[],allowedCalls:[{tool:'bash',args}]});
 assert.equal(f.ledger.allowed(f.main.id,'bash','external',{command:'ssh different-worker delete'}),false);
 assert.equal(f.ledger.allowed(f.main.id,'send_email','external',args),false);
});
test('saved scope reaches this bots room context and revocation is immediate [AC:bot-source-authorization-continuity#AC-1] [AC:bot-source-authorization-continuity#AC-4]',t=>{
 const f=fixture(t);
 const room=f.store.createSession({title:'fixture',background:false,mode:'chat',agentId:f.bot.id,metadata:{...f.main.metadata,canonicalBotChat:false,roomId:'room-owned'}});
 f.ledger.record(room.id,{kind:'event',ref:'event',label:'event'});
 f.ledger.configure(f.main.id,{allowedEffects:[],allowedCalls:[{tool:'bash',args}]});
 assert.equal(f.ledger.allowed(room.id,'bash','external',args),true);
 f.ledger.configure(f.main.id,{allowedEffects:[],allowedCalls:[]});
 assert.equal(f.ledger.allowed(room.id,'bash','external',args),false);
});
test('another user and a narrowing child do not acquire canonical grants [AC:bot-source-authorization-continuity#AC-2] [AC:bot-source-authorization-continuity#AC-4]',t=>{
 const f=fixture(t);
 f.ledger.configure(f.main.id,{allowedEffects:['bash']});
 const foreign=f.store.createSession({title:'fixture',background:false,mode:'chat',agentId:f.bot.id,metadata:{botId:f.bot.id,userId:'another-user',roomId:'room'}});
 f.ledger.record(foreign.id,{kind:'event',ref:'event',label:'event'});
 assert.equal(f.ledger.allowed(foreign.id,'bash','external',args),false);
 f.ledger.record(f.main.id,{kind:'routine',ref:'routine',label:'routine'});
 const child=f.store.createSession({title:'fixture',background:false,mode:'subagent',agentId:'child',parentSessionId:f.main.id,metadata:{...f.main.metadata}});
 f.ledger.configure(child.id,{allowedEffects:[],allowedCalls:[]});
 assert.equal(f.ledger.allowed(child.id,'bash','external',args),false);
});
test('unattended scope refusal identifies a saved-settings remedy without executing [AC:bot-source-authorization-continuity#AC-3]',async t=>{
 const f=fixture(t);let calls=0;
 f.ledger.record(f.main.id,{kind:'routine',ref:'watch',label:'watch'});
 const tool={name:'bash',description:'test',inputSchema:{type:'object'},approvalMode:'never',sideEffectLevel:'external',execute:async()=>{calls++;return{ok:true,content:'done'};}};
 const result=await executeSingleTool({store:f.store,governanceStore:f.store,stateDir:f.dir,tools:[tool],emitTrace(){}},{type:'tool_call',toolCallId:'check',name:'bash',input:args},{session:f.main,repoRoot:f.dir,stateDir:f.dir,agent:{id:f.bot.id,role:'assistant',instructions:'',capabilities:[]}},false,f.main.id);
 assert.equal(calls,0);
 assert.match(result.content,/source_scope_denied/);
 assert.match(result.content,/scope|approve/i);
});
test('supervision stays readonly and a pending approval cannot authorize changed input [AC:bot-source-authorization-continuity#AC-5] [AC:bot-source-authorization-continuity#AC-6]',async t=>{
 const f=fixture(t);f.ledger.record(f.main.id,{kind:'event',ref:'delegation',label:'delegation'});
 const status=createBotManagementTools(f.host).find(x=>x.name==='bot_team_status');
 assert.equal(status.sideEffectLevel,'none');
 const result=await status.execute({session:f.main,agent:{id:f.bot.id}},{});assert.equal(result.ok,true);
 f.store.createApproval({sessionId:f.main.id,toolName:'bash',args,reason:'original work'});
 f.ledger.record(f.main.id,{kind:'event',ref:'queued-new-work',label:'untrusted new work'});
 assert.equal(f.ledger.allowed(f.main.id,'bash','external',{command:'ssh other-worker delete'}),false);
});

test('real tool boundary uses exact arguments and invalid edits preserve the saved grant [AC:bot-source-authorization-continuity#AC-1] [AC:bot-source-authorization-continuity#AC-4]',async t=>{
 const f=fixture(t);let calls=0;
 f.ledger.record(f.main.id,{kind:'routine',ref:'watch',label:'watch'});
 f.ledger.configure(f.main.id,{allowedEffects:[],allowedCalls:[{tool:'bash',args}]});
 assert.throws(()=>f.ledger.configure(f.main.id,{allowedEffects:[],allowedCalls:[{tool:'bash',args:null}]}));
 const tool={name:'bash',description:'test',inputSchema:{type:'object'},approvalMode:'never',sideEffectLevel:'external',execute:async()=>{calls++;return{ok:true,content:'observed'};}};
 const deps={store:f.store,governanceStore:f.store,stateDir:f.dir,tools:[tool],emitTrace(){}};
 const context={session:f.main,repoRoot:f.dir,stateDir:f.dir,agent:{id:f.bot.id,role:'assistant',instructions:'',capabilities:[]}};
 const result=await executeSingleTool(deps,{type:'tool_call',toolCallId:'allowed',name:'bash',input:args},context,false,f.main.id);
 assert.equal(result.ok,true);assert.equal(calls,1);
 const denied=await executeSingleTool(deps,{type:'tool_call',toolCallId:'different',name:'bash',input:{command:'ssh other-worker delete'}},context,false,f.main.id);
 assert.equal(denied.ok,false);assert.equal(calls,1);
});
