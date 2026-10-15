import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createCronJob } from '../dist/cron/cron-facade.js';
import { RoutineRunStore, drainRoutineRuns } from '../dist/cron/routine-runtime.js';
import { sendUserMessage } from '../dist/runtime/session-facade.js';
async function fixture(){
 const stateDir=mkdtempSync(join(tmpdir(),'routine-cont-')),store=new SqliteStateStore(join(stateDir,'state.db'));
 const main=store.createSession({title:'main',mode:'chat',agentId:'general',background:false,metadata:{userId:'alice'}});
 const host={store,stateDir,log:{warn(){},info(){}},setCronStore(s){this.cronStore=s},runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},runSession:async id=>{store.appendMessage(id,'assistant',[{type:'text',text:'working detail 493827'}]);}};
 const job=createCronJob(host,{sessionId:main.id,name:'report',prompt:'research detail',intervalMs:60000}),runs=new RoutineRunStore(store),run=runs.enqueue(job,new Date().toISOString());
 await drainRoutineRuns(host);await new Promise(r=>setImmediate(r));
 return {store,main,host,run:runs.get(run.id),summary:store.listMessages(main.id).at(-1)};
}
test('reply to posted summary injects working context into main chat [AC:bot-routine-lifecycle#AC-13]',async()=>{
 const {store,main,host,run,summary}=await fixture();assert.equal(run.summaryMessageId,summary.id);
 sendUserMessage(host,main.id,'explain the detail',{replyTo:summary.id});
 const last=store.listMessages(main.id).at(-1);assert.equal(last.role,'user');assert.match(JSON.stringify(last),/research detail/);assert.match(JSON.stringify(last),/working detail 493827/);store.db.close();
});
test('immediate next message continues summary context [AC:bot-routine-lifecycle#AC-13]',async()=>{
 const {store,main,host}=await fixture();sendUserMessage(host,main.id,'explain');assert.match(JSON.stringify(store.listMessages(main.id).at(-1)),/research detail/);
 sendUserMessage(host,main.id,'another');assert.doesNotMatch(JSON.stringify(store.listMessages(main.id).at(-1)),/research detail/);store.db.close();
});
test('deleted working chat and foreign reply ids fall back gracefully [AC:bot-routine-lifecycle#AC-13]',async()=>{
 const {store,main,host,run,summary}=await fixture();store.deleteSession(run.sessionId);
 sendUserMessage(host,main.id,'explain',{replyTo:summary.id});assert.equal(store.listMessages(main.id).at(-1).parts[0].text,'explain');
 sendUserMessage(host,main.id,'other',{replyTo:'foreign'});assert.equal(store.listMessages(main.id).at(-1).parts[0].text,'other');store.db.close();
});

test('message API returns the context-aware follow-up in the main chat [AC:bot-routine-lifecycle#AC-13]',async()=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');
 const {sessionsRoutes}=await import('../../../apps/daemon/dist/routes/sessions.js');
 const repoRoot=mkdtempSync(join(tmpdir(),'routine-api-'));
 const runtime=new RawAgentRuntime({repoRoot,stateDir:join(repoRoot,'state'),modelAdapter:{name:'routine-context-test',async runTurn(input){
  const context=JSON.stringify(input.messages);
  const reply=context.includes('routine-context')&&context.includes('private research fact 8429')?'continued 8429':'routine report';
  return {stopReason:'end',assistantParts:[{type:'text',text:reply}]};
 }}});
 try{
  const main=runtime.createChatSession({title:'main',metadata:{userId:'alice',permissionMode:'ask'}});
  const job=runtime.createCronJob({sessionId:main.id,name:'report',prompt:'private research fact 8429',intervalMs:60000});
  const runs=new RoutineRunStore(runtime.store),run=runs.enqueue(job,new Date().toISOString());
  await runtime.runScheduler();
  for(let i=0;i<500&&runs.get(run.id).status!=='completed';i++)await new Promise(r=>setTimeout(r,10));
  const summaryId=runs.get(run.id).summaryMessageId;assert.ok(summaryId);
  // A later unrelated message makes this an explicit quoted reply, rather than implicit adjacency.
  runtime.store.appendMessage(main.id,'assistant',[{type:'text',text:'unrelated'}]);
  const route=sessionsRoutes(runtime).find(r=>r.method==='POST'&&r.pattern==='/api/sessions/:id/messages');
  let payload;const response={setHeader(){},writeHead(){},end(value){payload=JSON.parse(value);}};
  await route.handler({requireParam:()=>main.id,params:{id:main.id},auth:{},readBody:async()=>({message:'explain',replyTo:summaryId}),response});
  assert.equal(payload.session.id,main.id);assert.equal(payload.latestAssistant,'continued 8429');
  assert.equal(runtime.getLatestAssistantText(runs.get(run.id).sessionId),'routine report');
 }finally{await runtime.destroy();}
});

test('summary links survive reopen and never import another owner or chat [AC:bot-routine-lifecycle#AC-13]',async()=>{
 const {store,main,host,run,summary}=await fixture();const path=store.dbPath;store.db.close();
 const reopened=new SqliteStateStore(path);host.store=reopened;
 const foreign=reopened.createSession({title:'foreign',mode:'chat',agentId:'general',background:false,metadata:{userId:'bob'}});
 sendUserMessage(host,foreign.id,'question',{replyTo:summary.id});assert.equal(reopened.listMessages(foreign.id).at(-1).parts[0].text,'question');
 reopened.appendMessage(run.sessionId,'assistant',[{type:'reasoning',text:'private reasoning never copied'},{type:'text',text:'public conclusion'}]);
 sendUserMessage(host,main.id,'follow up',{replyTo:summary.id});const text=JSON.stringify(reopened.listMessages(main.id).at(-1));assert.match(text,/research detail/);assert.doesNotMatch(text,/private reasoning/);
 const work=reopened.getSession(run.sessionId);reopened.updateSession(work.id,{metadata:{...work.metadata,userId:'bob'}});
 sendUserMessage(host,main.id,'now isolated',{replyTo:summary.id});assert.equal(reopened.listMessages(main.id).at(-1).parts[0].text,'now isolated');reopened.db.close();
});
