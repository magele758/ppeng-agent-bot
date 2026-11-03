import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot, openBot } from '../dist/bots/bot-facade.js';
import { resolveBotPrincipal, dispatchBotTask, tickBotWork, listBotTasks } from '../dist/bots/bot-work.js';
import { createToolServices } from '../dist/runtime/tool-services.js';
import { DurableWaitStore } from '../dist/waits/index.js';
import { activeWaitOwner } from '../dist/waits/tool.js';

const log = { warn() {}, info() {}, debug() {}, error() {} };

function messagesText(store, sessionId) {
  return store.listMessages(sessionId).flatMap((message) => message.parts.map((part) => part.type === 'text' ? part.text : '')).join('\n');
}

function openStore(dir) {
  return new SqliteStateStore(join(dir, 'state.db'));
}

function hostFor(store, runSession) {
  return {
    store,
    log,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {},
    runSession,
  };
}

function servicesFor(store, dir) {
  return createToolServices({
    store,
    stateDir: dir,
    resolveSkillLoad: async () => ({}),
    resolveSkillSearch: async () => ({ content: '' }),
    unblockDependentTasks: async () => {},
    spawnSubagent: async () => '',
    spawnTeammate: async () => '',
    startBackgroundJob: async (sessionId, command) => store.createBackgroundJob({ sessionId, command, status: 'running' }),
  });
}

function scenario(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-work-wait-'));
  let store = openStore(dir);
  t.after(() => {
    try { store.db.close(); } catch { /* already closed on reopen */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    get store() { return store; },
    reopen() {
      store.db.close();
      store = openStore(dir);
      return store;
    },
  };
}

function taskByInput(store, principal, input) {
  return listBotTasks(store, principal).find((item) => item.input === input);
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function dispatch(host, principal, input) {
  const boss = createBot(host, { name: 'Boss ' + input });
  const worker = createBot(host, { name: 'Worker ' + input });
  return dispatchBotTask(host, { principal, requesterBotId: boss.id, targetBotId: worker.id, input });
}

function endTurnOnBackground(store, id) {
  const session = store.getSession(id);
  store.updateSession(id, {
    status: 'idle',
    metadata: { ...session.metadata, outcome: { kind: 'idle', reason: 'stop_at:bg_run' } },
  });
  store.appendMessage(id, 'assistant', [{ type: 'text', text: 'background command started' }]);
  return store.getSession(id);
}

test('bot task parks its background command and stays unfinished when the turn ends [AC:bot-work-durable-wait#AC-1]', async (t) => {
  const fx = scenario(t);
  const services = servicesFor(fx.store, fx.dir);
  let sessionId;
  let parked;
  let ran = 0;
  const host = hostFor(fx.store, async (id) => {
    ran += 1;
    sessionId = id;
    parked = await services.startBackgroundJob(id, 'sleep 30');
    return endTurnOnBackground(fx.store, id);
  });
  const principal = resolveBotPrincipal(fx.store);
  await dispatch(host, principal, 'Run the owned background command');
  await tickBotWork(host);
  await settle();
  const task = taskByInput(fx.store, principal, 'Run the owned background command');
  const wait = new DurableWaitStore(fx.store).get(parked.waitId);
  assert.equal(ran, 1);
  assert.equal(fx.store.getSession(sessionId).status, 'idle');
  assert.equal(parked.hostParked, true);
  assert.equal(parked.waitFor.source, 'background_job');
  assert.equal(parked.waitFor.ref, parked.id);
  assert.equal(wait.hostRegistered, true);
  assert.equal(wait.status, 'waiting');
  assert.equal(wait.owner.kind, 'bot_work');
  assert.equal(wait.owner.id, task.id);
  assert.equal(wait.owner.revision, 1);
  assert.equal(task.attempt, 1);
  assert.equal(task.status, 'running');
});

test('a restarted process does not call the model while the command is still running [AC:bot-work-durable-wait#AC-2]', async (t) => {
  const fx = scenario(t);
  const services = servicesFor(fx.store, fx.dir);
  let sessionId;
  let parked;
  const host = hostFor(fx.store, async (id) => {
    sessionId = id;
    parked = await services.startBackgroundJob(id, 'sleep 30');
    return endTurnOnBackground(fx.store, id);
  });
  const principal = resolveBotPrincipal(fx.store);
  await dispatch(host, principal, 'Keep the command running');
  await tickBotWork(host);
  await settle();
  const waitId = parked.waitId;
  const reopened = fx.reopen();
  let calls = 0;
  await tickBotWork(hostFor(reopened, async () => { calls += 1; }));
  assert.equal(calls, 0);
  assert.equal(taskByInput(reopened, principal, 'Keep the command running').status, 'running');
  assert.equal(new DurableWaitStore(reopened).get(waitId).status, 'waiting');
  assert.equal(reopened.getBackgroundJob(parked.id).status, 'running');
  assert.equal(reopened.getSession(sessionId).status, 'idle');
});

test('a finished command resumes the same task once and a second tick does not [AC:bot-work-durable-wait#AC-3]', async (t) => {
  const fx = scenario(t);
  const services = servicesFor(fx.store, fx.dir);
  let sessionId;
  let parked;
  const host = hostFor(fx.store, async (id) => {
    sessionId = id;
    parked = await services.startBackgroundJob(id, 'sleep 30');
    return endTurnOnBackground(fx.store, id);
  });
  const principal = resolveBotPrincipal(fx.store);
  await dispatch(host, principal, 'Resume when the command ends');
  await tickBotWork(host);
  await settle();
  const reopened = fx.reopen();
  reopened.updateBackgroundJob(parked.id, 'completed', 'command finished');
  let calls = 0;
  let saw = '';
  const restarted = hostFor(reopened, async (id) => {
    if (id !== sessionId) return reopened.getSession(id);
    calls += 1;
    saw = messagesText(reopened, id);
    const session = reopened.getSession(id);
    reopened.updateSession(id, {
      status: 'idle',
      metadata: { ...session.metadata, outcome: { kind: 'idle', reason: 'end' } },
    });
    reopened.appendMessage(id, 'assistant', [{ type: 'text', text: 'continued after the command' }]);
    return reopened.getSession(id);
  });
  await tickBotWork(restarted);
  assert.equal(calls, 1);
  assert.match(saw, /\[wait resumed\]/);
  assert.match(saw, new RegExp(parked.id));
  assert.match(saw, /"status":"completed"/);
  assert.equal(new DurableWaitStore(reopened).get(parked.waitId).status, 'consumed');
  await tickBotWork(restarted);
  await settle();
  assert.equal(calls, 1);
  assert.equal(new DurableWaitStore(reopened).get(parked.waitId).status, 'consumed');
  assert.equal(reopened.getSession(sessionId).metadata.botWorkDurableWait, undefined);
});

test('another bot session, a bad condition, and a missing observation do not resume the task [AC:bot-work-durable-wait#AC-4]', async (t) => {
  const fx = scenario(t);
  const services = servicesFor(fx.store, fx.dir);
  let parked;
  let sessionId;
  const principal = resolveBotPrincipal(fx.store);
  const other = createBot(hostFor(fx.store, async () => {}), { name: 'Other' });
  const otherChat = openBot(hostFor(fx.store, async () => {}), other.id, principal);
  const host = hostFor(fx.store, async (id) => {
    sessionId = id;
    const owner = activeWaitOwner(fx.store, fx.store.getSession(id));
    assert.equal(owner.kind, 'bot_work');
    assert.throws(
      () => new DurableWaitStore(fx.store).register(owner, {
        source: 'session',
        ref: otherChat.sessionId,
        condition: { op: 'in', field: 'status', values: ['completed', 'failed', 'cancelled'] },
      }),
      /Resource is not authorized for this execution/
    );
    assert.throws(
      () => new DurableWaitStore(fx.store).register(owner, {
        source: 'background_job',
        ref: 'not-a-job',
        condition: { op: 'nope' },
      }),
      /Invalid condition/
    );
    parked = await services.startBackgroundJob(id, 'sleep 30');
    return endTurnOnBackground(fx.store, id);
  });
  await dispatch(host, principal, 'Reject a foreign wait');
  await tickBotWork(host);
  await settle();
  assert.equal(taskByInput(fx.store, principal, 'Reject a foreign wait').status, 'running');
  const reopened = fx.reopen();
  reopened.db.prepare('DELETE FROM background_jobs WHERE id=?').run(parked.id);
  let calls = 0;
  const restarted = hostFor(reopened, async () => { calls += 1; });
  await tickBotWork(restarted);
  await settle();
  await tickBotWork(restarted);
  await settle();
  assert.equal(calls, 0);
  assert.equal(taskByInput(reopened, principal, 'Reject a foreign wait').status, 'running');
  const wait = new DurableWaitStore(reopened).get(parked.waitId);
  assert.equal(wait.status, 'waiting');
  assert.equal(wait.reason, 'Background job record is missing; reconcile before continuing');
  assert.equal(reopened.getSession(sessionId).status, 'idle');
});
