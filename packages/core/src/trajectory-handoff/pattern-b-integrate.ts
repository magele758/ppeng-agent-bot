/**
 * Host-only Pattern B integration.
 * Kernel done is not shared delivery. Old evidence is not reused.
 * Unknown results are not replayed. This is not a second handoff loop.
 */
import { createHash } from 'node:crypto';
import type { AuthorizeInput, BindingProof, IntegrationRecord, IntegrationStore, LifecycleStore, StoreResult } from '@ppeng/agent-loop/pattern-b';
import { evaluateSwarmDelivery, type DeliveryEvidence, type SwarmDelivery } from './swarm-entry.js';

export function patternBArtifactVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function patternBBindingProof(input: AuthorizeInput): BindingProof {
  return {
    runId: input.runId,
    workerId: input.workerId,
    planVersion: input.planVersion,
    taskScope: input.taskScope,
    artifactVersion: input.artifactVersion,
    expectedTargetVersion: input.expectedTargetVersion,
  };
}

/** Authorize, then begin. Crash leaves unknown. Commit does not replay unknown. */
export function runHostIntegration(
  store: IntegrationStore,
  input: AuthorizeInput,
  options?: { readonly crash?: boolean; readonly commitAt?: string },
): StoreResult {
  const authorized = store.authorize(input);
  if (!authorized.ok) return authorized;
  const begun = store.begin(input.integrationId, patternBBindingProof(input), input.now);
  if (!begun.ok) return begun;
  if (options?.crash === true) {
    const crashed = store.crashUncommitted(input.integrationId);
    return crashed ? { ok: false, reason: 'fail_closed', record: crashed } : { ok: false, reason: 'fail_closed' };
  }
  return store.commit(input.integrationId, options?.commitAt ?? input.now);
}

function sealMismatch(evidence: Record<string, unknown>, integration: IntegrationRecord): boolean {
  if (evidence.sealedAfterIntegration !== true) return true;
  if (evidence.integrationId !== integration.integrationId) return true;
  if (evidence.artifactVersion !== integration.artifactVersion) return true;
  if (evidence.verifiedTargetVersion !== integration.resultTargetVersion) return true;
  if (String(evidence.planVersion) !== integration.planVersion) return true;
  return evidence.taskScope !== integration.taskScope;
}

/** Accepted integration plus a fresh seal, then the existing #516 gate. */
export function patternBSharedDelivery(input: {
  readonly report: unknown;
  readonly kernelState?: string | null;
  readonly evidence?: Record<string, unknown> | null;
  readonly gateInvoked: boolean;
  readonly integration: IntegrationRecord | undefined;
}): SwarmDelivery {
  if (!input.integration || input.integration.status !== 'accepted') {
    return { success: false, reason: 'integration_not_accepted' };
  }
  if (!input.evidence || sealMismatch(input.evidence, input.integration)) {
    return { success: false, reason: 'stale_evidence' };
  }
  return evaluateSwarmDelivery({
    report: input.report,
    kernelState: input.kernelState,
    evidence: input.evidence as DeliveryEvidence,
    gateInvoked: input.gateInvoked,
  });
}

export type PatternBResume =
  | 'already_done'
  | 'drop_step'
  | 'blocked'
  | 'explicit_resume'
  | 'start';

/** Failed work is not blindly rerun. A replaced plan may drop the old step. */
export function patternBResumeDecision(input: {
  readonly previous: 'failed' | 'unknown' | 'accepted' | 'none';
  readonly resumePolicy: 'no_blind_rerun' | 'explicit';
  readonly previousStepId: string;
  readonly planSteps: readonly string[];
  readonly planChanged: boolean;
}): PatternBResume {
  if (input.previous === 'accepted') return 'already_done';
  if (input.planChanged && !input.planSteps.includes(input.previousStepId)) return 'drop_step';
  if (input.previous === 'failed' || input.previous === 'unknown') {
    return input.resumePolicy === 'explicit' ? 'explicit_resume' : 'blocked';
  }
  return 'start';
}

/** Keep unintegrated work. Do not copy it to the shared target and do not delete it. */
export function patternBRollbackArtifacts(input: {
  readonly lifecycles: LifecycleStore;
  readonly now: string;
}): { readonly retained: readonly string[]; readonly deleted: readonly string[]; readonly copiedToShared: false } {
  const retained: string[] = [];
  for (const record of input.lifecycles.list()) {
    if (record.phase === 'cleaned' || record.discardConfirmed) continue;
    const result = input.lifecycles.retain({
      actor: { kind: 'host' },
      lifecycleId: record.lifecycleId,
      now: input.now,
    });
    if (result.ok) retained.push(result.record.lifecycleId);
  }
  return { retained, deleted: [], copiedToShared: false };
}
