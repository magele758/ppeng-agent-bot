/**
 * Trajectory Handoff v2.3 — role pinning for planner/executor models.
 * 
 * Thin layer atop registry-router to resolve role-specific models.
 * Invalid single-role falls back to pinned session model (not last override).
 * Fallback failure is fail-closed.
 */

import type { ModelAdapter } from '../types.js';
import { resolveModelRoute, type ModelRouteResult } from './registry-router.js';
import type { ModelProviderCatalog, ModelProvidersStore } from './provider-catalog.js';

export type HandoffRole = 'planner' | 'executor';

export interface RolePinningContext {
  /** The role-specific model override (from capabilityTiers). Null/undefined = use pinned. */
  roleModel: string | null | undefined;
  /** The original pinned session model (stable fallback). */
  pinnedSessionModel: string;
  /** Model catalog. */
  catalog: ModelProviderCatalog;
  /** Provider store. */
  store: ModelProvidersStore;
  /** Environment (for credentials check). */
  env?: NodeJS.ProcessEnv;
  /** Optional runtime/env fallback adapter (used by registry-router). */
  fallbackAdapter?: ModelAdapter;
}

export interface RolePinResult {
  /** The resolved adapter, or null if both role model and pinned fallback failed. */
  adapter: ModelAdapter | null;
  /** Which resolution path was taken. */
  source: 'role_model' | 'pinned_fallback' | 'failed';
  /** Human-readable reason (for telemetry/logs). */
  reason: string;
}

/**
 * Resolve the model adapter for a given role.
 * 
 * Resolution order:
 * 1. If roleModel is provided and valid, use it.
 * 2. Otherwise, fall back to pinnedSessionModel.
 * 3. If both fail, return null (fail-closed).
 * 
 * Invalid single-role does NOT cascade to "last override" or other roles.
 * Only the pinned session model is the stable fallback.
 */
export function resolveRoleModel(
  role: HandoffRole,
  context: RolePinningContext
): RolePinResult {
  const { roleModel, pinnedSessionModel, catalog, store, env, fallbackAdapter } = context;

  // Attempt role-specific model if provided
  if (roleModel && typeof roleModel === 'string' && roleModel.trim() !== '') {
    try {
      // Minimal SessionRecord shape for resolveModelRoute
      const fakeSession = {
        id: 'temp',
        metadata: { preferredModel: roleModel }
      } as unknown as Parameters<typeof resolveModelRoute>[0]['session'];
      
      const routeResult: ModelRouteResult = resolveModelRoute({
        catalog,
        store,
        session: fakeSession,
        env,
        fallbackAdapter,
      });
      
      if (routeResult.primary) {
        return {
          adapter: routeResult.primary,
          source: 'role_model',
          reason: `Resolved ${role} role model: ${roleModel}`,
        };
      }
    } catch (err) {
      // Role model invalid; proceed to fallback
    }
  }

  // Fall back to pinned session model
  try {
    const fakeSession = {
      id: 'temp',
      metadata: { preferredModel: pinnedSessionModel }
    } as unknown as Parameters<typeof resolveModelRoute>[0]['session'];
    
    const routeResult: ModelRouteResult = resolveModelRoute({
      catalog,
      store,
      session: fakeSession,
      env,
      fallbackAdapter,
    });
    
    if (routeResult.primary) {
      return {
        adapter: routeResult.primary,
        source: 'pinned_fallback',
        reason: `${role} role model invalid or missing; using pinned session model: ${pinnedSessionModel}`,
      };
    }
  } catch (err) {
    // Pinned model also failed
  }

  // Both failed: fail-closed
  return {
    adapter: null,
    source: 'failed',
    reason: `Both ${role} role model and pinned session model failed to resolve`,
  };
}
