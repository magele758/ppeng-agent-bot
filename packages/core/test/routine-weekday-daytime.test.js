import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createCronJob, updateCronJob } from '../dist/cron/cron-facade.js';
import { createCronTools } from '../dist/cron/cron-store.js';

function hostFor(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const host = {
    store,
    stateDir: dir,
    cronStore: undefined,
    setCronStore(next) {
      this.cronStore = next;
    }
  };
  return { dir, store, host };
}

function localClock(iso, timezone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value])
  );
}

function assertWeekdayMorning(job, timezone) {
  assert.equal(job.scheduleKind, 'cron5');
  assert.equal(job.scheduleValue, '0 9 * * 1-5');
  const clock = localClock(job.nextRunAt, timezone);
  assert.equal(clock.hour, '09');
  assert.equal(clock.minute, '00');
  assert.ok(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(clock.weekday), clock.weekday);
}

test('省略时间的新例行任务落在工作日白天 [AC:routine-weekday-daytime-default#AC-1]', () => {
  const { store, host } = hostFor('weekday-default-');
  const session = store.createSession({ title: 'cron', mode: 'chat', agentId: 'general', metadata: { userId: 'alice' } });
  const omitted = createCronJob(host, { sessionId: session.id, name: 'brief', prompt: 'summarize', timezone: 'Asia/Shanghai' });
  assertWeekdayMorning(omitted, 'Asia/Shanghai');
  const blank = createCronJob(host, { sessionId: session.id, name: 'blank', prompt: 'summarize', cron: '', timezone: 'Asia/Shanghai' });
  assertWeekdayMorning(blank, 'Asia/Shanghai');
  store.db.close();
});

test('写明的夜间、周末、间隔和事件不会被默认窗盖掉 [AC:routine-weekday-daytime-default#AC-2]', () => {
  const { store, host } = hostFor('weekday-explicit-');
  const session = store.createSession({ title: 'cron', mode: 'chat', agentId: 'general', metadata: { userId: 'alice' } });
  const weekend = createCronJob(host, {
    sessionId: session.id,
    name: 'night',
    prompt: 'watch',
    cron: '15 3 * * 0',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(weekend.scheduleValue, '15 3 * * 0');
  const night = localClock(weekend.nextRunAt, 'Asia/Shanghai');
  assert.equal(night.hour, '03');
  assert.equal(night.minute, '15');
  assert.equal(night.weekday, 'Sun');
  const interval = createCronJob(host, { sessionId: session.id, name: 'often', prompt: 'watch', intervalMs: 3600000 });
  assert.equal(interval.scheduleKind, 'every_ms');
  assert.equal(interval.scheduleValue, '3600000');
  const event = createCronJob(host, {
    sessionId: session.id,
    name: 'push',
    prompt: 'watch',
    event: 'github/push',
    secretEnv: 'GH_WEBHOOK_SECRET'
  });
  assert.equal(event.scheduleKind, 'event');
  assert.equal(event.scheduleValue, 'github/push');
  store.db.close();
});

test('已有夜间任务不会因为新建默认任务或空更新被改写 [AC:routine-weekday-daytime-default#AC-3]', () => {
  const { store, host } = hostFor('weekday-keep-');
  const session = store.createSession({ title: 'cron', mode: 'chat', agentId: 'general', metadata: { userId: 'alice' } });
  const existing = createCronJob(host, {
    sessionId: session.id,
    name: 'weekend',
    prompt: 'watch',
    cron: '0 3 * * 0',
    timezone: 'UTC'
  });
  createCronJob(host, { sessionId: session.id, name: 'fresh', prompt: 'summarize' });
  const kept = updateCronJob(host, existing.id, { name: 'weekend renamed' });
  assert.equal(kept.scheduleKind, 'cron5');
  assert.equal(kept.scheduleValue, '0 3 * * 0');
  assert.equal(host.cronStore.get(existing.id).scheduleValue, '0 3 * * 0');
  store.db.close();
});

test('对话里省略时间的新例行任务也落在工作日白天 [AC:routine-weekday-daytime-default#AC-1] [AC:routine-weekday-daytime-default#AC-2]', async () => {
  const { dir, store } = hostFor('weekday-tool-');
  const { CronJobStore } = await import('../dist/cron/cron-store.js');
  const jobs = new CronJobStore(dir);
  const session = store.createSession({ title: 'tool', mode: 'chat', agentId: 'general', metadata: { userId: 'alice' } });
  const [create] = createCronTools(() => jobs, { store });
  const context = { session, agent: { id: 'general' } };
  const explicit = JSON.parse((await create.execute(context, { name: 'night', prompt: 'watch', cron: '0 3 * * 0', timezone: 'UTC' })).content);
  const created = JSON.parse((await create.execute(context, { name: 'brief', prompt: 'summarize', timezone: 'Asia/Shanghai' })).content);
  assertWeekdayMorning(created, 'Asia/Shanghai');
  const blank = JSON.parse((await create.execute(context, { name: 'blank', prompt: 'summarize', cron: '', timezone: 'UTC' })).content);
  assertWeekdayMorning(blank, 'UTC');
  assert.equal(jobs.get(explicit.id).scheduleValue, '0 3 * * 0');
  store.db.close();
});
