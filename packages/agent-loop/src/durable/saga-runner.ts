/**
 * Crash-safe Persistent Declarative Saga Runner (LIFO Compensation + Pivot Guard).
 * Zero Node I/O (mini-safe). Every helper kept at CC <= 5.
 */

import type {
  CompensationSpec,
  DurableJournalPort,
  DurableRunRecord,
  DurableStepRecord,
} from './types.js';

export interface CompensationExecOutcome {
  ok: boolean;
  alreadyUndone?: boolean;
  error?: string;
}

export type CompensationExecutor = (
  spec: CompensationSpec,
  step: DurableStepRecord
) => Promise<CompensationExecOutcome>;

export interface DurableSagaRollbackInput {
  journal: DurableJournalPort;
  runId: string;
  targetStepId?: string;
  force?: boolean;
  maxRetries?: number;
  executeCompensation: CompensationExecutor;
  rollbackWorkspace?: () => Promise<{ ok: boolean; conflictsCount: number; error?: string }>;
}

export interface DurableSagaRollbackResult {
  ok: boolean;
  blockedByPivot?: boolean;
  runStatus: DurableRunRecord['status'];
  compensatedStepIds: string[];
  alreadyCompensatedStepIds: string[];
  failedStepIds: Array<{ stepId: string; error: string }>;
  workspaceOk: boolean;
  error?: string;
}

function selectRollbackSteps(
  steps: readonly DurableStepRecord[],
  targetStepId?: string
): DurableStepRecord[] {
  if (!targetStepId) return [...steps];
  const idx = steps.findIndex((s) => s.stepId === targetStepId);
  return idx >= 0 ? steps.slice(idx) : [...steps];
}

export function rangeCrossesPivot(steps: readonly DurableStepRecord[]): boolean {
  return steps.some(
    (s) =>
      s.effectClass === 'external_irreversible' &&
      (s.phase === 'dispatched' || s.phase === 'committed' || s.phase === 'unknown')
  );
}

function isStepCompensatableNow(step: DurableStepRecord): boolean {
  if (!step.compensationSpec) return false;
  return step.phase === 'committed' || step.phase === 'compensating';
}

async function runCompensationWithRetries(
  step: DurableStepRecord,
  exec: CompensationExecutor,
  maxRetries: number
): Promise<CompensationExecOutcome> {
  let lastError = 'compensation_failed';
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const outcome = await exec(step.compensationSpec!, step);
      if (outcome.ok || outcome.alreadyUndone) return { ok: true, alreadyUndone: outcome.alreadyUndone };
      lastError = outcome.error ?? 'compensation returned ok=false';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Executes crash-safe LIFO Saga compensation for persisted JSON CompensationSpecs,
 * enforcing the Pivot guard and leaving durable state resumable if killed mid-rollback.
 */
export async function runDurableSagaRollback(
  input: DurableSagaRollbackInput
): Promise<DurableSagaRollbackResult> {
  const run = input.journal.getRun(input.runId);
  if (!run) {
    return {
      ok: false,
      runStatus: 'failed',
      compensatedStepIds: [],
      alreadyCompensatedStepIds: [],
      failedStepIds: [],
      workspaceOk: false,
      error: `Durable run not found: ${input.runId}`,
    };
  }

  const allSteps = input.journal.listSteps(input.runId);
  const affected = selectRollbackSteps(allSteps, input.targetStepId);

  if ((run.passedPivot || rangeCrossesPivot(affected)) && rangeCrossesPivot(affected) && !input.force) {
    return {
      ok: false,
      blockedByPivot: true,
      runStatus: run.status,
      compensatedStepIds: [],
      alreadyCompensatedStepIds: [],
      failedStepIds: [],
      workspaceOk: true,
      error: 'pivot_blocked: rollback range crosses an external_irreversible step',
    };
  }

  input.journal.updateRun(input.runId, { status: 'rolling_back' });

  const compensatedStepIds: string[] = [];
  const alreadyCompensatedStepIds: string[] = [];
  const failedStepIds: Array<{ stepId: string; error: string }> = [];
  const maxRetries = Math.max(1, input.maxRetries ?? 3);

  for (let i = affected.length - 1; i >= 0; i -= 1) {
    const step = affected[i]!;
    if (step.phase === 'compensated') {
      alreadyCompensatedStepIds.push(step.stepId);
      continue;
    }
    if (!isStepCompensatableNow(step)) continue;
    input.journal.updateStepPhase(step.stepId, 'compensating');
    const res = await runCompensationWithRetries(step, input.executeCompensation, maxRetries);
    if (res.ok) {
      input.journal.updateStepPhase(step.stepId, 'compensated');
      compensatedStepIds.push(step.stepId);
    } else {
      const errMsg = res.error ?? 'compensation_failed';
      input.journal.updateStepPhase(step.stepId, 'compensation_failed', { errorText: errMsg });
      failedStepIds.push({ stepId: step.stepId, error: errMsg });
    }
  }

  const wsOutcome = input.rollbackWorkspace
    ? await input.rollbackWorkspace()
    : { ok: true, conflictsCount: 0 };

  const hasFailure = failedStepIds.length > 0 || !wsOutcome.ok || wsOutcome.conflictsCount > 0;
  const finalStatus: DurableRunRecord['status'] = hasFailure ? 'needs_reconcile' : 'rolled_back';
  input.journal.updateRun(input.runId, { status: finalStatus });

  return {
    ok: !hasFailure,
    runStatus: finalStatus,
    compensatedStepIds,
    alreadyCompensatedStepIds,
    failedStepIds,
    workspaceOk: wsOutcome.ok,
    ...(wsOutcome.error ? { error: wsOutcome.error } : {}),
  };
}
