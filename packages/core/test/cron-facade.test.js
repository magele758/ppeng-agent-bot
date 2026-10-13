import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { ValidationError } from '../dist/errors.js';
import { createBot } from '../dist/bots/index.js';
import { createCronJob, listCronJobs, updateCronJob, deleteCronJob } from '../dist/cron/cron-facade.js';

function tempHost() {
  const dir = mkdtempSync(join(tmpdir(), 'cron-facade-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const host = {
    store,
    stateDir: dir,
    cronStore: undefined,
    setCronStore(next) {
      this.cronStore = next;
    },
    runImageRetention: async () => {},
    wakeAllAutonomousSessions: () => {},
    wakeAgentSessions: () => {}
  };
  return { store, host };
}

test('createCronJob binds bot canonical session', () => {
  const { store, host } = tempHost();
  const bot = createBot(host, { name: 'Ticker' });
  const job = createCronJob(host, {
    botId: bot.id,
    name: '晨报',
    prompt: '总结昨日进展',
    cron: '30 9 * * *'
  });
  assert.equal(job.sessionId, bot.canonicalSessionId);
  assert.equal(job.metadata.botId, bot.id);
  assert.equal(job.scheduleKind, 'cron5');
  assert.ok(job.nextRunAt);
  assert.equal(listCronJobs(host, { botId: bot.id }).length, 1);
  const paused = updateCronJob(host, job.id, { enabled: false });
  assert.equal(paused.enabled, false);
  deleteCronJob(host, job.id);
  assert.equal(listCronJobs(host, { botId: bot.id }).length, 0);
  store.db.close();
});

test('createCronJob rejects bad cron', () => {
  const { store, host } = tempHost();
  const bot = createBot(host, { name: 'BadCron' });
  assert.throws(
    () => createCronJob(host, { botId: bot.id, name: 'x', prompt: 'y', cron: 'not-cron' }),
    ValidationError
  );
  store.db.close();
});

test('createCronJob stores an event routine without a next run', () => {
  const { store, host } = tempHost();
  const bot = createBot(host, { name: 'PushBot' });
  const job = createCronJob(host, {
    botId: bot.id,
    name: 'on push',
    prompt: '总结推送',
    event: 'github/push',
    secretEnv: 'GH_WEBHOOK_SECRET',
    precheck: { kind: 'predicate', source: '{"wakeAgent":false}' }
  });
  assert.equal(job.scheduleKind, 'event');
  assert.equal(job.scheduleValue, 'github/push');
  assert.equal(job.nextRunAt, undefined);
  assert.equal(job.metadata.secretEnv, 'GH_WEBHOOK_SECRET');
  assert.equal(job.metadata.prompt, '总结推送');
  assert.deepEqual(job.metadata.precheck, { kind: 'predicate', source: '{"wakeAgent":false}' });
  assert.equal(host.cronStore.dueJobs().some((item) => item.id === job.id), false);
  assert.throws(
    () => createCronJob(host, { botId: bot.id, name: 'x', prompt: 'y', event: 'github/push', cron: '0 9 * * *', secretEnv: 'GH_WEBHOOK_SECRET' }),
    ValidationError
  );
  store.db.close();
});

test('schedule and content updates preserve explicit policies and invalidate old catch-up plans',()=>{
 const {store,host}=tempHost();const session=store.createSession({title:'tool fixture',mode:'chat',agentId:'general',metadata:{userId:'alice'}});let job=createCronJob(host,{sessionId:session.id,name:'update',prompt:'read',intervalMs:1000});
 host.cronStore.update(job.id,{metadata:{...job.metadata,catchUpPlan:{scheduledAts:['old']}}});
 job=updateCronJob(host,job.id,{onceAt:'2030-01-01T00:00:00Z',name:' once ',prompt:' act ',timezone:'Asia/Shanghai',missedPolicy:'skip',precheck:{kind:'predicate',source:'{"wakeAgent":false}'}});assert.equal(job.scheduleKind,'once_at');assert.equal(job.name,'once');assert.equal(job.prompt,'act');assert.equal(job.missedPolicy,'skip');assert.equal(job.metadata.catchUpPlan,undefined);
 job=updateCronJob(host,job.id,{intervalMs:60000,precheck:null});assert.equal(job.scheduleKind,'every_ms');assert.equal(job.metadata.precheck,undefined);
 assert.throws(()=>updateCronJob(host,job.id,{event:'github/push'}),/secretEnv/);
 job=updateCronJob(host,job.id,{event:'github/push',secretEnv:'UPDATE_EVENT_SECRET',prompt:'event prompt'});assert.equal(job.metadata.prompt,'event prompt');
 job=updateCronJob(host,job.id,{cron:'0 9 * * *',enabled:false});host.cronStore.update(job.id,{nextRunAt:'2020-01-01T00:00:00Z'});job=updateCronJob(host,job.id,{enabled:true});assert.ok(Date.parse(job.nextRunAt)>Date.now());
 const version=job.ruleVersion;job=updateCronJob(host,job.id,{timezone:'UTC'});assert.equal(job.ruleVersion,version+1);
 for(const patch of [{cron:'0 9 * * *',intervalMs:1000},{onceAt:'invalid'},{intervalMs:999},{event:'bad'},{timezone:'bad zone'},{missedPolicy:'bad'},{name:''},{prompt:''},{secretEnv:'bad env'}])assert.throws(()=>updateCronJob(host,job.id,patch));
 for(const input of [{onceAt:'invalid'},{intervalMs:0},{event:'bad',secretEnv:'ENV'},{cron:'0 9 * * *',missedPolicy:'bad'}])assert.throws(()=>createCronJob(host,{sessionId:session.id,name:'bad',prompt:'bad',...input}));store.db.close();
});
