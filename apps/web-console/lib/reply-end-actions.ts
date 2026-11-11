import { sliceConversationTurns, type TurnFeedStatMessage } from './turn-feed-stats.ts';

export type ReplyActivity = {
  optimisticUser?: unknown;
  streamOverlay?: unknown;
  waitTyping?: unknown;
  heldAssistantText?: unknown;
};

function replyStillOpen(chat: ReplyActivity): boolean {
  if (chat.optimisticUser) return false;
  return Boolean(chat.streamOverlay || chat.waitTyping || chat.heldAssistantText);
}

/** Index from which a still-open turn must not show the end-of-reply actions. */
export function liveReplyHoldIndex(messages: TurnFeedStatMessage[], chat: ReplyActivity): number | null {
  if (!replyStillOpen(chat)) return null;
  const last = sliceConversationTurns(messages).at(-1);
  return last ? last.startIndex : 0;
}

export function replyActionsHeld(hold: number | null, index: number): boolean {
  return hold != null && index >= hold;
}

/** The end-of-reply row is assistant-only. Other roles keep their own controls. */
export function assistantActionsHeld(role: string, hold: number | null, index: number): boolean {
  return role === 'assistant' && replyActionsHeld(hold, index);
}
