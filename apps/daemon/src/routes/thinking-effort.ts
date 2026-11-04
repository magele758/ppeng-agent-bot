/**
 * GET/PATCH /api/thinking-effort/settings
 * Lab UI is the control plane; no env feature switch.
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import {
  ValidationError,
  hasPersistedThinkingEffortSettings,
  isThinkingEffortLevel,
  readThinkingEffortSettings,
  writeThinkingEffortSettings,
  type ThinkingEffortSettingsPatch
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function thinkingEffortRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/thinking-effort/settings',
      handler: ({ response }) => {
        const settings = readThinkingEffortSettings(runtime.store);
        json(response, 200, {
          settings,
          effective: {
            level: settings.level,
            source: hasPersistedThinkingEffortSettings(runtime.store) ? 'ui' : 'default'
          }
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/thinking-effort/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as ThinkingEffortSettingsPatch;
        if (body?.level !== undefined && !isThinkingEffortLevel(body.level)) {
          throw new ValidationError('thinking effort must be off, low, medium, or high');
        }
        const settings = writeThinkingEffortSettings(runtime.store, body ?? {});
        json(response, 200, {
          settings,
          effective: { level: settings.level, source: 'ui' as const }
        });
      }
    }
  ];
}
