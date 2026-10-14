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
import { RoutineRunStore } from '../dist/cron/routine-runtime.js';
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
  assert.equal(store.listMessages(sessionId).filter(m=>m.role==='user').length, before);
  assert.ok(store.listMessages(sessionId).every(m=>m.role==='assistant'));

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
  assert.equal(store.listMessages(sessionId).filter(m=>m.role==='user').length, before);
  assert.ok(store.listMessages(sessionId).every(m=>m.role==='assistant'));
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
  assert.ok(runs.every(id=>id!==bot.canonicalSessionId));
  assert.ok(store.listMessages(runs[0]).some((m) => m.role === 'user' && JSON.stringify(m).includes('直接跑')));
  assert.ok(!store.listMessages(bot.canonicalSessionId).some(m=>m.role==='user'));
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

test('预检失败、非零退出或抛错时不开始模型回合 [AC:routine-precheck-fail-closed#AC-1]', async () => {
  const claimedWake = await evaluateRoutinePrecheck(
    { kind: 'script', source: `printf '%s\\n' '{"wakeAgent":true}'; exit 4` },
    { cwd: tmpdir() }
  );
  assert.equal(claimedWake.wakeAgent, false);

  const crashed = await evaluateRoutinePrecheck(
    { kind: 'script', source: 'exit 7' },
    { cwd: tmpdir() }
  );
  assert.equal(crashed.wakeAgent, false);

  const thrown = await evaluateRoutinePrecheck(
    { kind: 'script', source: 'printf hi' },
    { cwd: join(tmpdir(), `missing-precheck-cwd-${Date.now()}`) }
  );
  assert.equal(thrown.wakeAgent, false);

  const timedOut = await evaluateRoutinePrecheck(
    { kind: 'script', source: 'sleep 30' },
    { cwd: tmpdir() }
  );
  assert.equal(timedOut.wakeAgent, false);

  const { store, host, runs } = tempHost();
  const bot = createBot(host, { name: 'Fail closed' });
  const job = createCronJob(host, {
    botId: bot.id,
    name: '失败预检',
    prompt: '不要跑模型',
    cron: '0 9 * * *',
    precheck: { kind: 'script', source: 'exit 9' }
  });
  due(host, job);
  await tickCronJobs(host);
  assert.deepEqual(runs, []);
  assert.equal(new RoutineRunStore(store).list(job.id)[0].status, 'skipped');
  store.db.close();
});

test('预检输出不唤醒时，即使退出码非零也不开始模型回合 [AC:routine-precheck-fail-closed#AC-2]', async () => {
  const gate = await evaluateRoutinePrecheck(
    { kind: 'script', source: `printf '%s\\n' 'noise' '{"wakeAgent":false}'; exit 3` },
    { cwd: tmpdir() }
  );
  assert.equal(gate.wakeAgent, false);

  const { store, host, runs } = tempHost();
  const bot = createBot(host, { name: 'Suppress' });
  const job = createCronJob(host, {
    botId: bot.id,
    name: '非零仍不唤醒',
    prompt: '不要跑模型',
    cron: '0 9 * * *',
    precheck: { kind: 'script', source: `printf '%s\\n' '{"wakeAgent":false}'; exit 3` }
  });
  due(host, job);
  await tickCronJobs(host);
  assert.deepEqual(runs, []);
  assert.equal(new RoutineRunStore(store).list(job.id)[0].status, 'skipped');
  store.db.close();
});

test('预检脚本看不到守护进程环境，也不能访问公网 [AC:routine-precheck-fail-closed#AC-3]', async () => {
  const secret = `precheck-secret-${Date.now()}`;
  const names = ['RAW_AGENT_API_KEY', 'RAW_AGENT_AUTH_TOKEN', 'GITHUB_TOKEN'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = secret;
  const dir = mkdtempSync(join(tmpdir(), 'precheck-env-'));
  const file = join(dir, 'event.json');
  writeFileSync(file, 'visible-event');
  writeFileSync(join(dir, 'probe.mjs'), `import fs from 'node:fs';
import net from 'node:net';
const secret = ${JSON.stringify(secret)};
const leak = Object.entries(process.env).some(([k,v]) => k === 'RAW_AGENT_API_KEY' || k === 'RAW_AGENT_AUTH_TOKEN' || k === 'GITHUB_TOKEN' || String(v).includes(secret));
let fileOk = false;
try { fileOk = fs.readFileSync(process.env.PPENG_EVENT_FILE, 'utf8').includes('visible-event'); } catch {}
const s = net.connect({ host: '1.1.1.1', port: 443 });
const finish = (wake) => { console.log(JSON.stringify({ wakeAgent: wake })); process.exit(0); };
s.on('connect', () => { s.end(); finish(true); });
s.on('error', () => finish(leak || !fileOk));
s.setTimeout(800, () => { s.destroy(); finish(leak || !fileOk); });
`);
  try {
    const result = await evaluateRoutinePrecheck(
      { kind: 'script', source: 'node probe.mjs' },
      { cwd: dir, env: { PPENG_EVENT_FILE: file }, denyEnv: ['RAW_AGENT_API_KEY'] }
    );
    assert.equal(result.reason, undefined);
    assert.equal(result.wakeAgent, false);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('预检正常结束且没有明确拒绝时仍开始模型回合 [AC:routine-precheck-fail-closed#AC-4]', async () => {
  const gate = await evaluateRoutinePrecheck(
    { kind: 'script', source: `printf '%s\\n' hello` },
    { cwd: tmpdir() }
  );
  assert.equal(gate.wakeAgent, true);

  const { store, host, runs } = tempHost();
  const bot = createBot(host, { name: 'Still wake' });
  const job = createCronJob(host, {
    botId: bot.id,
    name: '纯文本仍唤醒',
    prompt: '要跑',
    cron: '0 9 * * *',
    precheck: { kind: 'script', source: `printf '%s\\n' hello` }
  });
  due(host, job);
  await tickCronJobs(host);
  assert.equal(runs.length, 1);
  assert.equal(new RoutineRunStore(store).list(job.id)[0].status === 'skipped', false);
  store.db.close();
});
