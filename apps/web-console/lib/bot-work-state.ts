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

/** Any Bot with work in progress. */
export function anyBotWorking(states: BotWorkStates): boolean {
  return Object.values(states).some((count) => count > 0);
}

/**
 * Wait before the next work-status read: every second while a Bot is working,
 * every two while all are idle, five while the tab is hidden (desktop notices
 * still need it), and the existing back-off after failures.
 */
export function botWorkPollMs(input: { failures: number; working: boolean; hidden: boolean }): number {
  if (input.failures > 0) return Math.min(8000, 1000 * input.failures);
  if (input.hidden) return 5000;
  return input.working ? 1000 : 2000;
}
