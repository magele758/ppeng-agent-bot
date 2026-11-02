import { api } from './api.ts';
import { createPinSync } from './bot-pin-sync.ts';
import { botForCanonicalSession } from './bots.ts';
import {
  BOT_PIN_STORAGE_KEY,
  displayPinnedIds,
  displayPinnedRoomIds,
  loadBotPinState,
  pinBot,
  pinStatesEqual,
  roomIdsOf,
  saveBotPinState,
  unpinBot,
  withPinMembership,
  withRegionOrder,
  savedRegionRefs,
  forgetRegionRef,
  type BotPinState,
  type OrderRegion,
  type SidebarRef
} from './bot-pin.ts';
export { forgetRegionRef, savedRegionRefs };
export type { OrderRegion, SidebarRef };
export {
  arrangeSidebarRows,
  beginSidebarDrag,
  currentSidebarDrag,
  dropPlace,
  endSidebarDrag,
  moveSidebarItem,
  orderRegionKey,
  regionRefs,
  sameOrderRegion,
  sortBotRows
} from './sidebar-order.ts';
export type { SidebarDrag, SidebarRow } from './sidebar-order.ts';

export const BOT_DRAG_MIME = 'application/x-agent-home-bot';
export const BOT_PIN_DRAG_MIME = 'application/x-agent-home-bot-pin';
export const ROOM_DRAG_MIME = 'application/x-agent-home-room';
export const ROOM_PIN_DRAG_MIME = 'application/x-agent-home-room-pin';

export type PinRosterBot = {
  id: string;
  name: string;
  builtin?: boolean;
  hidden?: boolean;
  canonicalSessionId?: string;
};

export type PinRoom = { id: string; title: string };

export type PinDragKind = 'bot' | 'room' | 'pin' | 'foreign' | 'ignore';

export type PinAreaDropResult = {
  accept: boolean;
  landedInside: boolean;
  next: BotPinState | null;
};

const UNTOUCHED: BotPinState = { customized: false, ids: [], roomIds: [] };

const listeners = new Set<() => void>();
let cachedState: BotPinState = UNTOUCHED;

function samePinState(a: BotPinState, b: BotPinState): boolean {
  return pinStatesEqual(a, b);
}

function remember(state: BotPinState): BotPinState {
  const next = withPinMembership(state, state.customized, state.ids, roomIdsOf(state), state.orders);
  cachedState = pinStatesEqual(next, UNTOUCHED) ? UNTOUCHED : next;
  return cachedState;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeBotPins(listener: () => void): () => void {
  listeners.add(listener);
  const stopSync = startPinSync();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== BOT_PIN_STORAGE_KEY) return;
    listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    stopSync();
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Stable snapshot. Untouched storage matches the server snapshot. */
export function getBotPinSnapshot(): BotPinState {
  const next = loadBotPinState();
  if (samePinState(cachedState, next)) return cachedState;
  return remember(next);
}

export function commitRegionOrder(state: BotPinState, region: OrderRegion, refs: readonly SidebarRef[]): BotPinState {
  const next = withRegionOrder(state, region, refs);
  commitBotPinState(next);
  return next;
}

export function getBotPinServerSnapshot(): BotPinState {
  return UNTOUCHED;
}

export function commitBotPinState(state: BotPinState): void {
  const next = withPinMembership(state, state.customized, state.ids, roomIdsOf(state), state.orders);
  saveBotPinState(next);
  remember(next);
  emit();
  queuePinSave(next);
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

export function visiblePinnedRooms<T extends PinRoom>(rooms: readonly T[], state: BotPinState): T[] {
  const byId = new Map(rooms.filter((room) => room.title.trim().length > 0).map((room) => [room.id, room]));
  return displayPinnedRoomIds(rooms, state).flatMap((id) => {
    const room = byId.get(id);
    return room ? [room] : [];
  });
}

/** Pin a group chat beside the bots already shown. Membership in a functional group stays put. */
export function nextStateAfterRoomPinDrop(
  state: BotPinState,
  bots: readonly PinRosterBot[],
  rooms: readonly PinRoom[],
  roomId: string
): BotPinState | null {
  const id = roomId.trim();
  if (!id || !rooms.some((room) => room.id === id && room.title.trim().length > 0)) return null;
  const ids = displayPinnedIds(pinRoster(bots), state);
  const roomIds = displayPinnedRoomIds(rooms, { ...state, customized: true, ids, roomIds: roomIdsOf(state) });
  if (!roomIds.includes(id)) roomIds.push(id);
  return withPinMembership(state, true, ids, roomIds);
}

export function nextStateAfterRoomUnpin(
  state: BotPinState,
  bots: readonly PinRosterBot[],
  rooms: readonly PinRoom[],
  roomId: string
): BotPinState {
  const ids = displayPinnedIds(pinRoster(bots), state);
  const roomIds = displayPinnedRoomIds(rooms, { ...state, customized: true, ids, roomIds: roomIdsOf(state) }).filter((id) => id !== roomId);
  const orders = state.orders?.pin?.length
    ? { ...state.orders, pin: state.orders.pin.filter((item) => item.kind !== 'room' || item.id !== roomId) }
    : state.orders;
  return withPinMembership(state, true, ids, roomIds, orders);
}

export function nextStateAfterRoomPinDragEnd(
  state: BotPinState,
  bots: readonly PinRosterBot[],
  rooms: readonly PinRoom[],
  roomId: string,
  landedInside: boolean
): BotPinState | null {
  if (landedInside) return null;
  return nextStateAfterRoomUnpin(state, bots, rooms, roomId);
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
  if (list.has(BOT_PIN_DRAG_MIME) || list.has(ROOM_PIN_DRAG_MIME)) return 'pin';
  if (list.has(ROOM_DRAG_MIME)) return 'room';
  if (list.has(BOT_DRAG_MIME)) return 'bot';
  if (list.size > 0) return 'foreign';
  return 'ignore';
}

export function resultOfPinAreaDrop(
  state: BotPinState,
  bots: readonly PinRosterBot[],
  types: Iterable<string>,
  botId: string,
  rooms: readonly PinRoom[] = [],
  roomId = ''
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
    case 'room':
      return { accept: true, landedInside: false, next: nextStateAfterRoomPinDrop(state, bots, rooms, roomId) };
    default: {
      const leftover: never = kind;
      return leftover;
    }
  }
}

const pinSync = createPinSync(api);
let pendingPin: BotPinState | null = null;
let syncBusy = false;
async function syncPins(): Promise<void> {
  if (syncBusy) return;
  syncBusy = true;
  const pending = pendingPin;
  try {
    const state = await exchangePins(pending);
    if (pendingPin !== pending) return;
    pendingPin = null;
    saveBotPinState(state);
    remember(state);
    emit();
  } catch { /* Keep local state and retry on the next poll. */ }
  finally { syncBusy = false; }
}
function exchangePins(pending: BotPinState | null): Promise<BotPinState> {
  return pending ? pinSync.save(pending) : pinSync.refresh(loadBotPinState());
}
function queuePinSave(state: BotPinState): void {
  pendingPin = state;
  if (typeof window !== 'undefined') void syncPins();
}
function startPinSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  void syncPins();
  const timer = window.setInterval(() => void syncPins(), 3000);
  return () => window.clearInterval(timer);
}
