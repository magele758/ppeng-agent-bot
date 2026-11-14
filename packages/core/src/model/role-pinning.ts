/**
 * Trajectory Handoff v2.3 — one-shot role pinning.
 * Invalid role model falls back only to the session-pinned original model,
 * never to modelOverride and never along catalog fallbackRefs.
 * If that also fails, the result is fail-closed (adapter null).
 */

import type { ModelAdapter } from '../types.js';
import { handoffRuntimeEnabled } from '@ppeng/agent-loop';
import {
  createAdapterFromProvider,
  findProvider,
  type ModelProviderCatalog,
  type ModelProvidersStore,
} from './provider-catalog.js';

export type HandoffRole = 'planner' | 'executor';

export interface RolePinningContext {
  /** Role model ref (`providerId/modelId`). Null/undefined = use the pin. */
  roleModel: string | null | undefined;
  /** Original pinned session model. Not the latest modelOverride. */
  pinnedSessionModel: string;
  catalog: ModelProviderCatalog;
  store: ModelProvidersStore;
  env?: NodeJS.ProcessEnv;
  /** Ignored. Kept so older callers still typecheck. Never used as a fallback. */
  fallbackAdapter?: ModelAdapter;
}

export interface RolePinResult {
  adapter: ModelAdapter | null;
  source: 'role_model' | 'pinned_fallback' | 'failed';
  reason: string;
}

export interface PinnedRoleRequest {
  role: HandoffRole;
  roleModel: string | null;
  pinnedSessionModel: string;
}

export interface PinnedRoleResolution {
  handled: boolean;
  adapter: ModelAdapter | null;
  reason: string;
  rolePinFailed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parsePinnedRef(
  model: string,
  catalog: ModelProviderCatalog
): { providerId: string; modelId: string } | null {
  const trimmed = model.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const providerId = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  const provider = catalog.providers.find((item) => item.id === providerId);
  if (!provider) return null;
  if (provider.kind !== 'heuristic' && !provider.models.some((item) => item.id === modelId && item.enabled !== false)) {
    return null;
  }
  return { providerId, modelId };
}

function adapterFor(
  model: string,
  catalog: ModelProviderCatalog,
  env: NodeJS.ProcessEnv | undefined
): ModelAdapter | null {
  const ref = parsePinnedRef(model, catalog);
  if (!ref) return null;
  const provider = findProvider(catalog, ref.providerId, env);
  if (!provider) return null;
  if (provider.kind !== 'heuristic' && (!provider.apiKey.trim() || !provider.baseUrl.trim())) return null;
  const adapter = createAdapterFromProvider(provider, ref.modelId);
  const modelName = `${ref.providerId}/${ref.modelId}`;
  return {
    name: adapter.name,
    modelName,
    runTurn: (input) => adapter.runTurn(input),
    summarizeMessages: (input) => adapter.summarizeMessages(input),
    ...(adapter.runTurnStream ? { runTurnStream: (input, onChunk) => adapter.runTurnStream!(input, onChunk) } : {}),
    ...(adapter.completeText ? { completeText: (input) => adapter.completeText!(input) } : {}),
  };
}

export function resolveRoleModel(role: HandoffRole, context: RolePinningContext): RolePinResult {
  const env = context.env ?? process.env;
  if (context.roleModel?.trim()) {
    const adapter = adapterFor(context.roleModel, context.catalog, env);
    if (adapter) {
      return { adapter, source: 'role_model', reason: `role ${role} pinned to ${context.roleModel.trim()}` };
    }
  }
  if (context.pinnedSessionModel.trim()) {
    const adapter = adapterFor(context.pinnedSessionModel, context.catalog, env);
    if (adapter) {
      return {
        adapter,
        source: 'pinned_fallback',
        reason: `role ${role} model invalid; using pinned session model ${context.pinnedSessionModel.trim()}`,
      };
    }
  }
  return {
    adapter: null,
    source: 'failed',
    reason: `role ${role} model and pinned session model both failed to resolve; failing closed`,
  };
}

function pinnedOriginal(metadata: Record<string, unknown>): string {
  const pinned = metadata.pinnedSessionModel;
  if (typeof pinned === 'string' && pinned.trim()) return pinned.trim();
  const ref = asRecord(metadata.modelRef);
  if (typeof ref?.providerId === 'string' && typeof ref.modelId === 'string' && ref.providerId && ref.modelId) {
    return `${ref.providerId}/${ref.modelId}`;
  }
  return '';
}

function roleModelOf(tiers: Record<string, unknown>, role: HandoffRole): string | null {
  const roles = asRecord(tiers.roles);
  const fromRoles = role === 'planner' ? roles?.plannerModel : roles?.executorModel;
  if (typeof fromRoles === 'string' && fromRoles.trim()) return fromRoles.trim();
  const product = asRecord(tiers[role]);
  if (typeof product?.model === 'string' && product.model.trim()) return product.model.trim();
  return null;
}

function namedHandoffRole(metadata: Record<string, unknown>): HandoffRole | null {
  const role = metadata.handoffRole;
  return role === 'planner' || role === 'executor' ? role : null;
}

/** Same result as classifyEnablement === 'explicit_off'. Non-objects stay parser_default, not a close. */
function tiersExplicitOff(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  const tagged = obj.enablementSource;
  if (tagged === 'explicit_off') return true;
  if (tagged === 'auto_policy' || tagged === 'parser_default') return false;
  if (tagged === 'explicit_on') return obj.enabled === false;
  if (obj.enabled === false) return true;
  return false;
}

/** Explicit close. Does not read role model strings. Wins over auto_policy and an explicit open. */
function explicitHandoffClosed(metadata: Record<string, unknown>): boolean {
  if (metadata.trajectoryHandoff === 'off') return true;
  if (metadata.taskRunMode === 'handoff_off' || metadata.task_run_mode === 'handoff_off') return true;
  const policy = asRecord(metadata.handoffEnablement);
  if (policy?.source === 'explicit_off') return true;
  return tiersExplicitOff(metadata.capabilityTiers);
}

function autoPolicyEnablement(metadata: Record<string, unknown>): boolean {
  const tiers = asRecord(metadata.capabilityTiers);
  if (tiers?.enablementSource === 'auto_policy') return true;
  const policy = asRecord(metadata.handoffEnablement);
  return policy?.source === 'auto_policy';
}

/**
 * Planner/executor request when runtime handoff is on, or when a persisted
 * auto policy has named a role and the session cap is not exhausted.
 * Explicit off returns null. A non-object capabilityTiers is ignored:
 * the role model stays null and the pin / modelRef remain the fallback.
 */
export function handoffRoleRequest(session: { metadata?: unknown } | undefined): PinnedRoleRequest | null {
  const metadata = asRecord(session?.metadata);
  if (!metadata) return null;
  const role = namedHandoffRole(metadata);
  if (!role || explicitHandoffClosed(metadata)) return null;
  const runtime = handoffRuntimeEnabled(metadata);
  const auto = metadata.handoffSuspended !== 'session_cap' && autoPolicyEnablement(metadata);
  if (!runtime && !auto) return null;
  const tiers = asRecord(metadata.capabilityTiers);
  return {
    role,
    roleModel: tiers ? roleModelOf(tiers, role) : null,
    pinnedSessionModel: pinnedOriginal(metadata),
  };
}

/**
 * Stamp the original model once a handoff role is active and no pin exists.
 * Explicit runtime open still qualifies. auto_policy qualifies only with a
 * planner/executor role that is not suspended for the session cap.
 */
export function handoffOriginalPinDue(session: { metadata?: unknown } | undefined): boolean {
  const metadata = asRecord(session?.metadata);
  if (!metadata || explicitHandoffClosed(metadata)) return false;
  if (handoffRuntimeEnabled(metadata)) return true;
  if (metadata.handoffSuspended === 'session_cap') return false;
  return namedHandoffRole(metadata) !== null && autoPolicyEnablement(metadata);
}

export function resolvePinnedRoleAdapter(input: {
  session: { metadata?: unknown } | undefined;
  catalog: ModelProviderCatalog;
  env?: NodeJS.ProcessEnv;
}): PinnedRoleResolution {
  const request = handoffRoleRequest(input.session);
  if (!request) return { handled: false, adapter: null, reason: '', rolePinFailed: false };
  const resolved = resolveRoleModel(request.role, {
    roleModel: request.roleModel,
    pinnedSessionModel: request.pinnedSessionModel,
    catalog: input.catalog,
    store: { getDaemonControl: () => undefined, setDaemonControl: () => undefined },
    env: input.env,
  });
  if (!resolved.adapter) {
    return { handled: true, adapter: null, reason: resolved.reason, rolePinFailed: true };
  }
  return { handled: true, adapter: resolved.adapter, reason: resolved.reason, rolePinFailed: false };
}

export function failClosedRoleAdapter(reason: string): ModelAdapter {
  const fail = async () => {
    throw new Error(`trajectory handoff role pin failed closed: ${reason}`);
  };
  return {
    name: 'handoff-fail-closed',
    modelName: 'handoff-fail-closed',
    runTurn: fail,
    summarizeMessages: async () => {
      throw new Error(reason);
    },
  };
}

/**
 * First qualifying original model for a session that has no pin yet.
 * Skips heuristic providers, disabled models, catalog fallback refs, and the VL model.
 */
export function selectOriginalModelPin(input: {
  catalog: ModelProviderCatalog;
  metadata: unknown;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const metadata = asRecord(input.metadata);
  const vlName = input.env?.RAW_AGENT_VL_MODEL_NAME?.trim() ?? '';
  const fallback = new Set(
    (input.catalog.fallbackRefs ?? []).map((ref) => ref.providerId + '/' + ref.modelId),
  );
  const named: string[] = [];
  const modelRef = metadata?.modelRef;
  if (typeof modelRef === 'string' && modelRef.trim()) named.push(modelRef.trim());
  const refRecord = asRecord(modelRef);
  if (typeof refRecord?.providerId === 'string' && typeof refRecord.modelId === 'string' && refRecord.providerId && refRecord.modelId) {
    named.push(refRecord.providerId + '/' + refRecord.modelId);
  }
  if (input.catalog.defaultRef) {
    named.push(input.catalog.defaultRef.providerId + '/' + input.catalog.defaultRef.modelId);
  }
  for (const provider of input.catalog.providers) {
    if (provider.kind === 'heuristic') continue;
    for (const model of provider.models) {
      if (model.enabled === false) continue;
      named.push(provider.id + '/' + model.id);
    }
  }
  for (const candidate of named) {
    if (fallback.has(candidate)) continue;
    const parsed = parsePinnedRef(candidate, input.catalog);
    if (!parsed) continue;
    const provider = input.catalog.providers.find((item) => item.id === parsed.providerId);
    if (!provider || provider.kind === 'heuristic') continue;
    if (vlName && parsed.modelId === vlName) continue;
    return parsed.providerId + '/' + parsed.modelId;
  }
  return undefined;
}
