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
export function botForCanonicalSession<T extends { id: string; canonicalSessionId?: string | null }>(
  bots: readonly T[],
  sessionId: string | null | undefined,
  sessions?: readonly { id: string; metadata?: Record<string, unknown> }[]
): T | undefined {
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

/** A bot-spawned child task (goal worker or concurrent fork), not the bot's own chat. */
export function isBotForkChildSession(metadata: Record<string, unknown> | undefined): boolean {
  const source = metadata?.spawnSource;
  return metadata?.botGoalWorker === true || source === 'bot-goal-continuation' || source === 'concurrent-bot-work';
}

/** Child tasks leave the bot sidebar. A bot's own canonical chat is never one of them. */
export function isSidebarForkChild<T extends { id: string; metadata?: Record<string, unknown> }>(
  session: T,
  bots: readonly { canonicalSessionId?: string | null }[]
): boolean {
  if (!isBotForkChildSession(session.metadata)) return false;
  if (session.metadata?.canonicalBotChat === true) return false;
  return !bots.some((bot) => bot.canonicalSessionId === session.id);
}

/** Child tasks belonging to this bot. Titles stay the stored task text. */
export function childTasksForBot<T extends { id: string; title: string; metadata?: Record<string, unknown> }>(
  sessions: readonly T[],
  bot: { id: string; canonicalSessionId?: string | null }
): T[] {
  const parentIds = new Set<string>();
  if (bot.canonicalSessionId) parentIds.add(bot.canonicalSessionId);
  for (const session of sessions) {
    if (session.metadata?.canonicalBotChat === true && session.metadata.botId === bot.id) {
      parentIds.add(session.id);
    }
  }
  return sessions.filter((session) => {
    if (!isSidebarForkChild(session, [bot])) return false;
    const botId = typeof session.metadata?.botId === 'string' ? session.metadata.botId : '';
    if (botId) return botId === bot.id;
    const parent = session.metadata?.parentSessionId;
    return typeof parent === 'string' && parentIds.has(parent);
  });
}

export function filterSessionsByPlaySurface<
  T extends { id: string; metadata?: Record<string, unknown> }
>(
  sessions: readonly T[],
  bots: readonly BotInfo[],
  surface: PlaySurface
): T[] {
  const canonical = new Set(
    bots.map((b) => b.canonicalSessionId).filter((id): id is string => Boolean(id))
  );
  const isBotSession = (s: T) => canonical.has(s.id) || s.metadata?.canonicalBotChat === true;
  return sessions.filter((s) => {
    if (s.metadata?.roomId) return false;
    const child = isSidebarForkChild(s, bots);
    if (surface === 'bot') return !child && isBotSession(s);
    if (child) return true;
    return !isBotSession(s);
  });
}

/** Sidebar rows for one play surface, including a selected row only when that surface already keeps it. */
export function sessionsForPlaySurface<
  T extends { id: string; metadata?: Record<string, unknown> }
>(
  sessions: readonly T[],
  bots: readonly BotInfo[],
  surface: PlaySurface,
  selectedSessionId?: string | null
): T[] {
  const scoped = filterSessionsByPlaySurface(sessions, bots, surface);
  if (!selectedSessionId) return scoped;
  if (scoped.some((session) => session.id === selectedSessionId)) return scoped;
  const current = sessions.find((session) => session.id === selectedSessionId);
  if (!current) return scoped;
  if (filterSessionsByPlaySurface([current], bots, surface).length === 0) return scoped;
  return [current, ...scoped];
}

/** The chat a pinned bot shows. Child tasks are not that chat. */
export function sessionForPinnedBot<
  T extends { id: string; metadata?: Record<string, unknown> },
  B extends { id: string; canonicalSessionId?: string | null }
>(bot: B, bots: readonly B[], sessions: readonly T[]): T | undefined {
  const rows = sessions.filter((session) => !isSidebarForkChild(session, bots));
  if (bot.canonicalSessionId) {
    const direct = rows.find((session) => session.id === bot.canonicalSessionId);
    if (direct) return direct;
  }
  return rows.find((session) => botForCanonicalSession(bots, session.id, rows)?.id === bot.id);
}

export function visibleBotRoster(bots: readonly BotInfo[]): BotInfo[] {
  return bots.filter((b) => !b.hidden);
}

export type BotsPane = 'create' | 'group' | 'detail' | 'none';

/** Which right-hand pane the roster shows. Create wins over group, group over a selected bot. */
export function botsPane(creating: boolean, creatingGroup: boolean, hasSelection: boolean): BotsPane {
  if (creating) return 'create';
  if (creatingGroup) return 'group';
  if (hasSelection) return 'detail';
  return 'none';
}

/** A card stays selected only while no create/group pane is covering the detail. */
export function botCardSelected(botId: string, selectedId: string | null, paneOpen: boolean): boolean {
  return botId === selectedId && !paneOpen;
}

/** A subtitle is shown only when the title differs from the name. */
export function botCardSubtitle(name: string, title: string | null | undefined): string | null {
  if (!title || title === name) return null;
  return title;
}

export type BotsHashIntent =
  | { kind: 'group' }
  | { kind: 'permissions'; botId: string }
  | { kind: 'ignore' };

/** What a location hash asks the roster to open. Group create wins over a permissions deep link. */
export function botsHashIntent(
  hash: string,
  readGroup: (hash: string) => boolean,
  readPermissions: (hash: string) => { botId: string } | null
): BotsHashIntent {
  if (readGroup(hash)) return { kind: 'group' };
  const target = readPermissions(hash);
  if (!target) return { kind: 'ignore' };
  return { kind: 'permissions', botId: target.botId };
}

export type BotsHashSetters = {
  setCreating: (value: boolean) => void;
  setCreatingGroup: (value: boolean) => void;
  setNotice: (value: null) => void;
  setQuery: (value: string) => void;
  setSelectedId: (value: string) => void;
};

/** Apply a hash intent. An unrecognized hash leaves the roster alone. */
export function applyBotsHash(
  hash: string,
  readGroup: (hash: string) => boolean,
  readPermissions: (hash: string) => { botId: string } | null,
  set: BotsHashSetters
): void {
  const intent = botsHashIntent(hash, readGroup, readPermissions);
  if (intent.kind === 'ignore') return;
  set.setCreating(false);
  set.setNotice(null);
  if (intent.kind === 'group') {
    set.setCreatingGroup(true);
    return;
  }
  set.setCreatingGroup(false);
  set.setQuery('');
  set.setSelectedId(intent.botId);
}

/** Empty roster with nothing open shows the empty state instead of the split view. */
export function showBotsEmpty(rosterCount: number, pane: BotsPane): boolean {
  return rosterCount === 0 && pane !== 'create' && pane !== 'group';
}

export function parseOpenBotResponse(data: OpenBotResponse): { bot: BotInfo; sessionId: string } {
  const bot = data.bot;
  const sessionId = data.session?.id || data.sessionId;
  if (!bot?.id || !sessionId) {
    throw new Error('打开 Bot 失败：响应缺少 bot 或 session');
  }
  return { bot, sessionId };
}
