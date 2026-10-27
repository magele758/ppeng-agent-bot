import type { OrderRegion, SidebarKind, SidebarRef } from './bot-pin.ts';

type RowFields = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  tie?: string;
};

export type BotSidebarRow<T> = RowFields & { kind: 'bot'; value: T };
export type RoomSidebarRow<T> = RowFields & { kind: 'room'; value: T };
export type SidebarRow<T> = BotSidebarRow<T> | RoomSidebarRow<T>;

export type SidebarDrag = {
  kind: SidebarKind;
  id: string;
  region: OrderRegion;
};

/** Creation time, then a stable tie. Activity fields are not sort keys. */
export function sortBotRows<T>(rows: readonly BotSidebarRow<T>[]): BotSidebarRow<T>[] {
  return rows.slice().sort((a, b) => {
    const created = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    if (created !== 0) return created;
    return (a.tie ?? a.id).localeCompare(b.tie ?? b.id);
  });
}

function sameRef(a: SidebarRef, b: SidebarRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Saved refs stay in front. Anything the saved list does not mention is appended
 * in the incoming order: bot rows first, then room rows.
 */
export function arrangeSidebarRows<B, R>(
  botRows: readonly BotSidebarRow<B>[],
  roomRows: readonly RoomSidebarRow<R>[],
  saved: readonly SidebarRef[] | undefined
): Array<BotSidebarRow<B> | RoomSidebarRow<R>> {
  const bots = botRows.slice();
  const rooms = roomRows.slice();
  if (!saved?.length) return [...bots, ...rooms];

  const botBuckets = new Map<string, BotSidebarRow<B>[]>();
  for (const row of bots) {
    const bucket = botBuckets.get(row.id);
    if (bucket) bucket.push(row);
    else botBuckets.set(row.id, [row]);
  }
  const roomById = new Map(rooms.map((row) => [row.id, row]));
  const usedBots = new Set<string>();
  const usedRooms = new Set<string>();
  const ordered: Array<BotSidebarRow<B> | RoomSidebarRow<R>> = [];

  for (const ref of saved) {
    if (ref.kind === 'bot') {
      if (usedBots.has(ref.id)) continue;
      const bucket = botBuckets.get(ref.id);
      if (!bucket) continue;
      usedBots.add(ref.id);
      ordered.push(...bucket);
      continue;
    }
    if (ref.kind !== 'room' || usedRooms.has(ref.id)) continue;
    const room = roomById.get(ref.id);
    if (!room) continue;
    usedRooms.add(ref.id);
    ordered.push(room);
  }

  for (const row of bots) {
    if (usedBots.has(row.id)) continue;
    const bucket = botBuckets.get(row.id) ?? [];
    usedBots.add(row.id);
    ordered.push(...bucket);
  }
  for (const row of rooms) {
    if (usedRooms.has(row.id)) continue;
    usedRooms.add(row.id);
    ordered.push(row);
  }
  return ordered;
}

export function regionRefs(rows: readonly { kind: SidebarKind; id: string }[]): SidebarRef[] {
  const refs: SidebarRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: row.kind, id: row.id });
  }
  return refs;
}

export function sameOrderRegion(a: OrderRegion, b: OrderRegion): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'group' && b.type === 'group') return a.id === b.id;
  return true;
}

export function orderRegionKey(region: OrderRegion): string {
  switch (region.type) {
    case 'pin':
      return 'pin';
    case 'ungrouped':
      return 'ungrouped';
    case 'looseRooms':
      return 'loose';
    case 'group':
      return `group:${region.id}`;
    default: {
      const leftover: never = region;
      return leftover;
    }
  }
}

export function dropPlace(clientY: number, top: number, height: number): 'before' | 'after' {
  if (!(height > 0)) return 'before';
  return clientY < top + height / 2 ? 'before' : 'after';
}

/** Move `moving` to just before or just after `target` inside one region. */
export function moveSidebarItem(
  items: readonly SidebarRef[],
  moving: SidebarRef,
  target: SidebarRef,
  place: 'before' | 'after'
): SidebarRef[] | null {
  if (sameRef(moving, target)) return null;
  const from = items.findIndex((item) => sameRef(item, moving));
  const targetIndex = items.findIndex((item) => sameRef(item, target));
  if (from < 0 || targetIndex < 0) return null;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  if (!item) return null;
  let index = next.findIndex((entry) => sameRef(entry, target));
  if (index < 0) return null;
  if (place === 'after') index += 1;
  next.splice(index, 0, item);
  if (next.length === items.length && next.every((entry, i) => sameRef(entry, items[i]!))) return null;
  return next;
}

let activeDrag: SidebarDrag | null = null;

export function beginSidebarDrag(drag: SidebarDrag): void {
  activeDrag = { kind: drag.kind, id: drag.id, region: { ...drag.region } };
}

export function endSidebarDrag(): void {
  activeDrag = null;
}

export function currentSidebarDrag(): SidebarDrag | null {
  return activeDrag;
}
