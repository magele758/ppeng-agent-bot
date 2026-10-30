const GOAL_UPDATE_PREFIX = '[goal update]';

export interface GoalUpdateScope {
  messageSessionId?: string;
  conversationId?: string;
}

export type GoalUpdatePresentation =
  | { kind: 'absent' }
  | { kind: 'hidden' };

export function readMessageSessionId(message: { sessionId?: unknown }): string | undefined {
  return typeof message.sessionId === 'string' && message.sessionId.length > 0 ? message.sessionId : undefined;
}

export function presentGoalUpdate(text: string, _scope: GoalUpdateScope = {}): GoalUpdatePresentation {
  return text.trimStart().startsWith(GOAL_UPDATE_PREFIX) ? { kind: 'hidden' } : { kind: 'absent' };
}
