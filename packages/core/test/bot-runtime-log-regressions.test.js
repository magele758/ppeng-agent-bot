import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { createCronJob } from '../dist/cron/cron-facade.js';
import { RoutineRunStore, drainRoutineRuns } from '../dist/cron/routine-runtime.js';
import { classifyGoalIntents } from '../dist/bots/goals/intake.js';
import { BotRoomService } from '../dist/rooms/index.js';

const text = value => [{ type: 'text', text: value }];
function fixture(t, execute) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-log-replay-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const host = { store, stateDir: dir, log: { warn() {}, info() {} },
    runImageRetention: async () => {}, wakeAllAutonomousSessions() {}, wakeAgentSessions() {},
    setCronStore(value) { this.cronStore = value; },
    runSession: async id => { await execute?.(store, id); return store.getSession(id); } };
  const bot = createBot(host, { name: 'Machine worker' });
  return { store, host, bot, sid: bot.canonicalSessionId };
}
async function runRoutine(f) {
  const job = createCronJob(f.host, { botId: f.bot.id, name: 'watch progress', prompt: 'Check current work', intervalMs: 60000 });
  const run = new RoutineRunStore(f.store).enqueue(job, new Date().toISOString());
  await drainRoutineRuns(f.host);
  await new Promise(resolve => setImmediate(resolve));
  return new RoutineRunStore(f.store).get(run.id);
}

test('logged status and format followups never become new deliverables [AC:bot-runtime-log-regressions#AC-1]', async () => {
  for (const input of ['好了吗', '搞完了没？', '现在在干嘛？', '还有什么没做完的', '回复简单点，按照子弹列表，给我列清楚就行了']) {
    const intents = await classifyGoalIntents(input, [{ id: 'work-1', title: '开发服务', status: 'running' }]);
    assert.ok(intents.every(i => ['query', 'chat'].includes(i.kind)), input);
  }
  const work = await classifyGoalIntents('再加一个功能：状态页面支持导出', []);
  assert.equal(work[0].kind, 'new_goal');
  const mixed = await classifyGoalIntents('回复简单点，再加一个 API', []);
  assert.ok(mixed.some(intent => intent.kind === 'new_goal'));
});

test('routine result stops at a new user request and excludes recap [AC:bot-runtime-log-regressions#AC-2]', async t => {
  const f = fixture(t, (store, id) => {
    store.appendMessage(id, 'assistant', text('CURRENT_CHECK'));
    store.appendMessage(id, 'assistant', text('OLD_RECAP'), { key: 'session-recap:old' });
    store.appendMessage(id, 'assistant', text('OLD_COMPACTION'), { key: 'compact-summary' });
    store.appendMessage(id, 'user', text('A DIFFERENT WORK ITEM'));
    store.runWithoutMessageSource(()=>store.appendMessage(id, 'assistant', text('OTHER_WORK_RESULT')));
  });
  const run = await runRoutine(f);
  assert.equal(run.result, 'CURRENT_CHECK');
});

test('a routine answer after concurrent human input retains its host execution ownership [AC:bot-runtime-log-regressions#AC-2]', async t => {
  const f=fixture(t,(store,id)=>{
    store.runWithoutMessageSource(()=>store.appendMessage(id,'user',text('new human input')));
    store.appendMessage(id,'assistant',text('CURRENT_ROUTINE_AFTER_STEER'));
  });
  const run=await runRoutine(f);
  assert.equal(run.result,'CURRENT_ROUTINE_AFTER_STEER');
  assert.equal(run.status,'completed');
});

test('routine result survives folded-away trigger without importing history [AC:bot-runtime-log-regressions#AC-2]', async t => {
  const f = fixture(t, (store, id) => {
    store.appendMessage(id, 'assistant', text('CURRENT_CHECK'));
    const original = store.foldMessages.bind(store);
    store.foldMessages = sid => original(sid).filter(m => !m.key?.startsWith('routine:'));
  });
  f.store.appendMessage(f.sid, 'assistant', text('OLD_HISTORY'));
  const run = await runRoutine(f);
  assert.equal(run.result, 'CURRENT_CHECK');
});

test('canonical routine result is visible once while receipt stays durable [AC:bot-runtime-log-regressions#AC-3]', async t => {
  const f = fixture(t, (store, id) => store.appendMessage(id, 'assistant', text('CHECK_COMPLETE')));
  const run = await runRoutine(f);
  const copies = f.store.foldMessages(f.sid).filter(m => m.role === 'assistant' && JSON.stringify(m.parts).includes('CHECK_COMPLETE'));
  assert.equal(copies.length, 1);
  assert.equal(run.notificationSent, true);
  assert.ok(f.store.db.prepare('SELECT 1 FROM bot_routine_summary_links WHERE run_id=?').get(run.id));
});

test('source-scope refusal cannot be converted into no-update success [AC:bot-runtime-log-regressions#AC-4]', async t => {
  const f = fixture(t, (store, id) => {
    store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'check', name: 'bash', input: { command: 'ssh worker status' } }]);
    store.appendMessage(id, 'tool', [{ type: 'tool_result', toolCallId: 'check', name: 'bash', ok: false, content: JSON.stringify({ error: 'source_scope_denied' }) }]);
    store.appendMessage(id, 'assistant', text('[NO_UPDATE]'));
  });
  const run = await runRoutine(f);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /source_scope_denied/);
});

test('group budget stop settles running member instead of claiming completion [AC:bot-runtime-log-regressions#AC-5]', async t => {
  const f = fixture(t);
  const other = createBot(f.host, { name: 'Reviewer' });
  const roomHost = { ...f.host, createChatSession: input => createChatSession(f.host, input),
    cancelSession: id => f.store.updateSession(id, { status: 'idle' }),
    runSession: async (id, options) => {
      const session = f.store.getSession(id);
      f.store.updateSession(id, { metadata: { ...session.metadata, usageCostUsd: 2 } });
      await options?.onEvent?.({ type: 'model_done', assistant: { parts: text('unfinished') } });
    } };
  const rooms = new BotRoomService(roomHost);
  const { resolveBotPrincipal } = await import('../dist/bots/bot-identity.js');
  const principal = resolveBotPrincipal(f.store);
  const room = rooms.create(principal, { title: 'Dev', botIds: [f.bot.id, other.id], maxCostUsd: 1 });
  rooms.send(principal, room.id, { text: 'work', mentions: [f.bot.id] });
  await rooms.tick();
  const turn = rooms.turns(principal, room.id)[0];
  assert.equal(turn.terminationReason, 'cost_budget');
  assert.equal(turn.status, 'failed');
  assert.ok(turn.members.every(member => !['running', 'waiting_approval'].includes(member.status)));
});

test('approved canonical routine retains result ownership across its continuation [AC:bot-runtime-log-regressions#AC-2]',async t=>{
 let count=0,approval;
 const f=fixture(t,(store,id)=>{
  if(count++===0){
   store.appendMessage(id,'assistant',[{type:'tool_call',toolCallId:'check',name:'bash',input:{command:'check'}}]);
   approval=store.createApproval({sessionId:id,toolName:'bash',args:{command:'check'},reason:'requires approval'});
   store.updateSession(id,{status:'waiting_approval',metadata:{...store.getSession(id).metadata,outcome:{kind:'waiting_approval'}}});
  }else{
   store.appendMessage(id,'tool',[{type:'tool_result',toolCallId:'check',name:'bash',ok:true,content:'observed'}]);
   store.appendMessage(id,'assistant',text('APPROVED_RESULT'));
   store.updateSession(id,{status:'idle',metadata:{...store.getSession(id).metadata,outcome:{kind:'idle',reason:'end'}}});
  }
 });
 const waiting=await runRoutine(f);assert.equal(waiting.status,'waiting_approval');
 f.store.updateApproval(approval.id,'approved');f.store.updateSession(f.sid,{status:'idle'});
 await drainRoutineRuns(f.host);await new Promise(resolve=>setImmediate(resolve));
 const done=new RoutineRunStore(f.store).get(waiting.id);
 assert.equal(done.status,'completed');assert.equal(done.result,'APPROVED_RESULT');
});

test('a successor writer cannot inherit the previous routine attribution [AC:bot-runtime-log-regressions#AC-2]',async t=>{
 const f=fixture(t);let first,second;
 await f.store.runWithMessageSource(f.sid,'routine-owner',async()=>{
  f.store.claimWriter(f.sid,'writer-1');
  await f.store.runWithWriter(f.sid,'writer-1',async()=>{first=f.store.appendMessage(f.sid,'assistant',text('first'));});
  f.store.releaseWriter(f.sid,'writer-1');
  f.store.claimWriter(f.sid,'writer-2');
  await f.store.runWithWriter(f.sid,'writer-2',async()=>{second=f.store.appendMessage(f.sid,'assistant',text('successor'));});
  f.store.releaseWriter(f.sid,'writer-2');
 });
 assert.deepEqual(f.store.messageIdsForSource(f.sid,'routine-owner'),[first.id]);
 assert.ok(second.id);
});

test('an already consumed routine steer is re-anchored before its owned continuation [AC:bot-runtime-log-regressions#AC-2]',async t=>{
 const f=fixture(t,(store,id)=>{
  const latest=store.listMessages(id).filter(message=>message.role==='user').at(-1);
  assert.match(JSON.stringify(latest.parts),/CURRENT_CHECK/);
  assert.match(JSON.stringify(latest.parts),/do not repeat/i);
  store.appendMessage(id,'assistant',text('CURRENT_CHECK_CONFIRMED'));
 });
 f.store.updateSession(f.sid,{status:'running'});
 const job=createCronJob(f.host,{botId:f.bot.id,name:'new routine',prompt:'CURRENT_CHECK',intervalMs:60000});
 const runs=new RoutineRunStore(f.store),run=runs.enqueue(job,new Date().toISOString());
 await drainRoutineRuns(f.host);
 const inbox=f.store.listUnclaimedInbox(f.sid)[0];
 f.store.appendMessage(f.sid,'user',text(inbox.text),{key:inbox.key});
 f.store.db.prepare('UPDATE session_inbox SET claimed_at=? WHERE id=?').run(new Date().toISOString(),inbox.id);
 f.store.appendMessage(f.sid,'assistant',text('A different active run answered'));
 f.store.appendMessage(f.sid,'user',text('previous operation'));
 f.store.updateSession(f.sid,{status:'idle'});
 await drainRoutineRuns(f.host);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(runs.get(run.id).result,'CURRENT_CHECK_CONFIRMED');
});
