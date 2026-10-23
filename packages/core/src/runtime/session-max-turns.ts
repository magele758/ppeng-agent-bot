/**
 * Single-execution step cap: 0 means unlimited; 24 / 48 / 96 remain supported.
 * Missing Bot metadata uses unlimited; ordinary sessions retain their global default.
 */

import { ValidationError } from '../errors.js';
import { BOT_DEFAULT_MAX_TURNS } from '../bots/types.js';

export const SESSION_MAX_TURNS_CHOICES = [0, 24, 48, 96] as const;
export type SessionMaxTurns = (typeof SESSION_MAX_TURNS_CHOICES)[number];

export function isSessionMaxTurns(value: unknown): value is SessionMaxTurns {
  return value === 0 || value === 24 || value === 48 || value === 96;
}

/** Reject anything other than 0, 24, 48, or 96. Numeric strings of those values are accepted. */
export function parseSessionMaxTurns(raw: unknown): SessionMaxTurns {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw.trim())
        : Number.NaN;
  if (isSessionMaxTurns(n)) return n;
  throw new ValidationError('maxTurns must be 0 (unlimited), 24, 48, or 96');
}

/**
 * Turn cap the kernel should run. Missing or illegal stored values use
 * the Bot default or ordinary-session `fallback`: writes are validated at the API boundary, and a
 * bad value that slipped in must not make the session unrunnable.
 */
export function resolveSessionMaxTurns(
  metadata: Record<string, unknown> | undefined,
  fallback: number
): number {
  const defaultCap = typeof metadata?.botId === 'string' ? BOT_DEFAULT_MAX_TURNS : fallback;
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, 'maxTurns')) {
    return defaultCap;
  }
  try {
    return parseSessionMaxTurns(metadata.maxTurns);
  } catch {
    return defaultCap;
  }
}
