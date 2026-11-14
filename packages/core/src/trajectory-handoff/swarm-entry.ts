/**
 * Independent Swarm handoff admission.
 * Only a trusted host context can open the entry. Worker metadata is ignored.
 * Flywheel orchestration stays closed. explicit off wins over the entry switch.
 */
import { createInitialKernelState } from '@ppeng/agent-loop';
import { qualityPassed } from '../quality/gate.js';
import type { SwarmRun } from '../swarm/types.js';

export interface TrustedSwarmHostContext {
  readonly source?: unknown;
  readonly explicitOff?: boolean;
  readonly entryEnabled?: boolean;
  readonly orchestrationRunId?: string | null;
}

export type SwarmAdmission =
  | { readonly open: true; readonly source: 'independent_swarm' }
  | {
      readonly open: false;
      readonly reason:
        | 'no_trusted_context'
        | 'explicit_off'
        | 'swarm_entry_closed'
        | 'flywheel_orchestration'
        | 'flywheel_source'
        | 'source_not_admitted';
    };

export function trustedContextForSwarmRun(
  run: Pick<SwarmRun, 'orchestrationRunId'>,
  entryEnabled: boolean,
  explicitOff = false,
): TrustedSwarmHostContext {
  return {
    source: run.orchestrationRunId ? 'flywheel' : 'independent_swarm',
    orchestrationRunId: run.orchestrationRunId ?? null,
    entryEnabled,
    explicitOff,
  };
}

/** Persisted host switch. Missing means the approved independent entry is open. */
export const SWARM_HANDOFF_ENTRY_CONTROL_KEY = 'trajectory-handoff.swarm-entry';

/**
 * Explicit off wins. Unknown or illegal stored values fail closed.
 * A missing value is the knife-3 default: the approved entry is open.
 */
export function readSwarmHandoffEntrySwitch(stored: unknown): {
  readonly enabled: boolean;
  readonly explicitOff: boolean;
} {
  if (stored == null) return { enabled: true, explicitOff: false };
  if (stored === true || stored === 'on') return { enabled: true, explicitOff: false };
  if (stored === false || stored === 'off' || stored === 'explicit_off') {
    return { enabled: false, explicitOff: true };
  }
  if (typeof stored === 'object' && !Array.isArray(stored)) {
    const record = stored as Record<string, unknown>;
    if (record.explicitOff === true || record.enabled === false || record.source === 'explicit_off') {
      return { enabled: false, explicitOff: true };
    }
    if (record.enabled === true) return { enabled: true, explicitOff: false };
  }
  return { enabled: false, explicitOff: true };
}

export function admitSwarmHandoff(input: {
  readonly trusted?: TrustedSwarmHostContext | null;
  readonly workerMetadata?: Record<string, unknown> | null;
}): SwarmAdmission {
  // Worker-writable fields never grant or revoke the host entry.
  void input.workerMetadata;
  const trusted = input.trusted;
  if (!trusted) return { open: false, reason: 'no_trusted_context' };
  if (trusted.explicitOff === true) return { open: false, reason: 'explicit_off' };
  if (trusted.entryEnabled !== true) return { open: false, reason: 'swarm_entry_closed' };
  if (typeof trusted.orchestrationRunId === 'string' && trusted.orchestrationRunId.length > 0) {
    return { open: false, reason: 'flywheel_orchestration' };
  }
  if (trusted.source === 'flywheel') return { open: false, reason: 'flywheel_source' };
  if (trusted.source === 'independent_swarm') return { open: true, source: 'independent_swarm' };
  return { open: false, reason: 'source_not_admitted' };
}

export function admittedSwarmWorkerMetadata(now: string): Record<string, unknown> {
  const kernel = createInitialKernelState({ now });
  return {
    handoffEnablement: { source: 'explicit_on' },
    capabilityTiers: { enablementSource: 'explicit_on', enabled: true },
    handoffState: kernel.state,
    handoffKernel: kernel,
  };
}

const NOT_DELIVERY: Record<string, true> = {
  answered: true,
  capped: true,
  failed: true,
  cancelled: true,
  timed_out: true,
  awaiting_coordinator: true,
};

/** No kernel state, including done, is delivery success by itself. */
export function kernelStateIsDeliverySuccess(_state: string): false {
  return false;
}

export interface DeliveryEvidence {
  readonly planVersion?: unknown;
  readonly taskScope?: unknown;
  readonly verifiedPlanVersion?: unknown;
  readonly verifiedTaskScope?: unknown;
  readonly available?: boolean;
}

export type SwarmDelivery =
  | { readonly success: true; readonly via: 'quality_gate' }
  | { readonly success: false; readonly reason: string };

function isDeliveryEvidence(value: unknown): value is DeliveryEvidence {
  return !!value && typeof value === 'object';
}

export function deliveryEvidenceFromReview(report: unknown): DeliveryEvidence | null {
  if (!report || typeof report !== 'object' || !('handoffEvidence' in report)) return null;
  return isDeliveryEvidence(report.handoffEvidence) ? report.handoffEvidence : null;
}

export function evaluateSwarmDelivery(input: {
  readonly report: unknown;
  readonly kernelState?: string | null;
  readonly evidence?: DeliveryEvidence | null;
  readonly gateInvoked: boolean;
}): SwarmDelivery {
  if (input.gateInvoked !== true) return { success: false, reason: 'gate_not_invoked' };
  if (input.kernelState && NOT_DELIVERY[input.kernelState] === true) {
    return { success: false, reason: 'kernel_not_delivery' };
  }
  const evidence = input.evidence;
  if (!evidence || evidence.available === false) return { success: false, reason: 'missing_evidence' };
  const plan = evidence.planVersion;
  if (typeof plan !== 'number' || !Number.isInteger(plan) || plan <= 0) {
    return { success: false, reason: 'missing_evidence' };
  }
  if (evidence.verifiedPlanVersion !== plan) return { success: false, reason: 'stale_plan_version' };
  if (typeof evidence.taskScope !== 'string' || evidence.taskScope.trim() === '') {
    return { success: false, reason: 'missing_evidence' };
  }
  if (evidence.verifiedTaskScope !== evidence.taskScope) return { success: false, reason: 'task_scope_mismatch' };
  if (!qualityPassed(input.report)) return { success: false, reason: 'quality_gate' };
  return { success: true, via: 'quality_gate' };
}
