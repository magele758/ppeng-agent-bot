/**
 * Unattended approval fail-safe: cron / bot routine / other wakes expire as deny
 * after 10 minutes. Human-present Lab chat approvals do not.
 */
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { runScheduler, startIdleSessionRun } from '../dist/runtime/scheduler-host.js';
import { decideInterruptResume } from '@ppeng/agent-loop/session';
import {
  APPROVAL_WAKE_KEY,
  UNATTENDED_APPROVAL_EXPIRE_REASON,
  UNATTENDED_APPROVAL_TTL_MS,
  armUnattendedApprovalExpiry,
  disarmAllUnattendedApprovalExpiries,
  expireDueUnattendedApprovals
} from '../dist/approval/unattended-approval.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'unatt-appr-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  store.upsertAgent({
    id: 'general',
    name: 'General',
    role: 'assistant',
    instructions: 'help',
    capabilities: []
  });
  return store;
}

function parkUnattended(store, wake) {
  const session = store.createSession({
    title: 'wake',
    mode: 'chat',
    agentId: 'general',
    metadata: { [APPROVAL_WAKE_KEY]: wake }
  });
  store.appendMessage(session.id, 'assistant', [
    {
      type: 'tool_call',
      toolCallId: 'call_1',
      name: 'bash',
      input: { command: 'rm -rf /tmp/example' }
    }
  ]);
  const approval = store.createApproval({
    sessionId: session.id,
    toolName: 'bash',
    reason: 'Approval required for bash',
    args: { command: 'rm -rf /tmp/example' }
  });
  const current = store.getSession(session.id);
  store.updateSession(session.id, {
    status: 'waiting_approval',
    metadata: {
      ...current.metadata,
      interrupt: {
        kind: 'waiting_approval',
        toolCallIds: ['call_1'],
        approvalIds: [approval.id],
        executedToolCallIds: [],
        stepCursor: 'tools'
      }
    }
  });
  return { sessionId: session.id, approval };
}

function bashResults(store, sessionId) {
  return store
    .foldMessages(sessionId)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'tool_result' && part.name === 'bash');
}

function assertDeniedWithoutRunning(store, sessionId, approvalId) {
  const approval = store.getApproval(approvalId);
  assert.equal(approval.status, 'rejected');
  assert.equal(approval.expireReason, UNATTENDED_APPROVAL_EXPIRE_REASON);
  const results = bashResults(store, sessionId);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].content, UNATTENDED_APPROVAL_EXPIRE_REASON);
  assert.equal(results.some((part) => part.ok === true), false);
  const session = store.getSession(sessionId);
  assert.equal(session.status, 'idle');
  const pending = store
    .listApprovals({ status: 'pending' })
    .filter((item) => item.sessionId === sessionId)
    .map((item) => item.id);
  assert.equal(decideInterruptResume({ session, pendingApprovalIds: pending }).action, 'none');
}

function withFakeClock(fn) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  try {
    return fn();
  } finally {
    disarmAllUnattendedApprovalExpiries();
    mock.timers.reset();
  }
}

describe('unattended approval expiry', { concurrency: false }, () => {
  test('cron wake expires as deny at 10 minutes and a later approve does not run the tool [AC:unattended-approval-expiry#AC-1]', () => {
    assert.equal(UNATTENDED_APPROVAL_TTL_MS, TEN_MINUTES_MS);
    withFakeClock(() => {
      const store = tempStore();
      try {
        const { sessionId, approval } = parkUnattended(store, { kind: 'unattended', source: 'cron' });
        assert.equal(approval.wakeSource, 'cron');
        assert.equal(Date.parse(approval.expiresAt) - Date.now(), TEN_MINUTES_MS);
        armUnattendedApprovalExpiry(approval, () => expireDueUnattendedApprovals(store));

        mock.timers.tick(TEN_MINUTES_MS - 1);
        assert.equal(store.getApproval(approval.id).status, 'pending');
        assert.equal(bashResults(store, sessionId).length, 0);

        mock.timers.tick(1);
        assertDeniedWithoutRunning(store, sessionId, approval.id);

        const late = store.updateApproval(approval.id, 'approved');
        assert.equal(late.status, 'rejected');
        assert.equal(late.expireReason, UNATTENDED_APPROVAL_EXPIRE_REASON);
        assert.equal(bashResults(store, sessionId).some((part) => part.ok === true), false);
      } finally {
        store.db.close();
      }
    });
  });

  test('a scheduler sweep denies a due unattended approval after restart [AC:unattended-approval-expiry#AC-1]', () => {
    withFakeClock(() => {
      const store = tempStore();
      try {
        const { sessionId, approval } = parkUnattended(store, { kind: 'unattended', source: 'cron' });
        mock.timers.tick(TEN_MINUTES_MS);
        const task = runScheduler({
          store,
          selfHeal: {
            processRuns: async () => {
              throw new Error('stop-after-expiry');
            }
          }
        });
        assertDeniedWithoutRunning(store, sessionId, approval.id);
        task.catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes('stop-after-expiry')) throw err;
        });
      } finally {
        store.db.close();
      }
    });
  });

  test('bot routine wake expires as deny without running the tool [AC:unattended-approval-expiry#AC-2]', () => {
    withFakeClock(() => {
      const store = tempStore();
      try {
        const { sessionId, approval } = parkUnattended(store, { kind: 'unattended', source: 'routine' });
        assert.equal(approval.wakeSource, 'routine');
        armUnattendedApprovalExpiry(approval, () => expireDueUnattendedApprovals(store));
        mock.timers.tick(TEN_MINUTES_MS);
        assertDeniedWithoutRunning(store, sessionId, approval.id);
      } finally {
        store.db.close();
      }
    });
  });

  test('other unattended wakes expire as deny without running the tool [AC:unattended-approval-expiry#AC-3]', () => {
    withFakeClock(() => {
      const store = tempStore();
      try {
        for (const source of ['scheduler', 'mailbox', 'message-agent']) {
          const { sessionId, approval } = parkUnattended(store, { kind: 'unattended', source });
          assert.equal(approval.wakeSource, source);
          armUnattendedApprovalExpiry(approval, () => expireDueUnattendedApprovals(store));
          mock.timers.tick(TEN_MINUTES_MS);
          assertDeniedWithoutRunning(store, sessionId, approval.id);
        }
      } finally {
        store.db.close();
      }
    });
  });

  test('a human decision inside 10 minutes is kept [AC:unattended-approval-expiry#AC-4]', () => {
    withFakeClock(() => {
      const store = tempStore();
      try {
        const approved = parkUnattended(store, { kind: 'unattended', source: 'cron' });
        store.updateApproval(approved.approval.id, 'approved');
        armUnattendedApprovalExpiry(approved.approval, () => expireDueUnattendedApprovals(store));
        mock.timers.tick(TEN_MINUTES_MS);
        const kept = store.getApproval(approved.approval.id);
        assert.equal(kept.status, 'approved');
        assert.equal(kept.expireReason, undefined);
        assert.equal(bashResults(store, approved.sessionId).length, 0);

        const rejected = parkUnattended(store, { kind: 'unattended', source: 'routine' });
        store.updateApproval(rejected.approval.id, 'rejected');
        armUnattendedApprovalExpiry(rejected.approval, () => expireDueUnattendedApprovals(store));
        mock.timers.tick(TEN_MINUTES_MS);
        const humanReject = store.getApproval(rejected.approval.id);
        assert.equal(humanReject.status, 'rejected');
        assert.equal(humanReject.expireReason, undefined);
        assert.equal(bashResults(store, rejected.sessionId).length, 0);
      } finally {
        store.db.close();
      }
    });
  });

  test('a human sitting in Lab chat is not expired or auto-run after 10 minutes [AC:unattended-approval-expiry#AC-5]', () => {
    withFakeClock(() => {
      const store = tempStore();
      try {
        const { sessionId, approval } = parkUnattended(store, { kind: 'human', source: 'lab-chat' });
        assert.equal(approval.expiresAt, undefined);
        assert.equal(approval.wakeSource, undefined);
        armUnattendedApprovalExpiry(approval, () => expireDueUnattendedApprovals(store));
        mock.timers.tick(TEN_MINUTES_MS);
        expireDueUnattendedApprovals(store);
        const still = store.getApproval(approval.id);
        assert.equal(still.status, 'pending');
        assert.equal(still.expireReason, undefined);
        assert.equal(bashResults(store, sessionId).length, 0);
        const session = store.getSession(sessionId);
        assert.equal(session.status, 'waiting_approval');
        const pending = store
          .listApprovals({ status: 'pending' })
          .filter((item) => item.sessionId === sessionId)
          .map((item) => item.id);
        assert.equal(decideInterruptResume({ session, pendingApprovalIds: pending }).action, 'yield_waiting');
      } finally {
        store.db.close();
      }
    });
  });
});

class ScriptedAdapter {
  constructor(handler) {
    this.name = 'scripted';
    this.handler = handler;
    this.calls = 0;
  }

  async runTurn(input) {
    this.calls += 1;
    return this.handler(input);
  }

  async summarizeMessages() {
    return 'summary';
  }
}

function runtimeWith(adapter) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'unatt-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'unatt-state-'));
  return new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });
}

function riskyBashTurn() {
  return {
    stopReason: 'tool_use',
    assistantParts: [
      {
        type: 'tool_call',
        toolCallId: 'call_1',
        name: 'bash',
        input: { command: 'rm -rf /tmp/example' }
      }
    ]
  };
}

describe('unattended approval wake wiring', { concurrency: false }, () => {
  test('cron and routine runs stamp a 10 minute deny deadline [AC:unattended-approval-expiry#AC-1] [AC:unattended-approval-expiry#AC-2]', async () => {
    const adapter = new ScriptedAdapter(() => riskyBashTurn());
    const runtime = runtimeWith(adapter);
    try {
      const cronSession = runtime.createChatSession({ title: 'cron', message: 'tick' });
      let cronRun;
      const host = {
        store: runtime.store,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        runSession: (id) => {
          cronRun = runtime.runSession(id);
          return cronRun;
        }
      };
      assert.equal(startIdleSessionRun(host, runtime.getSession(cronSession.id), 'cron:job-1'), true);
      const blocked = await cronRun;
      assert.equal(blocked.status, 'waiting_approval');
      const cronApproval = runtime.listApprovals().find((item) => item.sessionId === cronSession.id);
      assert.equal(cronApproval.wakeSource, 'cron');
      assert.equal(cronApproval.status, 'pending');
      assert.ok(Date.parse(cronApproval.expiresAt) - Date.parse(cronApproval.createdAt) >= TEN_MINUTES_MS - 1000);

      const routineSession = runtime.createChatSession({ title: 'routine', message: 'tick' });
      let routineRun;
      host.runSession = (id) => {
        routineRun = runtime.runSession(id);
        return routineRun;
      };
      assert.equal(
        startIdleSessionRun(host, runtime.getSession(routineSession.id), 'routine:job-2'),
        true
      );
      await routineRun;
      const routineApproval = runtime.listApprovals().find((item) => item.sessionId === routineSession.id);
      assert.equal(routineApproval.wakeSource, 'routine');
      assert.equal(routineApproval.status, 'pending');
    } finally {
      disarmAllUnattendedApprovalExpiries();
      runtime.store.db.close();
    }
  });

  test('a scheduler wake stamps an unattended deadline [AC:unattended-approval-expiry#AC-3]', async () => {
    const adapter = new ScriptedAdapter(() => riskyBashTurn());
    const runtime = runtimeWith(adapter);
    try {
      const session = runtime.createChatSession({ title: 'mail', message: 'tick' });
      runtime.store.enqueueSchedulerWake(session.id, 'mailbox');
      const blocked = await runtime.runSession(session.id);
      assert.equal(blocked.status, 'waiting_approval');
      const approval = runtime.listApprovals().find((item) => item.sessionId === session.id);
      assert.equal(approval.wakeSource, 'mailbox');
      assert.equal(approval.status, 'pending');
      assert.ok(approval.expiresAt);
    } finally {
      disarmAllUnattendedApprovalExpiries();
      runtime.store.db.close();
    }
  });

  test('Lab chat send keeps the approval pending with no deadline [AC:unattended-approval-expiry#AC-5]', async () => {
    const adapter = new ScriptedAdapter(() => riskyBashTurn());
    const runtime = runtimeWith(adapter);
    try {
      const session = runtime.createChatSession({ title: 'lab' });
      runtime.sendUserMessage(session.id, 'please run the risky command');
      const blocked = await runtime.runSession(session.id);
      assert.equal(blocked.status, 'waiting_approval');
      const approval = runtime.listApprovals().find((item) => item.sessionId === session.id);
      assert.equal(approval.status, 'pending');
      assert.equal(approval.expiresAt, undefined);
      assert.equal(approval.wakeSource, undefined);
      assert.equal(bashResults(runtime.store, session.id).length, 0);
    } finally {
      disarmAllUnattendedApprovalExpiries();
      runtime.store.db.close();
    }
  });
});
