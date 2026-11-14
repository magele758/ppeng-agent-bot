/**
 * Trajectory handoff enablement.
 * mechanism_off keeps the old tool path. auto_eligible allows pure reads until
 * a controlled tool or a task-mode user turn enters planner_readonly.
 * in_machine runs the state machine. Explicit off wins. Missing tiers stay off.
 * The turn kernel calls trajectoryHandoffGateFromMetadata.
 */

import type { SessionRecord } from '../types.js';
import { classifyEnablement, parseCapabilityTiers, type EnablementSource } from './config.js';
import { DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP, type ResolvedCapabilityTiers } from './types.js';

export type HandoffRuntimePath = 'mechanism_off' | 'auto_eligible' | 'in_machine';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function policySource(metadata: Record<string, unknown> | undefined): string | undefined {
  const source = asRecord(metadata?.handoffEnablement)?.source;
  return typeof source === 'string' ? source : undefined;
}

/**
 * Tiers explicit_off wins. Otherwise session flags and handoffEnablement.source
 * apply. A non-object capabilityTiers block does not strip auto_policy.
 */
export function distinguishEnablementSource(
  metadata: Record<string, unknown> | undefined,
): EnablementSource {
  const tiers = asRecord(metadata?.capabilityTiers);
  const tierSource = tiers ? classifyEnablement(tiers) : undefined;
  if (tierSource === 'explicit_off') return 'explicit_off';

  const policy = policySource(metadata);
  const mode = metadata?.taskRunMode ?? metadata?.task_run_mode;
  if (metadata?.trajectoryHandoff === 'off' || mode === 'handoff_off' || policy === 'explicit_off') {
    return 'explicit_off';
  }
  if (
    metadata?.trajectoryHandoff === 'on'
    || metadata?.trajectoryHandoffExplicit === true
    || mode === 'plan_execute'
    || tierSource === 'explicit_on'
    || policy === 'explicit_on'
  ) {
    return 'explicit_on';
  }
  if (policy === 'auto_policy' || tierSource === 'auto_policy') return 'auto_policy';
  return 'parser_default';
}

function machinePresent(metadata: Record<string, unknown> | undefined): boolean {
  if (typeof metadata?.handoffState === 'string' && metadata.handoffState.length > 0) return true;
  return asRecord(metadata?.handoffKernel) !== undefined;
}

/** True only while the state machine should run. Auto with no machine stays false. */
export function handoffRuntimeEnabled(metadata: Record<string, unknown> | undefined): boolean {
  if (metadata?.handoffSuspended === 'session_cap') return false;
  const source = distinguishEnablementSource(metadata);
  if (source === 'explicit_on') return true;
  if (source !== 'auto_policy') return false;
  if (metadata?.handoffWorkTurn === true) return true;
  return machinePresent(metadata);
}

/** Persisted auto policy, machine not started, budget suspension not set. */
export function handoffAutoEligible(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata || metadata.handoffSuspended === 'session_cap') return false;
  if (metadata.handoffWorkTurn === true || machinePresent(metadata)) return false;
  return distinguishEnablementSource(metadata) === 'auto_policy';
}

export function handoffRuntimePath(metadata: Record<string, unknown> | undefined): HandoffRuntimePath {
  if (handoffRuntimeEnabled(metadata)) return 'in_machine';
  if (handoffAutoEligible(metadata)) return 'auto_eligible';
  return 'mechanism_off';
}

export function checkHandoffEnabled(session: SessionRecord): ResolvedCapabilityTiers | null {
  const metadata = session.metadata;
  if (handoffRuntimePath(metadata) !== 'in_machine') return null;
  const parsed = parseCapabilityTiers(metadata?.capabilityTiers);
  if (parsed.ok) return parsed.resolved;
  const source = distinguishEnablementSource(metadata);
  return {
    enabled: source === 'explicit_on',
    enablementSource: source,
    plannerModel: null,
    executorModel: null,
    perSessionCap: DEFAULT_SESSION_CAP,
    perTurnCap: DEFAULT_TURN_CAP,
    inheritModelOverride: false,
  };
}
