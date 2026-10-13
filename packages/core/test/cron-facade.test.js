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
