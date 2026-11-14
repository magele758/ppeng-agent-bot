/**
 * One-way product → kernel capability-tier persistence.
 * Parser-default false is not an explicit close. Explicit close is not
 * flipped on by defaults or by a stored enabled:false that was only the
 * parser default. Refs and caps are kept either way.
 */

import { parseCapabilityTiers, type EnablementSource } from '@ppeng/agent-loop';

export interface PersistedCapabilityTiers {
  enabled: boolean;
  enablementSource: EnablementSource;
  roles?: { plannerModel?: string; executorModel?: string };
  caps?: { perTurn?: number; perSession?: number };
  inheritModelOverride?: boolean;
}

const POLICY_SOURCE: Record<string, true> = {
  explicit_off: true,
  explicit_on: true,
  parser_default: true,
  auto_policy: true,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Product `planner.model` / `executor.model` → kernel `roles.*Model`. Kernel roles win. */
export function productTiersToKernel(raw: Record<string, unknown>): Record<string, unknown> {
  const roles = asRecord(raw.roles) ? { ...asRecord(raw.roles) } : {};
  const planner = asRecord(raw.planner);
  const executor = asRecord(raw.executor);
  if (typeof planner?.model === 'string' && planner.model.trim() && roles.plannerModel == null) {
    roles.plannerModel = planner.model.trim();
  }
  if (typeof executor?.model === 'string' && executor.model.trim() && roles.executorModel == null) {
    roles.executorModel = executor.model.trim();
  }
  return { ...raw, roles };
}

export function normalizeStoredCapabilityTiers(raw: unknown): PersistedCapabilityTiers | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const input = productTiersToKernel(record);
  const parsed = parseCapabilityTiers(input);
  if (!parsed.ok) return undefined;
  const resolved = parsed.resolved;
  const roles: { plannerModel?: string; executorModel?: string } = {};
  if (resolved.plannerModel) roles.plannerModel = resolved.plannerModel;
  if (resolved.executorModel) roles.executorModel = resolved.executorModel;
  const hadCaps = input.caps != null || input.perTurnCap != null || input.perSessionCap != null;
  return {
    enabled: resolved.enablementSource === 'explicit_on',
    enablementSource: resolved.enablementSource,
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
    ...(hadCaps ? { caps: { perTurn: resolved.perTurnCap, perSession: resolved.perSessionCap } } : {}),
    ...(resolved.inheritModelOverride ? { inheritModelOverride: true } : {}),
  };
}

/**
 * Explicit close sticks unless the incoming object itself is an explicit open.
 * A parser-default or partial rewrite must not clear it.
 */
export function mergePersistedCapabilityTiers(
  previous: unknown,
  incoming: unknown
): PersistedCapabilityTiers | undefined {
  const prev = normalizeStoredCapabilityTiers(previous);
  if (incoming == null) return prev;
  const next = normalizeStoredCapabilityTiers(incoming);
  if (!next) return prev;
  if (prev?.enablementSource === 'explicit_off' && next.enablementSource !== 'explicit_on') {
    return {
      ...next,
      enabled: false,
      enablementSource: 'explicit_off',
      ...(next.roles ? {} : prev.roles ? { roles: prev.roles } : {}),
      ...(next.caps ? {} : prev.caps ? { caps: prev.caps } : {}),
    };
  }
  return next;
}

/**
 * New sessions can store an enablement policy. A bare create (no tiers, no
 * policy) is returned unchanged so production default stays off.
 * `auto_policy` is persisted for a later knife and is not turned on here.
 */
export function applySessionEnablement(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  if (metadata.capabilityTiers == null && metadata.handoffEnablement == null) return metadata;
  const policy = asRecord(metadata.handoffEnablement);
  const source = typeof policy?.source === 'string' ? policy.source : undefined;
  const incoming = metadata.capabilityTiers ?? policy?.capabilityTiers;
  const stamped = source && source in POLICY_SOURCE
    ? { ...(asRecord(incoming) ?? {}), enablementSource: source, enabled: source === 'explicit_on' }
    : incoming;
  const normalized = normalizeStoredCapabilityTiers(stamped);
  if (!normalized) return metadata;
  return { ...metadata, capabilityTiers: normalized };
}
