export const BOT_PIN_STORAGE_KEY = 'lab.botPins';

export type SidebarKind = 'bot' | 'room';
export type SidebarRef = { kind: SidebarKind; id: string };

/** Visual order kept beside pin membership in the same lab.botPins record. */
export type SidebarOrders = {
  pin?: SidebarRef[];
  looseBots?: string[];
  looseRooms?: string[];
  groups?: Record<string, SidebarRef[]>;
};

export type OrderRegion =
  | { type: 'pin' }
  | { type: 'ungrouped' }
  | { type: 'looseRooms' }
  | { type: 'group'; id: string };

export type BotPinState = {
  customized: boolean;
  ids: string[];
  roomIds: string[];
  orders?: SidebarOrders;
};

type PinStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type PinBot = { id: string; name: string; builtin?: boolean };

const SUPER_BOT_NAME = 'Super Bot';

function defaultState(): BotPinState {
  return { customized: false, ids: [], roomIds: [] };
}

export function roomIdsOf(state: { roomIds?: readonly string[] }): string[] {
  return Array.isArray(state.roomIds) ? state.roomIds.filter((id) => typeof id === 'string').slice() : [];
}

function parseRoomIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) return [];
  return value.slice();
}

function cloneRef(ref: SidebarRef): SidebarRef {
  return { kind: ref.kind, id: ref.id };
}

function cleanOrders(orders: SidebarOrders | undefined): SidebarOrders | undefined {
  if (!orders) return undefined;
  const next: SidebarOrders = {};
  if (orders.pin?.length) next.pin = orders.pin.map(cloneRef);
  if (orders.looseBots?.length) next.looseBots = orders.looseBots.slice();
  if (orders.looseRooms?.length) next.looseRooms = orders.looseRooms.slice();
  if (orders.groups) {
    const groups: Record<string, SidebarRef[]> = {};
    for (const [id, refs] of Object.entries(orders.groups)) {
      if (id && refs?.length) groups[id] = refs.map(cloneRef);
    }
    if (Object.keys(groups).length) next.groups = groups;
  }
  return next.pin || next.looseBots || next.looseRooms || next.groups ? next : undefined;
}

function sameRefs(a: readonly SidebarRef[] | undefined, b: readonly SidebarRef[] | undefined): boolean {
  if (!a?.length && !b?.length) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((ref, index) => ref.kind === b[index]?.kind && ref.id === b[index]?.id);
}

function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a?.length && !b?.length) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

export function pinStatesEqual(a: BotPinState, b: BotPinState): boolean {
  if (a.customized !== b.customized || a.ids.length !== b.ids.length || roomIdsOf(a).length !== roomIdsOf(b).length) return false;
  if (a.ids.some((id, index) => id !== b.ids[index])) return false;
  const aRooms = roomIdsOf(a);
  const bRooms = roomIdsOf(b);
  if (aRooms.some((id, index) => id !== bRooms[index])) return false;
  return sameRefs(a.orders?.pin, b.orders?.pin)
    && sameIds(a.orders?.looseBots, b.orders?.looseBots)
    && sameIds(a.orders?.looseRooms, b.orders?.looseRooms)
    && sameGroupOrders(a.orders?.groups, b.orders?.groups);
}

function sameGroupOrders(a: SidebarOrders['groups'], b: SidebarOrders['groups']): boolean {
  const aKeys = Object.keys(a ?? {}).sort();
  const bKeys = Object.keys(b ?? {}).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) return false;
  return aKeys.every((key) => sameRefs(a?.[key], b?.[key]));
}

function finishPin(base: { customized: boolean; ids: string[]; roomIds: string[] }, orders: SidebarOrders | undefined): BotPinState {
  const cleaned = cleanOrders(orders);
  const next: BotPinState = { customized: base.customized, ids: base.ids.slice(), roomIds: base.roomIds.slice() };
  if (cleaned) next.orders = cleaned;
  return next;
}

function parseRefList(value: unknown): SidebarRef[] {
  if (!Array.isArray(value)) return [];
  const refs: SidebarRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const kind = (item as { kind?: unknown }).kind;
    const id = (item as { id?: unknown }).id;
    if ((kind !== 'bot' && kind !== 'room') || typeof id !== 'string' || !id.trim()) continue;
    refs.push({ kind, id });
  }
  return refs;
}

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function parseOrders(value: unknown): SidebarOrders | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { pin?: unknown; looseBots?: unknown; looseRooms?: unknown; groups?: unknown };
  const orders: SidebarOrders = {};
  const pin = parseRefList(record.pin);
  if (pin.length) orders.pin = pin;
  const looseBots = parseIdList(record.looseBots);
  if (looseBots.length) orders.looseBots = looseBots;
  const looseRooms = parseIdList(record.looseRooms);
  if (looseRooms.length) orders.looseRooms = looseRooms;
  if (record.groups && typeof record.groups === 'object' && !Array.isArray(record.groups)) {
    const groups: Record<string, SidebarRef[]> = {};
    for (const [id, list] of Object.entries(record.groups as Record<string, unknown>)) {
      const refs = parseRefList(list);
      if (id && refs.length) groups[id] = refs;
    }
    if (Object.keys(groups).length) orders.groups = groups;
  }
  return cleanOrders(orders);
}

function stripPinRef(orders: SidebarOrders | undefined, ref: SidebarRef): SidebarOrders | undefined {
  if (!orders?.pin?.length) return orders;
  return { ...orders, pin: orders.pin.filter((item) => item.kind !== ref.kind || item.id !== ref.id) };
}

/** Keep membership, replace the stored visual order for one region. */
export function withRegionOrder(state: BotPinState, region: OrderRegion, refs: readonly SidebarRef[]): BotPinState {
  const orders: SidebarOrders = cleanOrders(state.orders) ?? {};
  const list = refs.filter((ref) => (ref.kind === 'bot' || ref.kind === 'room') && ref.id.trim()).map(cloneRef);
  switch (region.type) {
    case 'pin':
      orders.pin = list;
      break;
    case 'ungrouped':
      orders.looseBots = list.filter((ref) => ref.kind === 'bot').map((ref) => ref.id);
      break;
    case 'looseRooms':
      orders.looseRooms = list.filter((ref) => ref.kind === 'room').map((ref) => ref.id);
      break;
    case 'group':
      orders.groups = { ...(orders.groups ?? {}), [region.id]: list };
      break;
    default: {
      const leftover: never = region;
      return leftover;
    }
  }
  return finishPin({ customized: state.customized, ids: state.ids, roomIds: roomIdsOf(state) }, orders);
}

/** Drop one item from a region's saved order so a later return appends. */
export function forgetRegionRef(state: BotPinState, region: OrderRegion, ref: SidebarRef): BotPinState {
  if (!state.orders) return state;
  const orders: SidebarOrders = cleanOrders(state.orders) ?? {};
  const drop = (list: readonly SidebarRef[] | undefined) => (list ?? []).filter((item) => item.kind !== ref.kind || item.id !== ref.id);
  switch (region.type) {
    case 'pin':
      orders.pin = drop(orders.pin);
      break;
    case 'ungrouped':
      if (ref.kind === 'bot') orders.looseBots = (orders.looseBots ?? []).filter((id) => id !== ref.id);
      break;
    case 'looseRooms':
      if (ref.kind === 'room') orders.looseRooms = (orders.looseRooms ?? []).filter((id) => id !== ref.id);
      break;
    case 'group':
      if (orders.groups?.[region.id]) orders.groups = { ...orders.groups, [region.id]: drop(orders.groups[region.id]) };
      break;
    default: {
      const leftover: never = region;
      return leftover;
    }
  }
  const next = finishPin({ customized: state.customized, ids: state.ids, roomIds: roomIdsOf(state) }, orders);
  return pinStatesEqual(state, next) ? state : next;
}

export function savedRegionRefs(state: BotPinState, region: OrderRegion): SidebarRef[] | undefined {
  const orders = state.orders;
  if (!orders) return undefined;
  switch (region.type) {
    case 'pin':
      return orders.pin?.length ? orders.pin.map(cloneRef) : undefined;
    case 'ungrouped':
      return orders.looseBots?.length ? orders.looseBots.map((id) => ({ kind: 'bot', id })) : undefined;
    case 'looseRooms':
      return orders.looseRooms?.length ? orders.looseRooms.map((id) => ({ kind: 'room', id })) : undefined;
    case 'group': {
      const list = orders.groups?.[region.id];
      return list?.length ? list.map(cloneRef) : undefined;
    }
    default: {
      const leftover: never = region;
      return leftover;
    }
  }
}

/** Membership change that keeps any saved visual order unless `orders` is passed. */
export function withPinMembership(
  state: BotPinState,
  customized: boolean,
  ids: readonly string[],
  roomIds: readonly string[],
  orders: SidebarOrders | undefined = state.orders
): BotPinState {
  return finishPin({ customized, ids: ids.slice(), roomIds: roomIds.slice() }, orders);
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
    const record = value as { customized?: unknown; ids?: unknown; roomIds?: unknown };
    if (typeof record.customized !== 'boolean' || !Array.isArray(record.ids)) return defaultState();
    if (!record.ids.every((id) => typeof id === 'string')) return defaultState();
    return finishPin(
      { customized: record.customized, ids: record.ids.slice(), roomIds: parseRoomIds(record.roomIds) },
      parseOrders((record as { orders?: unknown }).orders)
    );
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
    const payload = finishPin(
      { customized: state.customized, ids: state.ids.slice(), roomIds: roomIdsOf(state) },
      state.orders
    );
    target.setItem(BOT_PIN_STORAGE_KEY, JSON.stringify(payload));
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

/** Ids of group chats the visitor pinned. An untouched list pins none. */
export function displayPinnedRoomIds(rooms: readonly { id: string; title: string }[], state: BotPinState): string[] {
  if (!state.customized) return [];
  const existing = new Set(rooms.filter((room) => room.title.trim().length > 0).map((room) => room.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of roomIdsOf(state)) {
    if (!existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Mark the list as the visitor's own and append `id` once. Room pins stay put. */
export function pinBot(state: BotPinState, id: string): BotPinState {
  const ids = state.ids.includes(id) ? state.ids.slice() : [...state.ids, id];
  return withPinMembership(state, true, ids, roomIdsOf(state));
}

/**
 * Remove `id` from the list the visitor currently sees.
 * An untouched default list is written down first, so Super Bot stays gone after refresh.
 */
export function unpinBot(state: BotPinState, bots: readonly PinBot[], id: string): BotPinState {
  return withPinMembership(
    state,
    true,
    displayPinnedIds(bots, state).filter((pinned) => pinned !== id),
    roomIdsOf(state),
    stripPinRef(state.orders, { kind: 'bot', id })
  );
}
