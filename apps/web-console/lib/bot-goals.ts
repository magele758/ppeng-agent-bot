export type GoalStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type GoalStrategy = 'auto' | 'direct' | 'subagent' | 'bot_delegate' | 'ptc' | 'team_dag' | 'swarm' | 'browser' | 'computer' | 'deep_research';
export interface BotGoalView {
  id: string; title: string; status: GoalStatus; progress: string; nextStep?: string;
  blockedReason?: string; wait?: { description?: string; source: string; correlationId: string };
  strategy?: GoalStrategy; strategyReason?: string; evidence: string[]; priority: number;
  budgetUsd: number; costUsd: number; attempts: number; draining?: boolean;
}
export interface BotGoalSettings {
  maxConcurrent: number; defaultBudgetUsd: number; maxAttempts: number;
  maxNoProgress: number; leaseMs: number; preferredStrategy: GoalStrategy;
}
export interface BotGoalsSnapshot { goals: BotGoalView[]; settings: BotGoalSettings }
export function goalMessage(text: string, goalId: string | null): string {
  return goalId && text.trim() && !text.trim().startsWith('/') ? `[goal:${goalId}] ${text}` : text;
}
const IN_PROGRESS_GOAL_STATUSES = new Set<GoalStatus>(['queued', 'running', 'waiting', 'blocked', 'paused']);

export function goalsPanelState<T extends { status: string }>(goals: readonly T[]): { show: boolean; count: number; items: T[] } {
  const items = goals.filter(goal => IN_PROGRESS_GOAL_STATUSES.has(goal.status as GoalStatus));
  return { show: items.length >= 2, count: items.length, items };
}

export function goalActions(status: GoalStatus): Array<'pause' | 'resume' | 'cancel'> {
  if (['completed', 'failed', 'cancelled'].includes(status)) return [];
  return [status === 'paused' || status === 'blocked' ? 'resume' : 'pause', 'cancel'];
}
