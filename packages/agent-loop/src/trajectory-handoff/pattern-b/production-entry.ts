/**
 * Pattern B production entry. Hard-closed.
 * Not a config flag, not an environment switch, not a worker claim.
 */
import type { BoundaryDecision } from './types.js';
import { PATTERN_B_PRODUCTION_ENTRY } from './types.js';

export const PATTERN_B_PRODUCTION_ENTRY_OPEN = false as const;

export function patternBProductionEntryOpen(): false {
  return PATTERN_B_PRODUCTION_ENTRY_OPEN;
}

/** Production tool path consults only this. It never admits a write. */
export function admitProductionWrite(): BoundaryDecision {
  if (PATTERN_B_PRODUCTION_ENTRY !== 'closed' || patternBProductionEntryOpen() !== false) {
    return {
      allowed: false,
      code: 'entry_closed',
      reason: 'Pattern B production entry is closed',
    };
  }
  return {
    allowed: false,
    code: 'entry_closed',
    reason: 'Pattern B production entry is closed',
  };
}
