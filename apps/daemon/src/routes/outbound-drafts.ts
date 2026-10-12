import { join } from 'node:path';
import type { RawAgentRuntime } from '@ppeng/agent-core';
import {
  loadGatewayFileConfig,
  parseGatewayEnv,
  readOutboundDrafts,
  releaseOutboundDraft
} from '@ppeng/agent-capability-gateway';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

/**
 * Human release path for proactive outbound drafts (digest, webhook, model-initiated).
 * The decision is the URL verb. A request body cannot approve a draft.
 */
export function outboundDraftRoutes(runtime: RawAgentRuntime, repoRoot: string): RouteSpec[] {
  const gatewayDir = () => join(runtime.stateDir, 'gateway');
  const decide = async (id: string, decision: 'approve' | 'reject') => {
    const { configPath } = parseGatewayEnv(repoRoot);
    const cfg = configPath ? await loadGatewayFileConfig(configPath) : undefined;
    return releaseOutboundDraft({
      gatewayDir: gatewayDir(),
      id,
      decision,
      channels: cfg?.channels ?? []
    });
  };
  return [
    {
      method: 'GET',
      pattern: '/api/outbound-drafts',
      handler: async ({ response }) => {
        const drafts = (await readOutboundDrafts(gatewayDir())).filter(
          (draft) => draft.status === 'pending_approval' || draft.status === 'failed' || draft.status === 'sending'
        );
        json(response, 200, { drafts });
      }
    },
    {
      method: 'POST',
      pattern: '/api/outbound-drafts/:id/approve',
      handler: async ({ requireParam, response }) => {
        const draft = await decide(requireParam('id'), 'approve');
        json(response, 200, { draft });
      }
    },
    {
      method: 'POST',
      pattern: '/api/outbound-drafts/:id/reject',
      handler: async ({ requireParam, response }) => {
        const draft = await decide(requireParam('id'), 'reject');
        json(response, 200, { draft });
      }
    }
  ];
}
