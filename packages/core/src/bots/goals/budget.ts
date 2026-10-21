import type { KernelHookListener } from '@ppeng/agent-loop';
import { goalScope, type GoalRuntimeHost } from './runtime-host.js';
import type { GoalReport } from './types.js';

interface BudgetMarker {
 goalId: string;
 revision: number;
 executionIds: string[];
 spentUsd: number;
 limitUsd: number;
 isolatedCostUsd: number;
 reason: string;
}
interface WaitReference {goalId?:string;executionId?:string;source?:string;correlationId?:string}
const finiteCost = (value:unknown):number => typeof value==='number'&&Number.isFinite(value)?Math.max(0,value):0;

type GoalCost = { execution: boolean; cost: number };
function sessionCost(metadata: { usageCostUsd?: unknown; botGoalCostStart?: unknown }): number {
  return Math.max(0, finiteCost(metadata.usageCostUsd) - finiteCost(metadata.botGoalCostStart));
}
function addActiveCosts(host: GoalRuntimeHost, active: { sessionId?: string }[], sessions: Map<string, GoalCost>): void {
  for (const execution of active) {
    const owner = execution.sessionId ? host.store.getSession(execution.sessionId) : undefined;
    if (!owner) continue;
    sessions.set(owner.id, { execution: true, cost: sessionCost(owner.metadata) });
  }
}
function sameGoalSessionRef(ref: WaitReference, goal: { id: string }): ref is WaitReference & { correlationId: string } {
  return ref.goalId === goal.id && ref.source === 'session' && typeof ref.correlationId === 'string';
}
function executionRefOk(ref: WaitReference, execution: { id: string }): boolean {
  return !ref.executionId || ref.executionId === execution.id;
}
function liveExecutionRef(execution: { status: string }, goal: { wait?: { source?: string; correlationId?: string } }, correlationId: string): boolean {
  return execution.status === 'running' || (goal.wait?.source === 'session' && goal.wait.correlationId === correlationId);
}
function refTargetsExecution(ref: WaitReference, execution: { id: string; status: string }, goal: { id: string; wait?: { source?: string; correlationId?: string } }): boolean {
  if (!sameGoalSessionRef(ref, goal)) return false;
  if (!executionRefOk(ref, execution)) return false;
  return liveExecutionRef(execution, goal, ref.correlationId);
}
function workerBelongs(worker: { id: string; metadata: { botGoalId?: unknown; botGoalScopeSessionId?: unknown; botId?: unknown; usageCostUsd?: unknown } } | undefined, goalId: string, scope: { sessionId: string; botId: string }): worker is { id: string; metadata: { botGoalId?: unknown; botGoalScopeSessionId?: unknown; botId?: unknown; usageCostUsd?: unknown } } {
  return !!worker && worker.metadata.botGoalId === goalId && worker.metadata.botGoalScopeSessionId === scope.sessionId && worker.metadata.botId === scope.botId;
}
function rememberWorker(host: GoalRuntimeHost, ref: WaitReference, execution: { id: string; status: string; sessionId?: string }, goal: { id: string; wait?: { source?: string; correlationId?: string } }, scope: { sessionId: string; botId: string }, executions: { sessionId?: string }[], sessions: Map<string, GoalCost>): void {
  if (!refTargetsExecution(ref, execution, goal)) return;
  const worker = host.store.getSession(ref.correlationId!);
  if (!workerBelongs(worker, goal.id, scope)) return;
  if (sessions.has(worker.id) || executions.some(item => item.sessionId === worker.id)) return;
  sessions.set(worker.id, { execution: false, cost: finiteCost(worker.metadata.usageCostUsd) });
}
function addAuthorizedCosts(host: GoalRuntimeHost, executions: { id: string; status: string; sessionId?: string }[], goal: { id: string; wait?: { source?: string; correlationId?: string } }, scope: { sessionId: string; botId: string }, sessions: Map<string, GoalCost>): void {
  for (const execution of executions) {
    const owner = execution.sessionId ? host.store.getSession(execution.sessionId) : undefined;
    const refs = owner?.metadata.botGoalAuthorizedWaits;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs as WaitReference[]) rememberWorker(host, ref, execution, goal, scope, executions, sessions);
  }
}
function stopBudgetSessions(host: GoalRuntimeHost, ids: Iterable<string>, marker: BudgetMarker): void {
  for (const id of ids) {
    const live = host.store.getSession(id);
    if (!live) continue;
    host.store.updateSession(id, { metadata: { ...live.metadata, botGoalBudgetExceeded: marker } });
    if (host.isRunning(id)) host.cancel(id);
  }
}
function enforceGoalBudget(host: GoalRuntimeHost, scope: NonNullable<ReturnType<typeof goalScope>>, goal: { id: string; revision: number; status: string; costUsd: number; budgetUsd: number; wait?: { source?: string; correlationId?: string } }, sessions: Map<string, GoalCost>, active: { id: string }[]): void {
  const spentUsd = goal.costUsd + [...sessions.values()].reduce((sum, row) => sum + row.cost, 0);
  if (spentUsd < goal.budgetUsd) return;
  const reason = `Goal budget exhausted (${spentUsd.toFixed(6)} USD / ${goal.budgetUsd.toFixed(6)} USD); current output retained`;
  const marker: BudgetMarker = { goalId: goal.id, revision: goal.revision, executionIds: active.map(execution => execution.id), spentUsd, limitUsd: goal.budgetUsd, isolatedCostUsd: [...sessions.values()].filter(row => !row.execution).reduce((sum, row) => sum + row.cost, 0), reason };
  scope.service.block(scope.botId, goal.id, reason);
  if (goal.wait) scope.service.setDraining(scope.botId, goal.id, true, reason);
  stopBudgetSessions(host, sessions.keys(), marker);
}
function chargeableGoal(host: GoalRuntimeHost, session: NonNullable<ReturnType<GoalRuntimeHost['store']['getSession']>>) {
  const scope = goalScope(host.store, session);
  const goalId = session.metadata.botGoalId;
  if (!scope || typeof goalId !== 'string') return undefined;
  const goal = scope.service.get(scope.botId, goalId);
  if (!goal || ['completed', 'cancelled', 'failed', 'paused'].includes(goal.status)) return undefined;
  return { scope, goal };
}
function chargeGoalBudget(host: GoalRuntimeHost, sessionId: string): void {
  const session = host.store.getSession(sessionId);
  if (!session) return;
  const charge = chargeableGoal(host, session);
  if (!charge) return;
  const executions = charge.scope.service.executions(charge.scope.botId, charge.goal.id);
  const active = executions.filter(execution => execution.status === 'running');
  const sessions = new Map<string, GoalCost>();
  addActiveCosts(host, active, sessions);
  addAuthorizedCosts(host, executions, charge.goal, charge.scope, sessions);
  enforceGoalBudget(host, charge.scope, charge.goal, sessions, active);
}

/** Runs after usage persistence, before further tools; never calls a model or polls. */
export function observeGoalBudget(host:GoalRuntimeHost,sessionId:string):KernelHookListener {
 return event => {
  if(!['model_done','turn_end'].includes(String(event.type)))return;
  chargeGoalBudget(host, sessionId);
 };
}

/** Apply last during settlement: abort handling or a success candidate must not erase the budget stop. */
export function preserveGoalBudgetReport(host:GoalRuntimeHost,sessionId:string,report:GoalReport):GoalReport {
 const session=host.store.getSession(sessionId);
 const marker=session?.metadata.botGoalBudgetExceeded as BudgetMarker|undefined;
 if(!session||!marker||marker.goalId!==session.metadata.botGoalId||!marker.executionIds.includes(String(session.metadata.botGoalExecutionId)))return report;
 return {...report,kind:'blocked',summary:marker.reason,verified:false,advanced:false};
}
