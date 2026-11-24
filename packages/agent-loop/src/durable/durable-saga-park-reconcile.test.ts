/**
 * Phase 3 Durable Saga, Pivot Guard, Park/Signal/Memo, and Reconcile unit suite.
 */

import { describe, expect, it } from 'vitest';
import { createAssembledLoop } from '../assembly/create-assembled-loop.js';
import { createDefaultMemoryStore } from '../assembly/store-adapter.js';
import {
  MemoryDurableJournal,
  cancelParkedStepsForRun,
  checkParkedStepWake,
  reconcileUnknownStepsForRun,
  runDurableSagaRollback,
  wakeReadyParkedRun,
} from '../index.js';
import type { ModelAdapter, RunContext, ToolContract } from '../types.js';

function createSeeded(prompt: string) {
  const { surface, store } = createDefaultMemoryStore();
  const session = surface.createSession({ agentId: 'general', title: 'p3-test', mode: 'chat' });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: prompt }]);
  return { surface, store, session };
}

describe('Phase 3 Durable Saga, Pivot, Park/Signal/Memo & Reconcile', () => {
  it('executes LIFO compensation with retries and resumes crash-interrupted rolling_back without repeating compensated steps [AC:durable-saga-park-reconcile#AC-1]', async () => {
    const journal = new MemoryDurableJournal();
    const run = journal.beginRun({ runId: 'drun_saga', sessionId: 'sess_saga' });
    const s1 = journal.planStep({
      runId: run.runId,
      sessionId: 'sess_saga',
      turn: 0,
      waveIndex: 0,
      kind: 'tool_call',
      toolCallId: 'c1',
      toolName: 'create_draft',
      idempotencyKey: 'ik1',
      effectClass: 'external_compensatable',
      replayPolicy: 'unsafe',
    });
    journal.markStepDispatched(s1.stepId);
    journal.commitStep(s1.stepId, {
      compensationSpec: { kind: 'delete_draft', toolName: 'create_draft', payload: { draftId: 'D1' } },
    });

    const s2 = journal.planStep({
      runId: run.runId,
      sessionId: 'sess_saga',
      turn: 0,
      waveIndex: 0,
      kind: 'tool_call',
      toolCallId: 'c2',
      toolName: 'create_branch',
      idempotencyKey: 'ik2',
      effectClass: 'external_compensatable',
      replayPolicy: 'unsafe',
    });
    journal.markStepDispatched(s2.stepId);
    journal.commitStep(s2.stepId, {
      compensationSpec: { kind: 'delete_branch', toolName: 'create_branch', payload: { branch: 'tmp-1' } },
    });

    // Simulate crash right after s2 was compensated (status stayed rolling_back, s1 still committed)
    journal.updateRun(run.runId, { status: 'rolling_back' });
    journal.updateStepPhase(s2.stepId, 'compensated');

    const executedOrder: string[] = [];
    let transientFailOnce = true;
    const result = await runDurableSagaRollback({
      journal,
      runId: run.runId,
      executeCompensation: async (spec) => {
        executedOrder.push(`${spec.toolName}:${JSON.stringify(spec.payload)}`);
        if (transientFailOnce) {
          transientFailOnce = false;
          return { ok: false, error: 'transient 503' };
        }
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.runStatus).toBe('rolled_back');
    expect(result.alreadyCompensatedStepIds).toEqual([s2.stepId]);
    expect(result.compensatedStepIds).toEqual([s1.stepId]);
    // s2 was skipped; s1 retried once and succeeded
    expect(executedOrder).toEqual([
      'create_draft:{"draftId":"D1"}',
      'create_draft:{"draftId":"D1"}',
    ]);
    expect(journal.getStep(s1.stepId)?.phase).toBe('compensated');
    expect(journal.getStep(s2.stepId)?.phase).toBe('compensated');
  });

  it('partitions external_irreversible Pivot after reversible steps and blocks non-forced rollback [AC:durable-saga-park-reconcile#AC-2]', async () => {
    const journal = new MemoryDurableJournal();
    const { store, session } = createSeeded('draft then send irreversible email');
    const dispatchOrder: string[] = [];

    const draftTool: ToolContract<Record<string, unknown>> = {
      name: 'create_draft',
      description: 'create draft',
      inputSchema: { type: 'object' },
      approvalMode: 'never',
      sideEffectLevel: 'workspace',
      effectClass: 'external_compensatable',
      replay: 'unsafe',
      buildCompensation: () => ({ kind: 'delete_draft', toolName: 'create_draft', payload: { id: 'draft-9' } }),
      execute: async () => {
        dispatchOrder.push('create_draft');
        return { ok: true, content: 'draft-9 created' };
      },
    };
    const sendEmailTool: ToolContract<Record<string, unknown>> = {
      name: 'send_email',
      description: 'irreversible email send',
      inputSchema: { type: 'object' },
      approvalMode: 'never',
      sideEffectLevel: 'system',
      effectClass: 'external_irreversible',
      replay: 'unsafe',
      execute: async () => {
        dispatchOrder.push('send_email');
        return { ok: true, content: 'email sent' };
      },
    };

    let modelTurn = 0;
    const adapter: ModelAdapter = {
      name: 'pivot-test',
      async runTurn() {
        modelTurn += 1;
        if (modelTurn === 1) {
          // Model outputs irreversible tool FIRST, reversible tool SECOND -> partitioner MUST run reversible first!
          return {
            stopReason: 'tool_use',
            assistantParts: [
              { type: 'tool_call', toolCallId: 'tc_send', name: 'send_email', input: {} },
              { type: 'tool_call', toolCallId: 'tc_draft', name: 'create_draft', input: {} },
            ],
          };
        }
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'sent' }] };
      },
      async summarizeMessages() {
        return 'summary';
      },
    };

    const loop = await createAssembledLoop({
      preset: 'normal',
      io: {
        store,
        model: adapter,
        tools: [draftTool, sendEmailTool],
        durable: { journal, restartLimit: 5 },
      },
    });
    await loop.run(session.id);

    expect(dispatchOrder).toEqual(['create_draft', 'send_email']);
    const run = journal.getLatestRunForSession(session.id)!;
    expect(run.passedPivot).toBe(true);

    const blocked = await runDurableSagaRollback({
      journal,
      runId: run.runId,
      executeCompensation: async () => ({ ok: true }),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockedByPivot).toBe(true);
    expect(blocked.error).toContain('pivot_blocked');
  });

  it('supports ctx.memo first-writer-wins, tool park(), early signal consume-once, deadline wake, and abort cancel() [AC:durable-saga-park-reconcile#AC-3]', async () => {
    const journal = new MemoryDurableJournal();
    const { store, session } = createSeeded('start async job');
    const seenMemos: string[] = [];
    const cancelledCheckpoints: unknown[] = [];

    const asyncJobTool: ToolContract<Record<string, unknown>> = {
      name: 'start_job',
      description: 'parks waiting for webhook signal',
      inputSchema: { type: 'object' },
      approvalMode: 'never',
      sideEffectLevel: 'system',
      effectClass: 'external_compensatable',
      replay: 'safe',
      execute: async (ctx) => {
        const key = await ctx.memo!('idem', () => `key-${seenMemos.length + 1}`);
        seenMemos.push(key);
        return {
          ok: true,
          content: 'parked',
          park: {
            kind: 'park',
            signals: [{ name: 'job_done', key: 'job-42' }],
            untilMs: Date.now() + 60_000,
            checkpoint: { jobId: 'job-42', idemKey: key },
            summary: 'Waiting for job-42',
          },
        };
      },
      cancel: async (_ctx, checkpoint) => {
        cancelledCheckpoints.push(checkpoint);
      },
    };

    const adapter: ModelAdapter = {
      name: 'park-test',
      async runTurn() {
        return {
          stopReason: 'tool_use',
          assistantParts: [{ type: 'tool_call', toolCallId: 'tc_park', name: 'start_job', input: {} }],
        };
      },
      async summarizeMessages() {
        return 'summary';
      },
    };

    const loop = await createAssembledLoop({
      preset: 'normal',
      io: {
        store,
        model: adapter,
        tools: [asyncJobTool],
        durable: { journal, restartLimit: 5 },
      },
    });
    await loop.run(session.id);

    const run = journal.getLatestRunForSession(session.id)!;
    const step = journal.getStepByToolCall(run.runId, 'tc_park', 0)!;
    expect(run.status).toBe('waiting_park');
    expect(step.phase).toBe('parked');
    expect(seenMemos).toEqual(['key-1']);
    // First-writer-wins memo check
    expect(journal.memo(step.stepId, 'idem', 'key-different')).toBe('key-1');

    // Before signal arrives: not ready
    expect(checkParkedStepWake(journal, step, Date.now()).ready).toBe(false);
    // Deadline wake check
    expect(checkParkedStepWake(journal, step, Date.now() + 120_000)).toMatchObject({ ready: true, reason: 'deadline' });

    // Deliver signal + verify duplicate rejection + consume-once wake
    expect(
      journal.deliverSignal({ runId: run.runId, stepId: step.stepId, signalName: 'job_done', signalKey: 'job-42', payload: { status: 'ok' } })
    ).toEqual({ status: 'delivered' });
    expect(
      journal.deliverSignal({ runId: run.runId, stepId: step.stepId, signalName: 'job_done', signalKey: 'job-42', payload: { status: 'dup' } })
    ).toEqual({ status: 'duplicate' });

    const woke = wakeReadyParkedRun(journal, run.runId);
    expect(woke.woke).toBe(true);
    expect(woke.consumedSignals).toHaveLength(1);
    expect(journal.getRun(run.runId)?.status).toBe('resumable');
    expect(journal.readSignal(run.runId, step.stepId, 'job_done', 'job-42')?.state).toBe('consumed');

    // Re-park and test cancelParkedStepsForRun invokes tool.cancel + expires pending signals
    journal.parkStep(step.stepId, { kind: 'park', signals: [{ name: 'other', key: 'k2' }], checkpoint: { jobId: 'job-42' } });
    journal.updateRun(run.runId, { status: 'waiting_park' });
    journal.deliverSignal({ runId: run.runId, stepId: step.stepId, signalName: 'other', signalKey: 'k2', payload: {} });
    const cancelled = await cancelParkedStepsForRun({
      journal,
      runId: run.runId,
      tools: [asyncJobTool],
      buildContext: () => ({ repoRoot: '/tmp', stateDir: '/tmp', session, agent: store.getAgent('general')! }) as RunContext,
    });
    expect(cancelled.cancelledStepIds).toEqual([step.stepId]);
    expect(cancelled.expiredSignals).toBe(1);
    expect(cancelledCheckpoints).toEqual([{ jobId: 'job-42' }]);
  });

  it('converges unknown steps via tool.reconcile() and flags unresolvable steps as needs_reconcile [AC:durable-saga-park-reconcile#AC-4]', async () => {
    const journal = new MemoryDurableJournal();
    const { store, session } = createSeeded('reconcile probes');
    const run = journal.beginRun({ runId: 'drun_rec', sessionId: session.id });

    const sCommitted = journal.planStep({
      runId: run.runId,
      sessionId: session.id,
      turn: 0,
      waveIndex: 0,
      kind: 'tool_call',
      toolCallId: 'c_ok',
      toolName: 'probe_committed',
      idempotencyKey: 'ik_ok',
      effectClass: 'external_compensatable',
      replayPolicy: 'unsafe',
    });
    journal.markStepDispatched(sCommitted.stepId);
    journal.markStepUnknown(sCommitted.stepId, 'crash');

    const sNotApplied = journal.planStep({
      runId: run.runId,
      sessionId: session.id,
      turn: 0,
      waveIndex: 0,
      kind: 'tool_call',
      toolCallId: 'c_no',
      toolName: 'probe_not_applied',
      idempotencyKey: 'ik_no',
      effectClass: 'external_compensatable',
      replayPolicy: 'unsafe',
    });
    journal.markStepDispatched(sNotApplied.stepId);
    journal.markStepUnknown(sNotApplied.stepId, 'crash');

    const sUnknown = journal.planStep({
      runId: run.runId,
      sessionId: session.id,
      turn: 0,
      waveIndex: 0,
      kind: 'tool_call',
      toolCallId: 'c_unk',
      toolName: 'probe_unknown',
      idempotencyKey: 'ik_unk',
      effectClass: 'external_irreversible',
      replayPolicy: 'unsafe',
    });
    journal.markStepDispatched(sUnknown.stepId);
    journal.markStepUnknown(sUnknown.stepId, 'crash');

    const tools: ToolContract<any>[] = [
      {
        name: 'probe_committed',
        description: '',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'system',
        execute: async () => ({ ok: true, content: 'never called' }),
        reconcile: async () => ({ status: 'committed', ok: true, content: 'confirmed remote #77', receipt: { remoteId: 77 } }),
      },
      {
        name: 'probe_not_applied',
        description: '',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'system',
        execute: async () => ({ ok: true, content: 'never called' }),
        reconcile: async () => ({ status: 'not_applied', content: 'not found remotely' }),
      },
      {
        name: 'probe_unknown',
        description: '',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'system',
        execute: async () => ({ ok: true, content: 'never called' }),
        reconcile: async () => ({ status: 'unknown' }),
      },
    ];

    const out = await reconcileUnknownStepsForRun({
      journal,
      runId: run.runId,
      tools,
      buildContext: () => ({ repoRoot: '/tmp', stateDir: '/tmp', session, agent: store.getAgent('general')! }) as RunContext,
    });

    expect(out.committedStepIds).toEqual([sCommitted.stepId]);
    expect(out.notAppliedStepIds).toEqual([sNotApplied.stepId]);
    expect(out.unresolvedStepIds).toEqual([sUnknown.stepId]);
    expect(journal.getStep(sCommitted.stepId)?.phase).toBe('committed');
    expect(journal.getStep(sCommitted.stepId)?.receipt).toEqual({ remoteId: 77 });
    expect(journal.getStep(sNotApplied.stepId)?.phase).toBe('failed');
    expect(journal.getRun(run.runId)?.status).toBe('needs_reconcile');
  });
});
