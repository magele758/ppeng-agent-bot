import type {SessionRecord} from '../../types.js';
import type {BotGoal, GoalExecution, GoalSnapshot} from './types.js';

function ownsActiveClaim(goal:BotGoal,execution:GoalExecution):boolean {
  return goal.status==='running' && goal.activeExecutionId===execution.id
    && execution.goalId===goal.id && execution.goalRevision===goal.revision;
}

function liveInSession(execution:GoalExecution,sessionId:string):boolean {
  return execution.sessionId===sessionId && execution.status==='running' && execution.leaseUntil>Date.now();
}

/** Use the same durable claim for executor tools and model-facing commands. */
export function currentGoalExecution(session:SessionRecord, store?:{getDaemonControl?(key:string):unknown}){
  const {botId, botGoalId, botGoalExecutionId, botWorkTaskId} = session.metadata;
  if (botWorkTaskId || typeof botId !== 'string' || typeof botGoalId !== 'string') return undefined;
  const snapshot = store?.getDaemonControl?.(`bot_goals:${botId}`) as GoalSnapshot | undefined;
  const goal = snapshot?.goals.find(item => item.id === botGoalId);
  const execution = snapshot?.executions.find(item => item.id === botGoalExecutionId);
  if (!goal || !execution) return undefined;
  if (!ownsActiveClaim(goal,execution) || !liveInSession(execution,session.id)) return undefined;
  return execution;
}

/** Annotate only goals actually mentioned in a retained historical summary. */
export function historicalGoalStatus(text:string,snapshot:GoalSnapshot|undefined):string {
  const mentioned=new Set(text.match(/\bgoal_[\w-]+/g));
  const states=snapshot?.goals.filter(goal=>mentioned.has(goal.id)).map(goal=>goal.id+'='+goal.status);
  if(!states?.length)return '';
  return 'Current saved goal states: '+states.join(', ')+'. The summary below is historical evidence only. Continue scheduled work only from a current execution assignment.\n\n';
}
