/** Pure helpers for ApprovalBanner row UI (CRAP-coverable without JSX). */

export type ApprovalItemBodyKind = 'secure-form' | 'ask' | 'preview' | 'empty';

export function approvalItemBodyKind(input: {
  hasSecureForm: boolean;
  isAsk: boolean;
  hasQuestion: boolean;
}): ApprovalItemBodyKind {
  if (input.hasSecureForm) return 'secure-form';
  if (!input.isAsk) return 'preview';
  return input.hasQuestion ? 'ask' : 'empty';
}

export function approvalApproveDisabled(isAsk: boolean, reply: string): boolean {
  return isAsk && !reply.trim();
}

export type ApprovalPostPlan =
  | { type: 'noop' }
  | { type: 'ask-reply'; reply: string }
  | { type: 'decision-only' };

/** Decide what ApprovalItemRow should POST before the approve/reject call. */
export function approvalPostPlan(input: {
  decision: 'approve' | 'reject';
  isAsk: boolean;
  reply: string;
  hasSession: boolean;
}): ApprovalPostPlan {
  if (input.decision !== 'approve' || !input.isAsk) return { type: 'decision-only' };
  const reply = input.reply.trim();
  if (!reply || !input.hasSession) return { type: 'noop' };
  return { type: 'ask-reply', reply };
}

export function approvalUsesStreamAttach(input: {
  hasAttachStream: boolean;
}): 'direct' | 'attach' {
  return input.hasAttachStream ? 'attach' : 'direct';
}

export type ApprovalDecisionFlow = 'stop' | 'direct' | 'attach';

/** After the ask-reply plan: stop, post the decision, or arm the live stream first. */
export function approvalDecisionFlow(input: {
  plan: ApprovalPostPlan;
  hasAttachStream: boolean;
}): ApprovalDecisionFlow {
  if (input.plan.type === 'noop') return 'stop';
  return approvalUsesStreamAttach({ hasAttachStream: input.hasAttachStream });
}

/** Ask-reply POST, if the plan says so. Decision POST stays with the caller. */
export async function approvalSendAskReply(input: {
  plan: ApprovalPostPlan;
  sessionId: string | undefined;
  post: (path: string, body: unknown) => Promise<unknown>;
}): Promise<void> {
  if (input.plan.type !== 'ask-reply' || !input.sessionId) return;
  await input.post(`/api/sessions/${encodeURIComponent(input.sessionId)}/ask-user/reply`, {
    reply: input.plan.reply
  });
}
