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
