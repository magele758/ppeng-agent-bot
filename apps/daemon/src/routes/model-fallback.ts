/**
 * Global model fallback chain (Lab "模型备选").
 *   GET   /api/model-fallback/settings   chain + selectable models + per-entry usability
 *   PATCH /api/model-fallback/settings   { chain?: [{providerId, modelId}], enabled?: boolean }
 * Persisted in daemon_control KV; no env switch. Empty chain or enabled false = off.
 */

import {
  ValidationError,
  modelFallbackPayload,
  writeModelFallbackSettings,
  type ModelRef,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function modelFallbackRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/model-fallback/settings',
      handler: ({ response }) => json(response, 200, modelFallbackPayload(runtime.store, process.env))
    },
    {
      method: 'PATCH',
      pattern: '/api/model-fallback/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown> | null;
        if (!body || typeof body !== 'object' || (!('chain' in body) && !('enabled' in body))) {
          throw new ValidationError('chain or enabled is required');
        }
        const patch: { chain?: ModelRef[]; enabled?: boolean } = {};
        if ('chain' in body) patch.chain = body.chain as ModelRef[];
        if ('enabled' in body) {
          if (typeof body.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
          patch.enabled = body.enabled;
        }
        writeModelFallbackSettings(runtime.store, patch, process.env);
        json(response, 200, modelFallbackPayload(runtime.store, process.env));
      }
    }
  ];
}
