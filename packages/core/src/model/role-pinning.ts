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

/** Null unless this session explicitly enabled handoff and named a role. */
export function handoffRoleRequest(session: { metadata?: unknown } | undefined): PinnedRoleRequest | null {
  const metadata = asRecord(session?.metadata);
  if (!handoffRuntimeEnabled(metadata)) return null;
  const role = metadata?.handoffRole;
  if (role !== 'planner' && role !== 'executor') return null;
  const tiers = asRecord(metadata?.capabilityTiers) ?? {};
  return { role, roleModel: roleModelOf(tiers, role), pinnedSessionModel: pinnedOriginal(metadata ?? {}) };
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
