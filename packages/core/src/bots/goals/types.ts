export type GoalStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'paused' | 'pending_review' | 'completed' | 'failed' | 'cancelled';
export interface GoalWait { source: string; correlationId: string; deadline?: number; description?: string }
export interface BotGoal {
 id: string; botId: string; sessionId: string; title: string; objective: string;
 sourceMessageId?: string; parentGoalId?: string; constraints: string[]; completionCriteria: string[];
 resources: string[]; priority: number; revision: number; status: GoalStatus;
 progress: string; nextStep?: string; blockedReason?: string; wait?: GoalWait; evidence: string[];
 budgetUsd: number; extraAttempts?: number; costUsd: number; attempts: number; noProgress: number;
 strategy?: string; strategyReason?: string; activeExecutionId?: string; draining?: boolean; resumeRequested?: boolean; createdAt: string; updatedAt: string;
}
export interface GoalExecution {
 id: string; goalId: string; goalRevision: number; strategy: string; owner: string; fence: number;
 leaseUntil: number; safeToRetry: boolean; status: 'running' | 'finished' | 'interrupted';
 messageStartSeq?: number; messageEndSeq?: number;
 runRef?: string; sessionId?: string; summary?: string; startedAt: string; endedAt?: string;
}
export interface GoalReport {
 kind: 'progress' | 'waiting' | 'blocked' | 'candidate_completed' | 'failed' | 'cancelled';
 summary: string; evidence?: string[]; verified?: boolean; wait?: GoalWait; costUsd?: number;
 eventId?: string; nextStep?: string; advanced?: boolean; correctionNeeded?: boolean; owner?: string; fence?: number;
}
export interface GoalIntent {
 kind: 'new_goal' | 'amend_goal' | 'query' | 'pause' | 'resume' | 'cancel';
 goalId?: string; text?: string; sourceMessageId?: string; sessionId?: string;
}
export interface GoalEvent { id: string; type: string; goalId?: string; at: string; detail?: string }
export interface GoalSnapshot { goals: BotGoal[]; executions: GoalExecution[]; events: GoalEvent[]; processed: string[]; wakeEvents?: { completionCandidate?: boolean; goalId?: string; summary?: string; evidence?: string[]; costUsd?: number; eventId: string; source: string; correlationId: string; sessionId?: string; consumedBy: string[] }[]; fence: number }
export interface GoalSettings { maxConcurrent: number; defaultBudgetUsd: number; maxAttempts: number; maxNoProgress: number; leaseMs: number; preferredStrategy: string }
export interface GoalStore {
 getDaemonControl<T>(key: string): T | undefined;
 setDaemonControl(key: string, value: unknown): void;
 db?: { exec(sql: string): unknown };
}
