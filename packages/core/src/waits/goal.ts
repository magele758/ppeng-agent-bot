import {backgroundWaitStillRunning} from './background-source.js';
import type {GoalRuntimeHost} from '../bots/goals/runtime-host.js';
import type {BotGoal} from '../bots/goals/types.js';
import type {BotGoalService} from '../bots/goals/service.js';
import {DurableWaitStore} from './store.js';
export function tickDurableGoalWait(host:GoalRuntimeHost,service:BotGoalService,goal:BotGoal):boolean {
 if(goal.wait?.source!=='durable_wait')return false;
 const waits=new DurableWaitStore(host.store),id=goal.wait.correlationId,wait=waits.get(id);
 if(!wait||wait.owner.kind!=='goal'||wait.owner.id!==goal.id||wait.owner.botId!==goal.botId||wait.owner.scopeSessionId!==goal.sessionId||wait.owner.revision!==goal.revision){
  if(wait?.owner.id===goal.id)waits.cancel(id);
  service.block(goal.botId,goal.id,'Wait owner or revision is no longer valid');service.setDraining(goal.botId,goal.id,false,'Wait owner or revision is no longer valid');return true;
 }
 const observed=waits.check(id);
 if(observed.status==='ready')waits.consume(id,record=>{service.wake(goal.botId,{goalId:goal.id,eventId:record.id,source:'durable_wait',correlationId:record.id,summary:`Wait condition satisfied for ${record.spec.source}:${record.spec.ref}; inspect evidence before continuing`,evidence:[JSON.stringify({source:record.spec.source,ref:record.spec.ref,observation:record.observation})]});});
 else if(observed.status==='expired'||observed.status==='cancelled'){
  service.block(goal.botId,goal.id,observed.reason??'Wait stopped');service.setDraining(goal.botId,goal.id,false,observed.reason??'Wait stopped');
 }else if(observed.reason)service.noteApprovalWait(goal.botId,goal.id,observed.reason);
 return true;
}
export function drainDurableGoalWait(host:GoalRuntimeHost,service:BotGoalService,goal:BotGoal):boolean {
 if(goal.wait?.source!=='durable_wait')return false;
 const waits=new DurableWaitStore(host.store),wait=waits.get(goal.wait.correlationId);
 waits.cancel(goal.wait.correlationId);
 if(wait?.owner.id===goal.id&&wait.owner.scopeSessionId===goal.sessionId&&wait.spec.source==='background_job'&&backgroundWaitStillRunning(host.store,wait)){
  service.setDraining(goal.botId,goal.id,true,'Background execution is still running or unverified; reconcile it before continuing');return true;
 }
 service.setDraining(goal.botId,goal.id,false,goal.status==='blocked'?goal.blockedReason:undefined);
 return true;
}
