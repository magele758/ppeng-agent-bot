import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { CronJobStore } from '../dist/cron/cron-store.js';
import { createCronJob, listCronJobs, updateCronJob } from '../dist/cron/cron-facade.js';
import { evaluateRoutinePrecheck } from '../dist/cron/routine-precheck.js';
import { tickCronJobs } from '../dist/runtime/scheduler-host.js';

function tempHost() {
  const dir = mkdtempSync(join(tmpdir(), 'routine-precheck-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const runs = [];
  const host = {
    store,
    stateDir: dir,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    runImageRetention: async () => {},
    wakeAllAutonomousSessions: () => {},
    wakeAgentSessions: () => {},
    cronStore: undefined,
    setCronStore(next) {
      this.cronStore = next;
    },
    selfHeal: { processRuns: async () => {} },
    swarmExecutor: { tick: async () => {} },
    orchestrationEngine: { tick: async () => {} },
    autonomousScheduler: { tick: async () => {} },
    runSession: async (sessionId) => {
      runs.push(sessionId);
      return store.getSession(sessionId);
    }
  };
  return { dir, store, host, runs };
}

function due(host, job) {
  host.cronStore.update(job.id, { nextRunAt: new Date(Date.now() - 5_000).toISOString() });
}

test('谓词与脚本返回 wakeAgent false 时不开始模型回合 [AC:bot-gateway-delivery#AC-6]', async () => {
  const predicate = await evaluateRoutinePrecheck(
    { kind: 'predicate', source: '{"wakeAgent": false, "reason": "unchanged"}' },
    { cwd: tmpdir() }
  );
  assert.equal(predicate.wakeAgent, false);

  const script = await evaluateRoutinePrecheck(
    { kind: 'script', source: `printf '%s\\n' 'noise' '{"wakeAgent":false}'` },
    { cwd: tmpdir() }
  );
  assert.equal(script.wakeAgent, false);

  const { dir, store, host, runs } = tempHost();
  const bot = createBot(host, { name: 'Quiet' });
  const sessionId = bot.canonicalSessionId;
  const before = store.listMessages(sessionId).length;
  const predJob = createCronJob(host, {
    botId: bot.id,
    name: '谓词预检',
    prompt: '如果有变化就总结',
    cron: '0 9 * * *',
    precheck: { kind: 'predicate', source: '{"wakeAgent":false}' }
  });
  due(host, predJob);
  await tickCronJobs(host);
  assert.deepEqual(runs, []);
  assert.equal(store.listMessages(sessionId).length, before);

  const file = join(dir, 'empty.txt');
  writeFileSync(file, '');
  const fileJob = createCronJob(host, {
    botId: bot.id,
    name: '文件谓词',
    prompt: '读文件',
    cron: '0 9 * * *',
    precheck: { kind: 'predicate', source: `file:${file}` }
  });
  due(host, fileJob);
  await tickCronJobs(host);
  assert.deepEqual(runs, []);

  const scriptJob = createCronJob(host, {
    botId: bot.id,
    name: '脚本预检',
    prompt: '跑模型',
    cron: '0 9 * * *',
    precheck: { kind: 'script', source: `printf '%s\\n' '{"wakeAgent": false}'` }
  });
  due(host, scriptJob);
  await tickCronJobs(host);
  assert.deepEqual(runs, []);
  assert.equal(store.listMessages(sessionId).length, before);
  store.db.close();
});

test('预检要求唤醒、没有预检、或没有明确拒绝时仍开始模型回合 [AC:bot-gateway-delivery#AC-7]', async () => {
  const { store, host, runs } = tempHost();
  const bot = createBot(host, { name: 'Awake' });
  const plain = createCronJob(host, {
    botId: bot.id,
    name: '无预检',
    prompt: '直接跑',
    cron: '0 9 * * *'
  });
  due(host, plain);
  await tickCronJobs(host);
  assert.equal(runs.length, 1);

  const wake = createCronJob(host, {
    botId: bot.id,
    name: '唤醒',
    prompt: '有变化',
    cron: '0 9 * * *',
    precheck: { kind: 'predicate', source: '{"wakeAgent": true}' }
  });
  due(host, wake);
  await tickCronJobs(host);

  const fuzzy = createCronJob(host, {
    botId: bot.id,
    name: '非严格假',
    prompt: '仍要跑',
    cron: '0 9 * * *',
    precheck: { kind: 'predicate', source: '{"wakeAgent": 0}' }
  });
  due(host, fuzzy);
  await tickCronJobs(host);

  const textScript = createCronJob(host, {
    botId: bot.id,
    name: '纯文本脚本',
    prompt: '脚本没拒绝',
    cron: '0 9 * * *',
    precheck: { kind: 'script', source: `printf '%s\\n' hello` }
  });
  due(host, textScript);
  await tickCronJobs(host);

  assert.equal(runs.length, 4);
  assert.ok(store.listMessages(bot.canonicalSessionId).some((m) => m.role === 'user' && JSON.stringify(m).includes('直接跑')));
  store.db.close();
});

test('预检保存在例行任务上，重新读取后下次触发仍生效 [AC:bot-gateway-delivery#AC-8]', async () => {
  const { dir, store, host, runs } = tempHost();
  const bot = createBot(host, { name: 'Saved' });
  const job = createCronJob(host, {
    botId: bot.id,
    name: '晨报',
    prompt: '总结',
    cron: '15 8 * * *',
    precheck: { kind: 'script', source: 'printf skip' }
  });

  const listed = listCronJobs(
    { ...host, cronStore: undefined },
    { botId: bot.id }
  );
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].metadata.precheck, { kind: 'script', source: 'printf skip' });

  const updated = updateCronJob(host, job.id, {
    precheck: { kind: 'predicate', source: '{"wakeAgent":false}' }
  });
  assert.equal(updated.metadata.precheck.kind, 'predicate');
  assert.equal(updated.metadata.botId, bot.id);

  const reread = new CronJobStore(dir).get(job.id);
  assert.equal(reread.metadata.precheck.source, '{"wakeAgent":false}');

  host.cronStore.update(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  const before = runs.length;
  await tickCronJobs(host);
  assert.equal(runs.length, before);

  updateCronJob(host, job.id, { precheck: { kind: 'predicate', source: '{"wakeAgent":true}' } });
  host.cronStore.update(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  await tickCronJobs(host);
  assert.equal(runs.length, before + 1);

  const cleared = updateCronJob(host, job.id, { precheck: null });
  assert.equal(cleared.metadata.precheck, undefined);
  assert.equal(process.env.RAW_AGENT_ROUTINE_PRECHECK, undefined);
  store.db.close();
});
