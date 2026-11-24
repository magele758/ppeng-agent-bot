/**
 * High-level session rollback, Saga compensation, reconcile, and operator
 * resolution services for Durable Control Plane.
 * Bridges DurableJournal + SagaRunner + WorkspaceTx + SurfaceStore tail folding.
 * Every helper kept at CC <= 5.
 */

import {
  foldRolledBackTail,
  formatTxRolledBackNotice,
  pairedToolCallIdsFromMessages,
  reconcileUnknownStepsForRun,
  runDurableSagaRollback,
  type CompensationSpec,
  type DurableRunRecord,
  type DurableStepRecord,
  type RunContext,
  type ToolContract,
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
  tools?: readonly ToolContract<any>[];
  buildContext?: (step: DurableStepRecord) => RunContext;
}

export interface SessionRollbackOutcome {
  ok: boolean;
  blockedByPivot?: boolean;
  runId?: string;
  checkpointLabel?: string;
  restoredFiles: string[];
  removedFiles: string[];
  conflicts: WorkspaceRollbackConflict[];
  compensatedStepIds: string[];
  failedStepIds: Array<{ stepId: string; error: string }>;
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
  const idx = stepId ? steps.findIndex((s) => s.stepId === stepId) : -1;
  const step = idx >= 0 ? steps[idx] : undefined;
  const affectedSteps = idx >= 0 ? steps.slice(idx) : [...steps];
  if (!scope) {
    return {
      afterSeq: idx > 0 ? steps[idx - 1]?.messageSeq : findSeqBeforeFirstStep(steps),
      label: step ? `step:${step.stepId} (turn ${step.turn})` : 'baseline',
      affectedSteps,
    };
  }
  const sp = step?.snapshotRef ? workspaceTx.getSavepoint(scope.scopeId, step.snapshotRef) : scope.baseline;
  return {
    savepoint: sp ?? scope.baseline,
    afterSeq: idx > 0 ? steps[idx - 1]?.messageSeq : findSeqBeforeFirstStep(steps),
    label: step ? `step:${step.stepId} (turn ${step.turn})` : `scope:${scope.scopeId}:baseline`,
    affectedSteps,
  };
}

function findSeqBeforeFirstStep(steps: readonly DurableStepRecord[]): number | undefined {
  for (const s of steps) {
    if (typeof s.messageSeq === 'number' && s.messageSeq > 1) return s.messageSeq - 1;
  }
  return undefined;
}

function buildToolCompensationExecutor(
  tools: readonly ToolContract<any>[] | undefined,
  buildContext: ((step: DurableStepRecord) => RunContext) | undefined
) {
  const byName = new Map((tools ?? []).map((t) => [t.name, t]));
  return async (spec: CompensationSpec, step: DurableStepRecord) => {
    const tool = byName.get(spec.toolName);
    if (!tool?.executeCompensation || !buildContext) {
      return { ok: false, error: `No compensation executor registered for ${spec.toolName}` };
    }
    return tool.executeCompensation(buildContext(step), spec);
  };
}

/**
 * Roll back a session's external compensatable effects (LIFO Saga) and
 * workspace files (WorkspaceTx) to a checkpoint or baseline, honoring the
 * Pivot guard and folding the tail into a `[tx_rolled_back]` notice.
 */
export async function rollbackSessionToStep(
  store: SqliteStateStore,
  workspaceTx: CompositeWorkspaceTxManager,
  input: SessionRollbackInput
): Promise<SessionRollbackOutcome> {
  const run = store.durableJournal.getLatestRunForSession(input.sessionId);
  if (!run) {
    return {
      ok: false,
      restoredFiles: [],
      removedFiles: [],
      conflicts: [],
      compensatedStepIds: [],
      failedStepIds: [],
      folded: false,
      error: 'No durable run found for session',
    };
  }

  const steps = store.durableJournal.listSteps(run.runId);
  const resolved = resolveTargetSavepoint(workspaceTx, run, steps, input.stepId);
  let wbResult: { ok: boolean; restoredFiles: string[]; removedFiles: string[]; conflicts: WorkspaceRollbackConflict[] } = {
    ok: true,
    restoredFiles: [],
    removedFiles: [],
    conflicts: [],
  };

  const saga = await runDurableSagaRollback({
    journal: store.durableJournal,
    runId: run.runId,
    targetStepId: input.stepId,
    force: input.force,
    executeCompensation: buildToolCompensationExecutor(input.tools, input.buildContext),
    rollbackWorkspace: async () => {
      if (run.txScopeId && resolved.savepoint) {
        wbResult = await workspaceTx.rollbackTo(run.txScopeId, resolved.savepoint, { force: input.force });
      }
      return { ok: wbResult.ok, conflictsCount: wbResult.conflicts.length };
    },
  });

  if (saga.blockedByPivot) {
    return {
      ok: false,
      blockedByPivot: true,
      runId: run.runId,
      checkpointLabel: resolved.label,
      restoredFiles: [],
      removedFiles: [],
      conflicts: [],
      compensatedStepIds: [],
      failedStepIds: [],
      folded: false,
      error: saga.error,
    };
  }

  markWorkspaceStepsCompensated(store, resolved.affectedSteps);
  const notice = formatTxRolledBackNotice({
    checkpointLabel: resolved.label,
    trigger: input.reason ?? 'user_rollback',
    restoredFiles: wbResult.restoredFiles,
    removedFiles: wbResult.removedFiles,
    conflicts: wbResult.conflicts,
    compensatedExternal: saga.compensatedStepIds,
  });

  const fold = foldRolledBackTail(store, input.sessionId, {
    afterSeq: resolved.afterSeq,
    notice,
  });

  return {
    ok: saga.ok,
    runId: run.runId,
    checkpointLabel: resolved.label,
    restoredFiles: wbResult.restoredFiles,
    removedFiles: wbResult.removedFiles,
    conflicts: wbResult.conflicts,
    compensatedStepIds: saga.compensatedStepIds,
    failedStepIds: saga.failedStepIds,
    folded: fold.folded,
    notice,
  };
}

function markWorkspaceStepsCompensated(store: SqliteStateStore, steps: readonly DurableStepRecord[]): void {
  for (const step of steps) {
    if (step.phase === 'committed' && step.effectClass === 'workspace_fs') {
      store.durableJournal.updateStepPhase(step.stepId, 'compensated');
    }
  }
}

export function buildSyntheticStepContext(input: {
  store: SqliteStateStore;
  sessionId: string;
  repoRoot: string;
  stateDir: string;
  step: DurableStepRecord;
}): RunContext {
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new Error(`Session not found: ${input.sessionId}`);
  const agent = input.store.getAgent(session.agentId) ?? {
    id: session.agentId,
    name: session.agentId,
    role: 'assistant',
    instructions: '',
    capabilities: [],
  };
  return {
    repoRoot: input.repoRoot,
    stateDir: input.stateDir,
    session,
    agent,
    workspaceRoot: input.repoRoot,
    durableRunId: input.step.runId,
    durableTurn: input.step.turn,
    durableStepId: input.step.stepId,
  };
}

/**
 * Reconciles unknown steps for a session's latest run using tool `reconcile()` probes.
 */
export async function reconcileSessionUnknownSteps(input: {
  store: SqliteStateStore;
  sessionId: string;
  repoRoot: string;
  stateDir: string;
  tools: readonly ToolContract<any>[];
}) {
  const run = input.store.durableJournal.getLatestRunForSession(input.sessionId);
  if (!run) {
    return { runId: undefined, committedStepIds: [], notAppliedStepIds: [], unresolvedStepIds: [] };
  }
  const res = await reconcileUnknownStepsForRun({
    journal: input.store.durableJournal,
    runId: run.runId,
    tools: input.tools,
    buildContext: (step) =>
      buildSyntheticStepContext({
        store: input.store,
        sessionId: input.sessionId,
        repoRoot: input.repoRoot,
        stateDir: input.stateDir,
        step,
      }),
    persistReconciledResult: (step, result) =>
      persistOpenToolResultIfUnpaired(input.store, input.sessionId, step, result),
  });
  return { runId: run.runId, ...res };
}

function persistOpenToolResultIfUnpaired(
  store: SqliteStateStore,
  sessionId: string,
  step: DurableStepRecord,
  result: { ok: boolean; content: string }
): number | undefined {
  if (!step.toolCallId) return undefined;
  const paired = pairedToolCallIdsFromMessages(store.foldMessages(sessionId));
  if (paired.has(step.toolCallId)) return step.messageSeq;
  const msg = store.appendMessage(sessionId, 'tool', [
    {
      type: 'tool_result',
      toolCallId: step.toolCallId,
      name: step.toolName ?? 'unknown',
      ok: result.ok,
      content: result.content,
    },
  ]);
  return typeof msg.seq === 'number' ? msg.seq : undefined;
}

/**
 * Operator resolution of an `unknown` or `compensation_failed` durable step.
 */
export function resolveDurableStepManually(
  store: SqliteStateStore,
  input: { sessionId: string; stepId: string; decision: 'committed' | 'not_applied'; note?: string }
): { ok: boolean; step?: DurableStepRecord; runStatus?: DurableRunRecord['status']; error?: string } {
  const step = store.durableJournal.getStep(input.stepId);
  if (!step || step.sessionId !== input.sessionId) {
    return { ok: false, error: 'Durable step not found for session' };
  }
  const text = input.note?.trim() || (input.decision === 'committed' ? '[operator] confirmed applied' : '[operator] confirmed not applied');
  const seq = persistOpenToolResultIfUnpaired(store, input.sessionId, step, {
    ok: input.decision === 'committed',
    content: text,
  });
  const updated =
    input.decision === 'committed'
      ? store.durableJournal.commitStep(step.stepId, { messageSeq: seq, receipt: { operatorResolved: true, note: text } })
      : store.durableJournal.failStep(step.stepId, text, { messageSeq: seq });

  const remaining = store.durableJournal
    .listSteps(step.runId)
    .filter((s) => s.phase === 'unknown' || s.phase === 'compensation_failed');
  const run = store.durableJournal.getRun(step.runId);
  let runStatus = run?.status;
  if (run && run.status === 'needs_reconcile' && remaining.length === 0) {
    runStatus = store.durableJournal.updateRun(run.runId, { status: 'resumable' }).status;
  }
  return { ok: true, step: updated, runStatus };
}
