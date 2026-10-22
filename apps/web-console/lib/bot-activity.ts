export type BotActivityStatus = 'running' | 'waiting' | 'done';

export type BotActivityItem = {
  id: string;
  title: string;
  status: BotActivityStatus;
  outcomeStatus?: string;
  botId: string;
  botName: string;
  startedAt: string;
  sessionId?: string;
};

function isStatus(value: unknown): value is BotActivityStatus {
  return value === 'running' || value === 'waiting' || value === 'done';
}

/** Session this card may open. Blank and missing ids are not targets. */
export function activityOpenSessionId(item: { sessionId?: string | null }): string | undefined {
  if (typeof item.sessionId !== 'string') return undefined;
  const sessionId = item.sessionId.trim();
  return sessionId || undefined;
}

/** Open this activity's own session. Returns false when there is nothing to open. */
export function openBotActivitySession(
  openSession: (sessionId: string, opts?: { focusChat?: boolean }) => unknown,
  item: { sessionId?: string | null }
): boolean {
  const sessionId = activityOpenSessionId(item);
  if (!sessionId) return false;
  openSession(sessionId, { focusChat: true });
  return true;
}

/** Keep only rows the activity rail can render. */
export function parseBotActivityItems(payload: unknown): BotActivityItem[] {
  const items = payload && typeof payload === 'object' ? (payload as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return [];
  const rows: BotActivityItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Partial<BotActivityItem>;
    if (typeof row.id !== 'string' || typeof row.title !== 'string' || !isStatus(row.status)) continue;
    if (typeof row.startedAt !== 'string') continue;
    const sessionId = activityOpenSessionId({ sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined });
    rows.push({
      id: row.id,
      title: row.title,
      status: row.status,
      ...(typeof row.outcomeStatus === 'string' ? { outcomeStatus: row.outcomeStatus } : {}),
      botId: typeof row.botId === 'string' ? row.botId : '',
      botName:
        typeof row.botName === 'string' && row.botName.trim()
          ? row.botName
          : typeof row.botId === 'string'
            ? row.botId
            : '',
      startedAt: row.startedAt,
      ...(sessionId ? { sessionId } : {})
    });
  }
  return rows;
}
