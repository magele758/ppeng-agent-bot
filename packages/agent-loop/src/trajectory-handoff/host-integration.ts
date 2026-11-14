/**
 * Trajectory handoff enablement.
 * Production default is off. Explicit enable is capabilityTiers enabled
 * (source explicit_on) or metadata.trajectoryHandoffExplicit, and neither
 * overrides an explicit close.
 * The turn kernel and the tool-loop entry call trajectoryHandoffGateFromMetadata.
 */

import type { SessionRecord } from '../types.js';
import type { ResolvedCapabilityTiers } from './types.js';
import { classifyEnablement, parseCapabilityTiers, type EnablementSource } from './config.js';

export function distinguishEnablementSource(
  metadata: Record<string, unknown> | undefined
): EnablementSource {
  return classifyEnablement(metadata?.capabilityTiers);
}

/** True only for an explicit open. Parser default and auto_policy stay off. */
export function handoffRuntimeEnabled(metadata: Record<string, unknown> | undefined): boolean {
  const source = distinguishEnablementSource(metadata);
  if (source === 'explicit_off') return false;
  if (source === 'explicit_on') return true;
  return metadata?.trajectoryHandoffExplicit === true;
}

export function checkHandoffEnabled(session: SessionRecord): ResolvedCapabilityTiers | null {
  const metadata = session.metadata;
  if (!handoffRuntimeEnabled(metadata)) return null;
  const parsed = parseCapabilityTiers(metadata?.capabilityTiers);
  if (!parsed.ok || !parsed.resolved.enabled) return null;
  return parsed.resolved;
}
