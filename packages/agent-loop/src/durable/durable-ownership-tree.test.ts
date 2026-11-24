import { describe, expect, it } from 'vitest';
import {
  MemoryDurableJournal,
  abandonOrphanChildRunsOnBoot,
  cancelDurableOwnershipTree,
} from './index.js';

describe('Durable Ownership Tree', () => {
  it('cancels nested parent -> child -> grandchild bottom-up through completing [AC:durable-tx-tree-and-ui#AC-1]', () => {
    const journal = new MemoryDurableJournal();
    journal.beginRun({ runId: 'run_root', sessionId: 'sess_root' });
    journal.beginRun({ runId: 'run_child', sessionId: 'sess_child', parentRunId: 'run_root' });
    journal.beginRun({ runId: 'run_grand', sessionId: 'sess_grand', parentRunId: 'run_child' });

    const parkedStep = journal.planStep({
      runId: 'run_grand',
      sessionId: 'sess_grand',
      turn: 0,
      waveIndex: 0,
      kind: 'tool_call',
      toolCallId: 'tc_park',
      toolName: 'wait_ext',
      idempotencyKey: 'k_park',
      effectClass: 'external_compensatable',
      replayPolicy: 'unsafe',
      argsHash: 'h_park',
    });
    journal.parkStep(parkedStep.stepId, {
      kind: 'park',
      signals: [{ name: 'sig', key: 'k1' }],
    });
    journal.deliverSignal({
      runId: 'run_grand',
      stepId: parkedStep.stepId,
      signalName: 'sig',
      signalKey: 'k1',
      payload: { ok: true },
    });

    const observedOrder: string[] = [];
    const result = cancelDurableOwnershipTree({
      journal,
      rootRunId: 'run_root',
      reason: 'user_cancelled',
      onCancelRun: (run) => observedOrder.push(run.runId),
    });

    expect(result.visitedCompleting).toEqual(['run_root', 'run_child']);
    expect(result.cancelledRunIds).toEqual(['run_grand', 'run_child', 'run_root']);
    expect(observedOrder).toEqual(['run_grand', 'run_child', 'run_root']);
    expect(result.childSessionIds).toEqual(['sess_grand', 'sess_child']);

    expect(journal.getRun('run_root')?.status).toBe('aborted');
    expect(journal.getRun('run_root')?.errorText).toBe('user_cancelled');
    expect(journal.getRun('run_child')?.status).toBe('aborted');
    expect(journal.getRun('run_child')?.errorText).toBe('parent_cancelled');
    expect(journal.getRun('run_grand')?.status).toBe('aborted');
    expect(journal.getStep(parkedStep.stepId)?.phase).toBe('failed');
    expect(journal.listSignals('run_grand')[0]?.state).toBe('expired');
  });

  it('abandons orphan child subtrees on boot while sparing children of healthy resumable parents [AC:durable-tx-tree-and-ui#AC-1]', () => {
    const journal = new MemoryDurableJournal();

    // Dead parent -> child -> grandchild (all descendants must be abandoned)
    journal.beginRun({ runId: 'run_dead_parent', sessionId: 'sess_dp' });
    journal.updateRun('run_dead_parent', { status: 'failed', errorText: 'crash' });
    journal.beginRun({ runId: 'run_orphan_child', sessionId: 'sess_oc', parentRunId: 'run_dead_parent' });
    journal.beginRun({ runId: 'run_orphan_grand', sessionId: 'sess_og', parentRunId: 'run_orphan_child' });
    const dispStep = journal.planStep({
      runId: 'run_orphan_child',
      sessionId: 'sess_oc',
      turn: 0,
      waveIndex: 0,
      kind: 'tool_call',
      toolCallId: 'tc_disp',
      toolName: 'work',
      idempotencyKey: 'k_disp',
      effectClass: 'workspace_fs',
      replayPolicy: 'unsafe',
      argsHash: 'h_disp',
    });
    journal.markStepDispatched(dispStep.stepId);

    // Parent with unsafe unknown step -> its active child must also be abandoned
    journal.beginRun({ runId: 'run_unsafe_parent', sessionId: 'sess_up' });
    journal.updateRun('run_unsafe_parent', { status: 'resumable' });
    const unsafeStep = journal.planStep({
      runId: 'run_unsafe_parent',
      sessionId: 'sess_up',
      turn: 0,
      waveIndex: 0,
      kind: 'tool_call',
      toolCallId: 'tc_u',
      toolName: 'pay',
      idempotencyKey: 'k_u',
      effectClass: 'external_irreversible',
      replayPolicy: 'unsafe',
      argsHash: 'h_u',
    });
    journal.markStepUnknown(unsafeStep.stepId, 'process_interrupted');
    journal.beginRun({ runId: 'run_unsafe_child', sessionId: 'sess_uc', parentRunId: 'run_unsafe_parent' });

    // Healthy resumable parent -> child should stay resumable
    journal.beginRun({ runId: 'run_ok_parent', sessionId: 'sess_okp' });
    journal.updateRun('run_ok_parent', { status: 'resumable' });
    journal.beginRun({ runId: 'run_ok_child', sessionId: 'sess_okc', parentRunId: 'run_ok_parent' });
    journal.updateRun('run_ok_child', { status: 'resumable' });

    const abandoned = abandonOrphanChildRunsOnBoot(journal);
    const abandonedIds = abandoned.map((r) => r.runId).sort();

    expect(abandonedIds).toEqual(['run_orphan_child', 'run_orphan_grand', 'run_unsafe_child']);
    expect(journal.getRun('run_orphan_child')?.status).toBe('aborted');
    expect(journal.getRun('run_orphan_child')?.errorText).toBe('abandoned_on_restart');
    expect(journal.getStep(dispStep.stepId)?.phase).toBe('unknown');
    expect(journal.getRun('run_orphan_grand')?.status).toBe('aborted');
    expect(journal.getRun('run_unsafe_child')?.status).toBe('aborted');
    expect(journal.getRun('run_ok_child')?.status).toBe('resumable');
  });
});
