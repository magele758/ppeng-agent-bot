/**
 * Running-turn composer policy.
 * Canonical bot chats insert and steer immediately.
 * Ordinary sessions keep the existing ask-before-steer path.
 */

export type RunningTurnSendAction = 'steer' | 'ask';

export type RunningTurnInterruptPolicy = 'queue' | 'steer' | 'disabled';

export interface RunningTurnDelivery {
  /** Put the user bubble in the transcript and clear the composer before the request returns. */
  optimistic: boolean;
  target: 'next-step' | 'next-run';
  /** Ordinary queue/ask reveals the follow-up inbox. A bot steer must not. */
  revealSettings: boolean;
  blocked: boolean;
}

export function decideRunningTurnSend(input: { canonicalBotChat: boolean }): RunningTurnSendAction {
  return input.canonicalBotChat ? 'steer' : 'ask';
}

/**
 * What confirming the composer does while a turn is already running.
 * A canonical bot steers on the next shot and does not open session settings.
 * An ordinary chat keeps queue / steer / disabled.
 */
export function planRunningTurnDelivery(input: {
  canonicalBotChat: boolean;
  interruptPolicy: RunningTurnInterruptPolicy;
}): RunningTurnDelivery {
  if (decideRunningTurnSend({ canonicalBotChat: input.canonicalBotChat }) === 'steer') {
    return { optimistic: true, target: 'next-step', revealSettings: false, blocked: false };
  }
  if (input.interruptPolicy === 'disabled') {
    return { optimistic: false, target: 'next-run', revealSettings: false, blocked: true };
  }
  return {
    optimistic: false,
    target: input.interruptPolicy === 'queue' ? 'next-run' : 'next-step',
    revealSettings: true,
    blocked: false
  };
}

/** Session settings auto-open is the ordinary "ask" surface. Bot steers stay in the transcript. */
export function shouldOpenSessionSettingsOnInboxGrowth(input: {
  previousCount: number;
  nextCount: number;
  immediateSteer: boolean;
}): boolean {
  if (input.immediateSteer) return false;
  return input.nextCount > input.previousCount;
}

/** Same flag the loop uses: chat session marked as the bot's canonical conversation. */
export function isCanonicalBotChatMetadata(input: {
  mode?: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  return input.mode === 'chat' && input.metadata?.canonicalBotChat === true;
}
