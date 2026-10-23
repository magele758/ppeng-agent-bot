import { createId, nowIso } from '../id.js';
import { readRoomGoals, writeRoomGoals, type RoomGoalStore } from './room-goals.js';

export function startCollaboration(store: RoomGoalStore, roomId: string, ownerBotId: string, title: string): string {
  const board = readRoomGoals(store, roomId);
  const id = createId('room_goal');
  const now = nowIso();
  board.goals.push({ id, roomId, ownerBotId, title, status: 'running', constraints: [], revision: 1, priority: 0, progress: '', createdAt: now, updatedAt: now });
  writeRoomGoals(store, roomId, board);
  return id;
}

export function collaborationBoard(store: RoomGoalStore, roomId: string, goalId: string) {
  const board = readRoomGoals(store, roomId);
  return { goal: board.goals.find(goal => goal.id === goalId), tasks: board.tasks.filter(task => task.goalId === goalId) };
}

export function recordCollaborationReply(store: RoomGoalStore, roomId: string, goalId: string, botId: string, messageId: string, text: string): void {
  const board = readRoomGoals(store, roomId);
  const goal = board.goals.find(item => item.id === goalId);
  if (!goal || !['running', 'completed'].includes(goal.status)) return;
  if (goal.ownerBotId === botId) goal.deliveryMessageIds = [...new Set([...(goal.deliveryMessageIds ?? []), messageId])];
  for (const task of board.tasks.filter(item => item.goalId === goalId && item.assigneeBotId === botId && item.status === 'queued')) {
    task.status = 'waiting_approval';
    task.summary = text;
    task.materialIds = [messageId];
    task.updatedAt = nowIso();
  }
  writeRoomGoals(store, roomId, board);
}

export function settleCollaboration(store: RoomGoalStore, roomId: string, goalId: string, status: string): void {
  if (!['completed', 'failed', 'cancelled', 'unknown'].includes(status)) return;
  const board = readRoomGoals(store, roomId);
  const goal = board.goals.find(item => item.id === goalId);
  if (!goal || goal.status !== 'running') return;
  goal.status = status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'paused';
  goal.progress = status === 'completed' ? 'Awaiting owner verification; finishing a speaking turn is not goal completion.' : `Execution ${status}; review evidence before resuming.`;
  for (const task of board.tasks.filter(item => item.goalId === goalId && item.status !== 'completed')) {
    if (status === 'cancelled') task.status = 'cancelled';
    else if (status === 'failed') task.status = 'failed';
  }
  writeRoomGoals(store, roomId, board);
}
