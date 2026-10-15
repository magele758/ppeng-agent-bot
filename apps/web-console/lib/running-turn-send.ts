/**
 * Running-turn composer policy.
 * Canonical bot chats insert and steer immediately.
 * Ordinary sessions keep the existing ask-before-steer path.
 */

export type RunningTurnSendAction = 'steer' | 'ask';

export function decideRunningTurnSend(input: { canonicalBotChat: boolean }): RunningTurnSendAction {
  return input.canonicalBotChat ? 'steer' : 'ask';
}

/** Same flag the loop uses: chat session marked as the bot's canonical conversation. */
export function isCanonicalBotChatMetadata(input: {
  mode?: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  return input.mode === 'chat' && input.metadata?.canonicalBotChat === true;
}
