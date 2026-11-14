import { describe, expect, it } from 'vitest';
import {
  commitPlanRevision,
  resolveResumeCursor,
  scriptDualModelHandoff,
} from './plan-commit.js';

describe('conditional plan commit', () => {
  it('rejects a mismatched expected version and does not return the next plan', () => {
    const current = { version: 2, analysis: 'kept', steps: [{ id: 's1', title: 'a', status: 'pending' }] };
    const result = commitPlanRevision({
      current,
      expectedOldVersion: 1,
      newVersion: 3,
      next: { version: 3, analysis: 'lost', steps: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
      expect(result.currentVersion).toBe(2);
      expect(result.plan).toEqual(current);
    }
  });
  it('treats a missing version as 0 and skips a side effect that already landed', () => {
    const current = { analysis: 'old', steps: [{ id: 'old', status: 'failed' }] };
    const next = { analysis: 'new', steps: [{ id: 'step-new', status: 'pending' }] };
    const committed = commitPlanRevision({
      current,
      expectedOldVersion: 0,
      newVersion: 1,
      next,
    });
    expect(committed.ok).toBe(true);
    const cursor = resolveResumeCursor({
      steps: [{ id: 'old', status: 'failed' }, { id: 'step-new', status: 'pending' }],
      resumeFromStepId: 'old',
      applied: [{ stepId: 'old', dedupeId: 'd1', attemptId: 'a1', sideEffect: true }],
      dedupeId: 'd2',
      attemptId: 'a2',
    });
    expect(cursor.action).toBe('skip');
    expect(cursor.stepId).toBe('step-new');
  });
});

describe('scripted dual-model handoff', () => {
  it('carries plan version, tool pair, effect, and failure evidence onto the new cursor [AC:trajectory-handoff-explicit#TH-9]', () => {
    const handoff = scriptDualModelHandoff();
    expect(handoff.planVersion).toBe(2);
    expect(handoff.plannerModel).not.toBe(handoff.executorModel);
    expect(handoff.pack.toolPairs).toEqual([
      { callId: 'c1', name: 'read_file', ok: true, result: 'file body' },
    ]);
    expect(handoff.pack.completedEffects).toEqual([
      { stepId: 'step-old', dedupeId: 'd1', attemptId: 'a1' },
    ]);
    expect(handoff.pack.failureEvidence).toEqual({ stepId: 'step-old', evidence: 'command exited 1' });
    expect(handoff.resumedStepId).toBe('step-new');
    expect(handoff.skippedDuplicate).toBe(true);
    expect(handoff.sameMachine).toBe(true);
  });
});
