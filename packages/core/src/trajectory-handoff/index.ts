/**
 * Core adapter for Trajectory Handoff v2.3.
 *
 * Thin adapter only — delegates to @ppeng/agent-loop kernel for state machine,
 * recovery, and budget accounting. This file wires config parsing and
 * ModelResolver to core's provider catalog, and exposes the adapter's
 * permission-intersection entry.
 *
 * NOT authoritative state. NOT a second handoff loop. NOT budget accounting.
 */

import {
  parseCapabilityTiers,
  parseCapabilityTiersOrNull,
  createTrajectoryHandoffAdapter,
} from '@ppeng/agent-loop';
import type {
  ResolvedCapabilityTiers,
  CapabilityTiersConfig,
  ParseConfigOutput,
  TrajectoryHandoffAdapter,
  AdapterContext,
} from '@ppeng/agent-loop';
import type { ModelPickerOption, ModelProviderCatalog } from '../model/provider-catalog.js';

// ============================================================================
// Re-exports for core consumers
// ============================================================================

export { parseCapabilityTiers, parseCapabilityTiersOrNull } from '@ppeng/agent-loop';
export type {
  ResolvedCapabilityTiers,
  CapabilityTiersConfig,
  ParseConfigOutput,
  ParseConfigResult,
  ParseConfigError,
} from '@ppeng/agent-loop';
export { createTrajectoryHandoffAdapter } from '@ppeng/agent-loop';
export type {
  TrajectoryHandoffAdapter,
  AdapterContext,
  EffectivePermissions,
} from '@ppeng/agent-loop';

// ============================================================================
// Core-facing config parser: old-config fallback
// ============================================================================

/**
 * Parse session metadata for the capabilityTiers block.
 *
 * Old configs without capabilityTiers must parse: returns { ok: true, resolved.enabled: false }.
 * Unknown fields are ignored; missing fields use defaults that do NOT turn
 * handoff on.
 *
 * @param metadata  The session.metadata record (or any raw config source).
 * @returns         ParseConfigOutput — resolved config or error+warning.
 */
export function parseHandoffConfig(metadata: Record<string, unknown> | undefined): ParseConfigOutput {
  // capabilityTiers may be at metadata.capabilityTiers or nested under a
  // "trajectoryHandoff" key for forward-compatibility. Unknown fields ignored.
  const raw = metadata?.capabilityTiers ?? metadata?.trajectoryHandoff ?? undefined;
  return parseCapabilityTiers(raw);
}

// ============================================================================
// Core-facing ModelResolver: role model + pinned fallback + fail-closed
// ============================================================================

/**
 * Resolve a role model identifier against available picker options.
 *
 * Rules (spec §Model fallback):
 * - Model choice depends only on current role + effective config + stable fallback.
 * - Missing/invalid single-role falls back to the session-pinned ORIGINAL model
 *   binding, not the last role override.
 * - Only the affected role falls back.
 * - If the original model is also invalid: fail-closed (return null). No recursive
 *   fallback.
 *
 * @param roleModel    ResolvedCapabilityTiers.plannerModel or executorModel
 *                     (null/empty = use pinned session model).
 * @param pinnedSessionModel  The original session model identifier (bare modelId
 *                            or "providerId/modelId" string).
 * @param catalog      Core's provider catalog for validation.
 * @param env          Environment for provider usability checks.
 * @returns            Resolved model string, or null if fail-closed.
 */
export function resolveRoleModel(
  roleModel: string | null,
  pinnedSessionModel: string,
  catalog: ModelProviderCatalog,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const usable = pickerUsableOptions(catalog, env);

  // Try the configured role model first.
  if (roleModel) {
    const ref = matchModelOption(roleModel, usable);
    if (ref) return ref;
    // Invalid role model: fall back to pinned session ORIGINAL model.
  }

  // Fall back to the session-pinned original model.
  if (pinnedSessionModel) {
    const ref = matchModelOption(pinnedSessionModel, usable);
    if (ref) return ref;
    // Original model also invalid: fail-closed, no recursive fallback.
  }

  return null;
}

/**
 * Match a model string against usable picker options.
 * Accepts "providerId/modelId" or bare "modelId".
 * Returns the canonical "providerId/modelId" string, or null if not found.
 */
function matchModelOption(
  model: string,
  usable: ModelPickerOption[],
): string | null {
  const trimmed = model.trim();
  if (!trimmed) return null;

  // "providerId/modelId" form.
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx > 0) {
    const providerId = trimmed.slice(0, slashIdx);
    const modelId = trimmed.slice(slashIdx + 1);
    const hit = usable.find(
      (o) => o.providerId === providerId && o.modelId === modelId,
    );
    return hit ? `${hit.providerId}/${hit.modelId}` : null;
  }

  // Bare modelId form: pick first usable match, prefer default provider.
  const byId = usable.filter((o) => o.modelId === trimmed);
  if (byId.length === 0) return null;
  return `${byId[0]!.providerId}/${byId[0]!.modelId}`;
}

/**
 * Get usable picker options from the catalog (provider has credentials, no scan error).
 */
function pickerUsableOptions(
  catalog: ModelProviderCatalog,
  env: NodeJS.ProcessEnv,
): ModelPickerOption[] {
  void env; // env reserved for future provider-level credential lookup
  return catalog.providers
    .filter((p) => {
      if (p.scanError?.trim()) return false;
      return p.kind === 'heuristic' || (Boolean(p.apiKey?.trim()) && Boolean(p.baseUrl?.trim()));
    })
    .flatMap((p) =>
      p.models
        .filter((m) => m.enabled)
        .map((m) => ({
          providerId: p.id,
          providerName: p.name,
          modelId: m.id,
          kind: p.kind,
          source: 'builtin' as const,
        })),
    );
}

// ============================================================================
// Adapter factory: wire core context to agent-loop adapter
// ============================================================================

/**
 * Create a core-facing adapter instance.
 *
 * The adapter is stateless: it receives context (kernel state, auth sets,
 * current role, config, current plan) and enforces:
 * - Planner readonly: writes rejected in planner role
 * - Permission intersection: original ∩ host phase ∩ role
 * - Single tool-execution entry
 * - Drain in-flight writes before planner entry, fail-closed if cannot stop
 *
 * It does NOT run a second handoff loop, hold authoritative state, do budget
 * accounting, or decide resume position. Those are the kernel's job.
 */
export function createCoreHandoffAdapter(context: AdapterContext): TrajectoryHandoffAdapter {
  return createTrajectoryHandoffAdapter(context);
}
