/**
 * GET/PATCH /api/compact/settings — persist immediately in daemon_control KV.
 * Lab UI is the control plane; no new RAW_AGENT_* policy switch.
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import {
  ValidationError,
  hasPersistedCompactSettings,
  parseCompactPolicy,
  parseKeepRecent,
  readCompactSettings,
  resolveMicroCompactConfig,
  writeCompactSettings,
  type CompactSettingsPatch
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function compactRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/compact/settings',
      handler: ({ response }) => {
        const settings = readCompactSettings(runtime.store);
        const effective = resolveMicroCompactConfig({ store: runtime.store, env: process.env });
        json(response, 200, {
          settings,
          effective: {
            policy: effective.policy ?? 'keep_recent',
            keepRecent: effective.keepRecent,
            enabled: effective.enabled,
            source: hasPersistedCompactSettings(runtime.store) ? 'ui' : 'default'
          }
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/compact/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as CompactSettingsPatch & Record<string, unknown>;
        const patch: CompactSettingsPatch = {};
        if (body && 'policy' in body) {
          const parsed = parseCompactPolicy(body.policy);
          if (!parsed) {
            throw new ValidationError(
              'policy must be keep_recent, after_any_assistant, or after_text_assistant'
            );
          }
          patch.policy = parsed;
        }
        if (body && 'keepRecent' in body) {
          const parsed = parseKeepRecent(body.keepRecent);
          if (parsed === undefined) {
            throw new ValidationError('keepRecent must be an integer from 0 to 50');
          }
          patch.keepRecent = parsed;
        }
        if (body && 'enabled' in body) {
          if (typeof body.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
          patch.enabled = body.enabled;
        }
        const settings = writeCompactSettings(runtime.store, patch);
        const effective = resolveMicroCompactConfig({ store: runtime.store, env: process.env });
        json(response, 200, {
          settings,
          effective: {
            policy: effective.policy ?? settings.policy,
            keepRecent: effective.keepRecent,
            enabled: effective.enabled,
            source: 'ui' as const
          }
        });
      }
    }
  ];
}
