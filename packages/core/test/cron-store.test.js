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
    scheduleValue: '1',
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
