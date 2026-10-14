import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptCoreHostToAgentLoop } from '../dist/turn/kernel-variant-adapter.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { defaultLoopSettings } from '../../../apps/daemon/src/loop-settings.ts';

test('default loop kernel variant is agent-loop', () => {
  assert.equal(defaultLoopSettings().kernelVariant, 'agent-loop');
});

test('adapter forwards A optional ports (claim/fold/HITL/dyn/goal/stepTx/task)', () => {
  const seen = [];
  const core = {
    store: {
      getTask: (id) => ({ id, title: 't' })
    },
    repoRoot: '/repo',
    stateDir: '/state',
    tools: [],
    modelAdapter: { name: 'stub', runTurn: async () => ({ stopReason: 'end', assistantParts: [] }) },
    promptBuilder: {
      buildSystemPrompt: async () => 's',
      buildMemoryAppendix: (_ctx, opts) => {
        seen.push(`appendix:${opts?.query ?? ''}:${opts?.stateDir ?? ''}`);
        return '[mem]';
      }
    },
    resolveRunProfile: (session) => {
      seen.push(`profile:${session.id}`);
      return { mode: 'fast' };
    },
    hooks: {
      register() {
        return () => undefined;
      },
      async onEvent() {
        seen.push('host-hooks');
      }
    },
    maxTurnsPerRun: 4,
    loopConfig: { compactEveryTurn: true },
    cumulativeInputTokensBySession: new Map(),
    emitTrace() {},
    mergeSessionMetadata() {},
    runTurnWithRetries: async () => ({ stopReason: 'end', assistantParts: [] }),
    executeToolCalls: async () => [],
    prepareMessagesForModel: async (_s, m) => m,
    autoCompact: async () => ({}),
    handleTurnCompletion: async (s) => s,
    processToolResults() {},
    checkToolApprovals: (...args) => {
      seen.push(`settled:${(args[6] ?? []).join(',')}`);
      return 'proceed';
    },
    filterValidToolCalls: (c) => c,
    autoClaimTask: async () => {
      seen.push('autoClaimTask');
    },
    applyOptionalFoldBudget: (_s, folded) => {
      seen.push('applyOptionalFoldBudget');
      return folded;
    },
    ensureWorkspaceRoot: async (session, task) => {
      seen.push(`ws:${session.id}:${task?.id ?? 'none'}`);
      return '/ws';
    },
    shouldLatchBeforeTools: () => {
      seen.push('shouldLatchBeforeTools');
      return 'steer';
    },
    recordToolUse: () => {
      seen.push('recordToolUse');
    },
    noteGoalWaitingUser: () => {
      seen.push('noteGoalWaitingUser');
    },
    resolveTask: (session) => ({ id: session.taskId ?? 'task-1' }),
    evaluateGoalGate: async () => ({ met: true, action: 'achieved' }),
    stepTx: {
      beginRun: () => {
        seen.push('beginRun');
      },
      endRun: () => {
        seen.push('endRun');
      }
    },
    mcpManager: { ensureLoaded: async () => undefined },
    sessionAbortControllers: new Map(),
    injectEvolvingCoachBeforeRecovery: async () => undefined,
    runCaseGovernance() {},
    scheduleBackgroundCaseReview() {}
  };

  const loop = adaptCoreHostToAgentLoop(core);
  assert.equal(typeof loop.autoClaimTask, 'function');
  assert.equal(typeof loop.applyFoldBudget, 'function');
  assert.equal(typeof loop.shouldLatchBeforeTools, 'function');
  assert.equal(typeof loop.recordToolUse, 'function');
  assert.equal(typeof loop.noteGoalWaitingUser, 'function');
  assert.equal(typeof loop.stepTx.beginRun, 'function');
  assert.equal(typeof loop.evaluateGoalGate, 'function');
  assert.equal(loop.promptBuilder.buildMemoryAppendix({}, { query: 'q' }), '[mem]');
  assert.equal(typeof loop.resolveRunProfile, 'function');
  assert.equal(loop.hooks, core.hooks);
  loop.resolveRunProfile({ id: 's1' });
  loop.checkToolApprovals(
    [],
    {},
    { id: 's1' },
    { settledApprovalIds: ['ap-1'], closedByGate: { reported: false, ids: [] } }
  );

  return Promise.resolve()
    .then(() => loop.autoClaimTask({ id: 's1' }))
    .then(() => loop.applyFoldBudget({ id: 's1' }, []))
    .then(() => loop.shouldLatchBeforeTools({ session: { id: 's1' }, toolCalls: [] }))
    .then(() => loop.recordToolUse({ name: 'echo', sessionId: 's1', turn: 0, ok: true }))
    .then(() => loop.noteGoalWaitingUser('s1', [{ name: 'ask_user', toolCallId: '1', input: {} }]))
    .then(() => loop.stepTx.beginRun({ sessionId: 's1', runId: 'r1' }))
    .then(() => loop.ensureWorkspaceRoot({ id: 's1', taskId: 'task-1' }))
    .then(() => {
      assert.ok(seen.includes('autoClaimTask'));
      assert.ok(seen.includes('applyOptionalFoldBudget'));
      assert.ok(seen.includes('shouldLatchBeforeTools'));
      assert.ok(seen.includes('recordToolUse'));
      assert.ok(seen.includes('noteGoalWaitingUser'));
      assert.ok(seen.includes('beginRun'));
      assert.ok(seen.includes('ws:s1:task-1'));
      assert.ok(seen.includes('appendix:q:/state'));
      assert.ok(seen.includes('profile:s1'));
      assert.ok(seen.includes('settled:ap-1'));
    });
});

test('runSession with no persisted variant uses agent-loop (A)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'al-default-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'al-default-state-'));
  const runtime = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'scripted',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok-a' }] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  try {
    assert.equal(runtime.store.getDaemonControl('loop_settings'), undefined);
    const session = runtime.createChatSession({ title: 'default-a', message: 'hi' });
    const steps = [];
    const out = await runtime.runSession(session.id, {
      latch: {
        emit: async (ev) => {
          steps.push(ev.type);
        }
      }
    });
    assert.equal(out.status, 'idle');
    assert.ok(steps.includes('turn_prepared'));
    assert.ok(steps.includes('ended'));
  } finally {
    await runtime.destroy?.();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
