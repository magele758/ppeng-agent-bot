/**
 * GET/PATCH /api/session-recap/settings — automatic away recap.
 * The one-line text is built in the Lab from the transcript already on screen.
 */

import { ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import {
  hasPersistedSessionRecapSettings,
  readSessionRecapSettings,
  writeSessionRecapSettings,
  type SessionRecapSettingsPatch
} from '../session-recap-settings.js';

function payload(runtime: RawAgentRuntime) {
  const settings = readSessionRecapSettings(runtime.store);
  return {
    settings,
    effective: {
      enabled: settings.enabled,
      source: hasPersistedSessionRecapSettings(runtime.store) ? 'ui' : 'default'
    }
  };
}

export function sessionRecapRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/session-recap/settings',
      handler: ({ response }) => {
        json(response, 200, payload(runtime));
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/session-recap/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as SessionRecapSettingsPatch & Record<string, unknown>;
        const patch: SessionRecapSettingsPatch = {};
        if (body && typeof body === 'object' && 'enabled' in body) {
          if (typeof body.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
          patch.enabled = body.enabled;
        }
        writeSessionRecapSettings(runtime.store, patch);
        json(response, 200, payload(runtime));
      }
    }
  ];
}
