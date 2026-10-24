import type { ApprovalItem, SessionSummary } from './types';

type ApprovalSession = Pick<SessionSummary, 'id'> & {
  parentSessionId?: string | null;
  metadata?: { parentSessionId?: unknown };
};

function parentOf(session: ApprovalSession | undefined): string {
  if (!session) return '';
  if (typeof session.parentSessionId === 'string' && session.parentSessionId.trim()) return session.parentSessionId.trim();
  const meta = session.metadata?.parentSessionId;
  return typeof meta === 'string' ? meta.trim() : '';
}

/** Pending approvals on this chat and on workers it spawned, including nested workers. */
export function approvalsForChat<T extends ApprovalItem>(
  chatId: string | null | undefined,
  approvals: readonly T[],
  sessions: readonly ApprovalSession[]
): T[] {
  if (!chatId) return [];
  const byId = new Map(sessions.map(session => [session.id, session]));
  const underChat = (sessionId: string): boolean => {
    const seen = new Set<string>();
    let current = sessionId;
    while (current && !seen.has(current)) {
      if (current === chatId) return true;
      seen.add(current);
      current = parentOf(byId.get(current));
    }
    return false;
  };
  return approvals.filter(item => (!item.status || item.status === 'pending') && underChat(item.sessionId));
}
