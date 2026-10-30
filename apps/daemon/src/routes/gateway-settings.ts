/**
 * GET/PATCH /api/gateway/settings — IM gateway inbound security (verification
 * token / encrypt key / WeCom secret / sender allowlists / Bot routing).
 * Persisted in daemon_control KV and effective immediately; secrets are never echoed back.
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import {
  parseGatewaySettingsPatch,
  readGatewaySettings,
  redactGatewaySettings,
  writeGatewaySettings
} from '@ppeng/agent-capability-gateway';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function gatewaySettingsRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/gateway/settings',
      handler: ({ response }) => {
        json(response, 200, { settings: redactGatewaySettings(readGatewaySettings(runtime.store)) });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/gateway/settings',
      handler: async ({ readBody, response }) => {
        const patch = parseGatewaySettingsPatch(await readBody());
        const botIds = [patch.feishu?.botId, patch.wecom?.botId, patch.slack?.botId].filter(
          (id): id is string => typeof id === 'string' && id.trim() !== ''
        );
        for (const id of botIds) {
          if (!runtime.store.getBot(id.trim())) {
            json(response, 404, { error: `Unknown bot: ${id}` });
            return;
          }
        }
        const settings = writeGatewaySettings(runtime.store, patch);
        json(response, 200, { settings: redactGatewaySettings(settings) });
      }
    }
  ];
}
