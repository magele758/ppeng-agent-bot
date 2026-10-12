import { join } from 'node:path';
import type { RawAgentRuntime } from '@ppeng/agent-core';
import {
  loadGatewayFileConfig,
  parseGatewayEnv,
  readOutboundDrafts,
  releaseOutboundDraft
} from '@ppeng/agent-capability-gateway';
import { hasHumanRelease, humanReleaseDeniedBody } from '../human-release.js';
import { json } from '../http-utils.js';
import type { RouteContext, RouteSpec } from '../routing.js';

/**
 * Human release path for proactive outbound drafts (digest, webhook, model-initiated).
 * The decision is the URL verb. A request body cannot approve a draft.
 * Approve and reject require a Lab login session ({@link hasHumanRelease}).
 * With login off, both fail closed and the Lab UI asks the operator to enable it.
 */
export function outboundDraftRoutes(runtime: RawAgentRuntime, repoRoot: string, env: NodeJS.ProcessEnv): RouteSpec[] {
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
  const requireHuman = (ctx: RouteContext): boolean => {
    if (hasHumanRelease(ctx.request, env, ctx.auth)) return true;
    json(ctx.response, 401, humanReleaseDeniedBody(env));
    return false;
  };
  return [
    {
      method: 'GET',
      pattern: '/api/outbound-drafts',
      handler: async ({ response }) => {
        // Do not reconcile here. An in-flight approve is `sending` until the POST
        // finishes; treating that as a crash marks a live send failed and the
        // human can release it a second time. Crash recovery runs at startup.
        const drafts = (await readOutboundDrafts(gatewayDir())).filter(
          (draft) => draft.status === 'pending_approval' || draft.status === 'failed' || draft.status === 'sending'
        );
        json(response, 200, { drafts });
      }
    },
    {
      method: 'POST',
      pattern: '/api/outbound-drafts/:id/approve',
      handler: async (ctx) => {
        if (!requireHuman(ctx)) return;
        const draft = await decide(ctx.requireParam('id'), 'approve');
        json(ctx.response, 200, { draft });
      }
    },
    {
      method: 'POST',
      pattern: '/api/outbound-drafts/:id/reject',
      handler: async (ctx) => {
        if (!requireHuman(ctx)) return;
        const draft = await decide(ctx.requireParam('id'), 'reject');
        json(ctx.response, 200, { draft });
      }
    }
  ];
}
