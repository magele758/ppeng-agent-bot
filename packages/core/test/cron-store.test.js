import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronJobStore, markCronJobRan } from '../dist/cron/cron-store.js';
import { nextCronRunAt } from '../dist/cron/cron-next.js';

test('CronJobStore create list due and mark', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-test-'));
  const store = new CronJobStore(dir);
  const job = store.create({
    sessionId: 's1',
    agentId: 'general',
    name: 'ping',
    prompt: 'say hi',
    scheduleKind: 'every_ms',
    scheduleValue: '60000',
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    metadata: {}
  });
  assert.equal(store.list({ sessionId: 's1' }).length, 1);
  const due = store.dueJobs();
  assert.ok(due.some((j) => j.id === job.id));
  const updated = markCronJobRan(store, job);
  assert.ok(updated?.lastRunAt);
  assert.ok(updated?.nextRunAt);
  assert.equal(store.remove(job.id), true);
});

test('cron5 dueJobs and mark advance nextRunAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-cron5-'));
  const store = new CronJobStore(dir);
  const past = new Date(Date.now() - 60_000);
  const cron = `${past.getMinutes()} ${past.getHours()} * * *`;
  const job = store.create({
    sessionId: 's1',
    agentId: 'general',
    name: 'daily',
    prompt: 'ping',
    scheduleKind: 'cron5',
    scheduleValue: cron,
    nextRunAt: past.toISOString(),
    metadata: { botId: 'researcher' }
  });
  assert.equal(store.list({ botId: 'researcher' }).length, 1);
  assert.ok(store.dueJobs().some((j) => j.id === job.id));
  const updated = markCronJobRan(store, job);
  assert.ok(updated?.lastRunAt);
  assert.ok(updated?.nextRunAt);
  const expected = nextCronRunAt(cron, new Date(Date.parse(updated.lastRunAt)));
  assert.equal(Date.parse(updated.nextRunAt), expected.getTime());
  assert.equal(store.dueJobs().some((j) => j.id === job.id), false);
});

test('event routines stay out of dueJobs even when nextRunAt is past', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-event-'));
  const store = new CronJobStore(dir);
  const job = store.create({
    sessionId: 's1',
    agentId: 'general',
    name: 'on push',
    prompt: 'summarize',
    scheduleKind: 'event',
    scheduleValue: 'github/push',
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    metadata: {
      prompt: 'summarize',
      secretEnv: 'GH_WEBHOOK_SECRET',
      precheck: { kind: 'predicate', source: '{"wakeAgent":false}' }
    }
  });
  assert.equal(store.dueJobs().some((j) => j.id === job.id), false);
  const updated = markCronJobRan(store, job);
  assert.ok(updated?.lastRunAt);
  assert.equal(updated?.nextRunAt, undefined);
  assert.equal(updated?.enabled, true);
  assert.equal(store.dueJobs().some((j) => j.id === job.id), false);
  assert.equal(JSON.stringify(store.list()).includes('super-secret-value'), false);
});

test('dialog tools cover schedule variants and enforce live disable and owner isolation',async()=>{
 const {createCronTools}=await import('../dist/cron/cron-store.js');const {SqliteStateStore}=await import('../dist/storage.js');const dir=mkdtempSync(join(tmpdir(),'cron-tools-'));const sqlite=new SqliteStateStore(join(dir,'state.db'));const jobs=new CronJobStore(dir);let enabled=true;
 const alice=sqlite.createSession({title:'tool fixture',mode:'chat',agentId:'general',metadata:{userId:'alice'}}),bob=sqlite.createSession({title:'tool fixture',mode:'chat',agentId:'general',metadata:{userId:'bob'}});
 const [create,list,remove]=createCronTools(()=>jobs,{store:sqlite,isEnabled:()=>enabled});const context={session:alice,agent:{id:'general'}};let first;
 for(const schedule of [{every_ms:60000},{once_at:'2030-01-01T00:00:00Z'},{cron:'0 9 * * *',timezone:'UTC'},{event:'github/push',secretEnv:'TOOL_EVENT_SECRET'}]){const output=await create.execute(context,{name:'tool',prompt:'read',...schedule});assert.equal(output.ok,true);first??=JSON.parse(output.content).id;}
 assert.equal(JSON.parse((await list.execute(context,{})).content).length,4);assert.equal(JSON.parse((await list.execute({session:bob,agent:{id:'general'}},{session_only:false})).content).length,0);
 assert.equal((await remove.execute({session:bob,agent:{id:'general'}},{id:first})).ok,false);assert.ok(jobs.get(first));assert.equal((await remove.execute(context,{id:first})).ok,true);assert.equal((await remove.execute(context,{id:first})).ok,false);
 for(const args of [{},{once_at:'bad'},{event:'bad',secretEnv:'ENV'},{event:'github/push',secretEnv:'bad env'},{every_ms:60000,cron:'* * * * *'}])await assert.rejects(()=>create.execute(context,{name:'bad',prompt:'bad',...args}));assert.equal((await create.execute(context,{name:'bad',prompt:'bad',every_ms:1})).ok,false);
 enabled=false;for(const [tool,args] of [[create,{name:'new',prompt:'new',every_ms:60000}],[list,{}],[remove,{id:first}]])assert.equal((await tool.execute(context,args)).ok,false);sqlite.db.close();
});

test('deadline persists and suppresses due jobs at the exact boundary [AC:bot-routine-lifecycle#AC-6]',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cron-expiry-')),store=new CronJobStore(dir);const now=Date.now();
 for(const scheduleKind of ['every_ms','cron5']){
 const job=store.create({sessionId:'s',agentId:'general',name:'expiry',prompt:'check',scheduleKind,scheduleValue:scheduleKind==='every_ms'?'60000':'* * * * *',nextRunAt:new Date(now-60000).toISOString(),expiresAt:new Date(now).toISOString(),metadata:{}});
 const reopened=new CronJobStore(dir);assert.equal(reopened.get(job.id).expiresAt,job.expiresAt);assert.ok(reopened.dueJobs(now-1).some(j=>j.id===job.id));assert.ok(!reopened.dueJobs(now).some(j=>j.id===job.id));
 }
});
test('dialog tools validate deadline and minimum interval [AC:bot-routine-lifecycle#AC-8]',async()=>{
 const {createCronTools}=await import('../dist/cron/cron-store.js');const store=new CronJobStore(mkdtempSync(join(tmpdir(),'cron-tool-expiry-')));const tool=createCronTools(()=>store)[0];const context={session:{id:'s',metadata:{}},agent:{id:'general'}};
 assert.equal((await tool.execute(context,{name:'r',prompt:'check',every_ms:59999})).ok,false);
 await assert.rejects(()=>tool.execute(context,{name:'r',prompt:'check',every_ms:60000,expiresAt:'2000-01-01T00:00:00Z'}),/expiresAt/);
 const expiresAt=new Date(Date.now()+3600000).toISOString();const result=await tool.execute(context,{name:'r',prompt:'check',every_ms:60000,expiresAt});assert.equal(JSON.parse(result.content).expiresAt,expiresAt);
});
