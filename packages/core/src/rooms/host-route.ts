import { nowIso } from '../id.js';
import { ValidationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import { readRoomSettings } from './settings.js';

/** Last service store, so the host tool can extend a running turn without a service handle. */
let boundStore: SqliteStateStore | undefined;

export function bindRoomHostRoute(store: SqliteStateStore): void {
  boundStore = store;
}

interface RoutedTurn {
  id: string;
  status: string;
  roomId: string;
  botIds: string[];
  currentSessionId?: string;
  routedBotIds?: string[];
  hostWrapUp?: boolean;
  routeDrops?: { id: string; reason: 'not_member' | 'over_cap' }[];
  updatedAt?: string;
}

function decode(row: { data: string } | undefined): RoutedTurn | undefined {
  return row ? JSON.parse(row.data) as RoutedTurn : undefined;
}

/**
 * Host-only, during a running room turn. Appends members who are in the room,
 * not already scheduled, up to the saved per-round speaker cap. Idempotent per bot id.
 * Outsiders and anyone past the cap are recorded so the room can say why they were dropped.
 * summarize asks the host for one closing summary after the other selected members finish.
 */
export function applyHostRoute(
  store: SqliteStateStore,
  sessionId: string,
  requested: readonly string[],
  options?: { summarize?: boolean }
): string[] {
  const session = store.getSession(sessionId);
  const roomId = session?.metadata?.roomId;
  if (typeof roomId !== 'string') throw new ValidationError('Not a room session');
  const roomRow = store.db.prepare('SELECT data FROM bot_rooms WHERE id=?').get(roomId) as { data: string } | undefined;
  const room = roomRow ? JSON.parse(roomRow.data) as { hostBotId?: string; botIds?: string[] } : undefined;
  if (!room?.botIds) throw new ValidationError('Room not found');
  const speaker = String(session?.metadata?.botId ?? '');
  if (!room.hostBotId || speaker !== room.hostBotId) throw new ValidationError('Only the host can choose speakers');
  const row = store.db.prepare(
    "SELECT id, data, status FROM bot_room_turns WHERE room_id=? AND status='running' AND json_extract(data,'$.currentSessionId')=?"
  ).get(roomId, sessionId) as { id: string; data: string; status: string } | undefined;
  const turn = decode(row);
  if (!turn || turn.status !== 'running') throw new ValidationError('No running room turn');
  const cap = readRoomSettings(store).maxWaveSpeakers;
  const accepted: string[] = [];
  const dropped: { id: string; reason: 'not_member' | 'over_cap' }[] = [];
  const scheduled = turn.botIds.slice();
  for (const id of requested) {
    if (typeof id !== 'string' || !id.trim()) continue;
    if (!room.botIds.includes(id)) {
      dropped.push({ id, reason: 'not_member' });
      continue;
    }
    if (scheduled.includes(id)) continue;
    if (scheduled.length >= cap) {
      dropped.push({ id, reason: 'over_cap' });
      continue;
    }
    scheduled.push(id);
    accepted.push(id);
  }
  const summarize = options?.summarize === true;
  if (accepted.length === 0 && dropped.length === 0 && !summarize) return [];
  turn.botIds = scheduled;
  if (accepted.length > 0) turn.routedBotIds = [...(turn.routedBotIds ?? []), ...accepted];
  if (dropped.length > 0) turn.routeDrops = [...(turn.routeDrops ?? []), ...dropped];
  if (summarize) turn.hostWrapUp = true;
  turn.updatedAt = nowIso();
  store.db.prepare('UPDATE bot_room_turns SET status=?, data=? WHERE id=?').run(turn.status, JSON.stringify(turn), turn.id);
  return accepted;
}

export function routeRoomTurnFromTool(sessionId: string, requested: readonly string[], options?: { summarize?: boolean }): string[] {
  if (!boundStore) throw new ValidationError('Room routing is unavailable');
  return applyHostRoute(boundStore, sessionId, requested, options);
}
