import type { BotInfo, SessionSummary } from './types';
import { botForCanonicalSession, isSidebarForkChild } from './bots.ts';

export type FunctionalGroup = { id: string; name: string; botIds: string[]; roomIds?: string[] };
export type SharedFact = { key: string; value: string };

export const FUNCTIONAL_GROUPS_CHANGED_EVENT = 'ppeng-functional-groups-changed';

export function groupForBot(groups: readonly FunctionalGroup[], botId: string): string | null {
  return groups.find(group => group.botIds.includes(botId))?.id ?? null;
}

export function functionalGroupRows(groups: readonly FunctionalGroup[], bots: readonly BotInfo[], sessions: readonly SessionSummary[], groupId: string | null) {
  return sessions.filter(session => {
    if (isSidebarForkChild(session, bots)) return false;
    const bot = botForCanonicalSession(bots, session.id, sessions);
    if (bot?.hidden) return false;
    const assigned = bot ? groupForBot(groups, bot.id) : null;
    return assigned === groupId;
  });
}

export function canMoveBot(groups: readonly FunctionalGroup[], bots: readonly BotInfo[], pending: boolean, botId: string, groupId: string | null): boolean {
  if (pending) return false;
  if (!bots.some(bot => bot.id === botId)) return false;
  return groupForBot(groups, botId) !== groupId;
}

export function moveBotInGroups(groups: readonly FunctionalGroup[], botId: string, groupId: string | null): FunctionalGroup[] {
  return groups.map(group => ({ ...group, botIds: [...group.botIds.filter(id => id !== botId), ...(group.id === groupId ? [botId] : [])] }));
}

export function moveRoomInGroups(groups: readonly FunctionalGroup[], roomId: string, groupId: string | null): FunctionalGroup[] {
  return groups.map(group => {
    const kept = (group.roomIds ?? []).filter(id => id !== roomId);
    return { ...group, roomIds: group.id === groupId ? [...kept, roomId] : kept };
  });
}

export function canMoveRoom(groups: readonly FunctionalGroup[], rooms: readonly { id: string }[], pending: boolean, roomId: string, groupId: string | null): boolean {
  if (pending || !roomId) return false;
  if (!rooms.some(room => room.id === roomId)) return false;
  const current = groups.find(group => (group.roomIds ?? []).includes(roomId))?.id ?? null;
  return current !== groupId;
}

export function looseRooms<T extends { id: string }>(rooms: readonly T[], groups: readonly { roomIds?: readonly string[] }[], pinnedRoomIds: readonly string[]): T[] {
  const placed = new Set(groups.flatMap(group => group.roomIds ?? []));
  const pinned = new Set(pinnedRoomIds);
  return rooms.filter(room => !placed.has(room.id) && !pinned.has(room.id));
}

export function roomsInGroup<T extends { id: string }>(rooms: readonly T[], group: { roomIds?: readonly string[] } | null, pinnedRoomIds: readonly string[]): T[] {
  if (!group) return [];
  const pinned = new Set(pinnedRoomIds);
  const byId = new Map(rooms.map(room => [room.id, room]));
  return (group.roomIds ?? []).flatMap(id => {
    if (pinned.has(id)) return [];
    const room = byId.get(id);
    return room ? [room] : [];
  });
}

export function upsertFunctionalGroup(groups: readonly FunctionalGroup[], group: FunctionalGroup): FunctionalGroup[] {
  const previous = groups.find(item => item.id === group.id);
  const roomIds = group.roomIds ?? previous?.roomIds;
  const next = roomIds === undefined ? group : { ...group, roomIds };
  if (!previous) return [...groups, next];
  return groups.map(item => item.id === group.id ? next : item);
}

export function factEditorState(rows: readonly SharedFact[], busy: boolean, ready: boolean) {
  const keys = rows.map(row => row.key.trim());
  const valid = keys.every(Boolean) && new Set(keys).size === keys.length;
  const disabled = busy || !ready;
  return { disabled, saveDisabled: disabled || !valid };
}

export function functionalGroupPresentation(group: FunctionalGroup | null, ungrouped: string) {
  return { id: group?.id ?? null, key: group?.id ?? 'ungrouped', name: group?.name ?? ungrouped };
}

export function groupSaveDisabled(editing: { name: string } | null, pending: boolean): boolean {
  if (!editing) return true;
  return pending || !editing.name.trim();
}

export function functionalGroupSaveRequest(editing: { id?: string; name: string }) {
  const suffix = editing.id ? `/${encodeURIComponent(editing.id)}` : '';
  return { path: `/api/bot-functional-groups${suffix}`, options: {
    method: editing.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: editing.name.trim() })
  } };
}
