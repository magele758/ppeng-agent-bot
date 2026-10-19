import { botForCanonicalSession } from './bots.ts';
import {
  BOT_PIN_STORAGE_KEY,
  displayPinnedIds,
  loadBotPinState,
  pinBot,
  saveBotPinState,
  unpinBot,
  type BotPinState
} from './bot-pin.ts';

export const BOT_DRAG_MIME = 'application/x-agent-home-bot';
export const BOT_PIN_DRAG_MIME = 'application/x-agent-home-bot-pin';

export type PinRosterBot = {
  id: string;
  name: string;
  builtin?: boolean;
  hidden?: boolean;
  canonicalSessionId?: string;
};

export type PinDragKind = 'bot' | 'pin' | 'foreign' | 'ignore';

export type PinAreaDropResult = {
  accept: boolean;
  landedInside: boolean;
  next: BotPinState | null;
};

const UNTOUCHED: BotPinState = { customized: false, ids: [] };

const listeners = new Set<() => void>();
let cachedState: BotPinState = UNTOUCHED;

function samePinState(a: BotPinState, b: BotPinState): boolean {
  if (a.customized !== b.customized || a.ids.length !== b.ids.length) return false;
  for (let index = 0; index < a.ids.length; index += 1) {
    if (a.ids[index] !== b.ids[index]) return false;
  }
  return true;
}

function remember(state: BotPinState): BotPinState {
  cachedState = !state.customized && state.ids.length === 0
    ? UNTOUCHED
    : { customized: state.customized, ids: state.ids.slice() };
  return cachedState;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeBotPins(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== BOT_PIN_STORAGE_KEY) return;
    listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Stable snapshot. Untouched storage matches the server snapshot. */
export function getBotPinSnapshot(): BotPinState {
  const next = loadBotPinState();
  if (samePinState(cachedState, next)) return cachedState;
  return remember(next);
}

export function getBotPinServerSnapshot(): BotPinState {
  return UNTOUCHED;
}

export function commitBotPinState(state: BotPinState): void {
  const next = { customized: state.customized, ids: state.ids.slice() };
  saveBotPinState(next);
  remember(next);
  emit();
}

export function pinRoster<T extends PinRosterBot>(bots: readonly T[]): T[] {
  return bots.filter((bot) => !bot.hidden && bot.name.trim().length > 0);
}

export function visiblePinnedBots<T extends PinRosterBot>(bots: readonly T[], state: BotPinState): T[] {
  const roster = pinRoster(bots);
  const byId = new Map(roster.map((bot) => [bot.id, bot]));
  return displayPinnedIds(roster, state).flatMap((id) => {
    const bot = byId.get(id);
    return bot ? [bot] : [];
  });
}

/** Rows already drawn in the pin area stay out of the groups underneath. Membership is unchanged. */
export function groupRowsWithoutPinnedBots<T extends { id: string; metadata?: Record<string, unknown> }>(
  rows: readonly T[],
  bots: readonly PinRosterBot[],
  sessions: readonly { id: string; metadata?: Record<string, unknown> }[],
  state: BotPinState
): T[] {
  const pinned = new Set(visiblePinnedBots(bots, state).map((bot) => bot.id));
  if (pinned.size === 0) return rows.slice();
  return rows.filter((row) => {
    const bot = botForCanonicalSession(bots, row.id, sessions);
    return !bot || !pinned.has(bot.id);
  });
}

/** Pin onto the bots already shown, so default Super Bot stays until dragged out. */
export function nextStateAfterPinDrop(state: BotPinState, bots: readonly PinRosterBot[], botId: string): BotPinState | null {
  const id = botId.trim();
  if (!id) return null;
  const roster = pinRoster(bots);
  if (!roster.some((bot) => bot.id === id)) return null;
  return pinBot({ ...state, ids: displayPinnedIds(roster, state) }, id);
}

export function nextStateAfterUnpin(state: BotPinState, bots: readonly PinRosterBot[], botId: string): BotPinState {
  return unpinBot(state, pinRoster(bots), botId);
}

export function nextStateAfterPinDragEnd(
  state: BotPinState,
  bots: readonly PinRosterBot[],
  botId: string,
  landedInside: boolean
): BotPinState | null {
  if (landedInside) return null;
  return nextStateAfterUnpin(state, bots, botId);
}

export function pinDragKind(types: Iterable<string>): PinDragKind {
  const list = new Set(Array.from(types));
  if (list.has('Files')) return 'foreign';
  if (list.has(BOT_PIN_DRAG_MIME)) return 'pin';
  if (list.has(BOT_DRAG_MIME)) return 'bot';
  if (list.size > 0) return 'foreign';
  return 'ignore';
}

export function resultOfPinAreaDrop(
  state: BotPinState,
  bots: readonly PinRosterBot[],
  types: Iterable<string>,
  botId: string
): PinAreaDropResult {
  const kind = pinDragKind(types);
  switch (kind) {
    case 'ignore':
      return { accept: false, landedInside: false, next: null };
    case 'foreign':
      return { accept: true, landedInside: false, next: null };
    case 'pin':
      return { accept: true, landedInside: true, next: null };
    case 'bot':
      return { accept: true, landedInside: false, next: nextStateAfterPinDrop(state, bots, botId) };
    default: {
      const leftover: never = kind;
      return leftover;
    }
  }
}
