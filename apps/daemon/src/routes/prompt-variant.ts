/**
 * GET/PATCH /api/prompt-variant/settings
 * Lab UI is the control plane; no env feature switch.
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import {
  hasPersistedPromptVariantSettings,
  readPromptVariantSettings,
  writePromptVariantSettings,
  type PromptVariantSettingsPatch
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function promptVariantRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/prompt-variant/settings',
      handler: ({ response }) => {
        const settings = readPromptVariantSettings(runtime.store);
        json(response, 200, {
          settings,
          effective: {
            variant: settings.variant,
            source: hasPersistedPromptVariantSettings(runtime.store) ? 'ui' : 'default'
          }
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/prompt-variant/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as PromptVariantSettingsPatch;
        const settings = writePromptVariantSettings(runtime.store, body ?? {});
        json(response, 200, {
          settings,
          effective: { variant: settings.variant, source: 'ui' as const }
        });
      }
    }
  ];
}
