import { readRoomGoals, writeRoomGoals, type RoomGoalSnapshot } from './room-goals.js';
import { assignRoomTask, type AssignRoomTaskResult } from './room-tasks.js';
import { nowIso } from '../id.js';
import { ValidationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import { readRoomSettings } from './settings.js';

/** Last service store, so the host tool can extend a running turn without a service handle. */
let boundStore: SqliteStateStore | undefined;

export function bindRoomHostRoute(store: SqliteStateStore): void {
  boundStore = store;
}

export interface RoomRouteOptions { mode?: string; summarize?: boolean; assignments?: { botId: string; task: string; evidence: string }[]; reviewedTaskIds?: string[]; completeGoal?: boolean; verificationSummary?: string; evidenceMessageIds?: string[] }
interface RoutedTurn {
  replyMode?: string; ownerBotId?: string; goalId?: string; maxBotTurns?: number;
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
function applyHostRouteInner(
  store: SqliteStateStore,
  sessionId: string,
  requested: readonly string[],
  options?: RoomRouteOptions
): string[] {
  const session = store.getSession(sessionId);
  const roomId = session?.metadata?.roomId;
  if (typeof roomId !== 'string') throw new ValidationError('Not a room session');
  const roomRow = store.db.prepare('SELECT data FROM bot_rooms WHERE id=?').get(roomId) as { data: string } | undefined;
  const room = roomRow ? JSON.parse(roomRow.data) as { hostBotId?: string; botIds?: string[] } : undefined;
  if (!room?.botIds) throw new ValidationError('Room not found');
  const speaker = String(session?.metadata?.botId ?? '');
  const row = store.db.prepare(
    "SELECT id, data, status FROM bot_room_turns WHERE room_id=? AND status='running' AND json_extract(data,'$.currentSessionId')=?"
  ).get(roomId, sessionId) as { id: string; data: string; status: string } | undefined;
  const turn = decode(row);
  if (!turn || turn.status !== 'running') throw new ValidationError('No running room turn');
  const owner = turn.replyMode === 'task-collaboration' ? turn.ownerBotId : room.hostBotId;
  if (!owner || speaker !== owner) throw new ValidationError('Only the host or task owner can choose speakers');
  const collaboration = turn.replyMode === 'task-collaboration';
  if (!collaboration && (options?.mode === 'assign_tasks' || options?.assignments?.length || options?.reviewedTaskIds?.length || options?.completeGoal)) throw new ValidationError('Assigning tasks is not available in this round.');
  let board = collaboration ? readRoomGoals(store, roomId) : undefined;
  if (board) {
    const goal = board.goals.find(item => item.id === turn.goalId);
    if (!goal || goal.status !== 'running') throw new ValidationError('Task goal is no longer running');
    for (const id of requested) {
      if (!room.botIds.includes(id)) throw new ValidationError('Collaborator must be a room member');
      if (turn.botIds.includes(id)) continue;
      const assignment = options?.assignments?.find(item => item.botId === id);
      if (!assignment?.task?.trim() || !assignment?.evidence?.trim()) throw new ValidationError('Each collaborator requires a concrete task and expected evidence');
    }
    for (const taskId of options?.reviewedTaskIds ?? []) {
      const task = board.tasks.find(item => item.id === taskId && item.goalId === turn.goalId);
      if (!task || task.status !== 'waiting_approval' || !task.materialIds.length || !task.summary.trim()) throw new ValidationError('Task has no submitted evidence to review');
      task.status = 'completed';
    }
    if (options?.completeGoal) {
      if (board.tasks.some(task => task.goalId === turn.goalId && task.status !== 'completed')) throw new ValidationError('All assigned tasks must have reviewed evidence');
      if (requested.some(id => !turn.botIds.includes(id))) throw new ValidationError('Cannot complete while assigning new tasks');
      if (!options.verificationSummary?.trim() || !options.evidenceMessageIds?.length) throw new ValidationError('Goal completion requires evidence and a verification summary');
      const sharedMessages = store.db.prepare('SELECT data FROM bot_room_messages WHERE room_id=?').all(roomId) as { data: string }[];
      const validIds = new Set(sharedMessages.map(row => JSON.parse(row.data) as { id: string; turnId?: string; sender: { type: string }; text: string }).filter(message => message.turnId === turn.id && message.sender.type === 'bot' && message.text.trim()).map(message => message.id));
      if (options.evidenceMessageIds.some(id => !validIds.has(id))) throw new ValidationError('Completion evidence must reference this turn’s published bot results');
      goal.status = 'completed';
      goal.progress = options.verificationSummary.trim();
      goal.evidenceMessageIds = [...options.evidenceMessageIds];
    }
  }
  const cap = Math.min(readRoomSettings(store).maxWaveSpeakers, collaboration ? Math.max(1, (turn.maxBotTurns ?? 1) - 1) : Infinity);
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
  if (board && turn.goalId) {
    for (const id of accepted) {
      const assignment = options!.assignments!.find(item => item.botId === id)!;
      const assigned: AssignRoomTaskResult<RoomGoalSnapshot> = assignRoomTask(board!, { actorBotId: speaker, hostBotId: owner, assigneeBotId: id, roomBotIds: room.botIds, title: assignment.task.trim(), goalId: turn.goalId });
      if (!assigned.ok) throw new ValidationError(assigned.reason);
      board = assigned.snapshot;
      board!.tasks.find(task => task.id === assigned.task.id)!.expectedEvidence = assignment.evidence.trim();
    }
    writeRoomGoals(store, roomId, board!);
  }
  const summarize = options?.summarize === true || (collaboration && accepted.length > 0);
  if (accepted.length === 0 && dropped.length === 0 && !summarize) return [];
  turn.botIds = scheduled;
  if (accepted.length > 0) turn.routedBotIds = [...(turn.routedBotIds ?? []), ...accepted];
  if (dropped.length > 0) turn.routeDrops = [...(turn.routeDrops ?? []), ...dropped];
  if (summarize) turn.hostWrapUp = true;
  turn.updatedAt = nowIso();
  store.db.prepare('UPDATE bot_room_turns SET status=?, data=? WHERE id=?').run(turn.status, JSON.stringify(turn), turn.id);
  return accepted;
}

export function routeRoomTurnFromTool(sessionId: string, requested: readonly string[], options?: RoomRouteOptions): string[] {
  if (!boundStore) throw new ValidationError('Room routing is unavailable');
  return applyHostRoute(boundStore, sessionId, requested, options);
}

export function applyHostRoute(store: SqliteStateStore, sessionId: string, requested: readonly string[], options?: RoomRouteOptions): string[] {
  if (store.db.isTransaction) return applyHostRouteInner(store, sessionId, requested, options);
  store.db.exec('BEGIN IMMEDIATE');
  try { const result = applyHostRouteInner(store, sessionId, requested, options); store.db.exec('COMMIT'); return result; }
  catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export function roomTaskRouteReceipt(sessionId: string): string | undefined {
  if (!boundStore) return undefined;
  const roomId = boundStore.getSession(sessionId)?.metadata?.roomId;
  if (typeof roomId !== 'string') return undefined;
  const row = boundStore.db.prepare("SELECT data FROM bot_room_turns WHERE room_id=? AND status='running' AND json_extract(data,'$.currentSessionId')=?").get(roomId, sessionId) as { data: string } | undefined;
  const turn = decode(row);
  if (!turn?.goalId) return undefined;
  const board = readRoomGoals(boundStore, roomId);
  return JSON.stringify({ goal: board.goals.find(goal => goal.id === turn.goalId), tasks: board.tasks.filter(task => task.goalId === turn.goalId) });
}
