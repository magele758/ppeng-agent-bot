import { NotFoundError, ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { createApprovalExplainer } from '../approval-explanation.js';

export function approvalExplanationRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  const explain = createApprovalExplainer(input => {
    const complete = runtime.modelAdapter.completeText;
    if (!complete) throw new Error('Text completion unavailable');
    return complete.call(runtime.modelAdapter, input);
  });
  return [{ method: 'POST', pattern: '/api/approval-explanations/:id', handler: async ctx => {
    const approval = runtime.store.getApproval(ctx.requireParam('id'));
    if (!approval) throw new NotFoundError('approval', ctx.requireParam('id'));
    const body = await ctx.readBody() as { locale?: string };
    if (body?.locale !== 'zh' && body?.locale !== 'en') throw new ValidationError('Invalid locale');
    const explanation = approval.reason.startsWith('Auto-review') ? await explain(approval, body.locale) : null;
    json(ctx.response, 200, { explanation });
  }}];
}
