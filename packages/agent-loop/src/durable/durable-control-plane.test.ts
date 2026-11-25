/**
 * Phase 1 Durable Control Plane verification suite.
 * Covers single-tool Intent-First persistence, double-checked replay policy,
 * restartLimit circuit breaker, KernelCheckpointState restoration,
 * reused toolCallId across turns, waveRollbackPolicy default, and Prompt Cache zero degradation.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssembledLoop } from '../assembly/create-assembled-loop.js';
import { createDefaultMemoryStore } from '../assembly/store-adapter.js';
import {
  INTERRUPTED_UNSAFE_RESULT,
  MemoryDurableJournal,
  canReplayUnknownStep,
  defaultDurableSettings,
  normalizeDurableSettings,
  openStandaloneSqliteDurableJournal,
  readDurableSettings,
  shouldTriggerWaveCompensation,
  writeDurableSettings,
} from '../index.js';
import type { ModelAdapter, ModelTurnInput, ModelTurnResult, ToolContract } from '../types.js';

function createSeededMemoryStore(userPrompt: string) {
  const { surface, store } = createDefaultMemoryStore();
  const session = surface.createSession({ agentId: 'general', title: 'durable-test', mode: 'chat' });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: userPrompt }]);
  return { surface, store, session };
}

type CapturedTurnInput = {
  systemPrompt: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  messages: Array<{ role: string; parts: unknown[] }>;
};

function createScriptedModel(
  turns: Array<(input: ModelTurnInput) => ModelTurnResult | Promise<ModelTurnResult>>
): { adapter: ModelAdapter; inputs: CapturedTurnInput[] } {
  const inputs: CapturedTurnInput[] = [];
  let idx = 0;
  const adapter: ModelAdapter = {
    name: 'scripted-durable-test',
    async runTurn(input) {
      inputs.push({
        systemPrompt: input.systemPrompt,
        tools: input.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        messages: input.messages.map((m) => ({ role: m.role, parts: structuredClone(m.parts) })),
      });
      const fn = turns[idx] ?? turns[turns.length - 1]!;
      idx += 1;
      return fn(input);
    },
    async summarizeMessages() {
      return 'summary';
    },
  };
  return { adapter, inputs };
}

function makeTool(
  name: string,
  opts: Partial<ToolContract<Record<string, unknown>>> & {
    onExecute: (args: Record<string, unknown>, ctx: Parameters<ToolContract['execute']>[0]) => Promise<{ ok: boolean; content: string }>;
  }
): ToolContract<Record<string, unknown>> {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    approvalMode: 'never',
    sideEffectLevel: opts.sideEffectLevel ?? 'workspace',
    effectClass: opts.effectClass,
    replay: opts.replay,
    execute: (ctx, args) => opts.onExecute(args, ctx),
  };
}

describe('Phase 1 Durable Control Plane', () => {
  it('commits each tool atomically and skips committed tools on crash resume [AC:durable-agent-control-plane#AC-1]', async () => {
    const journal = new MemoryDurableJournal();
    const { store, session } = createSeededMemoryStore('run step A and step B');

    let callsA = 0;
    let callsB = 0;

    const toolA = makeTool('tool_a', {
      effectClass: 'workspace_fs',
      replay: 'unsafe',
      onExecute: async () => {
        callsA += 1;
        return { ok: true, content: 'result-A' };
      },
    });
    const toolB = makeTool('tool_b', {
      effectClass: 'read',
      replay: 'safe',
      onExecute: async () => {
        callsB += 1;
        return { ok: true, content: 'result-B' };
      },
    });

    const run1Model = createScriptedModel([
      () => ({
        stopReason: 'tool_use',
        assistantParts: [
          { type: 'tool_call', toolCallId: 'call-a', name: 'tool_a', input: { value: '1' } },
          { type: 'tool_call', toolCallId: 'call-b', name: 'tool_b', input: { value: '2' } },
        ],
      }),
      () => ({
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'all done' }],
      }),
    ]);

    const loop1 = await createAssembledLoop({
      preset: 'normal',
      io: {
        store,
        model: run1Model.adapter,
        tools: [toolA, toolB],
        maxParallelToolCalls: 1,
        durable: { journal, restartLimit: 5 },
      },
    });

    await loop1.run(session.id);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
    const run1 = journal.getLatestRunForSession(session.id);
    expect(run1?.status).toBe('completed');
    expect(journal.listSteps(run1!.runId).map((s) => s.phase)).toEqual(['committed', 'committed']);

    // Simulate hard crash where call-a committed in epoch 1 and call-b was interrupted while dispatched (replay: 'safe')
    const journal2 = new MemoryDurableJournal();
    const mem2 = createSeededMemoryStore('resume partial wave');
    let countA2 = 0;
    let countB2 = 0;
    const tA2 = makeTool('tool_a', {
      effectClass: 'workspace_fs',
      replay: 'unsafe',
      onExecute: async () => {
        countA2 += 1;
        return { ok: true, content: 'A-committed-once' };
      },
    });
    const tB2 = makeTool('tool_b', {
      effectClass: 'read',
      replay: 'safe',
      onExecute: async () => {
        countB2 += 1;
        return { ok: true, content: 'B-replayed-safely' };
      },
    });

    const run = journal2.beginRun({ runId: 'drun_partial', sessionId: mem2.session.id });
    mem2.store.appendMessage(mem2.session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'call-a', name: 'tool_a', input: {} },
      { type: 'tool_call', toolCallId: 'call-b', name: 'tool_b', input: {} },
    ]);
    mem2.store.appendMessage(mem2.session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'call-a', name: 'tool_a', ok: true, content: 'A-committed-once' },
    ]);
    const stepA = journal2.planStep({
      runId: run.runId,
      sessionId: mem2.session.id,
      turn: 0,
      waveIndex: 0,
      fencingEpoch: 1,
      kind: 'tool_call',
      toolCallId: 'call-a',
      toolName: 'tool_a',
      idempotencyKey: 'k-a',
      effectClass: 'workspace_fs',
      replayPolicy: 'unsafe',
    });
    journal2.markStepDispatched(stepA.stepId);
    journal2.commitStep(stepA.stepId);
    const stepB = journal2.planStep({
      runId: run.runId,
      sessionId: mem2.session.id,
      turn: 0,
      waveIndex: 0,
      fencingEpoch: 1,
      kind: 'tool_call',
      toolCallId: 'call-b',
      toolName: 'tool_b',
      idempotencyKey: 'k-b',
      effectClass: 'read',
      replayPolicy: 'safe',
    });
    journal2.markStepDispatched(stepB.stepId);
    journal2.markStepUnknown(stepB.stepId, 'process_interrupted');
    journal2.updateRun(run.runId, { status: 'resumable', restarts: 1 });

    const resumeModel = createScriptedModel([
      (inp) => {
        const results = inp.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result');
        expect(results).toHaveLength(2);
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'resumed cleanly' }] };
      },
    ]);

    const loop2 = await createAssembledLoop({
      preset: 'normal',
      io: {
        store: mem2.store,
        model: resumeModel.adapter,
        tools: [tA2, tB2],
        durable: { journal: journal2, restartLimit: 5 },
      },
    });
    const finalSession = await loop2.run(mem2.session.id);

    expect(finalSession.status).toBe('idle');
    expect(countA2).toBe(0); // Committed tool A was NEVER re-executed
    expect(countB2).toBe(1); // Safe unknown tool B executed once on resume
    expect(journal2.getRun(run.runId)?.status).toBe('completed');
    expect(journal2.getStepByToolCall(run.runId, 'call-b', 0)?.phase).toBe('committed');
  });

  it('enforces double-checked replay policy and never replays unsafe unknown tools [AC:durable-agent-control-plane#AC-2]', async () => {
    expect(
      canReplayUnknownStep({ storedReplay: 'unsafe', currentToolReplay: 'safe', restarts: 1, restartLimit: 5 })
    ).toBe(false);
    expect(
      canReplayUnknownStep({ storedReplay: 'safe', currentToolReplay: 'unsafe', restarts: 1, restartLimit: 5 })
    ).toBe(false);
    expect(
      canReplayUnknownStep({ storedReplay: 'safe', currentToolReplay: 'safe', restarts: 1, restartLimit: 5 })
    ).toBe(true);
    expect(
      canReplayUnknownStep({ storedReplay: 'safe', currentToolReplay: 'safe', restarts: 5, restartLimit: 5 })
    ).toBe(false);

    const journal = new MemoryDurableJournal();
    const { store, session } = createSeededMemoryStore('run unsafe write');
    let execCount = 0;
    const unsafeTool = makeTool('write_it', {
      effectClass: 'workspace_fs',
      replay: 'unsafe',
      onExecute: async () => {
        execCount += 1;
        return { ok: true, content: 'wrote' };
      },
    });

    const run = journal.beginRun({ runId: 'drun_unsafe', sessionId: session.id });
    store.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'call-unsafe', name: 'write_it', input: { value: 'x' } },
    ]);
    const step = journal.planStep({
      runId: run.runId,
      sessionId: session.id,
      turn: 0,
      waveIndex: 0,
      fencingEpoch: 1,
      kind: 'tool_call',
      toolCallId: 'call-unsafe',
      toolName: 'write_it',
      idempotencyKey: 'k-u',
      effectClass: 'workspace_fs',
      replayPolicy: 'unsafe',
    });
    journal.markStepDispatched(step.stepId);
    journal.markStepUnknown(step.stepId, 'process_interrupted');
    journal.updateRun(run.runId, { status: 'resumable', restarts: 1 });

    const { adapter } = createScriptedModel([
      (inp) => {
        const tr = inp.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
        expect(tr?.type === 'tool_result' && tr.ok).toBe(false);
        expect(tr?.type === 'tool_result' && tr.content).toBe(INTERRUPTED_UNSAFE_RESULT);
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'acknowledged interruption' }] };
      },
    ]);

    const loop = await createAssembledLoop({
      preset: 'normal',
      io: {
        store,
        model: adapter,
        tools: [unsafeTool],
        durable: { journal, restartLimit: 5 },
      },
    });
    await loop.run(session.id);

    expect(execCount).toBe(0);
    expect(journal.getStep(step.stepId)?.phase).toBe('failed');
  });

  it('trips restartLimit circuit breaker and blocks crash loops with zero model calls [AC:durable-agent-control-plane#AC-3]', async () => {
    const journal = new MemoryDurableJournal();
    const { store, session } = createSeededMemoryStore('crash loop');
    const run = journal.beginRun({ runId: 'drun_breaker', sessionId: session.id });
    journal.updateRun(run.runId, { status: 'resumable', restarts: 3 });

    let modelCalls = 0;
    const { adapter } = createScriptedModel([
      () => {
        modelCalls += 1;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'should not run' }] };
      },
    ]);

    const loop = await createAssembledLoop({
      preset: 'normal',
      io: {
        store,
        model: adapter,
        durable: { journal, restartLimit: 3 },
      },
    });
    const out = await loop.run(session.id);
    expect(out.status).toBe('failed');
    expect(modelCalls).toBe(0);
    expect(journal.getRun(run.runId)?.status).toBe('failed');
    expect(journal.getRun(run.runId)?.errorText).toContain('restart_limit');
  });

  it('persists and restores KernelCheckpointState across SQLite reopen [AC:durable-agent-control-plane#AC-4]', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-ckpt-'));
    const dbPath = join(dir, 'durable.db');
    try {
      const opened1 = await openStandaloneSqliteDurableJournal(dbPath);
      const run = opened1.journal.beginRun({ runId: 'drun_ckpt', sessionId: 'sess_1' });
      opened1.journal.updateRun(run.runId, {
        status: 'resumable',
        restarts: 1,
        kernelState: {
          turn: 4,
          stepCursor: 9,
          advisoryGraceUsed: 1,
          pendingAdvisories: ['[recovery-advisory] inspect error before retry'],
          spinNoProgressStreak: 2,
          cumulativeInputTokens: 42_000,
          sameToolStreak: 3,
          loopFailureCount: 2,
          riskScore: 0.75,
        },
      });
      opened1.close();

      // Reopen fresh SQLite connection to simulate process restart
      const opened2 = await openStandaloneSqliteDurableJournal(dbPath);
      const restored = opened2.journal.getRun(run.runId);
      expect(restored?.kernelState).toEqual({
        turn: 4,
        stepCursor: 9,
        advisoryGraceUsed: 1,
        pendingAdvisories: ['[recovery-advisory] inspect error before retry'],
        spinNoProgressStreak: 2,
        cumulativeInputTokens: 42_000,
        sameToolStreak: 3,
        loopFailureCount: 2,
        riskScore: 0.75,
      });

      // Resume a session from restored turn=2 and complete cleanly
      const { store, session } = createSeededMemoryStore('continue work');
      const runForSession = opened2.journal.beginRun({ runId: 'drun_sess_restore', sessionId: session.id });
      opened2.journal.updateRun(runForSession.runId, {
        status: 'resumable',
        restarts: 1,
        kernelState: {
          turn: 2,
          stepCursor: 3,
          advisoryGraceUsed: 1,
          pendingAdvisories: [],
          spinNoProgressStreak: 1,
          cumulativeInputTokens: 12_345,
          sameToolStreak: 0,
          loopFailureCount: 0,
          riskScore: 0,
        },
      });
      const { adapter } = createScriptedModel([
        () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'finished at turn 2' }] }),
      ]);
      const loop = await createAssembledLoop({
        preset: 'normal',
        io: {
          store,
          model: adapter,
          maxTurns: 6,
          durable: { journal: opened2.journal, restartLimit: 5 },
        },
      });
      const done = await loop.run(session.id);
      expect(done.status).toBe('idle');
      expect(opened2.journal.getRun(runForSession.runId)?.kernelState.turn).toBeGreaterThanOrEqual(2);
      expect(opened2.journal.getRun(runForSession.runId)?.status).toBe('completed');
      opened2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles reused toolCallId across separate turns without false replay cache hits', async () => {
    const journal = new MemoryDurableJournal();
    const { store, session } = createSeededMemoryStore('read two files with reused id');
    const seenValues: string[] = [];
    const readTool = makeTool('read_file', {
      sideEffectLevel: 'none',
      effectClass: 'read',
      replay: 'safe',
      onExecute: async (args) => {
        const val = String(args.value ?? '');
        seenValues.push(val);
        return { ok: true, content: `content:${val}` };
      },
    });
    const { adapter } = createScriptedModel([
      () => ({
        stopReason: 'tool_use',
        assistantParts: [{ type: 'tool_call', toolCallId: 'heuristic_read_dir', name: 'read_file', input: { value: 'a.txt' } }],
      }),
      () => ({
        stopReason: 'tool_use',
        assistantParts: [{ type: 'tool_call', toolCallId: 'heuristic_read_dir', name: 'read_file', input: { value: 'b.txt' } }],
      }),
      () => ({
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'read both' }],
      }),
    ]);

    const loop = await createAssembledLoop({
      preset: 'normal',
      io: {
        store,
        model: adapter,
        tools: [readTool],
        durable: { journal, restartLimit: 5 },
      },
    });
    const done = await loop.run(session.id);
    expect(done.status).toBe('idle');
    expect(seenValues).toEqual(['a.txt', 'b.txt']);
  });

  it('does not degrade Prompt Cache: model wire input is byte-identical with durable on vs off [AC:durable-agent-control-plane#AC-6]', async () => {
    const runScenario = async (enableDurable: boolean) => {
      const { store, session } = createSeededMemoryStore('read hello.txt');
      const readTool = makeTool('read_file', {
        sideEffectLevel: 'none',
        effectClass: 'read',
        replay: 'safe',
        onExecute: async () => ({ ok: true, content: 'hello world' }),
      });
      const { adapter, inputs } = createScriptedModel([
        () => ({
          stopReason: 'tool_use',
          assistantParts: [{ type: 'tool_call', toolCallId: 'tc-1', name: 'read_file', input: { value: 'hello.txt' } }],
        }),
        () => ({
          stopReason: 'end',
          assistantParts: [{ type: 'text', text: 'The file says hello world.' }],
        }),
      ]);
      const loop = await createAssembledLoop({
        preset: 'normal',
        io: {
          store,
          model: adapter,
          tools: [readTool],
          durable: enableDurable ? { journal: new MemoryDurableJournal(), restartLimit: 5 } : undefined,
        },
      });
      await loop.run(session.id);
      return inputs.map((inp) => ({
        systemPrompt: inp.systemPrompt,
        tools: inp.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        messages: inp.messages.map((m) => ({ role: m.role, parts: m.parts })),
      }));
    };

    const baseline = await runScenario(false);
    const durable = await runScenario(true);
    expect(durable).toEqual(baseline);
  });

  it('defaults waveRollbackPolicy to abort_or_tx_only so ordinary tool failure does not undo prior writes', () => {
    const defaults = defaultDurableSettings();
    expect(defaults.waveRollbackPolicy).toBe('abort_or_tx_only');
    expect(defaults.chatRestartPolicy).toBe('auto_resume');

    expect(
      shouldTriggerWaveCompensation({
        results: [{ ok: true }, { ok: false }],
        aborted: false,
        policy: 'abort_or_tx_only',
      })
    ).toBe(false);
    expect(
      shouldTriggerWaveCompensation({
        results: [{ ok: true }, { ok: false }],
        aborted: true,
        policy: 'abort_or_tx_only',
      })
    ).toBe(true);
    expect(
      shouldTriggerWaveCompensation({
        results: [{ ok: true }, { ok: false }],
        aborted: false,
        policy: 'on_tool_error',
      })
    ).toBe(true);

    const kv = new Map<string, unknown>();
    const kvStore = {
      getDaemonControl: <T>(k: string) => kv.get(k) as T | undefined,
      setDaemonControl: (k: string, v: unknown) => {
        kv.set(k, v);
      },
    };
    expect(readDurableSettings(kvStore).mode).toBe('atomic_workspace');
    writeDurableSettings(kvStore, { mode: 'off', restartLimit: 7 });
    expect(readDurableSettings(kvStore).mode).toBe('off');
    expect(readDurableSettings(kvStore).restartLimit).toBe(7);
    expect(normalizeDurableSettings({ restartLimit: -1 }).restartLimit).toBe(5);
  });
});
