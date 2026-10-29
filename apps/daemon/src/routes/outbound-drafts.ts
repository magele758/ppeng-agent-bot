import type { RawAgentRuntime } from '@ppeng/agent-core';
import { createDaemonDeliveryPort } from '../delivery-port.js';
import { hasHumanRelease, humanReleaseDenied } from '../human-release.js';
import { json } from '../http-utils.js';
import type { RouteContext, RouteSpec } from '../routing.js';

const LISTED_STATUSES = new Set<string>(['pending_approval', 'failed', 'sending', 'deferred']);

/**
 * Human release path for proactive outbound drafts (digest, webhook, model-initiated).
 * The decision is the URL verb. A request body cannot approve a draft.
 * Approve and reject require a Lab login session ({@link hasHumanRelease}).
 * With login off, both fail closed with 403 `human_login_required` and the inbox asks the operator to enable it.
 */
export function outboundDraftRoutes(runtime: RawAgentRuntime, repoRoot: string, env: NodeJS.ProcessEnv): RouteSpec[] {
  const decide = async (id: string, decision: 'approve' | 'reject') => {
    return (await createDaemonDeliveryPort(runtime, repoRoot)).confirm({ id, decision });
  };
  const requireHuman = (ctx: RouteContext): boolean => {
    if (hasHumanRelease(ctx.request, env, ctx.auth)) return true;
    const denied = humanReleaseDenied(env);
    json(ctx.response, denied.status, denied.body);
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
        const drafts = (await (await createDaemonDeliveryPort(runtime, repoRoot)).list()).filter((draft) =>
          LISTED_STATUSES.has(draft.status)
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
