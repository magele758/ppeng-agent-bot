/**
 * Trajectory Handoff v2.3 — host integration flag and adapter wiring stub.
 * 
 * This module provides the explicit enable flag for trajectory handoff.
 * Production default is OFF. Tests can enable explicitly via session metadata.
 * 
 * NOT YET WIRED INTO TURN KERNEL. This is a placeholder for the host entry point.
 * Full integration requires:
 * - Wiring into turn/kernel.ts to call adapter methods
 * - Unique tool-execution entry with permission enforcement
 * - Planner readonly enforcement via effective permission intersection
 * - Session metadata persistence for capabilityTiers
 */

import type { SessionRecord } from '../types.js';
import type { ResolvedCapabilityTiers } from './types.js';
import { parseCapabilityTiersOrNull } from './config.js';

/**
 * Check if trajectory handoff is explicitly enabled for this session.
 * 
 * Returns null if disabled or config invalid.
 * Returns resolved config if explicitly enabled.
 * 
 * PRODUCTION DEFAULT: Returns null (disabled) when capabilityTiers is missing.
 * This preserves "old sessions default off, new sessions default off until knife-2".
 */
export function checkHandoffEnabled(
  session: SessionRecord
): ResolvedCapabilityTiers | null {
  const metadata = session.metadata;
  if (!metadata) return null;

  // Parse capabilityTiers from metadata
  const resolved = parseCapabilityTiersOrNull(metadata.capabilityTiers);
  
  // null = disabled, parsing failed, or missing config
  if (!resolved) return null;
  
  // Only return config if explicitly enabled
  if (!resolved.enabled) return null;
  
  return resolved;
}

/**
 * Reserved: stub for distinguishing parser-default-false from user-explicit-false.
 * 
 * The current implementation in config.ts returns enabled:false for missing config.
 * Knife-2 (production default-on) will need to distinguish:
 * - Missing config + old session → false (old session default off)
 * - Missing config + new session → true (new session default on)
 * - Explicit enabled:false → false (user opted out)
 * 
 * This stub is a placeholder for that future logic.
 */
export function distinguishEnablementSource(
  metadata: Record<string, unknown> | undefined
): 'explicit_off' | 'explicit_on' | 'parser_default' {
  const raw = metadata?.capabilityTiers;
  
  if (!raw || typeof raw !== 'object') {
    return 'parser_default';
  }
  
  const obj = raw as Record<string, unknown>;
  if ('enabled' in obj) {
    return obj.enabled === true ? 'explicit_on' : 'explicit_off';
  }
  
  return 'parser_default';
}
