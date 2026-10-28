import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {createBot} from '../dist/bots/index.js';
import {createCronJob} from '../dist/cron/cron-facade.js';
import {RoutineRunStore,drainRoutineRuns} from '../dist/cron/routine-runtime.js';
import {routineAnswerMessages} from '../dist/cron/routine-result.js';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'routine-owned-result-')),store=new SqliteStateStore(join(dir,'db'));
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 const host={store,stateDir:dir,log:{warn(){},info(){}},setCronStore(s){this.cronStore=s;},runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}};
 const bot=createBot(host,{name:'Worker'});return {host,store,sid:bot.canonicalSessionId,bot};
}
const text=(store,sid,body,key)=>store.appendMessage(sid,'assistant',[{type:'text',text:body}],key?{key}:undefined);

test('legacy completed routine cannot collect later unsolicited assistant replies [AC:single-host-bot-completion#AC-3] [AC:bot-watch-work-continuity#AC-7]',t=>{
 const f=fixture(t),prompt=f.store.appendMessage(f.sid,'user',[{type:'text',text:'inspect'}],{key:'routine:legacy'});
 const answer=text(f.store,f.sid,'owned answer');
 const later=text(f.store,f.sid,'unrelated later reply');
 f.store.db.prepare('UPDATE session_messages SET created_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z',later.id);
 const run={id:'legacy',sessionId:f.sid,startSeq:prompt.seq,createdAt:prompt.createdAt,startedAt:prompt.createdAt,finishedAt:answer.createdAt};
 assert.deepEqual(routineAnswerMessages(f.store,run).map(m=>m.id),[answer.id]);
});

test('shared routine keeps exact run results and publishes once despite unrelated messages [AC:single-host-bot-completion#AC-3] [AC:bot-watch-work-continuity#AC-7]',async t=>{
 const f=fixture(t);let expected;
 text(f.store,f.sid,'old report','routine-result:old');
 f.host.runSession=async sid=>{
  text(f.store,sid,'[routine:old] nested summary','routine-result:nested');
  expected=text(f.store,sid,'current result');
  f.store.runWithoutMessageSource(()=>{f.store.appendMessage(sid,'user',[{type:'text',text:'another question'}]);text(f.store,sid,'unrelated reply');});
  return f.store.getSession(sid);
 };
 const job=createCronJob(f.host,{botId:f.bot.id,name:'inspect',prompt:'inspect',intervalMs:60000});
 const runs=new RoutineRunStore(f.store),run=runs.enqueue(job,new Date().toISOString());
 await drainRoutineRuns(f.host);await new Promise(r=>setImmediate(r));
 const done=runs.get(run.id);assert.equal(done.result,'current result');assert.equal(done.summaryMessageId,expected.id);
 const before=f.store.listMessages(f.sid).length;await drainRoutineRuns(f.host);await drainRoutineRuns(f.host);
 assert.equal(f.store.listMessages(f.sid).length,before);assert.equal(runs.get(run.id).notificationSent,true);
});
