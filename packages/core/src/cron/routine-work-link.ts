import {createHash} from 'node:crypto';
import {ValidationError} from '../errors.js';
import type {SqliteStateStore} from '../storage.js';
import type {SessionRecord,BackgroundJobRecord} from '../types.js';
import {principalFromSession,sameBotPrincipal} from '../bots/bot-identity.js';
import {BotGoalService} from '../bots/goals/service.js';
import type {BotGoal} from '../bots/goals/types.js';

export interface RoutineWorkLink {goalId:string;backgroundJobId?:string;sopSkill?:string}
export interface RoutineWorkSnapshot {goalId:string;goalRevision:number;goalSessionId:string;sopSkill?:string;sopHash?:string;observedAt?:string;externalJob?:Pick<BackgroundJobRecord,'id'|'sessionId'|'status'|'createdAt'|'updatedAt'>}
interface LinkedWork {link:RoutineWorkLink;goal:BotGoal;session:SessionRecord;externalJob?:BackgroundJobRecord}
function ownedBy(store:SqliteStateStore,owner:SessionRecord,session:SessionRecord):boolean {
 const seen=new Set<string>();let cursor:SessionRecord|undefined=session;
 while(cursor&&!seen.has(cursor.id)&&seen.size<64){
  if(!sameBotPrincipal(principalFromSession(store,owner),principalFromSession(store,cursor)))return false;
  if(cursor.metadata.botId!==owner.metadata.botId)return false;
  if(cursor.id===owner.id)return true;
  seen.add(cursor.id);cursor=cursor.parentSessionId?store.getSession(cursor.parentSessionId):undefined;
 }
 return false;
}
function workOwner(store:SqliteStateStore,sessionId:string):SessionRecord {
 const session=store.getSession(sessionId);if(!session)throw new ValidationError('Work owner session not found');
 const scopeId=session.metadata.canonicalBotChat===true?session.id:session.metadata.botGoalScopeSessionId;
 const owner=typeof scopeId==='string'?store.getSession(scopeId):undefined;
 if(!owner||owner.metadata.canonicalBotChat!==true||!ownedBy(store,owner,session))throw new ValidationError('Work link requires an owned Bot conversation');
 return owner;
}
export function resolveRoutineWorkLink(store:SqliteStateStore,sessionId:string,raw:unknown):LinkedWork {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ValidationError('Invalid workLink');
 const input=raw as Record<string,unknown>;
 for(const key of ['goalId','backgroundJobId','sopSkill'])if(input[key]!==undefined&&(typeof input[key]!=='string'||!input[key].trim()||input[key].length>200))throw new ValidationError(`Invalid workLink.${key}`);
 if(typeof input.goalId!=='string')throw new ValidationError('workLink.goalId required');
 const link:RoutineWorkLink={goalId:input.goalId,...(typeof input.backgroundJobId==='string'?{backgroundJobId:input.backgroundJobId}:{}),...(typeof input.sopSkill==='string'?{sopSkill:input.sopSkill}:{})};
 const session=workOwner(store,sessionId),botId=String(session.metadata.botId);
 const goal=new BotGoalService(store,Date.now,session.id).get(botId,link.goalId);
 if(!goal)throw new ValidationError('Linked work goal not found for this Bot');
 const externalJob=link.backgroundJobId?store.getBackgroundJob(link.backgroundJobId):undefined;
 if(link.backgroundJobId){const worker=externalJob?store.getSession(externalJob.sessionId):undefined;
  if(!externalJob||!worker||!ownedBy(store,session,worker)||(worker.id!==session.id&&worker.metadata.botGoalId!==goal.id))throw new ValidationError('Linked external job not found for this work');
 }
 return {link,goal,session,externalJob};
}
export async function linkedRoutinePrompt(work:LinkedWork,loadSkill?: (name:string,sessionId:string)=>Promise<{content?:string;error?:string}>):Promise<{prompt:string;snapshot:RoutineWorkSnapshot}> {
 const {goal,link,session,externalJob}=work;
 const snapshot:RoutineWorkSnapshot={goalId:goal.id,goalRevision:goal.revision,goalSessionId:session.id};
 let sop='';
 if(link.sopSkill){
  const loaded=await loadSkill?.(link.sopSkill,session.id);
  if(!loaded?.content||loaded.error)throw new ValidationError(`Current SOP unavailable: ${loaded?.error??link.sopSkill}`);
  sop=loaded.content;snapshot.sopSkill=link.sopSkill;snapshot.sopHash=createHash('sha256').update(sop).digest('hex');
 }
 if(externalJob){snapshot.externalJob={id:externalJob.id,sessionId:externalJob.sessionId,status:externalJob.status,createdAt:externalJob.createdAt,updatedAt:externalJob.updatedAt};snapshot.observedAt=externalJob.updatedAt;}
 const prompt=`Current work ${goal.id}, revision ${goal.revision}: ${goal.objective}\nConstraints: ${JSON.stringify(goal.constraints)}\nNext authorized step: ${goal.nextStep??'Observe the current execution and continue remaining authorized work.'}\nCurrent work requirements supersede older copied routine instructions. A process exit or idle chat does not verify delivery. Never repeat confirmed external effects or widen saved permissions.\n${sop?`Current SOP (${snapshot.sopHash}):\n${sop}`:''}${externalJob?`\nCurrent registered external job (execution identity, not proof of delivery): ${JSON.stringify(snapshot.externalJob)}`:''}`;
 return {prompt,snapshot};
}
