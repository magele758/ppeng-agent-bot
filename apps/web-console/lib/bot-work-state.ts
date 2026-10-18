/** Per-Bot count of actual executing work, never an unresolved task total. */
export type BotWorkStates = Readonly<Record<string, number>>;
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
