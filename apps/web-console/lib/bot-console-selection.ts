/**
 * Bot detail selection and the chat page's default-bot load.
 * A newer selection invalidates in-flight /open results. The default-bot guard
 * releases on effect cleanup so React Strict Mode's second pass can still load.
 */

export function selectionForBot(bot: { id: string; canonicalSessionId: string }): {
  botId: string;
  sessionId: string;
} {
  return { botId: bot.id, sessionId: bot.canonicalSessionId };
}

/** Hide rows that belong to a session the user is no longer looking at. */
export function rowsForSession<T>(sessionId: string, loadedSessionId: string, rows: readonly T[]): readonly T[] {
  return sessionId === loadedSessionId ? rows : [];
}

export function createGenerationGuard() {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    invalidate(): void {
      current += 1;
    },
    isCurrent(generation: number): boolean {
      return generation === current;
    }
  };
}

export type BotDetailLoadResult<Settings> =
  | { status: 'ready'; sessionId: string; settings: Settings }
  | { status: 'stale' }
  | { status: 'error'; error: unknown };

export async function loadSelectedBotDetail<Settings>(args: {
  botId: string;
  generation: number;
  isCurrent: (generation: number) => boolean;
  openSession: (botId: string) => Promise<string>;
  readSettings: (sessionId: string) => Promise<Settings>;
}): Promise<BotDetailLoadResult<Settings>> {
  try {
    const sessionId = await args.openSession(args.botId);
    if (!args.isCurrent(args.generation)) return { status: 'stale' };
    const settings = await args.readSettings(sessionId);
    if (!args.isCurrent(args.generation)) return { status: 'stale' };
    return { status: 'ready', sessionId, settings };
  } catch (error) {
    if (!args.isCurrent(args.generation)) return { status: 'stale' };
    return { status: 'error', error };
  }
}

export type DefaultBotLoadInput = {
  playSurface: string;
  botId: string;
  selectedSessionId: string | null;
};

export function defaultBotLoadNeeded(input: DefaultBotLoadInput): boolean {
  return input.playSurface === 'bot' && input.botId === '' && input.selectedSessionId == null;
}

export function createDefaultBotLoadGuard() {
  let epoch = 0;
  let heldEpoch = 0;
  return {
    get held(): boolean {
      return heldEpoch !== 0;
    },
    tryAcquire(input: DefaultBotLoadInput): number {
      if (!defaultBotLoadNeeded(input) || heldEpoch !== 0) return 0;
      heldEpoch = ++epoch;
      return heldEpoch;
    },
    release(ticket: number): void {
      if (ticket !== 0 && heldEpoch === ticket) heldEpoch = 0;
    }
  };
}

export function startDefaultBotLoadEffect(
  guard: ReturnType<typeof createDefaultBotLoadGuard>,
  input: DefaultBotLoadInput,
  load: (isCancelled: () => boolean) => Promise<void>
): (() => void) | void {
  const ticket = guard.tryAcquire(input);
  if (ticket === 0) return;
  let cancelled = false;
  void (async () => {
    try {
      await load(() => cancelled);
    } finally {
      if (!cancelled) guard.release(ticket);
    }
  })().catch(() => {
    /* The loader records its own user-visible error. */
  });
  return () => {
    cancelled = true;
    guard.release(ticket);
  };
}
