import type { GoalEvidenceMessage, GoalEvidenceSource } from './completion-evidence.js';
import type { SqliteStateStore } from '../../storage.js';
import type { SessionMessage, SessionRecord } from '../../types.js';
import { principalFromSession, sameBotPrincipal } from '../bot-identity.js';
import { getBotTask } from '../bot-work.js';
import { readBotDelivery } from '../bot-delivery.js';
import { BotGoalService } from './service.js';
import type { BotGoal, GoalExecution } from './types.js';

/** Read the WAL so compaction keeps evidence, but explicit retractions still win. */
export function evidenceTranscript(store: SqliteStateStore, sessionId: string): SessionMessage[] {
 const nodes=store.listSurfaceNodes(sessionId);
 const retractions=nodes.filter(node=>node.surfaceOp==='hide'||(node.surfaceOp==='replace'&&node.key!=='compact-summary'));
 return nodes.filter(node=>node.surfaceOp!=='hide'&&!retractions.some(retraction=>node.seq>=retraction.replacesStart!&&node.seq<=retraction.replacesEnd!));
}
function samePrincipal(store:SqliteStateStore,parent:SessionRecord,session:SessionRecord|undefined):session is SessionRecord {
 return !!session&&sameBotPrincipal(principalFromSession(store,parent),principalFromSession(store,session));
}
function descendantOf(store:SqliteStateStore,session:SessionRecord,ancestorId:string|undefined):boolean {
 const visited=new Set<string>();
 let parentId=session.parentSessionId;
 while(parentId&&!visited.has(parentId)) {
  if(parentId===ancestorId)return true;
  visited.add(parentId);
  parentId=store.getSession(parentId)?.parentSessionId;
 }
 return false;
}
function executionOwner(store:SqliteStateStore,parent:SessionRecord,goal:BotGoal,execution:GoalExecution):SessionRecord|undefined {
 const owner=execution.sessionId?store.getSession(execution.sessionId):undefined;
 if(!samePrincipal(store,parent,owner))return undefined;
 if(owner.id!==parent.id&&(owner.metadata.botGoalScopeSessionId!==parent.id||owner.metadata.botGoalId!==goal.id||!descendantOf(store,owner,parent.id)))return undefined;
 return owner;
}
function ownerEvidence(store:SqliteStateStore,owner:SessionRecord,execution:GoalExecution):SessionMessage[] {
 const messages=evidenceTranscript(store,owner.id).filter(message=>
  (execution.messageStartSeq!==undefined ? (message.seq??-1)>execution.messageStartSeq : Date.parse(message.createdAt)>=Date.parse(execution.startedAt))
  && (execution.messageEndSeq!==undefined ? (message.seq??Infinity)<=execution.messageEndSeq : !execution.endedAt||Date.parse(message.createdAt)<=Date.parse(execution.endedAt)));
 if(!messages.some(message=>message.role==='tool'&&message.parts.some(part=>part.type==='tool_result'&&part.name==='goal_dispatch')))return messages;
 const ledger=store.getDaemonControl<Array<Pick<SessionMessage,'role'|'parts'>>>(`bot.goal-tool-ledger:${owner.id}:${execution.id}`)??[];
 return [...messages,...ledger.map((message,index)=>({...message,id:`ledger:${execution.id}:${index}`,sessionId:owner.id,createdAt:execution.startedAt}))];
}
function childEvidence(store:SqliteStateStore,parent:SessionRecord,goal:BotGoal,execution:GoalExecution,id:string):SessionMessage[] {
 const child=store.getSession(id);
 if(!samePrincipal(store,parent,child)||child.metadata.botGoalId!==goal.id||child.metadata.botGoalScopeSessionId!==parent.id)return [];
 if(!descendantOf(store,child,execution.sessionId))return [];
 if(child.metadata.botGoalWorkerExecutionId!==undefined&&child.metadata.botGoalWorkerExecutionId!==execution.id)return [];
 return evidenceTranscript(store,id);
}
function delegatedEvidence(store:SqliteStateStore,parent:SessionRecord,goal:BotGoal,execution:GoalExecution,id:string):SessionMessage[] {
 const principal=principalFromSession(store,parent);
 const task=getBotTask(store,principal,id);
 if(!task||task.requesterBotId!==goal.botId)return [];
 const delivery=readBotDelivery(store,id,task.attempt);
 const recipient=delivery?store.getSession(delivery.sessionId):store.listSessions().find(session=>
  session.metadata.canonicalBotChat===true&&session.metadata.botId===task.targetBotId
  &&session.metadata.botWorkTaskId===id&&session.metadata.botWorkTaskAttempt===task.attempt&&samePrincipal(store,parent,session));
 if(!samePrincipal(store,parent,recipient)||recipient.metadata.botId!==task.targetBotId)return [];
 const messages:SessionMessage[]=[];
 if(delivery?.transcriptRange&&samePrincipal(store,parent,recipient)&&recipient.metadata.botId===task.targetBotId) {
  const range=delivery.transcriptRange;
  messages.push(...evidenceTranscript(store,recipient.id).filter(message=>message.seq!==undefined&&message.seq>range.start&&message.seq<=range.end));
 }
 for(const worker of store.listSessions()) {
  if(worker.metadata.canonicalBotChat===true||worker.metadata.botWorkTaskId!==id||worker.metadata.botWorkTaskAttempt!==task.attempt)continue;
  if(!samePrincipal(store,parent,worker)||worker.metadata.botId!==task.targetBotId||!descendantOf(store,worker,recipient?.id))continue;
  messages.push(...evidenceTranscript(store,worker.id));
 }
 return sourced(messages,{kind:'delegated',goalId:goal.id,revision:goal.revision,executionId:execution.id,botId:task.targetBotId,taskId:id,attempt:task.attempt,taskStatus:task.status});
}

function sourced(messages:SessionMessage[],source:GoalEvidenceSource):GoalEvidenceMessage[] {
 return messages.map(message=>({...message,goalEvidenceSource:source}));
}

/** Only server-recorded execution links in the current revision can contribute proof. */
export function goalExecutionEvidence(store:SqliteStateStore,goal:BotGoal):SessionMessage[] {
 const parent=store.getSession(goal.sessionId);
 if(!parent||parent.metadata.botId!==goal.botId||parent.metadata.canonicalBotChat!==true)return [];
 const executions=new BotGoalService(store,Date.now,parent.id).executions(goal.botId,goal.id);
 const messages:SessionMessage[]=[];
 for(const execution of executions) {
  if(execution.goalRevision!==goal.revision)continue;
  const owner=executionOwner(store,parent,goal,execution);
  if(!owner)continue;
  const source:GoalEvidenceSource={kind:'coordinator',goalId:goal.id,revision:goal.revision,executionId:execution.id,botId:goal.botId};
  messages.push(...sourced(ownerEvidence(store,owner,execution),source));
  const ref=execution.runRef;
  if(ref?.startsWith('session:')&&ref.slice(8)!==owner.id)messages.push(...sourced(childEvidence(store,parent,goal,execution,ref.slice(8)),{...source,kind:'worker'}));
  if(ref?.startsWith('bot_task:'))messages.push(...delegatedEvidence(store,parent,goal,execution,ref.slice(9)));
 }
 return [...new Map(messages.map(message=>[`${message.sessionId}:${message.id}`,message])).values()];
}
