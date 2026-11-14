/**
 * Conditional plan publish and resume cursor.
 * Old plans with no version are version 0 (no accepted plan). A mismatched
 * expectedOldVersion never returns or writes the next plan.
 */

export type ResumePolicyName =
  | 'skip_if_effect_done'
  | 'retry_idempotent'
  | 'compensate_then_retry'
  | 'replace_with_new_steps'
  | 'escalate';

export interface ResumeStep {
  id: string;
  status?: string;
}

export interface AppliedEffectRecord {
  stepId: string;
  dedupeId: string;
  attemptId: string;
  sideEffect: boolean;
}

export interface HandoffContextPack {
  planVersion: number;
  fromRole: 'planner' | 'executor';
  toRole: 'planner' | 'executor';
  fromModel: string;
  toModel: string;
  toolPairs: Array<{ callId: string; name: string; ok: boolean; result: string }>;
  completedEffects: Array<{ stepId: string; dedupeId: string; attemptId: string }>;
  failureEvidence?: { stepId: string; evidence: string };
}

export function acceptedPlanVersion(plan: object | null | undefined): number {
  const version = plan && 'version' in plan ? plan.version : undefined;
  return typeof version === 'number' && Number.isFinite(version) && version > 0 ? Math.floor(version) : 0;
}

export function commitPlanRevision<T extends object>(input: {
  current: T | null;
  expectedOldVersion: number;
  newVersion: number;
  next: T;
}): { ok: true; plan: T } | { ok: false; conflict: true; currentVersion: number; plan: T | null } {
  const currentVersion = acceptedPlanVersion(input.current);
  if (currentVersion !== input.expectedOldVersion || !(input.newVersion > input.expectedOldVersion)) {
    return { ok: false, conflict: true, currentVersion, plan: input.current };
  }
  return { ok: true, plan: { ...input.next, version: input.newVersion } };
}

/**
 * A resume id that the new plan dropped is not reused. Failed steps that
 * already applied a side effect are not rerun unless the policy is
 * retry_idempotent. The same dedupeId + attemptId is never applied twice.
 */
export function resolveResumeCursor(input: {
  steps: readonly ResumeStep[];
  resumeFromStepId?: string;
  resumePolicy?: ResumePolicyName;
  applied: readonly AppliedEffectRecord[];
  dedupeId: string;
  attemptId: string;
}): { action: 'skip' | 'run' | 'blocked'; stepId: string | null; reason: string } {
  const known = new Set(input.steps.map((step) => step.id));
  const fallback = input.steps.find((step) => step.status !== 'completed' && step.status !== 'failed')?.id
    ?? input.steps.find((step) => step.status !== 'completed')?.id
    ?? null;
  const stepId = input.resumeFromStepId && known.has(input.resumeFromStepId)
    ? input.resumeFromStepId
    : fallback;
  if (!stepId) return { action: 'blocked', stepId: null, reason: 'no resume cursor' };

  const duplicate = input.applied.some((effect) =>
    effect.stepId === stepId && effect.dedupeId === input.dedupeId && effect.attemptId === input.attemptId
  );
  if (duplicate) {
    return { action: 'skip', stepId, reason: 'same dedupeId and attemptId already applied' };
  }

  const sideEffect = input.applied.some((effect) => effect.stepId === stepId && effect.sideEffect);
  const policy = input.resumePolicy ?? 'skip_if_effect_done';
  if (sideEffect && policy !== 'retry_idempotent') {
    if (policy === 'escalate' || policy === 'compensate_then_retry') {
      return {
        action: 'blocked',
        stepId,
        reason: `${policy}: refusing to rerun a step that already applied a side effect`,
      };
    }
    const next = input.steps.find((step) => step.id !== stepId && step.status !== 'completed' && step.status !== 'failed');
    return {
      action: 'skip',
      stepId: next?.id ?? stepId,
      reason: 'side effect already applied; not rerunning the failed step',
    };
  }
  return { action: 'run', stepId, reason: sideEffect ? 'idempotent retry' : 'resume cursor' };
}

export function roundTripHandoffContext(pack: HandoffContextPack): HandoffContextPack {
  return JSON.parse(JSON.stringify(pack)) as HandoffContextPack;
}

/**
 * Scripted planner → executor handoff. Continuity is the context pack
 * (plan version, tool pairs, effects, failure evidence), not the model name.
 * The same pack shape is what a same-model handoff would carry.
 */
export function scriptDualModelHandoff(): {
  sameMachine: boolean;
  plannerModel: string;
  executorModel: string;
  pack: HandoffContextPack;
  resumedStepId: string;
  skippedDuplicate: boolean;
  planVersion: number;
} {
  const plannerModel = 'provider-a/planner';
  const executorModel = 'provider-b/executor';
  const failedStep = 'step-old';
  const newStep = 'step-new';
  const committed = commitPlanRevision({
    current: { version: 1, steps: [{ id: failedStep, status: 'failed' }] },
    expectedOldVersion: 1,
    newVersion: 2,
    next: { version: 2, steps: [{ id: newStep, status: 'pending' }] },
  });
  if (!committed.ok) throw new Error('scripted plan commit conflicted');
  const cursor = resolveResumeCursor({
    steps: committed.plan.steps,
    resumeFromStepId: failedStep,
    applied: [{ stepId: failedStep, dedupeId: 'd1', attemptId: 'a1', sideEffect: true }],
    dedupeId: 'd2',
    attemptId: 'a2',
  });
  const duplicate = resolveResumeCursor({
    steps: [{ id: newStep, status: 'pending' }],
    resumeFromStepId: newStep,
    applied: [{ stepId: newStep, dedupeId: 'd1', attemptId: 'a1', sideEffect: false }],
    dedupeId: 'd1',
    attemptId: 'a1',
  });
  const pack = roundTripHandoffContext({
    planVersion: committed.plan.version ?? 0,
    fromRole: 'planner',
    toRole: 'executor',
    fromModel: plannerModel,
    toModel: executorModel,
    toolPairs: [{ callId: 'c1', name: 'read_file', ok: true, result: 'file body' }],
    completedEffects: [{ stepId: failedStep, dedupeId: 'd1', attemptId: 'a1' }],
    failureEvidence: { stepId: failedStep, evidence: 'command exited 1' },
  });
  const sameModel = { ...pack, toModel: plannerModel };
  return {
    sameMachine: pack.planVersion === sameModel.planVersion
      && pack.toolPairs.length === sameModel.toolPairs.length
      && pack.completedEffects.length === sameModel.completedEffects.length
      && Boolean(pack.failureEvidence)
      && cursor.stepId === newStep,
    plannerModel,
    executorModel,
    pack,
    resumedStepId: cursor.stepId ?? '',
    skippedDuplicate: duplicate.action === 'skip',
    planVersion: pack.planVersion,
  };
}
