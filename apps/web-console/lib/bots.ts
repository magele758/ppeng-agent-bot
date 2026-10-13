import type { BotInfo } from './types';

export type CreateBotInput = {
  name: string;
  title?: string;
  description?: string;
};

export type OpenBotResponse = {
  bot?: BotInfo;
  session?: { id?: string; agentId?: string };
  sessionId?: string;
};

export type PlaySurface = 'chat' | 'bot';

export const PLAY_SURFACE_STORAGE_KEY = 'ppeng.lab.playSurface';

export function parsePlaySurface(value: unknown): PlaySurface | undefined {
  return value === 'chat' || value === 'bot' ? value : undefined;
}

export function readStoredPlaySurface(): PlaySurface {
  if (typeof window === 'undefined') return 'chat';
  try {
    return parsePlaySurface(window.localStorage.getItem(PLAY_SURFACE_STORAGE_KEY)) ?? 'chat';
  } catch {
    return 'chat';
  }
}

export function writeStoredPlaySurface(surface: PlaySurface): void {
  try {
    window.localStorage.setItem(PLAY_SURFACE_STORAGE_KEY, surface);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Sidebar session → Bot roster match (canonical session or per-user bot chat). */
export function botForCanonicalSession(
  bots: readonly BotInfo[],
  sessionId: string | null | undefined,
  sessions?: readonly { id: string; metadata?: Record<string, unknown> }[]
): BotInfo | undefined {
  if (!sessionId) return undefined;
  const byCanon = bots.find((b) => b.canonicalSessionId === sessionId);
  if (byCanon) return byCanon;
  const sess = sessions?.find((s) => s.id === sessionId);
  const botId = typeof sess?.metadata?.botId === 'string' ? sess.metadata.botId : '';
  if (botId && sess?.metadata?.canonicalBotChat === true) {
    return bots.find((b) => b.id === botId);
  }
  return undefined;
}

export function filterSessionsByPlaySurface<
  T extends { id: string; metadata?: Record<string, unknown> }
>(
  sessions: readonly T[],
  bots: readonly BotInfo[],
  surface: PlaySurface
): T[] {
  const botIds = new Set(bots.map((b) => b.id));
  const canonical = new Set(
    bots.map((b) => b.canonicalSessionId).filter((id): id is string => Boolean(id))
  );
  const isBotSession = (s: T) => {
    if (canonical.has(s.id)) return true;
    const botId = typeof s.metadata?.botId === 'string' ? s.metadata.botId : '';
    return Boolean(botId && botIds.has(botId) && s.metadata?.canonicalBotChat === true);
  };
  return sessions.filter((s) => !s.metadata?.roomId && (surface === 'bot' ? isBotSession(s) : !isBotSession(s)));
}

export function visibleBotRoster(bots: readonly BotInfo[]): BotInfo[] {
  return bots.filter((b) => !b.hidden);
}

export function parseOpenBotResponse(data: OpenBotResponse): { bot: BotInfo; sessionId: string } {
  const bot = data.bot;
  const sessionId = data.session?.id || data.sessionId;
  if (!bot?.id || !sessionId) {
    throw new Error('打开 Bot 失败：响应缺少 bot 或 session');
  }
  return { bot, sessionId };
}
