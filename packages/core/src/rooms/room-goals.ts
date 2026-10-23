/**
 * Room goals, stored only under `bot.room-goals:${roomId}`.
 * Private bot goals stay on their own key. This module never writes them,
 * never writes bot work rows, and never starts a model turn.
 *
 * The room scheduler calls these later (not wired in this change):
 * - readRoomGoals / writeRoomGoals around board and intake changes
 * - intakeRoomMessage(store, { roomId, text, members }) from send() while a turn is running
 * - renderRoomProgress(snapshot) as the direct progress receipt
 * - completeRoomAction(snapshot, actionId) before treating an in-flight action as done
 *
 * Query and an unclear target set opensModelTurn false. Post `receipt` and return.
 * A named cancel fills stopBotIds or stopTaskIds for that object only.
 * An added constraint sets bumpRoomEpoch and steerBotIds for work that can still change.
 * The scheduler applies epoch, enqueueSteer, and cancelSession. Do not import @ppeng/agent-loop.
 */

import { randomUUID } from 'node:crypto';
import type { GoalIntakeContext, GoalIntentProposal } from '../bots/goals/intake.js';
import type { RoomSubTask } from './room-tasks.js';

export type RoomGoalStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface RoomGoal {
  ownerBotId?: string;
  evidenceMessageIds?: string[];
  deliveryMessageIds?: string[];
  id: string;
  roomId: string;
  title: string;
  status: RoomGoalStatus;
  constraints: string[];
  revision: number;
  priority: number;
  progress: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomInFlightAction {
  id: string;
  goalId?: string;
  taskId?: string;
  botId: string;
  summary: string;
  recallable: boolean;
  goalRevision: number;
  status: 'running' | 'stopped' | 'completed';
  settlement?: '待核对' | '仍在收尾';
}

export interface RoomGoalSnapshot {
  goals: RoomGoal[];
  tasks: RoomSubTask[];
  actions: RoomInFlightAction[];
  stoppedBotIds: string[];
}

export interface RoomGoalStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export interface RoomGoalMember {
  id: string;
  name: string;
}

export interface RoomIntakeEffect {
  kind: 'query' | 'amend_goal' | 'pause' | 'cancel' | 'resume' | 'new_goal' | 'chat' | 'clarify' | 'reprioritize';
  /** This call never opens a model turn. Query and clarify are posted from receipt. */
  opensModelTurn: false;
  receipt: string;
  mutated: boolean;
  /** Scheduler bumps room.epoch when a constraint changes in-flight work. */
  bumpRoomEpoch: boolean;
  /** Scheduler steers only these members. */
  steerBotIds: string[];
  /** Scheduler stops only these members. Empty does not stop the room. */
  stopBotIds: string[];
  stopTaskIds: string[];
  stopGoalIds: string[];
  goalId?: string;
  taskId?: string;
  botId?: string;
}

export interface CompleteRoomActionResult {
  ok: boolean;
  reason?: 'not_found' | 'pending_review';
  snapshot: RoomGoalSnapshot;
}

type IntakeModule = typeof import('../bots/goals/intake.js');

interface Target {
  kind: 'goal' | 'task' | 'member';
  id: string;
}

type Decision =
  | { type: 'query' }
  | { type: 'ignore' }
  | { type: 'clarify' }
  | { type: 'amend'; goalId: string; text: string }
  | { type: 'new_goal'; title: string }
  | { type: 'reprioritize'; goalId: string; priority: number }
  | { type: 'pause' | 'cancel' | 'resume'; target: Target };

const CLARIFY_RECEIPT = '有多件进行中的事，请说明要改或停止的是哪一件，或哪一位成员。';

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertNever(value: never): never {
  throw new Error(`Unexpected room intent ${String(value)}`);
}

export function roomGoalsStorageKey(roomId: string): string {
  if (typeof roomId !== 'string' || !roomId.trim() || roomId.includes(':') || roomId.includes('/')) {
    throw new Error('Invalid roomId');
  }
  return `bot.room-goals:${roomId}`;
}

export function emptyRoomGoalSnapshot(): RoomGoalSnapshot {
  return { goals: [], tasks: [], actions: [], stoppedBotIds: [] };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function readRoomGoals(store: RoomGoalStore, roomId: string): RoomGoalSnapshot {
  const raw = store.getDaemonControl<Partial<RoomGoalSnapshot>>(roomGoalsStorageKey(roomId));
  if (!raw || typeof raw !== 'object') return emptyRoomGoalSnapshot();
  return {
    goals: asArray<RoomGoal>(raw.goals),
    tasks: asArray<RoomSubTask>(raw.tasks),
    actions: asArray<RoomInFlightAction>(raw.actions),
    stoppedBotIds: asArray<string>(raw.stoppedBotIds),
  };
}

export function writeRoomGoals(store: RoomGoalStore, roomId: string, snapshot: RoomGoalSnapshot): void {
  store.setDaemonControl(roomGoalsStorageKey(roomId), structuredClone(snapshot));
}

function statusLabel(status: string): string {
  switch (status) {
    case 'queued': return '排队';
    case 'running': return '进行中';
    case 'paused': return '已暂停';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
    case 'stopped': return '已停止';
    default: return status;
  }
}

/** Direct board text. The scheduler posts this for a progress question and does not call the model. */
export function renderRoomProgress(snapshot: RoomGoalSnapshot): string {
  const lines = ['当前进度'];
  if (!snapshot.goals.length && !snapshot.tasks.length) lines.push('还没有进行中的事');
  for (const goal of snapshot.goals) {
    lines.push(`《${goal.title}》${statusLabel(goal.status)}：${goal.progress || '暂无进度'}`);
  }
  for (const task of snapshot.tasks) {
    const settlement = task.settlement ? `，${task.settlement}` : '';
    lines.push(`子任务《${task.title}》负责人 ${task.assigneeBotId}：${statusLabel(task.status)}，${task.summary || '暂无进度'}${settlement}`);
  }
  for (const action of snapshot.actions) {
    if (action.settlement) lines.push(`${action.summary}：${action.settlement}`);
  }
  return lines.join('\n');
}

function blank(kind: RoomIntakeEffect['kind'], receipt = ''): RoomIntakeEffect {
  return {
    kind,
    opensModelTurn: false,
    receipt,
    mutated: false,
    bumpRoomEpoch: false,
    steerBotIds: [],
    stopBotIds: [],
    stopTaskIds: [],
    stopGoalIds: [],
  };
}

function isProgressQuery(text: string): boolean {
  return /进度|进展|做到哪|谁还在|怎么样了|状态如何|完成了吗|完成了没|跑完了没|还没好|\bstatus\b|\bprogress\b|\bhow\b.*\bgoing\b/i.test(text)
    && !/帮我.*(实现|开发)|implement|\bbuild\b/i.test(text);
}

function looksLikeConstraint(text: string): boolean {
  return /追加约束|追加|约束|必须|不要|改为|改成|兼容|保持不变|不要删|别改/.test(text);
}

function moduleNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'ERR_MODULE_NOT_FOUND');
}

async function loadIntake(): Promise<IntakeModule> {
  const compiled = '../bots/goals/intake.js';
  try {
    return await import(compiled) as IntakeModule;
  } catch (error) {
    if (!moduleNotFound(error)) throw error;
    return await import(compiled.replace(/\.js$/, '.ts')) as IntakeModule;
  }
}

function activeGoals(snapshot: RoomGoalSnapshot): RoomGoal[] {
  return snapshot.goals.filter(goal => goal.status === 'running' || goal.status === 'queued');
}

function explicitTarget(text: string, snapshot: RoomGoalSnapshot, members: readonly RoomGoalMember[]): Target | 'ambiguous' | undefined {
  const goal = text.match(/\[goal:([^\]\s]+)\]/);
  const task = text.match(/\[task:([^\]\s]+)\]/);
  const member = text.match(/\[member:([^\]\s]+)\]/);
  const marks = [goal, task, member].filter(mark => mark !== null);
  if (marks.length > 1) return 'ambiguous';
  const goalId = goal?.[1];
  if (goalId) return snapshot.goals.some(item => item.id === goalId) ? { kind: 'goal', id: goalId } : 'ambiguous';
  const taskId = task?.[1];
  if (taskId) return snapshot.tasks.some(item => item.id === taskId) ? { kind: 'task', id: taskId } : 'ambiguous';
  const memberId = member?.[1];
  if (memberId) return members.some(item => item.id === memberId) ? { kind: 'member', id: memberId } : 'ambiguous';
  return undefined;
}

function locate(text: string, snapshot: RoomGoalSnapshot, members: readonly RoomGoalMember[]): Target | 'ambiguous' | undefined {
  const marked = explicitTarget(text, snapshot, members);
  if (marked) return marked;
  const candidates: { target: Target; weight: number }[] = [];
  for (const goal of snapshot.goals) {
    if (goal.title.trim().length >= 2 && text.includes(goal.title.trim())) {
      candidates.push({ target: { kind: 'goal', id: goal.id }, weight: goal.title.trim().length });
    }
  }
  for (const task of snapshot.tasks) {
    if (task.title.trim().length >= 2 && text.includes(task.title.trim())) {
      candidates.push({ target: { kind: 'task', id: task.id }, weight: task.title.trim().length });
    }
  }
  for (const member of members) {
    if (member.name.trim().length >= 2 && text.includes(member.name.trim())) {
      candidates.push({ target: { kind: 'member', id: member.id }, weight: member.name.trim().length });
    }
  }
  if (!candidates.length) return undefined;
  const best = Math.max(...candidates.map(item => item.weight));
  const top: Target[] = [];
  for (const item of candidates) {
    if (item.weight !== best) continue;
    if (top.some(target => target.kind === item.target.kind && target.id === item.target.id)) continue;
    top.push(item.target);
  }
  const chosen = top[0];
  if (!chosen || top.length > 1) return 'ambiguous';
  return chosen;
}

function goalTarget(
  named: Target | 'ambiguous' | undefined,
  snapshot: RoomGoalSnapshot,
  proposal: GoalIntentProposal
): string | 'ambiguous' | undefined {
  if (named === 'ambiguous' || named?.kind === 'member') return 'ambiguous';
  if (named?.kind === 'goal') return named.id;
  if (named?.kind === 'task') return snapshot.tasks.find(task => task.id === named.id)?.goalId;
  if (proposal.goalId && snapshot.goals.some(goal => goal.id === proposal.goalId)) return proposal.goalId;
  const only = activeGoals(snapshot);
  if (only.length === 1) return only[0]?.id;
  if (only.length > 1) return 'ambiguous';
  return undefined;
}

function controlTarget(
  named: Target | 'ambiguous' | undefined,
  snapshot: RoomGoalSnapshot
): Target | 'ambiguous' {
  if (named === 'ambiguous') return 'ambiguous';
  if (named) return named;
  const only = activeGoals(snapshot);
  if (only.length === 1 && only[0]) return { kind: 'goal', id: only[0].id };
  return 'ambiguous';
}

function interpret(
  snapshot: RoomGoalSnapshot,
  members: readonly RoomGoalMember[],
  proposal: GoalIntentProposal
): Decision {
  const named = locate(proposal.text, snapshot, members);
  switch (proposal.kind) {
    case 'query':
      return { type: 'query' };
    case 'chat':
      return { type: 'ignore' };
    case 'new_goal': {
      if (looksLikeConstraint(proposal.text)) {
        const goalId = goalTarget(named, snapshot, proposal);
        if (goalId === 'ambiguous') return { type: 'clarify' };
        if (goalId) return { type: 'amend', goalId, text: proposal.text.trim() };
      }
      return { type: 'new_goal', title: proposal.text.trim() };
    }
    case 'amend_goal': {
      const goalId = goalTarget(named, snapshot, proposal);
      if (!goalId || goalId === 'ambiguous') return { type: 'clarify' };
      return { type: 'amend', goalId, text: proposal.text.trim() };
    }
    case 'pause':
    case 'cancel':
    case 'resume': {
      const target = controlTarget(named, snapshot);
      if (target === 'ambiguous') return { type: 'clarify' };
      return { type: proposal.kind, target };
    }
    case 'reprioritize': {
      const goalId = goalTarget(named, snapshot, proposal);
      if (!goalId || goalId === 'ambiguous' || !Number.isInteger(proposal.priority)) return { type: 'clarify' };
      return { type: 'reprioritize', goalId, priority: proposal.priority };
    }
    default:
      return assertNever(proposal);
  }
}

function amend(snapshot: RoomGoalSnapshot, goalId: string, text: string, now: string): { snapshot: RoomGoalSnapshot; steerBotIds: string[] } {
  const goal = snapshot.goals.find(item => item.id === goalId);
  if (!goal) return { snapshot, steerBotIds: [] };
  const revision = goal.revision + 1;
  const steerBotIds: string[] = [];
  const stuckTaskIds = new Set<string>();
  for (const action of snapshot.actions) {
    if (action.goalId !== goalId || action.status !== 'running') continue;
    if (!action.recallable) {
      if (action.taskId) stuckTaskIds.add(action.taskId);
      continue;
    }
    if (!steerBotIds.includes(action.botId)) steerBotIds.push(action.botId);
  }
  return {
    steerBotIds,
    snapshot: {
      ...snapshot,
      goals: snapshot.goals.map(item => item.id === goalId
        ? { ...item, revision, constraints: [...item.constraints, text], updatedAt: now }
        : item),
      tasks: snapshot.tasks.map(task => {
        if (task.goalId !== goalId) return task;
        if (stuckTaskIds.has(task.id)) return { ...task, settlement: '待核对' as const, updatedAt: now };
        if (task.status === 'running' || task.status === 'queued') return { ...task, goalRevision: revision, updatedAt: now };
        return task;
      }),
      actions: snapshot.actions.map(action => {
        if (action.goalId !== goalId || action.status !== 'running') return action;
        if (!action.recallable) return { ...action, settlement: '待核对' as const };
        return { ...action, goalRevision: revision };
      }),
    },
  };
}

function stopMember(snapshot: RoomGoalSnapshot, botId: string, now: string): RoomGoalSnapshot {
  const stuckTaskIds = new Set(snapshot.actions.filter(action =>
    action.botId === botId && action.status === 'running' && !action.recallable && action.taskId
  ).map(action => action.taskId as string));
  return {
    ...snapshot,
    stoppedBotIds: snapshot.stoppedBotIds.includes(botId) ? snapshot.stoppedBotIds : [...snapshot.stoppedBotIds, botId],
    tasks: snapshot.tasks.map(task => {
      if (task.assigneeBotId !== botId || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task;
      if (stuckTaskIds.has(task.id)) return { ...task, settlement: '仍在收尾' as const, updatedAt: now };
      return { ...task, status: 'cancelled' as const, updatedAt: now };
    }),
    actions: snapshot.actions.map(action => {
      if (action.botId !== botId || action.status !== 'running') return action;
      if (!action.recallable) return { ...action, settlement: '仍在收尾' as const, status: 'stopped' as const };
      return { ...action, status: 'stopped' as const };
    }),
  };
}

function stopTask(snapshot: RoomGoalSnapshot, taskId: string, now: string): RoomGoalSnapshot {
  const stuck = snapshot.actions.some(action => action.taskId === taskId && action.status === 'running' && !action.recallable);
  return {
    ...snapshot,
    tasks: snapshot.tasks.map(task => {
      if (task.id !== taskId) return task;
      if (stuck) return { ...task, settlement: '仍在收尾' as const, updatedAt: now };
      return { ...task, status: 'cancelled' as const, updatedAt: now };
    }),
    actions: snapshot.actions.map(action => {
      if (action.taskId !== taskId || action.status !== 'running') return action;
      if (!action.recallable) return { ...action, settlement: '仍在收尾' as const, status: 'stopped' as const };
      return { ...action, status: 'stopped' as const };
    }),
  };
}

function stopGoal(snapshot: RoomGoalSnapshot, goalId: string, cancel: boolean, now: string): RoomGoalSnapshot {
  const stuckTaskIds = new Set(snapshot.actions.filter(action =>
    action.goalId === goalId && action.status === 'running' && !action.recallable && action.taskId
  ).map(action => action.taskId as string));
  return {
    ...snapshot,
    goals: snapshot.goals.map(goal => goal.id === goalId
      ? { ...goal, status: cancel ? 'cancelled' as const : 'paused' as const, updatedAt: now }
      : goal),
    tasks: snapshot.tasks.map(task => {
      if (task.goalId !== goalId || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task;
      if (stuckTaskIds.has(task.id)) return { ...task, settlement: '仍在收尾' as const, updatedAt: now };
      return cancel ? { ...task, status: 'cancelled' as const, updatedAt: now } : task;
    }),
    actions: snapshot.actions.map(action => {
      if (action.goalId !== goalId || action.status !== 'running') return action;
      if (!action.recallable) return { ...action, settlement: '仍在收尾' as const, status: 'stopped' as const };
      return { ...action, status: 'stopped' as const };
    }),
  };
}

function applyDecision(snapshot: RoomGoalSnapshot, decision: Decision, roomId: string, now: string): { snapshot: RoomGoalSnapshot; effect: RoomIntakeEffect } {
  switch (decision.type) {
    case 'query':
      return { snapshot, effect: blank('query', renderRoomProgress(snapshot)) };
    case 'ignore':
      return { snapshot, effect: blank('chat') };
    case 'clarify':
      return { snapshot, effect: blank('clarify', CLARIFY_RECEIPT) };
    case 'amend': {
      const amended = amend(snapshot, decision.goalId, decision.text, now);
      return {
        snapshot: amended.snapshot,
        effect: { ...blank('amend_goal'), mutated: true, bumpRoomEpoch: true, steerBotIds: amended.steerBotIds, goalId: decision.goalId },
      };
    }
    case 'new_goal': {
      const title = decision.title.trim().slice(0, 500);
      if (!title) return { snapshot, effect: blank('chat') };
      const goal: RoomGoal = {
        id: createId('rgoal'),
        roomId,
        title,
        status: 'running',
        constraints: [],
        revision: 1,
        priority: 0,
        progress: '',
        createdAt: now,
        updatedAt: now,
      };
      return {
        snapshot: { ...snapshot, goals: [...snapshot.goals, goal] },
        effect: { ...blank('new_goal'), mutated: true, goalId: goal.id },
      };
    }
    case 'reprioritize':
      return {
        snapshot: {
          ...snapshot,
          goals: snapshot.goals.map(goal => goal.id === decision.goalId ? { ...goal, priority: decision.priority, updatedAt: now } : goal),
        },
        effect: { ...blank('reprioritize'), mutated: true, goalId: decision.goalId },
      };
    case 'pause':
    case 'cancel':
    case 'resume':
      return applyControl(snapshot, decision, now);
    default:
      return assertNever(decision);
  }
}

function applyControl(
  snapshot: RoomGoalSnapshot,
  decision: Extract<Decision, { type: 'pause' | 'cancel' | 'resume' }>,
  now: string
): { snapshot: RoomGoalSnapshot; effect: RoomIntakeEffect } {
  const kind = decision.type;
  const target = decision.target;
  if (target.kind === 'member') {
    if (kind === 'resume') {
      return {
        snapshot: { ...snapshot, stoppedBotIds: snapshot.stoppedBotIds.filter(id => id !== target.id) },
        effect: { ...blank('resume'), mutated: true, botId: target.id },
      };
    }
    return {
      snapshot: stopMember(snapshot, target.id, now),
      effect: { ...blank(kind), mutated: true, stopBotIds: [target.id], botId: target.id },
    };
  }
  if (target.kind === 'task') {
    if (kind === 'resume') return { snapshot, effect: blank('resume') };
    return {
      snapshot: stopTask(snapshot, target.id, now),
      effect: { ...blank(kind), mutated: true, stopTaskIds: [target.id], taskId: target.id },
    };
  }
  if (kind === 'resume') {
    return {
      snapshot: {
        ...snapshot,
        goals: snapshot.goals.map(goal => goal.id === target.id && goal.status === 'paused'
          ? { ...goal, status: 'running' as const, updatedAt: now }
          : goal),
      },
      effect: { ...blank('resume'), mutated: true, goalId: target.id, stopGoalIds: [] },
    };
  }
  return {
    snapshot: stopGoal(snapshot, target.id, kind === 'cancel', now),
    effect: { ...blank(kind), mutated: true, goalId: target.id, stopGoalIds: [target.id] },
  };
}

export async function intakeRoomMessage(
  store: RoomGoalStore,
  input: { roomId: string; text: string; members: readonly RoomGoalMember[] }
): Promise<RoomIntakeEffect> {
  const snapshot = readRoomGoals(store, input.roomId);
  const text = input.text.trim();
  if (!text) return blank('chat');
  if (isProgressQuery(text)) return blank('query', renderRoomProgress(snapshot));

  const intake = await loadIntake();
  const proposals = await intake.classifyGoalIntents(text, snapshot.goals.map((goal): GoalIntakeContext => ({
    id: goal.id,
    title: goal.title,
    status: goal.status,
    priority: goal.priority,
  })));
  const decisions = proposals.map(proposal => interpret(snapshot, input.members, proposal));
  if (decisions.some(decision => decision.type === 'clarify')) return blank('clarify', CLARIFY_RECEIPT);
  if (decisions.every(decision => decision.type === 'query' || decision.type === 'ignore')) {
    return decisions.some(decision => decision.type === 'query') ? blank('query', renderRoomProgress(snapshot)) : blank('chat');
  }

  let next = snapshot;
  let effect = blank('chat');
  const now = nowIso();
  for (const decision of decisions) {
    if (decision.type === 'ignore' || decision.type === 'query') continue;
    const applied = applyDecision(next, decision, input.roomId, now);
    next = applied.snapshot;
    effect = applied.effect;
  }
  if (effect.mutated) writeRoomGoals(store, input.roomId, next);
  return effect;
}

export function completeRoomAction(snapshot: RoomGoalSnapshot, actionId: string): CompleteRoomActionResult {
  const action = snapshot.actions.find(item => item.id === actionId);
  if (!action) return { ok: false, reason: 'not_found', snapshot };
  const goal = action.goalId ? snapshot.goals.find(item => item.id === action.goalId) : undefined;
  const stale = goal !== undefined && action.goalRevision !== goal.revision;
  if (action.settlement === '待核对' || action.settlement === '仍在收尾' || stale) {
    return { ok: false, reason: 'pending_review', snapshot };
  }
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      actions: snapshot.actions.map(item => item.id === actionId ? { ...item, status: 'completed' as const } : item),
    },
  };
}
