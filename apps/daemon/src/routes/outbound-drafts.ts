import { ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import type { UserDeliveryPort } from '@ppeng/agent-capability-gateway';
import { createDaemonDeliveryPort } from '../delivery-port.js';
import { hasHumanRelease, humanReleaseDenied } from '../human-release.js';
import { json } from '../http-utils.js';
import type { RouteContext, RouteSpec } from '../routing.js';

function parseRevision(body: unknown): number | undefined {
  const raw = (body as { revision?: unknown } | null)?.revision;
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || (raw as number) < 0) throw new ValidationError('revision must be a non-negative integer');
  return raw as number;
}

function parseEditText(body: unknown): string {
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') throw new ValidationError('text is required');
  return text;
}

const LISTED_STATUSES = new Set<string>(['pending_approval', 'failed', 'sending', 'deferred']);

/**
 * Human release path for proactive outbound drafts (digest, webhook, model-initiated).
 * The decision is the URL verb. A request body cannot approve a draft; it may only carry the
 * preview `revision` the human saw (stale → 409). Editing the preview text (PATCH) never confirms.
 * Edit, approve and reject require a Lab login session ({@link hasHumanRelease}).
 * With login off, both fail closed with 403 `human_login_required` and the inbox asks the operator to enable it.
 */
export function outboundDraftRoutes(runtime: RawAgentRuntime, repoRoot: string, env: NodeJS.ProcessEnv): RouteSpec[] {
  const port = (): Promise<UserDeliveryPort> => createDaemonDeliveryPort(runtime, repoRoot);
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
        // Each draft carries the identity it will send as, so the preview shows who it goes out as.
        // Do not reconcile here. An in-flight approve is `sending` until the POST
        // finishes; treating that as a crash marks a live send failed and the
        // human can release it a second time. Crash recovery runs at startup.
        const drafts = (await (await port()).listPreviews()).filter((draft) => LISTED_STATUSES.has(draft.status));
        json(response, 200, { drafts });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/outbound-drafts/:id',
      handler: async (ctx) => {
        if (!requireHuman(ctx)) return;
        const body = await ctx.readBody();
        const draft = await (await port()).edit({
          id: ctx.requireParam('id'),
          text: parseEditText(body),
          expectedRevision: parseRevision(body)
        });
        json(ctx.response, 200, { draft });
      }
    },
    {
      method: 'POST',
      pattern: '/api/outbound-drafts/:id/approve',
      handler: async (ctx) => {
        if (!requireHuman(ctx)) return;
        const expectedRevision = parseRevision(await ctx.readBody());
        const draft = await (await port()).confirm({ id: ctx.requireParam('id'), decision: 'approve', expectedRevision });
        json(ctx.response, 200, { draft });
      }
    },
    {
      method: 'POST',
      pattern: '/api/outbound-drafts/:id/reject',
      handler: async (ctx) => {
        if (!requireHuman(ctx)) return;
        const draft = await (await port()).confirm({ id: ctx.requireParam('id'), decision: 'reject' });
        json(ctx.response, 200, { draft });
      }
    }
  ];
}
