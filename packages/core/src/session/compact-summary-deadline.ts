/** Auxiliary summaries must not hold the interactive startup path indefinitely. */
export const COMPACT_SUMMARY_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 30_000;
const cooldowns = new WeakMap<object, Map<string, number>>();

export class CompactSummaryTimeout extends Error {
  constructor() { super('History summary exceeded the startup deadline'); }
}

export function summaryCoolingDown(store: object, sessionId: string): boolean {
  const entries = cooldowns.get(store);
  if (!entries) return false;
  const now = Date.now();
  for (const [id, until] of entries) if (until <= now) entries.delete(id);
  return entries.has(sessionId);
}

export async function summarizeWithinDeadline(
  store: object,
  sessionId: string,
  summarize: (signal: AbortSignal) => Promise<string>
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new CompactSummaryTimeout();
      reject(error);
      controller.abort(error);
    }, COMPACT_SUMMARY_TIMEOUT_MS);
  });
  try {
    // Race also bounds custom adapters that ignore the cancellation signal.
    const summary = await Promise.race([Promise.resolve().then(() => summarize(controller.signal)), deadline]);
    cooldowns.get(store)?.delete(sessionId);
    return summary;
  } catch (error) {
    if (error instanceof CompactSummaryTimeout) {
      const entries = cooldowns.get(store) ?? new Map<string, number>();
      entries.set(sessionId, Date.now() + RETRY_DELAY_MS);
      cooldowns.set(store, entries);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
