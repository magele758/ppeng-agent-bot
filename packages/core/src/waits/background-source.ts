import type {SqliteStateStore} from '../storage.js';
import type {BackgroundJobRecord} from '../types.js';
import {activeWaitOwner} from './tool.js';
import type {DurableWait,Observation,WaitOwner,WaitSource,WaitSpec} from './types.js';
import {DurableWaitStore} from './store.js';
import {RoutineRunStore} from '../cron/routine-runtime.js';
import {stableJson} from '../cron/notification-decision.js';
import {principalFromSession,botPrincipalKey} from '../bots/bot-identity.js';
interface BackgroundBinding {owner:WaitOwner;principal:string;botId?:string;jobId:string;jobSessionId:string;jobCreatedAt:string}
const key=(id:string)=>`agent.background-wait-source:${id}`;
/** Host-only capability, recorded after the authorized bg_run gateway returns a real job. */
export function recordBackgroundWaitSource(store:SqliteStateStore,sessionId:string,job:BackgroundJobRecord):WaitSpec|undefined {
 const session=store.getSession(sessionId);if(!session||job.sessionId!==sessionId)return undefined;
 const owner=activeWaitOwner(store,session);if(!owner)return undefined;
 const actual=store.getBackgroundJob(job.id);if(!actual||actual.sessionId!==session.id||actual.createdAt!==job.createdAt)return undefined;
 const binding:BackgroundBinding={owner,botId:typeof session.metadata.botId==='string'?session.metadata.botId:undefined,principal:botPrincipalKey(principalFromSession(store,session)),jobId:actual.id,jobSessionId:actual.sessionId,jobCreatedAt:actual.createdAt};
 store.setDaemonControl(key(actual.id),binding);
 return {source:'background_job',ref:actual.id,condition:{op:'in',field:'status',values:['completed','failed']}};
}

function markHostRegistered(store:SqliteStateStore, waitId:string):void {
 const row=store.db.prepare('SELECT payload FROM agent_waits WHERE id=?').get(waitId) as {payload?:string}|undefined;
 if(!row?.payload)return;
 const wait=JSON.parse(String(row.payload));
 wait.hostRegistered=true;
 wait.updatedAt=Date.now();
 store.db.prepare('UPDATE agent_waits SET payload=? WHERE id=?').run(JSON.stringify(wait),waitId);
}

/** Host-parks a durable wait for an owned bg_run so the model need not call wait_for next. */
export function parkBackgroundDurableWait(
 store:SqliteStateStore,
 sessionId:string,
 job:BackgroundJobRecord,
 summary='Background job still running; resume once its status is terminal'
):{waitId:string;waitFor:WaitSpec}|undefined {
 const waitFor=recordBackgroundWaitSource(store,sessionId,job);
 if(!waitFor)return undefined;
 const session=store.getSession(sessionId);if(!session)return undefined;
 const owner=activeWaitOwner(store,session);if(!owner)return undefined;
 try{
  const record=new DurableWaitStore(store).register(owner,waitFor);
  markHostRegistered(store,record.id);
  const live=store.getSession(session.id)??session;
  const checkpoint={kind:'waiting' as const,summary,wait:{source:'durable_wait',correlationId:record.id}};
  store.updateSession(live.id,{metadata:{...live.metadata,agentWaitId:record.id,...(owner.kind==='goal'?{botGoalCheckpoint:checkpoint}:{})}});
  if(owner.kind==='routine'){
   new RoutineRunStore(store).update(owner.id,{waitId:record.id,waitCheckpoint:summary,status:'waiting_condition',result:summary,error:undefined});
  }
  return {waitId:record.id,waitFor};
 }catch{return undefined;}
}

function observeBackground(store:SqliteStateStore,owner:WaitOwner,ref:string):Observation {
 const binding=store.getDaemonControl<BackgroundBinding>(key(ref));
 if(!binding||binding.jobId!==ref||stableJson(binding.owner)!==stableJson(owner))return {availability:'unauthorized',reason:'Background job is not bound to this work execution'};
 const session=store.getSession(binding.jobSessionId),scope=store.getSession(owner.scopeSessionId);
 if(!session||!scope||[session,scope].some(s=>botPrincipalKey(principalFromSession(store,s))!==binding.principal||s.metadata.botId!==binding.botId))return {availability:'unauthorized',reason:'Background job ownership changed'};
 const job=store.getBackgroundJob(ref);if(!job)return {availability:'unavailable',reason:'Background job record is missing; reconcile before continuing'};
 if(job.sessionId!==binding.jobSessionId||job.createdAt!==binding.jobCreatedAt)return {availability:'unauthorized',reason:'Background job execution identity changed'};
 return {availability:'available',facts:{status:job.status==='error'?'failed':job.status,version:job.updatedAt,startedAt:job.createdAt,sessionId:job.sessionId}};
}
export const backgroundJobWaitSource:WaitSource={fields:['status','version','startedAt','sessionId'],observe({store,owner},ref){return observeBackground(store,owner,ref);}};
/** Cancellation stops the wait, not the process; keep work draining until its own job ends. */
export function backgroundWaitStillRunning(store:SqliteStateStore,wait:DurableWait):boolean {
 const observed=observeBackground(store,wait.owner,wait.spec.ref);
 return observed.availability!=='available'||observed.facts.status==='running';
}
