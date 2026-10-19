export const BOT_PIN_STORAGE_KEY = 'lab.botPins';

export type BotPinState = { customized: boolean; ids: string[] };

type PinStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type PinBot = { id: string; name: string; builtin?: boolean };

const SUPER_BOT_NAME = 'Super Bot';

function defaultState(): BotPinState {
  return { customized: false, ids: [] };
}

function browserStorage(): PinStorage | undefined {
  try {
    const storage = globalThis.localStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      return undefined;
    }
    return storage;
  } catch {
    return undefined;
  }
}

function parseBotPinState(raw: string | null): BotPinState {
  if (raw == null || raw === '') return defaultState();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultState();
    const record = value as { customized?: unknown; ids?: unknown };
    if (typeof record.customized !== 'boolean' || !Array.isArray(record.ids)) return defaultState();
    if (!record.ids.every((id) => typeof id === 'string')) return defaultState();
    return { customized: record.customized, ids: record.ids.slice() };
  } catch {
    return defaultState();
  }
}

/** Missing or unreadable storage means the visitor has never changed pins. */
export function loadBotPinState(storage?: PinStorage): BotPinState {
  const target = storage ?? browserStorage();
  if (!target) return defaultState();
  try {
    return parseBotPinState(target.getItem(BOT_PIN_STORAGE_KEY));
  } catch {
    return defaultState();
  }
}

export function saveBotPinState(state: BotPinState, storage?: PinStorage): void {
  const target = storage ?? browserStorage();
  if (!target) return;
  try {
    target.setItem(
      BOT_PIN_STORAGE_KEY,
      JSON.stringify({ customized: state.customized, ids: state.ids.slice() })
    );
  } catch {
    /* private mode / quota */
  }
}

/** The bot whose name is exactly "Super Bot". Several matches prefer `builtin`. */
export function superBotId(bots: readonly PinBot[]): string | null {
  const matches = bots.filter((bot) => bot.name === SUPER_BOT_NAME);
  if (matches.length === 0) return null;
  return (matches.find((bot) => bot.builtin === true) ?? matches[0]!).id;
}

/**
 * Not customized: only Super Bot, when one exists.
 * Customized: stored ids that still exist, without putting Super Bot back.
 */
export function displayPinnedIds(bots: readonly PinBot[], state: BotPinState): string[] {
  if (!state.customized) {
    const id = superBotId(bots);
    return id ? [id] : [];
  }
  const existing = new Set(bots.map((bot) => bot.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of state.ids) {
    if (!existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Mark the list as the visitor's own and append `id` once. */
export function pinBot(state: BotPinState, id: string): BotPinState {
  const ids = state.ids.includes(id) ? state.ids.slice() : [...state.ids, id];
  return { customized: true, ids };
}

/**
 * Remove `id` from the list the visitor currently sees.
 * An untouched default list is written down first, so Super Bot stays gone after refresh.
 */
export function unpinBot(state: BotPinState, bots: readonly PinBot[], id: string): BotPinState {
  return {
    customized: true,
    ids: displayPinnedIds(bots, state).filter((pinned) => pinned !== id)
  };
}
