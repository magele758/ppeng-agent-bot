import type { SqliteStateStore } from '../../storage.js';
import type { SessionRecord } from '../../types.js';
import { BotGoalService } from './service.js';

/** Workers can resume their own revision while waiting, but cannot claim or follow a newer execution. */
export function isGoalWorkerCurrent(store:SqliteStateStore,session:SessionRecord):boolean {
 const live=store.getSession(session.id);
 if(!live||live.metadata.botGoalWorker!==true)return false;
 const {botId,botGoalId:goalId,botGoalScopeSessionId:scopeId,botGoalWorkerRevision:revision,botGoalWorkerExecutionId:executionId,botGoalWorkerFence:fence}=live.metadata;
 if(typeof botId!=='string'||typeof goalId!=='string'||typeof scopeId!=='string'||typeof executionId!=='string'||typeof revision!=='number'||typeof fence!=='number')return false;
 const parent=store.getSession(scopeId);
 if(!parent||parent.metadata.canonicalBotChat!==true||parent.metadata.botId!==botId)return false;
 const service=new BotGoalService(store,Date.now,scopeId);
 const goal=service.get(botId,goalId);
 const execution=service.executions(botId,goalId).find(item=>item.id===executionId);
 if(!goal||!execution||goal.revision!==revision||execution.goalRevision!==revision||execution.fence!==fence||execution.sessionId!==live.parentSessionId)return false;
 const owner=execution.sessionId?store.getSession(execution.sessionId):undefined;
 if(!owner||owner.metadata.botId!==botId||(owner.id!==scopeId&&owner.metadata.botGoalScopeSessionId!==scopeId))return false;
 if(goal.status==='running')return goal.activeExecutionId===executionId&&execution.status==='running'&&execution.leaseUntil>Date.now();
 if(goal.status!=='waiting'||execution.status!=='finished'||goal.wait?.source!=='session'||goal.wait.correlationId!==live.id)return false;
 return hasAuthorizedWorkerWait(owner,goalId,executionId,live.id);
}

function hasAuthorizedWorkerWait(owner:SessionRecord,goalId:string,executionId:string,workerId:string):boolean {
 const waits=owner.metadata.botGoalAuthorizedWaits;
 return Array.isArray(waits)&&waits.some(wait=>wait?.goalId===goalId&&wait.executionId===executionId&&wait.source==='session'&&wait.correlationId===workerId);
}
