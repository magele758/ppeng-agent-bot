import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { expireDueUnattendedApprovals, UNATTENDED_APPROVAL_TTL_MS } from '../dist/approval/unattended-approval.js';
import { RoutineRunStore } from '../dist/cron/routine-runtime.js';
import { buildTaskContext } from '../dist/session/task-context.js';
import { requestHumanRun, requestSteerContinuation } from '../dist/session/human-continuation.js';
import { createBot, openBot } from '../dist/bots/bot-facade.js';
import { cancelSession } from '../dist/runtime/session-control.js';
import { resolveBotPrincipal, enqueueBotMessage, tickBotWork, dispatchBotTask, listBotTasks, ensureSuperBot, recoverBotWork, botWorkStatus, claimBotSession, releaseBotSession, cancelBotTask, updateBotWorkSettings, retryBotTask, botTaskPage, botQueueUsage, checkBotWorkCapacity } from '../dist/bots/bot-work.js';

function setup() {
 const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(),'bot-work-')),'state.db'));
 const runs=[];
 const host={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){},log:{warn(){},info(){},debug(){},error(){}},runSession:async(id)=>{runs.push(id);store.appendMessage(id,'assistant',[{type:'text',text:'completed result'}]);return store.getSession(id)}};
 return {store,host,runs};
}
test('a current unmet goal is not reported as a completed delegated task [AC:bot-product-p0#AC-2] [AC:bot-product-p0#AC-7]', async () => {
 const {store,host}=setup();const boss=createBot(host,{name:'Goal boss'}),worker=createBot(host,{name:'Goal worker'});const principal=resolveBotPrincipal(store);
 host.runSession=async id=>{
  store.appendMessage(id,'assistant',[{type:'text',text:'Partial work, missing the second source.'}]);
  const session=store.getSession(id);
  store.updateSession(id,{metadata:{...session.metadata,goalCondition:'Collect two sources',goalLedger:[{met:false,reason:'Only one source collected',at:new Date(Date.now()+1).toISOString(),turn:1}]}});
 };
 dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:worker.id,input:'Collect two sources'});
 await tickBotWork(host);
 const task=listBotTasks(store,principal)[0];
 assert.equal(task.status,'failed');
 assert.match(task.failureReason,/Only one source collected/);
 assert.match(task.result,/Partial work/);
});
test('an old goal judgment cannot fail a fresh task [AC:bot-product-p0#AC-2]', async () => {
 const {store,host}=setup();const boss=createBot(host,{name:'Old goal boss'}),worker=createBot(host,{name:'Old goal worker'});const principal=resolveBotPrincipal(store);
 const chat=openBot(host,worker.id,principal),session=store.getSession(chat.sessionId);
 store.updateSession(chat.sessionId,{metadata:{...session.metadata,goalCondition:'Old goal',goalLedger:[{met:false,reason:'Old failure',at:'2000-01-01T00:00:00Z',turn:1}]}});
 dispatchBotTask(host,{principal,requesterBotId:boss.id,targetBotId:worker.id,input:'New work'});
 await tickBotWork(host);
 assert.equal(listBotTasks(store,principal)[0].status,'completed');
});
test('busy recipient persists and later drains [AC:bot-reliable-messaging#AC-1]', async()=>{
 const {store,host,runs}=setup(); const a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});
 const principal=resolveBotPrincipal(store); const target=openBot(host,b.id,principal);
 store.updateSession(target.sessionId,{status:'running'});
 const accepted=enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'work'});
 assert.equal(accepted.accepted,true);assert.equal(runs.length,0);
 store.updateSession(target.sessionId,{status:'idle'});await tickBotWork(host);
 assert.equal(runs.length,1);assert.ok(store.listMessages(target.sessionId).some(m=>JSON.stringify(m.parts).includes('work')));
});
test('delegate retry is one task with traceable result [AC:bot-reliable-messaging#AC-2]',async()=>{
 const {store,host}=setup();const a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});const principal=resolveBotPrincipal(store);
 const input={principal,requesterBotId:a.id,targetBotId:b.id,input:'research',idempotencyKey:'req-1'};
 const one=dispatchBotTask(host,input),two=dispatchBotTask(host,input);assert.equal(one.id,two.id);
 await tickBotWork(host);assert.equal(listBotTasks(store,principal).length,1);assert.equal(listBotTasks(store,principal)[0].status,'completed');
});
test('principal persists and user chats never fallback [AC:bot-identity-continuity#AC-1] [AC:bot-identity-continuity#AC-2]',()=>{
 const {store,host}=setup();assert.deepEqual(resolveBotPrincipal(store),resolveBotPrincipal(store));const b=createBot(host,{name:'B'});
 const x=openBot(host,b.id,{userId:'x',tenantId:'t'}),y=openBot(host,b.id,{userId:'y',tenantId:'t'});assert.notEqual(x.sessionId,y.sessionId);assert.equal(openBot(host,b.id,{userId:'x',tenantId:'t'}).sessionId,x.sessionId);
});
test('default Super is stable without overwriting settings [AC:default-super-bot#AC-1] [AC:default-super-bot#AC-2]',()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const first=ensureSuperBot(host,principal);const second=ensureSuperBot(host,principal);assert.equal(first.bot.id,second.bot.id);assert.equal(first.sessionId,second.sessionId);
});
test('Super sees own bots and task status; hidden target can receive [AC:default-super-bot#AC-3] [AC:default-super-bot#AC-4]',()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const boss=ensureSuperBot(host,principal);const b=createBot(host,{name:'Hidden'});store.updateBot(b.id,{hidden:true});
 const accepted=enqueueBotMessage(host,{principal,senderBotId:boss.bot.id,targetBotId:b.id,message:'hello',wake:false});assert.equal(accepted.accepted,true);
 assert.ok(botWorkStatus(host,principal).some(s=>s.bot.id===b.id));
});
test('concurrent delegation and replies remain associated during busy Super [AC:default-super-bot#AC-5] [AC:default-super-bot#AC-6] [AC:default-super-bot#AC-7] [AC:default-super-bot#AC-8]',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const boss=ensureSuperBot(host,principal);const b=createBot(host,{name:'B'}),c=createBot(host,{name:'C'});
 store.updateSession(boss.sessionId,{status:'running'});
 const bc=openBot(host,b.id,principal);store.updateSession(bc.sessionId,{status:'waiting_approval'});
 const first=dispatchBotTask(host,{principal,requesterBotId:boss.bot.id,targetBotId:b.id,input:'one'}),second=dispatchBotTask(host,{principal,requesterBotId:boss.bot.id,targetBotId:c.id,input:'two'});
 await tickBotWork(host);assert.equal(listBotTasks(store,principal).find(t=>t.id===first.id).status,'queued');assert.equal(listBotTasks(store,principal).find(t=>t.id===second.id).status,'completed');
 const pending=store.db.prepare("SELECT * FROM bot_work_messages WHERE target_bot=? AND status='pending'").all(boss.bot.id);assert.equal(pending.length,1);assert.ok(pending[0].reply_to);assert.match(pending[0].body,new RegExp(second.id));
 store.updateSession(bc.sessionId,{status:'idle'});await tickBotWork(host);assert.equal(listBotTasks(store,principal).filter(t=>t.status==='completed').length,2);
});
test('restart fences unconfirmed attempts and retains known results [AC:bot-reliable-messaging#AC-3] [AC:default-super-bot#AC-9]',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const boss=ensureSuperBot(host,principal);const b=createBot(host,{name:'B'});
 host.runSession=()=>new Promise(()=>{});
 const task=dispatchBotTask(host,{principal,requesterBotId:boss.bot.id,targetBotId:b.id,input:'write'});await tickBotWork(host);
 assert.equal(listBotTasks(store,principal)[0].status,'running');recoverBotWork(store);assert.equal(listBotTasks(store,principal)[0].status,'unknown');assert.match(listBotTasks(store,principal)[0].failureReason,/verify/);
 const fence=claimBotSession(store,'isolated','one',-1);const next=claimBotSession(store,'isolated','two');assert.ok(next>fence);assert.equal(releaseBotSession(store,'isolated','one',fence),false);assert.equal(releaseBotSession(store,'isolated','two',next),true);
});
test('delegate preserves own permissions and never approves [AC:default-super-bot#AC-10]',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const boss=ensureSuperBot(host,principal);const b=createBot(host,{name:'B'});const chat=openBot(host,b.id,principal);store.updateSession(chat.sessionId,{metadata:{...store.getSession(chat.sessionId).metadata,permissionMode:'ask'}});
 host.runSession=async id=>store.updateSession(id,{status:'waiting_approval'});
 const task=dispatchBotTask(host,{principal,requesterBotId:boss.bot.id,targetBotId:b.id,input:'protected write'});await tickBotWork(host);
 assert.equal(listBotTasks(store,principal)[0].status,'waiting_approval');assert.equal(store.getSession(chat.sessionId).metadata.permissionMode,'ask');assert.equal(store.listApprovals().length,0);
});
test('cross tenant and private Bot cannot be read or messaged',()=>{
 const {store,host}=setup();const a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});store.updateSession(b.canonicalSessionId,{metadata:{...store.getSession(b.canonicalSessionId).metadata,userId:'other',tenantId:'other'}});
 const principal={userId:'me',tenantId:'mine'};assert.throws(()=>enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'hello'}),/another principal/);assert.ok(!botWorkStatus(host,principal).some(s=>s.bot.id===b.id));
});
test('cancel queued work avoids execution and idempotency conflict is rejected',async()=>{
 const {store,host,runs}=setup();const principal=resolveBotPrincipal(store);const a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});const task=dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'one',idempotencyKey:'key'});
 assert.throws(()=>dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'different',idempotencyKey:'key'}),/Idempotency/);
 cancelBotTask(host,principal,task.id);await tickBotWork(host);assert.equal(runs.length,0);assert.equal(listBotTasks(store,principal)[0].status,'cancelled');
});

test('queue backpressure never evicts accepted work; built-in Super can initialize full roster',()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});const session=openBot(host,b.id,principal);store.updateSession(session.sessionId,{status:'running'});updateBotWorkSettings(store,{perBot:1,perPrincipal:2});
 const accepted=enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'first',idempotencyKey:'first'});assert.throws(()=>enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'second'}),/QUEUE_FULL/);assert.equal(enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'first',idempotencyKey:'first'}).messageId,accepted.messageId);
 for(let i=2;i<50;i++)createBot(host,{name:`Bot ${i}`});assert.ok(ensureSuperBot(host,principal).bot);assert.equal(store.listBots().length,51);assert.throws(()=>createBot(host,{name:'extra'}),/cap reached/);
});
test('database reopen preserves results and installation principal [AC:default-super-bot#AC-9] [AC:bot-identity-continuity#AC-2]',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const boss=ensureSuperBot(host,principal);const worker=createBot(host,{name:'Worker'});const task=dispatchBotTask(host,{principal,requesterBotId:boss.bot.id,targetBotId:worker.id,input:'persist result'});await tickBotWork(host);assert.equal(listBotTasks(store,principal)[0].status,'completed');
 await new Promise(resolve=>setImmediate(resolve));const path=store.dbPath;store.db.close();const reopened=new SqliteStateStore(path);recoverBotWork(reopened);assert.deepEqual(resolveBotPrincipal(reopened),principal);assert.equal(listBotTasks(reopened,principal).find(t=>t.id===task.id).result,'completed result');reopened.db.close();
});
test('unknown work requires explicit effect verification to retry; missing output is failed',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});host.runSession=async()=>{};const task=dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'work'});await tickBotWork(host);await new Promise(resolve=>setImmediate(resolve));assert.equal(listBotTasks(store,principal)[0].status,'failed');
 store.db.prepare("UPDATE bot_work_tasks SET status='unknown' WHERE id=?").run(task.id);assert.throws(()=>retryBotTask(host,principal,task.id),/Confirm/);assert.equal(retryBotTask(host,principal,task.id,true).status,'queued');
});
test('restart closes unconfirmed tool wave and drains new input in same canonical [AC:bot-reliable-messaging#AC-3]',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});host.runSession=id=>{store.updateSession(id,{status:'running'});store.appendMessage(id,'assistant',[{type:'tool_call',toolCallId:'unfinished',name:'bash',input:{command:'external-write'}}]);return new Promise(()=>{});};
 const task=dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'uncertain write'});await tickBotWork(host);const canonical=openBot(host,b.id,principal).sessionId;
 enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'new safe read'});
 const reopened=new SqliteStateStore(store.dbPath);recoverBotWork(reopened);assert.equal(reopened.getSession(canonical).status,'idle');assert.equal(reopened.getBot(b.id).canonicalSessionId,canonical);assert.ok(!reopened.foldMessages(canonical).some(m=>m.parts.some(p=>p.type==='tool_call')));assert.ok(reopened.listMessages(canonical).some(m=>m.parts.some(p=>p.type==='tool_call'&&p.toolCallId==='unfinished')));
 const recoveryHost={...host,store:reopened,runSession:async id=>{const folded=reopened.foldMessages(id);assert.ok(!folded.some(m=>m.parts.some(p=>p.type==='tool_call')));reopened.appendMessage(id,'assistant',[{type:'text',text:'safe read complete'}]);}};
 await tickBotWork(recoveryHost);assert.equal(listBotTasks(reopened,principal).find(t=>t.id===task.id).status,'unknown');assert.ok(reopened.foldMessages(canonical).some(m=>JSON.stringify(m.parts).includes('new safe read')));
});
test('cancelling work parked on approval shows cancelled [AC:pr152-approval-followups#AC-3]', async () => {
  const {store, host} = setup();
  const principal = resolveBotPrincipal(store);
  const a = createBot(host, {name: 'A'});
  const b = createBot(host, {name: 'B'});
  host.runSession = async (id) => {
    store.createApproval({sessionId: id, toolName: 'bash', reason: 'ask', args: {command: 'true'}});
    const session = store.getSession(id);
    store.updateSession(id, {
      status: 'waiting_approval',
      metadata: {
        ...session.metadata,
        interrupt: {
          kind: 'waiting_approval',
          toolCallIds: ['c1'],
          approvalIds: ['a1'],
          executedToolCallIds: [],
          stepCursor: 'tools'
        },
        outcome: {kind: 'waiting_approval', reason: 'waiting_approval'}
      }
    });
  };
  const task = dispatchBotTask(host, {principal, requesterBotId: a.id, targetBotId: b.id, input: 'parked approval'});
  await tickBotWork(host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listBotTasks(store, principal).find((item) => item.id === task.id).status, 'waiting_approval');
  const pendingApproval = store.listApprovals({status: 'pending'}).find(item => item.sessionId === b.canonicalSessionId);
  assert.ok(pendingApproval);
  cancelSession({
    store,
    sessionAbortControllers: new Map(),
    backgroundJobAborts: new Map(),
    emitTrace() {}
  }, b.canonicalSessionId);
  assert.equal(store.listApprovals().find(item => item.id === pendingApproval.id).status, 'rejected');
  const session = store.getSession(b.canonicalSessionId);
  assert.equal(session.metadata.interrupt, undefined);
  assert.equal(session.metadata.outcome.kind, 'aborted');
  await tickBotWork(host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listBotTasks(store, principal).find((item) => item.id === task.id).status, 'cancelled');
});
test('aborted task with partial output never reports completed',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});
 host.runSession=async id=>{store.appendMessage(id,'assistant',[{type:'text',text:'partial progress'}]);store.updateSession(id,{status:'idle',metadata:{...store.getSession(id).metadata,outcome:{kind:'aborted',reason:'user_abort'}}});};
 dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'do work'});await tickBotWork(host);
 assert.equal(listBotTasks(store,principal)[0].status,'cancelled');assert.match(listBotTasks(store,principal)[0].failureReason,/user_abort/);
});
test('unconfirmed external effect overrides confident assistant completion',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});
 const checked=[];host.hasUnconfirmedEffects=(sessionId,startedAt)=>{checked.push({sessionId,startedAt});return true;};
 dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'external write'});await tickBotWork(host);
 const task=listBotTasks(store,principal)[0];assert.equal(task.status,'unknown');assert.match(task.failureReason,/External write/);assert.match(task.result,/completed result/);assert.ok(Number.isFinite(Date.parse(checked[0].startedAt)));
});
test('real approval decision resumes before scheduler marks delegated terminal',async()=>{
 let effects=0;
 const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'approval-work-repo-')),stateDir:mkdtempSync(join(tmpdir(),'approval-work-state-')),extraTools:[{name:'guarded_effect',description:'Controlled approval effect',inputSchema:{type:'object',properties:{}},approvalMode:'always',sideEffectLevel:'workspace',async execute(){effects++;return {ok:true,content:'effect confirmed'};}}],modelAdapter:{name:'approval-work',async summarizeMessages(){return '';},async runTurn(input){if(input.messages.some(m=>m.parts.some(p=>p.type==='tool_result'&&p.name==='guarded_effect'&&p.ok)))return {stopReason:'end',assistantParts:[{type:'text',text:'approved work completed'}]};return {stopReason:'tool_use',assistantParts:[{type:'tool_call',name:'guarded_effect',toolCallId:'controlled-call',input:{}}]};}}});
 rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
 try{
 const principal=resolveBotPrincipal(rt.store),boss=ensureSuperBot({store:rt.store,runSession:id=>rt.runSession(id),log:{warn(){}}},principal),worker=rt.createBot({name:'Approval Worker'});
 // Keep deadline calculation and synchronous persistence on one fixture clock instant.
 const createApproval=rt.store.createApproval.bind(rt.store);
 rt.store.createApproval=input=>{
  const RealDate=globalThis.Date,instant=RealDate.now();
  class ApprovalClock extends RealDate {constructor(...args){super(...(args.length?args:[instant]));}static now(){return instant;}}
  globalThis.Date=ApprovalClock;try{return createApproval(input);}finally{globalThis.Date=RealDate;}
 };
 const task=dispatchBotTask({store:rt.store,runSession:id=>rt.runSession(id),isSessionRunning:id=>rt.isSessionRunning(id),log:{warn(){}}},{principal,requesterBotId:boss.bot.id,targetBotId:worker.id,input:'guarded work'});
 await rt.runScheduler();let approval;
 for(let i=0;i<100;i++){approval=rt.store.listApprovals({status:'pending'}).find(a=>a.toolName==='guarded_effect');if(approval)break;await new Promise(r=>setTimeout(r,10));}assert.ok(approval);
 assert.ok(approval.expiresAt);assert.equal(Date.parse(approval.expiresAt)-Date.parse(approval.createdAt),UNATTENDED_APPROVAL_TTL_MS);
 await rt.approve(approval.id,'approved');assert.equal(rt.store.getSession(approval.sessionId).status,'idle');await rt.runScheduler();
 for(let i=0;i<100;i++){await rt.runScheduler();const current=listBotTasks(rt.store,principal).find(t=>t.id===task.id);if(current.status==='completed'){assert.equal(effects,1);return;}assert.notEqual(current.status,'failed');await new Promise(r=>setTimeout(r,10));}assert.fail('Approved task did not finish');
 }finally{await rt.destroy();}
});
test('unattended delegated approval expires once and never resumes rejected work',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});let runs=0;
 host.runSession=async id=>{if(id!==b.canonicalSessionId){store.appendMessage(id,'assistant',[{type:'text',text:'Failure report received'}]);return;}runs++;store.createApproval({sessionId:id,toolName:'write_file',args:{path:'marker'},reason:'guarded'});store.updateSession(id,{status:'waiting_approval',metadata:{...store.getSession(id).metadata,outcome:{kind:'waiting_approval',reason:'waiting_approval'}}});};
 dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'unattended write'});await tickBotWork(host);await new Promise(r=>setImmediate(r));const approval=store.listApprovals()[0];assert.ok(approval.expiresAt);assert.equal(store.getSession(approval.sessionId).metadata.approvalWake.kind,'unattended');
 assert.equal(expireDueUnattendedApprovals(store,Date.parse(approval.expiresAt)+1).length,1);assert.equal(expireDueUnattendedApprovals(store,Date.parse(approval.expiresAt)+2).length,0);await tickBotWork(host);assert.equal(runs,1);assert.equal(listBotTasks(store,principal)[0].status,'failed');assert.match(listBotTasks(store,principal)[0].failureReason,/denied or expired/);
});
test('old unresolved work remains visible beyond terminal history and history pages do not overlap',()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});const old=dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'old uncertain work'});store.db.prepare("UPDATE bot_work_tasks SET status='unknown' WHERE id=?").run(old.id);
 const insert=store.db.prepare("INSERT INTO bot_work_tasks(id,principal,requester_bot,target_bot,input,status,created_at,updated_at) SELECT ?,principal,requester_bot,target_bot,'new completed work','completed',created_at,updated_at FROM bot_work_tasks WHERE id=?");for(let i=0;i<501;i++)insert.run(`new-${i}`,old.id);
 assert.ok(listBotTasks(store,principal).some(task=>task.id===old.id));const status=botWorkStatus(host,principal).find(item=>item.bot.id===b.id);assert.equal(status.taskCounts.unknown,1);assert.equal(status.taskCounts.completed,501);
 const first=botTaskPage(store,principal,{limit:20});assert.equal(first.activeTasks[0].id,old.id);assert.equal(first.historyTasks.length,20);assert.equal(first.hasMore,true);
 const second=botTaskPage(store,principal,{limit:20,cursor:first.nextCursor});assert.ok(second.historyTasks.every(task=>!first.historyTasks.some(prior=>prior.id===task.id)));assert.equal(second.activeTasks[0].id,old.id);assert.equal(second.counts.completed,501);
});
test('max turns with partial output is failed rather than completed',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});host.runSession=async id=>{store.appendMessage(id,'assistant',[{type:'text',text:'partial progress'}]);store.updateSession(id,{status:'idle',metadata:{...store.getSession(id).metadata,outcome:{kind:'idle',reason:'max_turns'}}});};
 dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'long work'});await tickBotWork(host);assert.equal(listBotTasks(store,principal)[0].status,'failed');assert.match(listBotTasks(store,principal)[0].failureReason,/max_turns/);
});
test('accepted pending work repairs a missing canonical without changing principal',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});const context=openBot(host,b.id,principal);store.updateSession(context.sessionId,{status:'running'});
 const accepted=enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'accepted before deletion'});assert.equal(accepted.queued,true);store.deleteSession(context.sessionId);await tickBotWork(host);
 const repaired=store.getBot(b.id).canonicalSessionId;assert.notEqual(repaired,context.sessionId);assert.equal(store.getSession(repaired).metadata.userId,principal.userId);const row=store.db.prepare('SELECT * FROM bot_work_messages WHERE id=?').get(accepted.messageId);assert.equal(row.session_id,repaired);assert.equal(row.status,'processed');assert.ok(store.foldMessages(repaired).some(m=>JSON.stringify(m.parts).includes('accepted before deletion')));
});
test('Routine pending work shares Bot admission capacity and returns retryable 429',()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});updateBotWorkSettings(store,{perBot:1,perPrincipal:1});
 const routines=new RoutineRunStore(store);const time=new Date().toISOString();routines.enqueue({id:'routine',sessionId:b.canonicalSessionId,agentId:b.id,name:'queued routine',prompt:'work',scheduleKind:'once_at',scheduleValue:time,createdAt:time,updatedAt:time,enabled:false,metadata:{principal,botId:b.id}},time);
 assert.throws(()=>enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'new work'}),error=>error.statusCode===429&&error.retryable===true&&error.usage.total===1);
 assert.equal(routines.list()[0].status,'queued');assert.equal(store.db.prepare('SELECT count(*) AS n FROM bot_work_messages').get().n,0);
});
test('default 1000 per Bot and 10000 per principal admission boundaries retain accepted receipts',()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});store.updateSession(b.canonicalSessionId,{status:'running'});
 const first=enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'original accepted work',idempotencyKey:'original'});
 const insert=store.db.prepare("INSERT INTO bot_work_messages(id,principal,sender_bot,target_bot,session_id,body,status,created_at,updated_at) SELECT ?,principal,sender_bot,?,?,'accepted workload','pending',created_at,updated_at FROM bot_work_messages WHERE id=?");
 store.db.exec('BEGIN');for(let i=1;i<1000;i++)insert.run(`per-bot-${i}`,b.id,b.canonicalSessionId,first.messageId);store.db.exec('COMMIT');
 assert.throws(()=>enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'over per-bot'}),error=>error.statusCode===429&&error.limits.perBot===1000&&error.usage.byBot[b.id]===1000);
 assert.equal(enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'original accepted work',idempotencyKey:'original'}).messageId,first.messageId);
 for(let botIndex=0;botIndex<10;botIndex++){const target=createBot(host,{name:`Loaded ${botIndex}`});store.db.exec('BEGIN');for(let i=0;i<900;i++)insert.run(`principal-${botIndex}-${i}`,target.id,target.canonicalSessionId,first.messageId);store.db.exec('COMMIT');}
 assert.throws(()=>enqueueBotMessage(host,{principal,senderBotId:b.id,targetBotId:a.id,message:'over principal'}),error=>error.statusCode===429&&error.limits.perPrincipal===10000&&error.usage.total===10000);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM bot_work_messages').get().n,10000);assert.equal(store.db.prepare('SELECT status FROM bot_work_messages WHERE id=?').get(first.messageId).status,'pending');
});
test('deleted approval-waiting execution becomes unknown and never reruns',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'A'}),b=createBot(host,{name:'B'});let runs=0;
 host.runSession=async id=>{runs++;store.createApproval({sessionId:id,toolName:'guarded',args:{},reason:'approval required'});store.updateSession(id,{status:'waiting_approval',metadata:{...store.getSession(id).metadata,outcome:{kind:'waiting_approval',reason:'waiting_approval'}}});};
 const task=dispatchBotTask(host,{principal,requesterBotId:a.id,targetBotId:b.id,input:'protected work'});await tickBotWork(host);await new Promise(r=>setImmediate(r));assert.equal(listBotTasks(store,principal).find(t=>t.id===task.id).status,'waiting_approval');
 store.deleteSession(b.canonicalSessionId);recoverBotWork(store);await tickBotWork(host);assert.equal(listBotTasks(store,principal).find(t=>t.id===task.id).status,'unknown');assert.match(listBotTasks(store,principal).find(t=>t.id===task.id).failureReason,/context missing/);assert.equal(runs,1);assert.equal(botWorkStatus(host,principal).find(item=>item.bot.id===b.id).taskCounts.unknown,1);
 assert.equal(store.db.prepare('SELECT status FROM bot_work_messages WHERE task_id=? AND kind=\'task\'').get(task.id).status,'failed');
});

test('team status projects only own canonical chats amid background context growth [AC:default-super-bot#AC-3]',()=>{
 const {store,host}=setup();const installation=resolveBotPrincipal(store);const bot=createBot(host,{name:'Status worker'});const principal={userId:'viewer',tenantId:'t'};
 const mine=openBot(host,bot.id,principal),foreign=openBot(host,bot.id,{userId:'viewer',tenantId:'foreign'});
 store.updateSession(mine.sessionId,{status:'waiting_approval'});store.updateSession(foreign.sessionId,{status:'running'});
 const background=store.createSession({title:'Routine isolated context',mode:'chat',agentId:bot.id,background:true,metadata:{userId:principal.userId,tenantId:principal.tenantId}});
 const insert=store.db.prepare('INSERT INTO sessions (id,title,mode,status,agent_id,task_id,workspace_id,parent_session_id,background,summary,todo_json,metadata_json,created_at,updated_at) SELECT ?,title,mode,status,agent_id,task_id,workspace_id,parent_session_id,background,summary,todo_json,metadata_json,created_at,updated_at FROM sessions WHERE id=?');
 store.db.exec('BEGIN IMMEDIATE');for(let i=0;i<10000;i++)insert.run(`status-background-${i}`,background.id);store.db.exec('COMMIT');
 const originalGet=store.getSession.bind(store);const reads=[];store.getSession=id=>{reads.push(id);return originalGet(id);};store.listSessions=()=>{throw new Error('status must not hydrate every context');};
 const before=store.db.prepare('SELECT total_changes() AS n').get().n;
 const status=botWorkStatus(host,principal);assert.equal(status.length,1);assert.equal(status[0].sessionId,mine.sessionId);assert.equal(status[0].status,'waiting_approval');assert.deepEqual(reads.sort(),[bot.canonicalSessionId,mine.sessionId].sort());assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,before);
 reads.length=0;const installed=botWorkStatus(host,installation);assert.equal(installed[0].sessionId,bot.canonicalSessionId);assert.ok(reads.every(id=>id===bot.canonicalSessionId));
 store.db.close();
});

test('human continuations and steer inbox share Bot capacity without double counting',()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),a=createBot(host,{name:'Human sender'}),b=createBot(host,{name:'Human queue'});const sid=b.canonicalSessionId;
 const human=store.appendMessage(sid,'user',[{type:'text',text:'accepted human'}]);
 const key='session.humanContinuation:'+sid;store.setDaemonControl(key,{pending:[{id:human.id,seq:human.seq},{id:'steer-capacity',seq:0,kind:'steer'}]});
 store.db.prepare('INSERT INTO session_inbox(id,session_id,target,role,text,key,created_at,claimed_at) VALUES(?,?,?,?,?,?,?,NULL)').run('steer-capacity',sid,'turn','user','accepted steer','steer-receipt',new Date().toISOString());
 const foreign=openBot(host,b.id,{userId:'other',tenantId:'foreign'});store.setDaemonControl('session.humanContinuation:'+foreign.sessionId,{pending:[{id:'foreign',seq:1}]});
 const unrelated=store.createSession({title:'Not a Bot conversation',mode:'chat',agentId:'general',metadata:{...principal}});store.setDaemonControl('session.humanContinuation:'+unrelated.id,{pending:[{id:'ordinary',seq:1}]});
 const rawBot=store.createSession({title:'Raw Bot conversation',mode:'chat',agentId:b.id,metadata:{...principal}});store.setDaemonControl('session.humanContinuation:'+rawBot.id,{pending:[{id:'raw-bot',seq:1}]});
 assert.equal(botQueueUsage(store,principal).byBot[b.id],3);updateBotWorkSettings(store,{perBot:3,perPrincipal:4});
 assert.throws(()=>enqueueBotMessage(host,{principal,senderBotId:a.id,targetBotId:b.id,message:'over accepted capacity'}),error=>error.statusCode===429&&error.retryable===true);
 store.db.prepare('UPDATE session_inbox SET claimed_at=? WHERE id=?').run(new Date().toISOString(),'steer-capacity');assert.equal(botQueueUsage(store,principal).byBot[b.id],3);
 store.setDaemonControl(key,{pending:[{id:human.id,seq:human.seq}]});assert.equal(botQueueUsage(store,principal).byBot[b.id],2);
 store.db.prepare('UPDATE bots SET agent_id=? WHERE id=?').run('human-alias-agent',b.id);assert.equal(store.getBot(b.id).agentId,'human-alias-agent');const alias=store.createSession({title:'Bot agent alias',mode:'chat',agentId:'human-alias-agent',metadata:{...principal}});store.setDaemonControl('session.humanContinuation:'+alias.id,{pending:[{id:'alias',seq:1}]});assert.equal(botQueueUsage(store,principal).byBot[b.id],3);
 assert.equal(botQueueUsage(store,{userId:'other',tenantId:'foreign'}).byBot[b.id],1);
});

test('overflow summary does not double count its mapped accepted steer receipts [AC:bot-human-continuation#AC-3]',()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),bot=createBot(host,{name:'Overflow capacity'}),sessionId=bot.canonicalSessionId;
 store.setDaemonControl('loop_settings',{inboxOverflowCap:2});
 for(const text of ['old a','old b','new c']){const item=store.enqueueSteer(sessionId,text,{target:'next-step'});requestSteerContinuation(store,sessionId,item);}
 const ledger=store.getDaemonControl('session.humanContinuation:'+sessionId);assert.equal(ledger.pending.length,3);assert.equal(ledger.pending.filter(request=>request.summaryId).length,2);
 assert.equal(store.listUnclaimedInbox(sessionId).length,2);assert.equal(botQueueUsage(store,principal).byBot[bot.id],3);
 updateBotWorkSettings(store,{perBot:4,perPrincipal:10000});assert.doesNotThrow(()=>checkBotWorkCapacity(store,principal,bot.id));
 store.setDaemonControl('session.humanContinuation:'+sessionId,{pending:[]});assert.equal(botQueueUsage(store,principal).byBot[bot.id],2,'legacy unclaimed summary without mapped receipts still occupies capacity');
});

test('task deadline continues to expire while waiting for approval',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),sender=createBot(host,{name:'Deadline sender'}),worker=createBot(host,{name:'Deadline worker'});let workerRuns=0,effects=0,approval;
 host.runSession=async id=>{if(id!==worker.canonicalSessionId){store.appendMessage(id,'assistant',[{type:'text',text:'noted result'}]);return store.getSession(id);}workerRuns++;
  if(workerRuns===1){approval=store.createApproval({sessionId:id,toolName:'deadline_effect',reason:'permission',args:{}});store.updateSession(id,{status:'waiting_approval',metadata:{...store.getSession(id).metadata,outcome:{kind:'waiting_approval',reason:'waiting_approval'}}});}
  else{effects++;store.appendMessage(id,'assistant',[{type:'text',text:'write finished'}]);store.updateSession(id,{status:'idle',metadata:{...store.getSession(id).metadata,outcome:{kind:'idle',reason:'end'}}});}return store.getSession(id);};
 const task=dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:worker.id,input:'guarded deadline write',deadline:new Date(Date.now()+70).toISOString()});await tickBotWork(host);await new Promise(resolve=>setTimeout(resolve,100));await tickBotWork(host);
 assert.equal(listBotTasks(store,principal).find(item=>item.id===task.id).status,'unknown');
 store.updateApproval(approval.id,'approved');store.updateSession(approval.sessionId,{status:'idle'});await tickBotWork(host);await new Promise(resolve=>setImmediate(resolve));await tickBotWork(host);
 assert.equal(effects,0);assert.equal(workerRuns,1);assert.equal(listBotTasks(store,principal).find(item=>item.id===task.id).status,'unknown');
});

test('unknown recovery retains fresh human raw ids in model input',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),sender=createBot(host,{name:'Recover sender'}),worker=createBot(host,{name:'Recover worker'});host.runSession=()=>new Promise(()=>{});
 dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:worker.id,input:'old interrupted work'});await tickBotWork(host);
 const fresh=store.appendMessage(worker.canonicalSessionId,'user',[{type:'text',text:'fresh accepted human'}]);requestHumanRun(store,worker.canonicalSessionId);recoverBotWork(store);
 assert.ok(store.foldMessages(worker.canonicalSessionId).some(message=>message.id===fresh.id));assert.ok(store.listMessages(worker.canonicalSessionId).some(message=>message.id===fresh.id));assert.ok(store.getDaemonControl('session.humanContinuation:'+worker.canonicalSessionId).pending.some(receipt=>receipt.id===fresh.id));
});
test('cancelled approval work cannot execute an effect after later approval',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),sender=createBot(host,{name:'Cancel sender'}),worker=createBot(host,{name:'Cancel worker'});let approval,effects=0,runs=0;
 host.runSession=async id=>{if(id!==worker.canonicalSessionId){store.appendMessage(id,'assistant',[{type:'text',text:'noted'}]);return store.getSession(id);}if(++runs===1){approval=store.createApproval({sessionId:id,toolName:'cancel_effect',reason:'approval',args:{}});store.updateSession(id,{status:'waiting_approval',metadata:{...store.getSession(id).metadata,outcome:{kind:'waiting_approval',reason:'waiting_approval'}}});}else{effects++;store.appendMessage(id,'assistant',[{type:'text',text:'effect done'}]);store.updateSession(id,{status:'idle',metadata:{...store.getSession(id).metadata,outcome:{kind:'idle',reason:'end'}}});}return store.getSession(id);};
 const task=dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:worker.id,input:'pending guarded effect'});await tickBotWork(host);await new Promise(resolve=>setImmediate(resolve));cancelBotTask(host,principal,task.id);
 store.updateApproval(approval.id,'approved');store.updateSession(approval.sessionId,{status:'idle'});await tickBotWork(host);await new Promise(resolve=>setImmediate(resolve));assert.equal(effects,0);assert.equal(listBotTasks(store,principal).find(item=>item.id===task.id).status,'cancelled');
});
test('cancellation never suppresses an unknown write outcome or its retry verification',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),sender=createBot(host,{name:'Unknown cancel sender'}),worker=createBot(host,{name:'Unknown cancel worker'});let finish;host.runSession=id=>id===worker.canonicalSessionId?new Promise(resolve=>{finish=resolve;}):Promise.resolve(store.getSession(id));host.hasUnconfirmedEffects=()=>true;
 const task=dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:worker.id,input:'unconfirmed write'});await tickBotWork(host);cancelBotTask(host,principal,task.id);finish();await new Promise(resolve=>setImmediate(resolve));await tickBotWork(host);
 assert.equal(listBotTasks(store,principal).find(item=>item.id===task.id).status,'unknown');assert.throws(()=>retryBotTask(host,principal,task.id),/verification/);
});


test('unknown recovery protects the pending receipt delivery alias without reappending input',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),sender=createBot(host,{name:'Alias recovery sender'}),worker=createBot(host,{name:'Alias recovery worker'});host.runSession=()=>new Promise(()=>{});
 dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:worker.id,input:'interrupted operation'});await tickBotWork(host);
 const original=store.appendMessage(worker.canonicalSessionId,'user',[{type:'text',text:'accepted original'}]);requestHumanRun(store,worker.canonicalSessionId);store.hideRange(worker.canonicalSessionId,original.seq,original.seq);
 const delivered=store.appendMessage(worker.canonicalSessionId,'user',[{type:'text',text:'accepted original'}],{key:'human-delivery:accepted'}),key='session.humanContinuation:'+worker.canonicalSessionId,ledger=store.getDaemonControl(key);
 ledger.pending[0].deliveryKey=delivered.key;ledger.pending[0].deliverySeqFloor=original.seq;store.setDaemonControl(key,ledger);recoverBotWork(store);
 assert.ok(store.foldMessages(worker.canonicalSessionId).some(message=>message.id===delivered.id));assert.equal(store.listMessages(worker.canonicalSessionId).filter(message=>message.id===delivered.id).length,1);assert.equal(store.getDaemonControl(key).pending[0].id,original.id);
});

test('real public approve and run reject an overdue paused task while fresh human input remains usable',async()=>{
 let effects=0;
 const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'deadline-public-repo-')),stateDir:mkdtempSync(join(tmpdir(),'deadline-public-state-')),extraTools:[{name:'deadline_public_effect',description:'Deadline guarded effect',inputSchema:{type:'object',properties:{}},approvalMode:'always',sideEffectLevel:'workspace',async execute(){effects++;return {ok:true,content:'effect'};}}],modelAdapter:{name:'deadline-public',async summarizeMessages(){return '';},async runTurn(input){const latest=input.messages.filter(message=>message.role==='user').at(-1);if(latest?.parts.some(part=>part.type==='text'&&part.text.includes('perform deadline guarded action')))return {stopReason:'tool_use',assistantParts:[{type:'tool_call',name:'deadline_public_effect',toolCallId:'deadline-public-call',input:{}}]};return {stopReason:'end',assistantParts:[{type:'text',text:'Fresh human request answered'}]};}}});
 rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
 try{
 const principal=resolveBotPrincipal(rt.store),sender=rt.createBot({name:'Public deadline sender'}),worker=rt.createBot({name:'Public deadline worker'}),host={store:rt.store,runSession:id=>rt.runSession(id),isSessionRunning:id=>rt.isSessionRunning(id),log:{warn(){}}};
 const task=dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:worker.id,input:'perform deadline guarded action',deadline:new Date(Date.now()+60000).toISOString()});await rt.runScheduler();let approval;
 for(let i=0;i<100;i++){approval=rt.store.listApprovals({status:'pending'}).find(item=>item.toolName==='deadline_public_effect');if(approval&&!rt.isSessionRunning(approval.sessionId))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(approval);
 // Reproduce deadline crossing before the next scheduler tick, avoiding timer-order dependence.
 rt.store.db.prepare('UPDATE bot_work_tasks SET deadline=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),task.id);
 await assert.rejects(()=>rt.approve(approval.id,'approved'),/deadline|cancelled|retired|verif|parked/i);await rt.runSession(approval.sessionId);assert.equal(effects,0);assert.equal(listBotTasks(rt.store,principal).find(item=>item.id===task.id).status,'unknown');
 const fresh=rt.store.appendMessage(approval.sessionId,'user',[{type:'text',text:'Please answer this fresh human request'}]);requestHumanRun(rt.store,approval.sessionId);await rt.runSession(approval.sessionId);assert.equal(effects,0);assert.ok(rt.store.foldMessages(approval.sessionId).some(message=>message.id===fresh.id));assert.ok(rt.store.foldMessages(approval.sessionId).some(message=>message.role==='assistant'&&message.parts.some(part=>part.type==='text'&&part.text==='Fresh human request answered')));
 }finally{await rt.destroy();}
});


test('retired Bot task sources no longer pin active goals or unfinished todos while fresh sources survive',async()=>{
 const {store,host}=setup();const principal=resolveBotPrincipal(store),sender=createBot(host,{name:'Pinned sender'}),worker=createBot(host,{name:'Pinned worker'}),sid=worker.canonicalSessionId;
 const retained=store.appendMessage(sid,'user',[{type:'text',text:'Constraint: retain the unrelated workspace rule'}]);host.runSession=()=>new Promise(()=>{});
 const task=dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:worker.id,input:'\nGoal: retired delegated goal\nTodo: retired delegated pending'});await tickBotWork(host);
 const source=store.db.prepare('SELECT message_ref FROM bot_work_messages WHERE task_id=?').get(task.id).message_ref;
 assert.match(buildTaskContext(store.getSession(sid)),/retired delegated goal/,'claim preserves requirements captured from its appended source');
 store.updateSession(sid,{todo:[{content:'retired delegated pending',status:'pending',activeForm:'retired delegated pending'},{content:'completed historical item',status:'completed',activeForm:'completed historical item'},{content:'independent pending',status:'pending',activeForm:'independent pending'}]});
 const fresh=store.appendMessage(sid,'user',[{type:'text',text:'Goal: fresh accepted goal\nTodo: fresh accepted pending'}]);requestHumanRun(store,sid);
 assert.match(buildTaskContext(store.getSession(sid)),/retired delegated goal/);recoverBotWork(store);
 const session=store.getSession(sid),prompt=buildTaskContext(session),facts=Object.values(session.metadata.taskContext.tasks).flat();
 assert.doesNotMatch(prompt,/retired delegated goal|retired delegated pending/);assert.match(prompt,/fresh accepted goal/);assert.match(prompt,/retain the unrelated workspace rule/);
 assert.ok(facts.filter(fact=>fact.sourceMessageId===source).every(fact=>fact.status==='superseded'));assert.ok(facts.some(fact=>fact.sourceMessageId===fresh.id&&fact.status==='active'));assert.ok(facts.some(fact=>fact.sourceMessageId===retained.id&&fact.status==='active'));
 assert.ok(!session.todo.some(todo=>todo.content==='retired delegated pending'));assert.ok(session.todo.some(todo=>todo.content==='independent pending'));assert.ok(session.todo.some(todo=>todo.status==='completed'));assert.ok(!Object.values(session.metadata.taskContext.todos).flat().some(todo=>todo.content==='retired delegated pending'&&todo.status!=='completed'));
 assert.equal(listBotTasks(store,principal).find(item=>item.id===task.id).status,'unknown');assert.throws(()=>retryBotTask(host,principal,task.id),/verification/);
});

test('boot recovery preserves live Bot work while retiring a dead peer', async () => {
 const {store,host}=setup();const principal=resolveBotPrincipal(store);const boss=ensureSuperBot(host,principal);
 const live=createBot(host,{name:'live'}),dead=createBot(host,{name:'dead'});
 host.runSession=()=>new Promise(()=>{});
 const liveTask=dispatchBotTask(host,{principal,requesterBotId:boss.bot.id,targetBotId:live.id,input:'live'});
 const deadTask=dispatchBotTask(host,{principal,requesterBotId:boss.bot.id,targetBotId:dead.id,input:'dead'});
 await tickBotWork(host);
 const sid=store.db.prepare('SELECT session_id FROM bot_work_messages WHERE task_id=?').get(liveTask.id).session_id;
 store.claimWriter(sid,'live-writer');
 const deadSid=store.db.prepare('SELECT session_id FROM bot_work_messages WHERE task_id=?').get(deadTask.id).session_id;
 const departed=new SqliteStateStore(store.dbPath);
 departed.claimWriter(deadSid,'departed-writer');departed.db.close();
 const beforeSession=store.getSession(sid),beforeTask=listBotTasks(store,principal).find(t=>t.id===liveTask.id);
 const beforeLease=store.db.prepare('SELECT * FROM bot_work_leases WHERE session_id=?').get(sid);
 const other=new SqliteStateStore(store.dbPath);
 try {
  recoverBotWork(other);
  assert.deepEqual(store.getSession(sid),beforeSession);
  assert.deepEqual(listBotTasks(store,principal).find(t=>t.id===liveTask.id),beforeTask);
  assert.deepEqual(store.db.prepare('SELECT * FROM bot_work_leases WHERE session_id=?').get(sid),beforeLease);
  assert.equal(listBotTasks(store,principal).find(t=>t.id===deadTask.id).status,'unknown');
  assert.equal(store.getSession(deadSid).activeWriterRunId,undefined);
 } finally {other.db.close();store.db.close();}
});
