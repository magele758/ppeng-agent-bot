import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { SqliteStateStore } from '../dist/storage.js';
import { DurableWaitStore } from '../dist/waits/index.js';
import { backgroundJobWaitSource, parkBackgroundDurableWait } from '../dist/waits/background-source.js';
import { activeWaitOwner } from '../dist/waits/tool.js';
import { BotGoalService } from '../dist/bots/goals/service.js';

const INTERRUPTED = 'Process interrupted; command was not restarted. Verify effects before retrying.';

const modelAdapter = {
  name: 'restart-test',
  async runTurn() {
    return { stopReason: 'end', assistantParts: [] };
  },
  async summarizeMessages() {
    return '';
  },
  async completeText() {
    return '';
  }
};

function openStore(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'bg-restart-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'bg-restart-repo-'));
  const store = new SqliteStateStore(join(stateDir, 'runtime.sqlite'));
  let released = false;
  function releaseStore() {
    if (released) return;
    released = true;
    store.db.close();
  }
  t.after(() => {
    releaseStore();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });
  return { stateDir, repoRoot, store, releaseStore };
}

function boot(stateDir, repoRoot) {
  return new RawAgentRuntime({ repoRoot, stateDir, modelAdapter });
}

function runningJob(store, command) {
  const session = store.createSession({
    title: 'bg',
    mode: 'chat',
    agentId: 'general',
    metadata: { userId: 'alice' }
  });
  const job = store.createBackgroundJob({ sessionId: session.id, command, status: 'running' });
  return { session, job };
}

test('启动恢复把无人执行的后台命令标成中断且不另开一条 [AC:background-job-restart#AC-1]', async (t) => {
  const { stateDir, repoRoot, store, releaseStore } = openStore(t);
  const { job } = runningJob(store, 'echo once');
  const before = store.listBackgroundJobs();
  assert.equal(before.length, 1);
  assert.equal(before[0].status, 'running');
  releaseStore();
  const runtime = boot(stateDir, repoRoot);
  t.after(() => runtime.destroy());
  assert.equal(runtime.isBackgroundJobRunning(job.id), false);
  const jobs = runtime.store.listBackgroundJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, job.id);
  assert.equal(jobs[0].command, 'echo once');
  assert.equal(jobs[0].status, 'error');
  assert.equal(jobs[0].result, INTERRUPTED);
});

test('同一次清扫保留本进程正在执行的后台命令 [AC:background-job-restart#AC-2]', async (t) => {
  const { stateDir, repoRoot, releaseStore } = openStore(t);
  releaseStore();
  const runtime = boot(stateDir, repoRoot);
  t.after(() => runtime.destroy());
  const { job: live } = runningJob(runtime.store, 'echo live');
  const { job: orphan } = runningJob(runtime.store, 'echo orphan');
  const controller = new AbortController();
  runtime.backgroundJobAborts.set(live.id, controller);
  assert.equal(runtime.isBackgroundJobRunning(live.id), true);
  assert.equal(runtime.isBackgroundJobRunning(orphan.id), false);
  await runtime.runScheduler();
  const kept = runtime.store.getBackgroundJob(live.id);
  const swept = runtime.store.getBackgroundJob(orphan.id);
  assert.equal(kept.status, 'running');
  assert.equal(kept.command, 'echo live');
  assert.equal(kept.result, undefined);
  assert.equal(runtime.isBackgroundJobRunning(live.id), true);
  assert.equal(swept.status, 'error');
  assert.equal(swept.result, INTERRUPTED);
  assert.equal(runtime.store.listBackgroundJobs().length, 2);
});

test('再次清扫不改已中断的记录也不启动命令 [AC:background-job-restart#AC-3]', async (t) => {
  const { stateDir, repoRoot, store, releaseStore } = openStore(t);
  const { job } = runningJob(store, 'echo interrupted');
  releaseStore();
  const runtime = boot(stateDir, repoRoot);
  t.after(() => runtime.destroy());
  const first = runtime.store.getBackgroundJob(job.id);
  assert.equal(first.status, 'error');
  assert.equal(first.result, INTERRUPTED);
  await runtime.runScheduler();
  const second = runtime.store.getBackgroundJob(job.id);
  assert.deepEqual(second, first);
  assert.equal(runtime.store.listBackgroundJobs().length, 1);
  assert.equal(second.command, 'echo interrupted');
  assert.notEqual(second.status, 'running');
});

function ownedRunningJob(store) {
  const parent = store.createSession({
    title: 'scope',
    mode: 'chat',
    agentId: 'general',
    metadata: { userId: 'alice', botId: 'b', canonicalBotChat: true }
  });
  const service = new BotGoalService(store, Date.now, parent.id);
  const goal = service.create({
    botId: 'b',
    sessionId: parent.id,
    title: 'Run job',
    objective: 'finish background work'
  });
  const ex = service.claim('b', goal.id, { strategy: 'direct' });
  service.updateExecution('b', ex.id, { sessionId: parent.id });
  store.updateSession(parent.id, {
    metadata: {
      ...store.getSession(parent.id).metadata,
      botGoalId: goal.id,
      botGoalExecutionId: ex.id,
      botGoalScopeSessionId: parent.id
    }
  });
  const session = store.getSession(parent.id);
  const owner = activeWaitOwner(store, session);
  const job = store.createBackgroundJob({ sessionId: parent.id, command: 'echo waited', status: 'running' });
  const parked = parkBackgroundDurableWait(store, parent.id, job, 'wait for background command');
  return { session, owner, job, parked };
}

test('中断后的后台命令让所属等待观察到失败并可继续 [AC:background-job-restart#AC-4]', async (t) => {
  const { stateDir, repoRoot, store, releaseStore } = openStore(t);
  const { session, owner, job, parked } = ownedRunningJob(store);
  assert.ok(owner);
  assert.ok(parked);
  const waiting = backgroundJobWaitSource.observe({ store, owner, session, scope: session }, job.id);
  assert.equal(waiting.availability, 'available');
  assert.equal(waiting.facts.status, 'running');
  const waitBefore = new DurableWaitStore(store).check(parked.waitId);
  assert.equal(waitBefore.status, 'waiting');
  releaseStore();
  const runtime = boot(stateDir, repoRoot);
  t.after(() => runtime.destroy());
  const liveSession = runtime.store.getSession(session.id);
  const liveOwner = activeWaitOwner(runtime.store, liveSession);
  assert.ok(liveOwner);
  const observed = backgroundJobWaitSource.observe(
    { store: runtime.store, owner: liveOwner, session: liveSession, scope: liveSession },
    job.id
  );
  assert.equal(observed.availability, 'available');
  assert.equal(observed.facts.status, 'failed');
  const ready = new DurableWaitStore(runtime.store).check(parked.waitId);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.observation.facts.status, 'failed');
});
