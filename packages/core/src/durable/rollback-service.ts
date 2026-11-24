/**
 * High-level session rollback & checkpoint fork services for Durable Control Plane.
 * Bridges DurableJournal + CompositeWorkspaceTxManager + SurfaceStore tail folding.
 * Every helper kept at CC <= 5.
 */

import {
  foldRolledBackTail,
  formatTxRolledBackNotice,
  type DurableRunRecord,
  type DurableStepRecord,
  type WorkspaceRollbackConflict,
  type WorkspaceSavepoint,
} from '@ppeng/agent-loop';
import type { SqliteStateStore } from '../storage.js';
import type { CompositeWorkspaceTxManager } from './workspace-tx-manager.js';

export interface SessionRollbackInput {
  sessionId: string;
  stepId?: string;
  force?: boolean;
  reason?: string;
}

export interface SessionRollbackOutcome {
  ok: boolean;
  blockedByPivot?: boolean;
  runId?: string;
  checkpointLabel?: string;
  restoredFiles: string[];
  removedFiles: string[];
  conflicts: WorkspaceRollbackConflict[];
  folded: boolean;
  notice?: string;
  error?: string;
}

function resolveTargetSavepoint(
  workspaceTx: CompositeWorkspaceTxManager,
  run: DurableRunRecord,
  steps: readonly DurableStepRecord[],
  stepId: string | undefined
): { savepoint?: WorkspaceSavepoint; afterSeq?: number; label: string; affectedSteps: DurableStepRecord[] } {
  const scope = run.txScopeId ? workspaceTx.loadScope(run.txScopeId) : undefined;
  if (!scope) {
    return { label: 'baseline', affectedSteps: [...steps] };
  }
  if (!stepId) {
    return {
      savepoint: scope.baseline,
      afterSeq: findSeqBeforeFirstStep(steps),
      label: `scope:${scope.scopeId}:baseline`,
      affectedSteps: [...steps],
    };
  }
  const idx = steps.findIndex((s) => s.stepId === stepId);
  const step = idx >= 0 ? steps[idx] : undefined;
  const sp = step?.snapshotRef ? workspaceTx.getSavepoint(scope.scopeId, step.snapshotRef) : scope.baseline;
  return {
    savepoint: sp ?? scope.baseline,
    afterSeq: idx > 0 ? steps[idx - 1]?.messageSeq : undefined,
    label: step ? `step:${step.stepId} (turn ${step.turn})` : `scope:${scope.scopeId}:baseline`,
    affectedSteps: idx >= 0 ? steps.slice(idx) : [...steps],
  };
}

function findSeqBeforeFirstStep(steps: readonly DurableStepRecord[]): number | undefined {
  for (const s of steps) {
    if (typeof s.messageSeq === 'number' && s.messageSeq > 1) return s.messageSeq - 1;
  }
  return undefined;
}

function hasIrreversibleInRange(steps: readonly DurableStepRecord[]): boolean {
  return steps.some(
    (s) =>
      s.effectClass === 'external_irreversible' &&
      (s.phase === 'dispatched' || s.phase === 'committed' || s.phase === 'unknown')
  );
}

/**
 * Roll back a session's workspace to a saved checkpoint (or run baseline),
 * honoring the Pivot guard and folding the reverted tail into a
 * `[tx_rolled_back]` cognitive-preservation message.
 */
export async function rollbackSessionToStep(
  store: SqliteStateStore,
  workspaceTx: CompositeWorkspaceTxManager,
  input: SessionRollbackInput
): Promise<SessionRollbackOutcome> {
  const run = store.durableJournal.getLatestRunForSession(input.sessionId);
  if (!run) {
    return { ok: false, restoredFiles: [], removedFiles: [], conflicts: [], folded: false, error: 'No durable run found for session' };
  }
  const steps = store.durableJournal.listSteps(run.runId);
  const resolved = resolveTargetSavepoint(workspaceTx, run, steps, input.stepId);

  if (run.passedPivot && hasIrreversibleInRange(resolved.affectedSteps) && !input.force) {
    return {
      ok: false,
      blockedByPivot: true,
      runId: run.runId,
      checkpointLabel: resolved.label,
      restoredFiles: [],
      removedFiles: [],
      conflicts: [],
      folded: false,
      error: 'pivot_blocked: rollback range includes an irreversible external step',
    };
  }

  store.durableJournal.updateRun(run.runId, { status: 'rolling_back' });
  const wbResult =
    run.txScopeId && resolved.savepoint
      ? await workspaceTx.rollbackTo(run.txScopeId, resolved.savepoint, { force: input.force })
      : { ok: true, restoredFiles: [], removedFiles: [], conflicts: [] };

  const notice = formatTxRolledBackNotice({
    checkpointLabel: resolved.label,
    trigger: input.reason ?? 'user_rollback',
    restoredFiles: wbResult.restoredFiles,
    removedFiles: wbResult.removedFiles,
    conflicts: wbResult.conflicts,
  });

  const fold = foldRolledBackTail(store, input.sessionId, {
    afterSeq: resolved.afterSeq,
    notice,
  });

  markRolledBackSteps(store, resolved.affectedSteps);
  store.durableJournal.updateRun(run.runId, {
    status: wbResult.conflicts.length > 0 ? 'needs_reconcile' : 'rolled_back',
  });

  return {
    ok: wbResult.ok,
    runId: run.runId,
    checkpointLabel: resolved.label,
    restoredFiles: wbResult.restoredFiles,
    removedFiles: wbResult.removedFiles,
    conflicts: wbResult.conflicts,
    folded: fold.folded,
    notice,
  };
}

function markRolledBackSteps(store: SqliteStateStore, steps: readonly DurableStepRecord[]): void {
  for (const step of steps) {
    if (step.phase === 'committed' && step.effectClass === 'workspace_fs') {
      store.durableJournal.updateStepPhase(step.stepId, 'compensated');
    }
  }
}
