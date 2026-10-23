/**
 * Room subtasks and a single next-wave peer request.
 * The task list lives on the room goal snapshot (`bot.room-goals:${roomId}`).
 * Nothing here writes private goal storage, bot work rows, swarm, or orchestration.
 *
 * The room scheduler calls these later (not wired in this change):
 * - assignRoomTask(snapshot, input) for the host tool room_assign_task, then writeRoomGoals
 * - checkpointRoomTask(snapshot, input) for room_task_checkpoint, then writeRoomGoals
 * - roomTaskBoard(snapshot) when the room shows assignees and progress
 * - requestNextWavePeer(roster, request) for room_request_peer; speak only scheduledBotIds
 * - applyMemberHumanStep(snapshot, input, viewRoomHumanStep(...)) on a human step
 *
 * requestNextWavePeer does not schedule the rest of the room. A member who already
 * spoke this round is not added again. The caller supplies the round's speaker cap.
 */

import { randomUUID } from 'node:crypto';

export type RoomTaskStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type RoomTaskSettlement = '待核对' | '仍在收尾';

export interface RoomSubTask {
  expectedEvidence?: string;
  id: string;
  goalId: string;
  goalRevision: number;
  title: string;
  assigneeBotId: string;
  blockedBy: string[];
  status: RoomTaskStatus;
  summary: string;
  materialIds: string[];
  settlement?: RoomTaskSettlement;
  /** Set when the member's step moved to private chat. The task itself is not failed. */
  handoff?: 'private_chat';
  updatedAt: string;
}

export interface RoomTaskBoardRow {
  id: string;
  title: string;
  assigneeBotId: string;
  status: RoomTaskStatus;
  progress: string;
  settlement?: RoomTaskSettlement;
}

export interface RoomTaskGoalRef {
  id: string;
  revision: number;
}

export interface RoomWaveRoster {
  roomBotIds: readonly string[];
  scheduledBotIds: readonly string[];
  spokenBotIds: readonly string[];
  maxSpeakers: number;
}

export interface RoomPeerRequest {
  fromBotId: string;
  targetBotId: string;
  /** Set when the caller named more than the one allowed next expert. */
  extraTargetBotIds?: readonly string[];
}

export type RoomPeerRejectReason =
  | 'not_member'
  | 'not_in_room'
  | 'self'
  | 'already_spoken'
  | 'already_scheduled'
  | 'over_cap'
  | 'too_many';

export interface RoomPeerDecision {
  ok: boolean;
  reason?: RoomPeerRejectReason;
  addedBotId?: string;
  /** Scheduler must speak this list only. Do not replace it with the whole room. */
  scheduledBotIds: string[];
  wokenBotIds: string[];
}

export interface AssignRoomTaskInput {
  actorBotId: string;
  hostBotId: string;
  assigneeBotId: string;
  roomBotIds: readonly string[];
  title: string;
  goalId: string;
  id?: string;
  now?: string;
}

export type AssignRoomTaskResult<T> =
  | { ok: true; snapshot: T; task: RoomSubTask }
  | { ok: false; reason: 'not_host' | 'not_member' | 'empty_title' | 'missing_goal'; snapshot: T };

export interface CheckpointRoomTaskInput {
  actorBotId: string;
  hostBotId: string;
  taskId: string;
  summary?: string;
  status?: RoomTaskStatus;
  now?: string;
}

export type CheckpointRoomTaskResult<T> =
  | { ok: true; snapshot: T; task: RoomSubTask }
  | { ok: false; reason: 'not_found' | 'not_assignee' | 'pending_review'; snapshot: T };

export interface MemberHumanStepInput {
  botId: string;
  taskId?: string;
  selectedBotIds: readonly string[];
}

export interface MemberHumanStepDecision {
  memberOutcome: 'handed_to_private_chat' | 'waiting_on_member';
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function unique(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function withTasks<T extends { tasks: RoomSubTask[] }>(snapshot: T, tasks: RoomSubTask[]): T {
  return { ...structuredClone(snapshot), tasks };
}

export function roomTaskBoard(snapshot: { tasks: readonly RoomSubTask[] }): RoomTaskBoardRow[] {
  return snapshot.tasks.map(task => ({
    id: task.id,
    title: task.title,
    assigneeBotId: task.assigneeBotId,
    status: task.status,
    progress: task.summary,
    ...(task.settlement ? { settlement: task.settlement } : {}),
  }));
}

export function assignRoomTask<T extends { goals: readonly RoomTaskGoalRef[]; tasks: RoomSubTask[] }>(
  snapshot: T,
  input: AssignRoomTaskInput
): AssignRoomTaskResult<T> {
  const title = input.title.trim();
  const hostInRoom = input.roomBotIds.includes(input.hostBotId);
  if (input.actorBotId !== input.hostBotId || !hostInRoom) return { ok: false, reason: 'not_host', snapshot };
  if (!title) return { ok: false, reason: 'empty_title', snapshot };
  if (!input.roomBotIds.includes(input.assigneeBotId)) return { ok: false, reason: 'not_member', snapshot };
  const goal = snapshot.goals.find(item => item.id === input.goalId);
  if (!goal) return { ok: false, reason: 'missing_goal', snapshot };
  const task: RoomSubTask = {
    id: input.id ?? createId('rtask'),
    goalId: goal.id,
    goalRevision: goal.revision,
    title,
    assigneeBotId: input.assigneeBotId,
    blockedBy: [],
    status: 'queued',
    summary: '',
    materialIds: [],
    updatedAt: input.now ?? nowIso(),
  };
  return { ok: true, task, snapshot: withTasks(snapshot, [...snapshot.tasks, task]) };
}

export function checkpointRoomTask<T extends { goals?: readonly RoomTaskGoalRef[]; tasks: RoomSubTask[] }>(
  snapshot: T,
  input: CheckpointRoomTaskInput
): CheckpointRoomTaskResult<T> {
  const current = snapshot.tasks.find(task => task.id === input.taskId);
  if (!current) return { ok: false, reason: 'not_found', snapshot };
  if (input.actorBotId !== current.assigneeBotId && input.actorBotId !== input.hostBotId) {
    return { ok: false, reason: 'not_assignee', snapshot };
  }
  const goal = snapshot.goals?.find(item => item.id === current.goalId);
  const blocked = current.settlement === '待核对' || current.settlement === '仍在收尾'
    || (goal !== undefined && current.goalRevision !== goal.revision);
  if (input.status === 'completed' && blocked) return { ok: false, reason: 'pending_review', snapshot };
  const task: RoomSubTask = {
    ...current,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    updatedAt: input.now ?? nowIso(),
  };
  return {
    ok: true,
    task,
    snapshot: withTasks(snapshot, snapshot.tasks.map(item => item.id === task.id ? task : item)),
  };
}

/**
 * Add at most one room member to a later wave.
 * People who already spoke stay once. Members who were not requested stay out.
 */
export function requestNextWavePeer(roster: RoomWaveRoster, request: RoomPeerRequest): RoomPeerDecision {
  const scheduledBotIds = unique(roster.scheduledBotIds);
  const refuse = (reason: RoomPeerRejectReason): RoomPeerDecision => ({
    ok: false,
    reason,
    scheduledBotIds: [...scheduledBotIds],
    wokenBotIds: [],
  });
  const extras = (request.extraTargetBotIds ?? []).filter(id => id.trim());
  if (extras.length > 0) return refuse('too_many');
  if (!roster.roomBotIds.includes(request.fromBotId)) return refuse('not_member');
  if (!roster.roomBotIds.includes(request.targetBotId)) return refuse('not_in_room');
  if (request.targetBotId === request.fromBotId) return refuse('self');
  if (roster.spokenBotIds.includes(request.targetBotId)) return refuse('already_spoken');
  if (scheduledBotIds.includes(request.targetBotId)) return refuse('already_scheduled');
  const used = unique([...scheduledBotIds, ...roster.spokenBotIds]);
  if (!Number.isInteger(roster.maxSpeakers) || roster.maxSpeakers < 1 || used.length >= roster.maxSpeakers) {
    return refuse('over_cap');
  }
  return {
    ok: true,
    addedBotId: request.targetBotId,
    scheduledBotIds: [...scheduledBotIds, request.targetBotId],
    wokenBotIds: [request.targetBotId],
  };
}

/**
 * Record one member's human step without failing sibling tasks or pausing the room.
 * Private hand-off ends that member's turn. In-room waiting sticks only to that task.
 */
export function applyMemberHumanStep<T extends { tasks: RoomSubTask[] }>(
  snapshot: T,
  input: MemberHumanStepInput,
  decision: MemberHumanStepDecision
): {
  snapshot: T;
  roomWaits: false;
  memberFailed: false;
  memberOutcome: MemberHumanStepDecision['memberOutcome'];
  continuingBotIds: string[];
} {
  const now = nowIso();
  const tasks = snapshot.tasks.map(task => {
    const selected = input.taskId ? task.id === input.taskId : task.assigneeBotId === input.botId;
    if (!selected) return task;
    if (decision.memberOutcome === 'waiting_on_member') {
      return { ...task, status: 'waiting_approval' as const, updatedAt: now };
    }
    return { ...task, handoff: 'private_chat' as const, updatedAt: now };
  });
  return {
    snapshot: withTasks(snapshot, tasks),
    roomWaits: false,
    memberFailed: false,
    memberOutcome: decision.memberOutcome,
    continuingBotIds: input.selectedBotIds.filter(id => id !== input.botId),
  };
}
