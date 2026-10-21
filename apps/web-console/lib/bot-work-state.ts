/** Per-Bot count of actual executing work, never an unresolved task total. */
export type BotWorkStates = Readonly<Record<string, number>>;
export type BotWorkOverview = Record<string, { running: number; queued: number; waiting: number; unknown: number }>;
export function parseBotWorkOverview(payload: unknown): BotWorkOverview {
  const rows = payload && typeof payload === 'object' ? (payload as { bots?: unknown }).bots : undefined;
  if (!Array.isArray(rows)) return {};
  const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
  const overview: BotWorkOverview = {};
  for (const row of rows) {
    if (typeof row?.bot?.id !== 'string') continue;
    overview[row.bot.id] = {
      running: count(row.activeWorkCount),
      queued: count(row.pending),
      waiting: Math.max(count(row.taskCounts?.waiting_approval), row.status === 'waiting_approval' ? 1 : 0),
      unknown: Math.max(count(row.taskCounts?.unknown), row.status === 'unknown' ? 1 : 0),
    };
  }
  return overview;
}
export function parseBotWorkStates(payload: unknown): BotWorkStates {
  const rows = payload && typeof payload === 'object' ? (payload as {bots?:unknown}).bots : undefined;
  if (!Array.isArray(rows)) return {};
  const states: Record<string, number> = {};
  for (const row of rows) {
    const id = row?.bot?.id;
    const count = row?.activeWorkCount;
    if (typeof id === 'string' && Number.isSafeInteger(count) && count > 0) states[id] = count;
  }
  return states;
}
