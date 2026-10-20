import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createCronJob } from '../dist/cron/cron-facade.js';
import { RoutineRunStore, drainRoutineRuns } from '../dist/cron/routine-runtime.js';
import { checkToolApprovals } from '../dist/runtime/tool-loop.js';
import { applyPermissionModeGate } from '../dist/approval/permission-mode.js';
import {
  expireDueUnattendedApprovals,
  UNATTENDED_APPROVAL_EXPIRE_REASON
} from '../dist/approval/unattended-approval.js';
import { spawnSubagent } from '../dist/runtime/spawn-host.js';

const bashTool = {
  name: 'bash',
  description: 'bash',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' }, isolation: { type: 'string' } },
    required: ['command']
  },
  approvalMode: 'auto',
  sideEffectLevel: 'workspace',
  async execute() {
    return { ok: true, content: 'ran' };
  }
};

function bashCall() {
  return {
    type: 'tool_call',
    toolCallId: 'c1',
    name: 'bash',
    input: { command: 'echo ok', isolation: 'direct' }
  };
}

function fixture(t, permissionMode) {
  const stateDir = mkdtempSync(join(tmpdir(), 'routine-owner-perm-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const session = store.createSession({
    title: 'bot chat',
    mode: 'chat',
    agentId: 'general',
    background: false,
    metadata: {
      userId: 'alice',
      botId: 'bot-owner',
      canonicalBotChat: true,
      permissionMode
    }
  });
  const seen = { executed: false };
  const host = {
    store,
    stateDir,
    log: { warn() {}, info() {} },
    cronStore: undefined,
    setCronStore(cronStore) {
      this.cronStore = cronStore;
    },
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {},
    async runSession(id) {
      const work = store.getSession(id);
      const deps = {
        tools: [bashTool],
        store,
        envApprovalPolicy: undefined,
        maxParallelToolCalls: 1,
        modelAdapter: {},
        stateDir,
        emitTrace() {}
      };
      const context = {
        repoRoot: stateDir,
        workspaceRoot: stateDir,
        stateDir,
        agent: { id: 'general' },
        session: work
      };
      seen.mode = work.metadata.permissionMode;
      seen.decision = checkToolApprovals(deps, [bashCall()], context, undefined, work, [bashTool]);
      seen.approvals = store.listApprovals().filter((row) => row.sessionId === id);
      if (seen.decision === 'proceed') {
        seen.executed = true;
        store.appendMessage(id, 'assistant', [{ type: 'text', text: 'checked remote' }]);
      } else {
        store.updateSession(id, { status: 'waiting_approval' });
      }
      return store.getSession(id);
    }
  };
  t.after(() => store.db.close());
  return { store, session, host, seen, stateDir };
}

async function fire(host, session) {
  const job = createCronJob(host, {
    sessionId: session.id,
    name: 'check',
    prompt: 'inspect',
    intervalMs: 60000
  });
  const runs = new RoutineRunStore(host.store);
  const run = runs.enqueue(job, new Date().toISOString());
  await drainRoutineRuns(host);
  await new Promise((resolve) => setImmediate(resolve));
  return runs.get(run.id);
}

test('bypass bot routine runs a direct shell command without waiting [AC:routine-owner-permission#AC-1]', async (t) => {
  const { store, session, host, seen } = fixture(t, 'bypass');
  const run = await fire(host, session);
  assert.equal(seen.mode, 'bypass');
  assert.equal(seen.decision, 'proceed');
  assert.equal(seen.approvals.length, 0);
  assert.equal(seen.executed, true);
  assert.equal(run.status, 'completed');
  assert.equal(store.listApprovals().length, 0);
});

test('ask bot routine still fails when nobody answers [AC:routine-owner-permission#AC-2]', async (t) => {
  const { store, session, host, seen } = fixture(t, 'ask');
  const waiting = await fire(host, session);
  assert.equal(seen.mode, 'ask');
  assert.equal(seen.decision, 'waiting');
  assert.equal(seen.executed, false);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(seen.approvals.length, 1);
  assert.match(seen.approvals[0].reason, /permissionMode=ask/);
  assert.equal(seen.approvals[0].wakeSource, 'routine');
  assert.ok(seen.approvals[0].expiresAt);
  expireDueUnattendedApprovals(store, Date.parse(seen.approvals[0].expiresAt) + 1);
  await drainRoutineRuns(host);
  await new Promise((resolve) => setImmediate(resolve));
  const failed = new RoutineRunStore(store).get(waiting.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Approval denied or expired');
  assert.equal(seen.executed, false);
  const denied = store.getApproval(seen.approvals[0].id);
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.expireReason, UNATTENDED_APPROVAL_EXPIRE_REASON);
});

test('auto bot routine keeps the main session auto and is not rewritten to ask', async (t) => {
  const { store, session, host, seen } = fixture(t, 'auto');
  const run = await fire(host, session);
  assert.equal(run.sessionId, session.id);
  assert.equal(seen.mode, 'auto');
  assert.equal(store.getSession(session.id).metadata.permissionMode, 'auto');
  assert.equal(store.listSessions().some((item) => String(item.title).startsWith('Routine:')), false);
  assert.equal(seen.approvals.some((item) => String(item.reason).includes('permissionMode=ask')), false);
});

test('spawned child of a bypass bot still asks [AC:routine-owner-permission#AC-3]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'routine-owner-spawn-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => store.db.close());
  store.upsertAgent({
    id: 'general',
    name: 'General',
    role: 'general',
    instructions: '',
    capabilities: []
  });
  const session = store.createSession({
    title: 'parent',
    mode: 'chat',
    agentId: 'general',
    metadata: { canonicalBotChat: true, botId: 'researcher', permissionMode: 'bypass', userId: 'alice' }
  });
  await spawnSubagent(
    {
      store,
      repoRoot: dir,
      stateDir: dir,
      workspaceManager: {},
      sandbox: undefined,
      setSandbox() {},
      backgroundJobAborts: new Map(),
      async runSession(id) {
        return store.getSession(id);
      }
    },
    {
      repoRoot: dir,
      stateDir: dir,
      session,
      agent: { id: 'general', name: 'General', role: 'general', instructions: '', capabilities: [] }
    },
    'do the thing'
  );
  const child = store.listSessions().find((item) => item.parentSessionId === session.id);
  assert.ok(child);
  assert.equal(child.metadata.permissionMode, 'ask');
  const gate = applyPermissionModeGate('ask', 'bash', 'auto');
  assert.equal(gate?.action, 'require_approval');
});
