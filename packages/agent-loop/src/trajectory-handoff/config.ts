/**
 * Trajectory Handoff v2.3 — capability tiers config parser.
 *
 * Rules (from spec §Other config rules):
 * - Explicit off has highest priority; do not read tiers; old path.
 * - Whole-block type error: ignore tiers and warn.
 * - Illegal caps (including cap=0): use defaults 3/6, do not turn handoff off.
 * - If perTurn > perSession after validation, clamp perTurn.
 * - Fallback failure is fail-closed.
 * - inheritModelOverride must not pin the executor model onto a planner subtask.
 *
 * Old files parse: configs without capabilityTiers must parse; missing fields
 * use defaults.
 */

import type { CapabilityTiersConfig, ResolvedCapabilityTiers } from './types.js';
import { DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP } from './types.js';

export interface ParseConfigResult {
  readonly ok: true;
  readonly resolved: ResolvedCapabilityTiers;
}
export interface ParseConfigError {
  readonly ok: false;
  readonly warning: string;
}
export type ParseConfigOutput = ParseConfigResult | ParseConfigError;

/**
 * Parse and validate a raw capabilityTiers block from session config.
 *
 * Returns a fully-resolved config with all fields present and validated.
 * If the input is malformed, returns { ok: false, warning: "…" }.
 *
 * @param raw  The capabilityTiers field from the session config (may be
 *             undefined, null, or an object).
 * @returns    A resolved config or an error.  When ok=false, the caller should
 *             ignore tiers and warn; handoff is disabled.
 */
export function parseCapabilityTiers(
  raw: unknown,
): ParseConfigOutput {
  // Missing or null → handoff OFF. Enablement is an explicit policy switch.
  // Old files without capabilityTiers parse cleanly; missing fields use
  // defaults that do NOT turn handoff on.
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      resolved: {
        enabled: false,
        plannerModel: null,
        executorModel: null,
        perSessionCap: DEFAULT_SESSION_CAP,
        perTurnCap: DEFAULT_TURN_CAP,
        inheritModelOverride: false,
      },
    };
  }

  // Explicit off wins.
  if (typeof raw === 'object' && raw !== null && 'enabled' in raw) {
    const enabledRaw = (raw as Record<string, unknown>).enabled;
    if (enabledRaw === false) {
      return {
        ok: true,
        resolved: {
          enabled: false,
          plannerModel: null,
          executorModel: null,
          perSessionCap: DEFAULT_SESSION_CAP,
          perTurnCap: DEFAULT_TURN_CAP,
          inheritModelOverride: false,
        },
      };
    }
  }

  // Whole-block type error: not an object or is an array.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      warning: '[CapabilityTiers] Whole-block type error: expected object, ignoring tiers.',
    };
  }

  const cfg = raw as Partial<CapabilityTiersConfig>;

  // Parse roles.
  let plannerModel: string | null = null;
  let executorModel: string | null = null;
  if (cfg.roles && typeof cfg.roles === 'object') {
    const { plannerModel: pm, executorModel: em } = cfg.roles;
    if (pm !== undefined && pm !== null && typeof pm === 'string' && pm.length > 0) {
      plannerModel = pm;
    }
    if (em !== undefined && em !== null && typeof em === 'string' && em.length > 0) {
      executorModel = em;
    }
  }

  // Parse caps with defaults and validation.
  let perSessionCap = DEFAULT_SESSION_CAP;
  let perTurnCap = DEFAULT_TURN_CAP;
  if (cfg.caps && typeof cfg.caps === 'object') {
    const { perSession, perTurn } = cfg.caps;
    // Illegal caps (<=0) → defaults.
    if (typeof perSession === 'number' && perSession > 0) {
      perSessionCap = Math.floor(perSession);
    }
    if (typeof perTurn === 'number' && perTurn > 0) {
      perTurnCap = Math.floor(perTurn);
    }
  }

  // Clamp perTurn if it exceeds perSession.
  if (perTurnCap > perSessionCap) {
    perTurnCap = perSessionCap;
  }

  const inheritModelOverride = Boolean(cfg.inheritModelOverride);

  // Enablement is an explicit policy switch: missing/absent => false.
  // Illegal caps including 0 => use defaults but do not turn handoff off
  // if it was explicitly on.
  const enabled = cfg.enabled === true;

  return {
    ok: true,
    resolved: {
      enabled,
      plannerModel,
      executorModel,
      perSessionCap,
      perTurnCap,
      inheritModelOverride,
    },
  };
}

/**
 * Convenience: parse and return null if disabled or parsing failed.
 * When non-null, handoff is enabled and the resolved config is valid.
 */
export function parseCapabilityTiersOrNull(
  raw: unknown,
): ResolvedCapabilityTiers | null {
  const result = parseCapabilityTiers(raw);
  if (!result.ok) return null;
  if (!result.resolved.enabled) return null;
  return result.resolved;
}
