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
