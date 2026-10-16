export type BotActivityStatus = 'running' | 'waiting' | 'done';

export type BotActivityItem = {
  id: string;
  title: string;
  status: BotActivityStatus;
  botId: string;
  botName: string;
  startedAt: string;
};

function isStatus(value: unknown): value is BotActivityStatus {
  return value === 'running' || value === 'waiting' || value === 'done';
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
    rows.push({
      id: row.id,
      title: row.title,
      status: row.status,
      botId: typeof row.botId === 'string' ? row.botId : '',
      botName:
        typeof row.botName === 'string' && row.botName.trim()
          ? row.botName
          : typeof row.botId === 'string'
            ? row.botId
            : '',
      startedAt: row.startedAt
    });
  }
  return rows;
}
