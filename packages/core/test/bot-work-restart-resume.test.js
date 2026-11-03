import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { saveStepCheckpoint } from '../dist/session/checkpoint.js';
import { createBot } from '../dist/bots/bot-facade.js';
import { dispatchBotTask, listBotTasks, recoverBotWork, retryBotTask, tickBotWork, resolveBotPrincipal } from '../dist/bots/bot-work.js';

const FORBID = 'Do not resume';

function harness(name) {
  const dir = mkdtempSync(join(tmpdir(), `bot-restart-${name}-`));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const runs = [];
  const host = {
    store,
    runs,
    log: { warn() {}, info() {}, debug() {}, error() {} },
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {},
    runSession: async (id) => {
      runs.push(id);
      store.appendMessage(id, 'assistant', [{ type: 'text', text: 'noted' }]);
      return store.getSession(id);
    },
  };
  const principal = resolveBotPrincipal(store);
  const sender = createBot(host, { name: `${name}-sender` });
  const worker = createBot(host, { name: `${name}-worker` });
  return {
    dir, store, host, runs, principal, sender, worker,
    close() {
      try { store.db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function forbidText(store, sessionId) {
  return store.listMessages(sessionId).some(message => JSON.stringify(message.parts).includes(FORBID));
}

async function hangTask(env, input, during) {
  let started;
  let tailError;
  const startedDone = new Promise(resolve => { started = resolve; });
  env.host.runSession = async (id) => {
    if (id !== env.worker.canonicalSessionId) {
      env.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'noted' }]);
      return env.store.getSession(id);
    }
    env.runs.push(id);
    try { if (during) during(id); }
    catch (error) { tailError = error; }
    finally { started(); }
    return new Promise(() => {});
  };
  const task = dispatchBotTask(env.host, {
    principal: env.principal,
    requesterBotId: env.sender.id,
    targetBotId: env.worker.id,
    input,
  });
  await tickBotWork(env.host);
  await startedDone;
  if (tailError) throw tailError;
  return task;
}

function reopen(env) {
  const next = new SqliteStateStore(env.store.dbPath);
  return next;
}

test('safe checkpoint resumes once and keeps the transcript [AC:bot-work-restart-resume#AC-1]', async () => {
  const env = harness('safe');
  const resumed = [];
  let releaseRun;
  try {
    const task = await hangTask(env, 'continue from checkpoint', (id) => {
      const saved = saveStepCheckpoint(env.store, id, { label: 'read complete' });
      assert.equal(saved.ok, true);
      env.store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'read-1', name: 'read_file', input: { path: 'notes.txt' } }]);
      env.store.appendMessage(id, 'tool', [{ type: 'tool_result', toolCallId: 'read-1', name: 'read_file', ok: true, content: 'safe-reader-body' }]);
    });
    const sessionId = env.worker.canonicalSessionId;
    const departed = new SqliteStateStore(env.store.dbPath);
    departed.claimWriter(sessionId, 'dead-writer');
    departed.db.close();
    const store = reopen(env);
    try {
      recoverBotWork(store);
      const afterBoot = listBotTasks(store, env.principal).find(item => item.id === task.id);
      assert.equal(afterBoot.status, 'running');
      assert.equal(store.getSession(sessionId).metadata.botWorkRestartEffectCheck, true);
      assert.equal(store.getSession(sessionId).activeWriterRunId, undefined);
      assert.equal(forbidText(store, sessionId), false);
      assert.match(JSON.stringify(store.foldMessages(sessionId)), /safe-reader-body/);
      assert.match(JSON.stringify(store.foldMessages(sessionId)), /continue from checkpoint/);
      const host = {
        store,
        log: env.host.log,
        hasUnconfirmedEffects: () => false,
        runSession: (id) => {
          resumed.push(id);
          return new Promise(resolve => { releaseRun = resolve; });
        },
      };
      await tickBotWork(host);
      assert.deepEqual(resumed, [sessionId]);
      assert.equal(listBotTasks(store, env.principal).find(item => item.id === task.id).status, 'running');
      assert.equal(forbidText(store, sessionId), false);
      assert.match(JSON.stringify(store.foldMessages(sessionId)), /safe-reader-body/);
      await tickBotWork(host);
      assert.deepEqual(resumed, [sessionId]);
    } finally {
      releaseRun?.();
      store.db.close();
    }
  } finally {
    env.close();
  }
});

test('unsafe or unconfirmed work stays unknown until a person confirms [AC:bot-work-restart-resume#AC-2]', async () => {
  const cases = [
    { name: 'missing', tail: () => {} },
    { name: 'not-retained', tail: (store, id) => {
      const saved = saveStepCheckpoint(store, id, { label: 'gone' });
      assert.equal(saved.ok, true);
      const session = store.getSession(id);
      store.updateSession(id, { metadata: { ...session.metadata, stepCheckpoints: [{ ...saved.checkpoint, seq: saved.checkpoint.seq + 1000 }] } });
    } },
    { name: 'open-tool', tail: (store, id) => {
      assert.equal(saveStepCheckpoint(store, id, { label: 'before read' }).ok, true);
      store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'open-1', name: 'read_file', input: { path: 'a' } }]);
    } },
    { name: 'writer-tool', tail: (store, id) => {
      assert.equal(saveStepCheckpoint(store, id, { label: 'before write' }).ok, true);
      store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'bash-1', name: 'bash', input: { command: 'echo hi' } }]);
      store.appendMessage(id, 'tool', [{ type: 'tool_result', toolCallId: 'bash-1', name: 'bash', ok: true, content: 'hi' }]);
    } },
  ];
  for (const item of cases) {
    const env = harness(item.name);
    try {
      const task = await hangTask(env, `unsafe ${item.name}`, (id) => item.tail(env.store, id));
      const sessionId = env.worker.canonicalSessionId;
      const store = reopen(env);
      try {
        const resumed = [];
        recoverBotWork(store);
        assert.equal(listBotTasks(store, env.principal).find(row => row.id === task.id).status, 'unknown', item.name);
        assert.equal(forbidText(store, sessionId), true, item.name);
        const host = { store, log: env.host.log, hasUnconfirmedEffects: () => false, runSession: async (id) => { resumed.push(id); return store.getSession(id); } };
        await tickBotWork(host);
        assert.deepEqual(resumed, [], item.name);
        assert.throws(() => retryBotTask(host, env.principal, task.id), /Confirm/);
      } finally { store.db.close(); }
    } finally { env.close(); }
  }

  const env = harness('effects');
  try {
    const task = await hangTask(env, 'effect not confirmed', (id) => {
      assert.equal(saveStepCheckpoint(env.store, id, { label: 'closed' }).ok, true);
    });
    const sessionId = env.worker.canonicalSessionId;
    const store = reopen(env);
    try {
      recoverBotWork(store);
      assert.equal(listBotTasks(store, env.principal).find(row => row.id === task.id).status, 'running');
      assert.equal(forbidText(store, sessionId), false);
      const resumed = [];
      const host = { store, log: env.host.log, hasUnconfirmedEffects: () => true, runSession: async (id) => { resumed.push(id); return store.getSession(id); } };
      await tickBotWork(host);
      assert.equal(listBotTasks(store, env.principal).find(row => row.id === task.id).status, 'unknown');
      assert.equal(forbidText(store, sessionId), true);
      assert.deepEqual(resumed, []);
      assert.throws(() => retryBotTask(host, env.principal, task.id), /Confirm/);
      const quiet = { store, log: env.host.log, runSession: async (id) => { resumed.push(id); return store.getSession(id); } };
      await tickBotWork(quiet);
      assert.deepEqual(resumed, []);
    } finally { store.db.close(); }
  } finally { env.close(); }

  const missing = harness('probe-missing');
  try {
    const task = await hangTask(missing, 'probe missing', (id) => {
      assert.equal(saveStepCheckpoint(missing.store, id, { label: 'closed' }).ok, true);
    });
    const sessionId = missing.worker.canonicalSessionId;
    const store = reopen(missing);
    try {
      recoverBotWork(store);
      assert.equal(listBotTasks(store, missing.principal).find(row => row.id === task.id).status, 'running');
      const resumed = [];
      const host = { store, log: missing.host.log, runSession: async (id) => { resumed.push(id); return store.getSession(id); } };
      await tickBotWork(host);
      assert.equal(listBotTasks(store, missing.principal).find(row => row.id === task.id).status, 'unknown');
      assert.equal(forbidText(store, sessionId), true);
      assert.deepEqual(resumed, []);
      assert.throws(() => retryBotTask(host, missing.principal, task.id), /Confirm/);
    } finally { store.db.close(); }
  } finally { missing.close(); }
});

test('approval pause is not retired or restarted [AC:bot-work-restart-resume#AC-3]', async () => {
  const env = harness('approval');
  try {
    env.host.runSession = async (id) => {
      if (id !== env.worker.canonicalSessionId) {
        env.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'noted' }]);
        return env.store.getSession(id);
      }
      env.runs.push(id);
      const session = env.store.getSession(id);
      env.store.updateSession(id, {
        status: 'waiting_approval',
        metadata: { ...session.metadata, outcome: { kind: 'waiting_approval', reason: 'waiting_approval' } },
      });
      return env.store.getSession(id);
    };
    const task = dispatchBotTask(env.host, {
      principal: env.principal,
      requesterBotId: env.sender.id,
      targetBotId: env.worker.id,
      input: 'wait for approval',
    });
    await tickBotWork(env.host);
    await new Promise(resolve => setImmediate(resolve));
    const sessionId = env.worker.canonicalSessionId;
    assert.equal(listBotTasks(env.store, env.principal).find(row => row.id === task.id).status, 'waiting_approval');
    recoverBotWork(env.store);
    assert.equal(listBotTasks(env.store, env.principal).find(row => row.id === task.id).status, 'waiting_approval');
    assert.equal(forbidText(env.store, sessionId), false);
    assert.match(JSON.stringify(env.store.foldMessages(sessionId)), /wait for approval/);
    await tickBotWork(env.host);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(env.runs, [sessionId]);
    assert.equal(listBotTasks(env.store, env.principal).find(row => row.id === task.id).status, 'waiting_approval');
  } finally { env.close(); }
});

test('a durable wait is left for its owner [AC:bot-work-restart-resume#AC-4]', async () => {
  for (const status of ['waiting', 'ready', 'blocked']) {
    const env = harness(status);
    try {
      const task = await hangTask(env, `parked ${status}`, (id) => {
        assert.equal(saveStepCheckpoint(env.store, id, { label: 'parked' }).ok, true);
      });
      const sessionId = env.worker.canonicalSessionId;
      const waitId = `wait-${status}`;
      env.store.db.exec("CREATE TABLE IF NOT EXISTS agent_waits(id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)");
      env.store.db.prepare('INSERT INTO agent_waits(id, owner_key, status, payload) VALUES(?,?,?,?)').run(
        waitId, `owner-${status}`, status, JSON.stringify({ id: waitId, status }));
      const session = env.store.getSession(sessionId);
      env.store.updateSession(sessionId, { metadata: { ...session.metadata, agentWaitId: waitId } });
      const departed = new SqliteStateStore(env.store.dbPath);
      departed.claimWriter(sessionId, `dead-${status}`);
      departed.db.close();
      const store = reopen(env);
      try {
        recoverBotWork(store);
        assert.equal(listBotTasks(store, env.principal).find(row => row.id === task.id).status, 'running', status);
        assert.equal(store.getSession(sessionId).activeWriterRunId, undefined, status);
        assert.equal(forbidText(store, sessionId), false, status);
        assert.match(JSON.stringify(store.foldMessages(sessionId)), new RegExp(`parked ${status}`));
        const resumed = [];
        const host = {
          store,
          log: env.host.log,
          hasUnconfirmedEffects: () => false,
          runSession: async (id) => { resumed.push(id); return store.getSession(id); },
        };
        await tickBotWork(host);
        assert.deepEqual(resumed, [], status);
        assert.equal(listBotTasks(store, env.principal).find(row => row.id === task.id).status, 'running', status);
        assert.equal(forbidText(store, sessionId), false, status);
      } finally { store.db.close(); }
    } finally { env.close(); }
  }
});
