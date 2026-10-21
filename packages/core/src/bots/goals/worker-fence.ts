import type { SqliteStateStore } from '../../storage.js';
import type { SessionRecord } from '../../types.js';
import { BotGoalService } from './service.js';
import type { BotGoal, GoalExecution } from './types.js';

interface GoalWorkerIdentity {
  botId: string;
  goalId: string;
  scopeId: string;
  revision: number;
  executionId: string;
  fence: number;
}

interface LoadedGoalExecution {
  goal: BotGoal;
  execution: GoalExecution;
}

function workerStrings(botId: unknown, goalId: unknown, scopeId: unknown, executionId: unknown): boolean {
  return typeof botId === 'string' && typeof goalId === 'string' && typeof scopeId === 'string' && typeof executionId === 'string';
}

function workerNumbers(revision: unknown, fence: unknown): boolean {
  return typeof revision === 'number' && typeof fence === 'number';
}

function goalWorkerIdentity(metadata: SessionRecord['metadata']): GoalWorkerIdentity | undefined {
  if (metadata.botGoalWorker !== true) return undefined;
  const { botId, botGoalId: goalId, botGoalScopeSessionId: scopeId, botGoalWorkerRevision: revision, botGoalWorkerExecutionId: executionId, botGoalWorkerFence: fence } = metadata;
  if (!workerStrings(botId, goalId, scopeId, executionId) || !workerNumbers(revision, fence)) return undefined;
  return { botId: botId as string, goalId: goalId as string, scopeId: scopeId as string, revision: revision as number, executionId: executionId as string, fence: fence as number };
}

function canonicalGoalParent(store: SqliteStateStore, scopeId: string, botId: string): boolean {
  const parent = store.getSession(scopeId);
  if (!parent || parent.metadata.canonicalBotChat !== true) return false;
  return parent.metadata.botId === botId;
}

function revisionMatches(goal: BotGoal, execution: GoalExecution, revision: number): boolean {
  return goal.revision === revision && execution.goalRevision === revision;
}

function fenceMatches(execution: GoalExecution, fence: number, parentSessionId: string | undefined): boolean {
  return execution.fence === fence && execution.sessionId === parentSessionId;
}

function loadExecution(service: BotGoalService, identity: GoalWorkerIdentity, parentSessionId: string | undefined): LoadedGoalExecution | undefined {
  const goal = service.get(identity.botId, identity.goalId);
  const execution = service.executions(identity.botId, identity.goalId).find(item => item.id === identity.executionId);
  if (!goal || !execution || !revisionMatches(goal, execution, identity.revision)) return undefined;
  if (!fenceMatches(execution, identity.fence, parentSessionId)) return undefined;
  return { goal, execution };
}

function sessionFor(store: SqliteStateStore, sessionId: string | undefined): SessionRecord | undefined {
  return sessionId ? store.getSession(sessionId) : undefined;
}

function ownerInScope(owner: SessionRecord, scopeId: string): boolean {
  return owner.id === scopeId || owner.metadata.botGoalScopeSessionId === scopeId;
}

function runningLease(goal: BotGoal, execution: GoalExecution, executionId: string, now: number): boolean {
  return goal.activeExecutionId === executionId && execution.status === 'running' && execution.leaseUntil > now;
}

function waitingOnSession(goal: BotGoal, execution: GoalExecution, sessionId: string): boolean {
  if (goal.status !== 'waiting' || execution.status !== 'finished') return false;
  return goal.wait?.source === 'session' && goal.wait.correlationId === sessionId;
}

function sameAuthorizedWait(wait: { goalId?: string; executionId?: string; source?: string; correlationId?: string } | undefined, goalId: string, executionId: string, sessionId: string): boolean {
  return wait?.goalId === goalId && wait?.executionId === executionId && wait?.source === 'session' && wait?.correlationId === sessionId;
}

function waitAuthorized(waits: unknown, goalId: string, executionId: string, sessionId: string): boolean {
  return Array.isArray(waits) && waits.some(wait => sameAuthorizedWait(wait, goalId, executionId, sessionId));
}

function identifiedWorker(store: SqliteStateStore, session: SessionRecord): { live: SessionRecord; identity: GoalWorkerIdentity } | undefined {
  const live = store.getSession(session.id);
  if (!live) return undefined;
  const identity = goalWorkerIdentity(live.metadata);
  if (!identity || !canonicalGoalParent(store, identity.scopeId, identity.botId)) return undefined;
  return { live, identity };
}

function ownedExecution(store: SqliteStateStore, found: { live: SessionRecord; identity: GoalWorkerIdentity }): { identity: GoalWorkerIdentity; loaded: LoadedGoalExecution; owner: SessionRecord; sessionId: string } | undefined {
  const loaded = loadExecution(new BotGoalService(store, Date.now, found.identity.scopeId), found.identity, found.live.parentSessionId);
  if (!loaded) return undefined;
  const owner = sessionFor(store, loaded.execution.sessionId);
  if (!owner || owner.metadata.botId !== found.identity.botId) return undefined;
  if (!ownerInScope(owner, found.identity.scopeId)) return undefined;
  return { identity: found.identity, loaded, owner, sessionId: found.live.id };
}

function goalWorkerStillCurrent(ctx: { identity: GoalWorkerIdentity; loaded: LoadedGoalExecution; owner: SessionRecord; sessionId: string }, now: number): boolean {
  if (ctx.loaded.goal.status === 'running') return runningLease(ctx.loaded.goal, ctx.loaded.execution, ctx.identity.executionId, now);
  if (!waitingOnSession(ctx.loaded.goal, ctx.loaded.execution, ctx.sessionId)) return false;
  return waitAuthorized(ctx.owner.metadata.botGoalAuthorizedWaits, ctx.identity.goalId, ctx.identity.executionId, ctx.sessionId);
}

/** Workers can resume their own revision while waiting, but cannot claim or follow a newer execution. */
export function isGoalWorkerCurrent(store: SqliteStateStore, session: SessionRecord): boolean {
  const found = identifiedWorker(store, session);
  const ctx = found ? ownedExecution(store, found) : undefined;
  if (!ctx) return false;
  return goalWorkerStillCurrent(ctx, Date.now());
}
