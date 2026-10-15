import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { cancelAllSessions, cancelSession } from '../dist/runtime/session-control.js';
import { RawAgentRuntime } from '../dist/runtime.js';

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-all-'));
  return new SqliteStateStore(join(dir, 'state.db'));
}

function session(store, title) {
  return store.createSession({ title, mode: 'chat', agentId: 'general' });
}

test('cancelAllSessions aborts two running sessions and leaves the store open', () => {
  const store = openStore();
  try {
    const first = session(store, 'one');
    const second = session(store, 'two');
    const idle = session(store, 'idle');
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const alreadyStopped = new AbortController();
    alreadyStopped.abort();
    const firstJob = new AbortController();
    const orphanJob = new AbortController();
    const firstJobRow = store.createBackgroundJob({
      sessionId: first.id,
      command: 'sleep 30',
      status: 'running'
    });
    const host = {
      store,
      sessionAbortControllers: new Map([
        [first.id, firstAbort],
        [second.id, secondAbort],
        [idle.id, alreadyStopped]
      ]),
      backgroundJobAborts: new Map([
        [firstJobRow.id, firstJob],
        ['bg-orphan', orphanJob]
      ]),
      emitTrace() {}
    };

    const result = cancelAllSessions(host);

    assert.deepEqual(new Set(result.sessionIds), new Set([first.id, second.id]));
    assert.equal(firstAbort.signal.aborted, true);
    assert.equal(secondAbort.signal.aborted, true);
    assert.equal(firstJob.signal.aborted, true);
    assert.equal(orphanJob.signal.aborted, true);
    assert.equal(host.backgroundJobAborts.size, 0);
    assert.equal(host.sessionAbortControllers.size, 3);
    assert.equal(store.getSession(first.id)?.title, 'one');
    assert.equal(store.getSession(second.id)?.title, 'two');
    assert.equal(store.listSessions().length, 3);
  } finally {
    store.db.close();
  }
});

test('cancelAllSessions skips sessions the caller cannot access', () => {
  const store = openStore();
  try {
    const owned = session(store, 'owned');
    const other = session(store, 'other');
    const ownedAbort = new AbortController();
    const otherAbort = new AbortController();
    const otherJob = new AbortController();
    const otherJobRow = store.createBackgroundJob({
      sessionId: other.id,
      command: 'sleep 30',
      status: 'running'
    });
    const host = {
      store,
      sessionAbortControllers: new Map([
        [owned.id, ownedAbort],
        [other.id, otherAbort]
      ]),
      backgroundJobAborts: new Map([[otherJobRow.id, otherJob]]),
      emitTrace() {}
    };

    const result = cancelAllSessions(host, new Set([owned.id]));

    assert.deepEqual(result.sessionIds, [owned.id]);
    assert.equal(ownedAbort.signal.aborted, true);
    assert.equal(otherAbort.signal.aborted, false);
    assert.equal(otherJob.signal.aborted, false);
    assert.equal(store.getSession(owned.id)?.id, owned.id);
    assert.equal(store.getSession(other.id)?.id, other.id);
  } finally {
    store.db.close();
  }
});

test('runtime cancelAllSessions aborts two in-flight runs and still reads sessions', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cancel-all-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'cancel-all-state-'));
  let started = 0;
  let markStarted = () => {};
  const bothStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const adapter = {
    name: 'hold',
    async runTurn(input) {
      started += 1;
      if (started >= 2) markStarted();
      await new Promise((resolve) => {
        if (!input.signal) return;
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'stopped' }] };
    },
    async summarizeMessages() {
      return '';
    }
  };
  const runtime = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });
  try {
    const first = runtime.createChatSession({ title: 'run-one' });
    const second = runtime.createChatSession({ title: 'run-two' });
    const runs = Promise.all([runtime.runSession(first.id), runtime.runSession(second.id)]);
    await Promise.race([
      bothStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('runs did not start')), 8000))
    ]);
    const result = runtime.cancelAllSessions();
    assert.deepEqual(new Set(result.sessionIds), new Set([first.id, second.id]));
    await Promise.race([
      runs,
      new Promise((_, reject) => setTimeout(() => reject(new Error('runs did not finish')), 8000))
    ]);
    assert.equal(runtime.getSession(first.id)?.title, 'run-one');
    assert.equal(runtime.getSession(second.id)?.title, 'run-two');
  } finally {
    await runtime.destroy();
  }
});

test('cancelSession releases a parked approval and leaves other statuses abort-only', () => {
  const store = openStore();
  try {
    const parked = session(store, 'parked');
    store.updateSession(parked.id, {
      status: 'waiting_approval',
      metadata: {
        interrupt: {
          kind: 'waiting_approval',
          toolCallIds: ['c1'],
          approvalIds: ['a1'],
          executedToolCallIds: [],
          stepCursor: 'tools'
        }
      }
    });
    const approval = store.createApproval({
      sessionId: parked.id,
      toolName: 'bash',
      reason: 'ask',
      args: { command: 'true' }
    });
    const running = session(store, 'running');
    store.updateSession(running.id, { status: 'running' });
    const host = {
      store,
      sessionAbortControllers: new Map(),
      backgroundJobAborts: new Map(),
      emitTrace() {}
    };
    cancelSession(host, parked.id);
    cancelSession(host, running.id);
    assert.equal(store.getSession(parked.id)?.status, 'idle');
    assert.equal(store.getSession(parked.id)?.metadata?.interrupt, undefined);
    assert.equal(store.getApproval(approval.id)?.status, 'rejected');
    assert.equal(store.getSession(running.id)?.status, 'running');
    assert.equal(store.getSession(running.id)?.metadata?.outcome?.kind, 'aborted');
  } finally {
    store.db.close();
  }
});
