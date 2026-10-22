const GOAL_UPDATE_PREFIX = '[goal update]';

export interface GoalUpdateNotice {
  id: string;
  title: string;
  status: string;
  reason: string;
}

export interface GoalUpdateScope {
  messageSessionId?: string;
  conversationId?: string;
}

export type GoalUpdatePresentation =
  | { kind: 'absent' }
  | { kind: 'hidden' }
  | { kind: 'card'; notice: GoalUpdateNotice };

export function readMessageSessionId(message: { sessionId?: unknown }): string | undefined {
  return typeof message.sessionId === 'string' && message.sessionId.length > 0 ? message.sessionId : undefined;
}

export function presentGoalUpdate(text: string, scope: GoalUpdateScope = {}): GoalUpdatePresentation {
  if (!text.trimStart().startsWith(GOAL_UPDATE_PREFIX)) return { kind: 'absent' };
  if (!belongsToConversation(scope.messageSessionId, scope.conversationId)) return { kind: 'hidden' };
  return { kind: 'card', notice: parseGoalUpdateNotice(text) ?? { id: '', title: '', status: '', reason: '' } };
}

function belongsToConversation(messageSessionId: string | undefined, conversationId: string | undefined): boolean {
  if (!messageSessionId || !conversationId) return true;
  return messageSessionId === conversationId;
}

export function parseGoalUpdateNotice(text: string): GoalUpdateNotice | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(GOAL_UPDATE_PREFIX)) return null;
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  const json = extractJsonObject(trimmed, start);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  return {
    id: typeof row.id === 'string' ? row.id : '',
    title: typeof row.title === 'string' ? row.title.trim() : '',
    status: typeof row.status === 'string' ? row.status.trim() : '',
    reason: typeof row.reason === 'string' ? row.reason.trim() : ''
  };
}

function extractJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
