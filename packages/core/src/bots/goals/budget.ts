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

/** Runs after usage persistence, before further tools; never calls a model or polls. */
export function observeGoalBudget(host:GoalRuntimeHost,sessionId:string):KernelHookListener {
 return event => {
  if(!['model_done','turn_end'].includes(String(event.type)))return;
  const session=host.store.getSession(sessionId);
  if(!session)return;
  const scope=goalScope(host.store,session);
  const goalId=session.metadata.botGoalId;
  if(!scope||typeof goalId!=='string')return;
  const goal=scope.service.get(scope.botId,goalId);
  if(!goal||['completed','cancelled','failed','paused'].includes(goal.status))return;
  const executions=scope.service.executions(scope.botId,goal.id);
  const active=executions.filter(e=>e.status==='running');
  const sessions=new Map<string,{execution:boolean;cost:number}>();
  for(const execution of active) {
   const owner=execution.sessionId?host.store.getSession(execution.sessionId):undefined;
   if(!owner)continue;
   sessions.set(owner.id,{execution:true,cost:Math.max(0,finiteCost(owner.metadata.usageCostUsd)-finiteCost(owner.metadata.botGoalCostStart))});
  }
  // Only references returned by authorized dispatch count; arbitrary child metadata cannot charge a goal.
  for(const execution of executions) {
   const owner=execution.sessionId?host.store.getSession(execution.sessionId):undefined;
   const refs=owner?.metadata.botGoalAuthorizedWaits;
   if(!Array.isArray(refs))continue;
   for(const ref of refs as WaitReference[]) {
    if(ref.goalId!==goal.id||!['session','self_heal'].includes(String(ref.source))||typeof ref.correlationId!=='string')continue;
    if(ref.executionId&&ref.executionId!==execution.id)continue;
    if(execution.status!=='running'&&!(goal.wait&&goal.wait.source===ref.source&&goal.wait.correlationId===ref.correlationId))continue;
    const workerId=ref.source==='self_heal'?host.store.getSelfHealRun(ref.correlationId)?.sessionId:ref.correlationId;
    const worker=workerId?host.store.getSession(workerId):undefined;
    if(!worker||worker.metadata.botGoalId!==goal.id||worker.metadata.botGoalScopeSessionId!==scope.sessionId||worker.metadata.botId!==scope.botId)continue;
    if(sessions.has(worker.id)||executions.some(e=>e.sessionId===worker.id))continue;
    sessions.set(worker.id,{execution:false,cost:finiteCost(worker.metadata.usageCostUsd)});
   }
  }
  const spentUsd=goal.costUsd+[...sessions.values()].reduce((sum,s)=>sum+s.cost,0);
  if(spentUsd<goal.budgetUsd)return;
  const reason=`Goal budget exhausted (${spentUsd.toFixed(6)} USD / ${goal.budgetUsd.toFixed(6)} USD); current output retained`;
  const marker:BudgetMarker={goalId:goal.id,revision:goal.revision,executionIds:active.map(e=>e.id),spentUsd,limitUsd:goal.budgetUsd,isolatedCostUsd:[...sessions.values()].filter(s=>!s.execution).reduce((sum,s)=>sum+s.cost,0),reason};
  scope.service.block(scope.botId,goal.id,reason);
  if(goal.wait)scope.service.setDraining(scope.botId,goal.id,true,reason);
  for(const id of sessions.keys()) {
   const live=host.store.getSession(id);
   if(!live)continue;
   host.store.updateSession(id,{metadata:{...live.metadata,botGoalBudgetExceeded:marker}});
   if(host.isRunning(id))host.cancel(id);
  }
 };
}

/** Apply last during settlement: abort handling or a success candidate must not erase the budget stop. */
export function preserveGoalBudgetReport(host:GoalRuntimeHost,sessionId:string,report:GoalReport):GoalReport {
 const session=host.store.getSession(sessionId);
 const marker=session?.metadata.botGoalBudgetExceeded as BudgetMarker|undefined;
 if(!session||!marker||marker.goalId!==session.metadata.botGoalId||!marker.executionIds.includes(String(session.metadata.botGoalExecutionId)))return report;
 return {...report,kind:'blocked',summary:marker.reason,verified:false,advanced:false};
}
