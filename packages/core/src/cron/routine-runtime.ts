import { type RoutineDeliveryPolicy } from './routine-delivery-policy.js';
import { RoutineHealthStore, classifyRoutineFailure, isGovernedRoutine, type RoutineFailureClass } from './routine-health.js';
/** Durable occurrence ledger. Configuration and individual execution have independent lifecycles. */
import { ensureRoutineSummarySchema } from './routine-continuation.js';
import { RoutineLease, ensureRoutineLeaseSchema } from './routine-lease.js';
import { routineExpired } from './routine-deadline.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteStateStore } from '../storage.js';
import { createId, nowIso } from '../id.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ApprovalRecord, SessionRecord } from '../types.js';
import { childPermissionMode, inheritBotAllowlists, inheritModelOverride } from '../runtime/spawn-policy.js';
import { enqueueSteer, textPart } from '../runtime/session-facade.js';
import { stampSessionWake } from '../approval/unattended-approval.js';
import { parseRunOutcome } from '../session/run-outcome.js';
import { assistantTextsFromFold } from '../session/visible-assistant.js';
import { BotQueueCapacityError, checkBotWorkCapacity, botWorkControl, resumeApprovedBotSession } from '../bots/bot-work.js';
import { openBot } from '../bots/bot-facade.js';
import { principalFromSession } from '../bots/bot-identity.js';
import { CronJobStore, type CronJobRecord } from './cron-store.js';
import { type PrecheckResult, evaluateRoutinePrecheck, readStoredPrecheck } from './routine-precheck.js';
import { nextZonedCronRunAt, skippedZonedCronMinutes } from './cron-next.js';
import { deliverBotRoomMessage } from '../rooms/index.js';
import { isSilenceToken } from '../bots/silence.js';
import type { BotPrincipal } from '../bots/bot-identity.js';
export type RoutineRunStatus = 'queued'|'running'|'waiting_approval'|'completed'|'failed'|'cancelled'|'unknown'|'skipped'|'silent';
export interface RoutineRoomDelivery { status:'delivered'|'skipped'; roomId:string; messageId?:string; reason?:string }
export interface RoutineAttempt { number:number;sessionId:string;startedAt:string;finishedAt?:string;status:RoutineRunStatus;result?:string;error?:string }
export interface RoutineRun {
 publication?:'pending'|'approved'|'rejected'; publicationDecidedAt?:string; notificationReason?:'unchanged'|'below_failure_threshold'|'rejected';
 id:string; routineId:string; scheduledAt:string; timezone:string; status:RoutineRunStatus;
 approvalIds?:string[];resumeStartedAt?:string; attempts?:RoutineAttempt[]; sessionId?:string; mainSessionId:string; attempt:number; result?:string; error?:string;
 failureClass?:RoutineFailureClass; precheckOutcome?:'ready'|'no_change'|'failed'; precheckState?:unknown; precheckChecked?:boolean; missedCount:number; createdAt:string; updatedAt:string; startedAt?:string; finishedAt?:string; ownerPid?:number;
 summaryMessageId?:string; eventBody?:string; notificationSent?:boolean; requiresEffectVerification?:boolean; roomDelivery?:RoutineRoomDelivery; steerKey?:string; job:CronJobRecord;
}
export interface RoutineRuntimeHost {
 store:SqliteStateStore; stateDir:string; log:Pick<Logger,'warn'|'info'>;
 runSession(sessionId:string):Promise<unknown>;
 isSessionRunning?(sessionId:string):boolean;
 hasUnconfirmedEffects?(sessionId:string,startedAt:string):boolean;
 cancelSession?(sessionId:string):unknown;
}
const active = new WeakMap<SqliteStateStore,Set<string>>();
function activeFor(store:SqliteStateStore):Set<string> { let set=active.get(store); if(!set){set=new Set();active.set(store,set)}return set; }
export function ensureRoutineSchema(store:Pick<SqliteStateStore,'db'>):void {
 store.db.exec('CREATE TABLE IF NOT EXISTS routine_precheck_state(routine_id TEXT PRIMARY KEY,state_json TEXT NOT NULL)');
 ensureRoutineLeaseSchema(store);
 ensureRoutineSummarySchema(store);
 store.db.exec(`CREATE TABLE IF NOT EXISTS bot_routine_runs(id TEXT PRIMARY KEY,routine_id TEXT NOT NULL,occurrence_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,payload TEXT NOT NULL,notified INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS idx_bot_routine_runs ON bot_routine_runs(routine_id,status); CREATE INDEX IF NOT EXISTS idx_bot_routine_status ON bot_routine_runs(status)`);
 const columns=store.db.prepare('PRAGMA table_info(bot_routine_runs)').all();
 if(!columns.some(c=>c.name==='notified')){store.db.exec("ALTER TABLE bot_routine_runs ADD COLUMN notified INTEGER NOT NULL DEFAULT 0; UPDATE bot_routine_runs SET notified=1 WHERE json_extract(payload,'$.notificationSent')=1");}
 store.db.exec('CREATE INDEX IF NOT EXISTS idx_bot_routine_notify ON bot_routine_runs(notified)');
}
export class RoutineRunStore {
 constructor(private store:SqliteStateStore){ensureRoutineSchema(store);}
 pending():RoutineRun[]{
 const activeRows=this.store.db.prepare("SELECT payload FROM bot_routine_runs WHERE status IN ('queued','running','waiting_approval','unknown') ORDER BY rowid").all();
 const notificationRows=this.store.db.prepare("SELECT payload FROM bot_routine_runs WHERE notified=0 AND status NOT IN ('queued','running','waiting_approval','unknown') ORDER BY rowid").all();
 return [...activeRows,...notificationRows].map(r=>JSON.parse(String(r.payload)));
 }
 findByKey(key:string):RoutineRun|undefined{const row=this.store.db.prepare('SELECT payload FROM bot_routine_runs WHERE occurrence_key=?').get(key);return row?JSON.parse(String(row.payload)):undefined;}
 get(id:string):RoutineRun|undefined {const row=this.store.db.prepare('SELECT payload FROM bot_routine_runs WHERE id=?').get(id);return row?JSON.parse(String(row.payload)):undefined;}
 page(routineId:string,opts?:{before?:number;limit?:number}):{runs:RoutineRun[];nextCursor?:number} {
  const limit=Math.min(500,Math.max(1,Math.floor(opts?.limit??100)));
  const rows=(opts?.before?this.store.db.prepare('SELECT rowid AS sequence,payload FROM bot_routine_runs WHERE routine_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(routineId,opts.before,limit+1):this.store.db.prepare('SELECT rowid AS sequence,payload FROM bot_routine_runs WHERE routine_id=? ORDER BY rowid DESC LIMIT ?').all(routineId,limit+1));
  const visible=rows.slice(0,limit);
  const activeRows=this.store.db.prepare("SELECT rowid AS sequence,payload FROM bot_routine_runs WHERE routine_id=? AND (status IN ('queued','running','waiting_approval','unknown') OR json_extract(payload,'$.publication')='pending') ORDER BY rowid DESC").all(routineId);
  const byId=new Map<string,RoutineRun>();for(const row of [...activeRows,...visible]){const run=JSON.parse(String(row.payload)) as RoutineRun;byId.set(run.id,run);}
  return {runs:[...byId.values()],...(rows.length>limit?{nextCursor:Number(visible.at(-1)!.sequence)}:{})};
 }
 list(routineId?:string):RoutineRun[]{if(routineId)return this.page(routineId,{limit:500}).runs;return this.store.db.prepare('SELECT payload FROM bot_routine_runs ORDER BY rowid LIMIT 10000').all().map(r=>JSON.parse(String(r.payload)));}
 enqueue(job:CronJobRecord,scheduledAt:string,opts?:{status?:RoutineRunStatus;missedCount?:number;error?:string;key?:string;prompt?:string;precheckChecked?:boolean;eventBody?:string}):RoutineRun {
  const key=opts?.key??`${job.id}:${job.ruleVersion??1}:${job.timezone??'UTC'}:${scheduledAt}`;
  const now=nowIso();const run:RoutineRun={id:createId('routine_run'),routineId:job.id,scheduledAt,timezone:job.timezone??'UTC',status:opts?.status??'queued',mainSessionId:job.sessionId,attempt:1,missedCount:opts?.missedCount??0,createdAt:now,updatedAt:now,precheckChecked:opts?.precheckChecked??false,job:{...job,prompt:opts?.prompt??job.prompt},...(opts?.error?{error:opts.error}:{})};
  const ownTransaction=!this.store.db.isTransaction;if(ownTransaction)this.store.db.exec('BEGIN IMMEDIATE');
  try {
   const existing=this.findByKey(key);if(existing){if(ownTransaction)this.store.db.exec('COMMIT');return existing;}
   if(run.status==='queued'){const parent=this.store.getSession(job.sessionId);const principal=job.metadata.principal as {userId:string;tenantId?:string}|undefined;
    if(principal||parent)checkBotWorkCapacity(this.store,principal??principalFromSession(this.store,parent!),String(job.metadata.botId??job.agentId));
   }
   if(opts?.eventBody!==undefined)run.eventBody=opts.eventBody;
   this.store.db.prepare('INSERT INTO bot_routine_runs(id,routine_id,occurrence_key,status,payload) VALUES(?,?,?,?,?)').run(run.id,run.routineId,key,run.status,JSON.stringify(run));
   if(ownTransaction)this.store.db.exec('COMMIT');return run;
  }catch(error){if(ownTransaction)this.store.db.exec('ROLLBACK');throw error;}
 }
 update(id:string,patch:Partial<RoutineRun>):RoutineRun {const old=this.get(id);if(!old)throw new NotFoundError('RoutineRun',id);const next={...old,...patch,id,updatedAt:nowIso()};if(patch.status&&old.sessionId&&old.attempts?.length&&patch.status!=='queued'){next.attempts=old.attempts.map(a=>a.sessionId===old.sessionId?{...a,status:patch.status!,...(patch.result!==undefined?{result:patch.result}:{}),...(patch.error!==undefined?{error:patch.error}:{}),...(patch.finishedAt?{finishedAt:patch.finishedAt}:{})}:a);}this.store.db.prepare('UPDATE bot_routine_runs SET status=?,payload=?,notified=? WHERE id=?').run(next.status,JSON.stringify(next),next.notificationSent?1:0,id);return next;}
 claim(id:string,sessionId:string):RoutineRun|undefined { const current=this.get(id);if(!current||current.status!=='queued')return undefined;const startedAt=nowIso();const next={...current,status:'running' as const,sessionId,error:current.error?.startsWith('Bot is')?undefined:current.error,ownerPid:process.pid,startedAt,updatedAt:startedAt,attempts:[...(current.attempts??[]),{number:current.attempt,sessionId,startedAt,status:'running' as const}]};const result=this.store.db.prepare("UPDATE bot_routine_runs SET status='running',payload=? WHERE id=? AND status='queued' AND NOT EXISTS (SELECT 1 FROM bot_routine_runs other WHERE other.routine_id=? AND other.id<>? AND other.status IN ('running','waiting_approval','unknown'))").run(JSON.stringify(next),id,current.routineId,id);return result.changes?next:undefined; }
}
function routineRoomId(run:RoutineRun):string|undefined {
 const roomId=run.job.metadata.roomId;return typeof roomId==='string'&&roomId.trim()?roomId.trim():undefined;
}
function routinePrincipal(run:RoutineRun):BotPrincipal|undefined {
 const raw=run.job.metadata.principal;if(!raw||typeof raw!=='object'||Array.isArray(raw))return undefined;
 const userId=(raw as {userId?:unknown}).userId;if(typeof userId!=='string'||!userId.trim())return undefined;
 const tenantId=(raw as {tenantId?:unknown}).tenantId;
 return {userId:userId.trim(),...(typeof tenantId==='string'&&tenantId.trim()?{tenantId:tenantId.trim()}:{})};
}
/** Completed text only. Silence, skip, empty, and failure stay out of the room. */
export function routineRoomPost(run:RoutineRun):string|undefined {
 if(!routineRoomId(run)||run.status!=='completed')return undefined;
 const text=run.result?.trim();return text||undefined;
}
function refusedRoom(host:RoutineRuntimeHost,run:RoutineRun,roomId:string,reason:string):RoutineRoomDelivery {
 host.log.warn('routine room delivery skipped',{runId:run.id,roomId,reason});
 return {status:'skipped',roomId,reason};
}
function postRoomResult(host:RoutineRuntimeHost,run:RoutineRun):RoutineRoomDelivery|undefined {
 const roomId=routineRoomId(run);const text=routineRoomPost(run);if(!roomId||!text)return undefined;
 const botId=run.job.metadata.botId;const principal=routinePrincipal(run);
 if(typeof botId!=='string'||!principal)return refusedRoom(host,run,roomId,'not_bot_owned');
 const delivery=deliverBotRoomMessage(host.store,{roomId,botId,principal,text,idempotencyKey:`routine:${run.id}:${run.attempt}`});
 if(delivery.delivered)return {status:'delivered',roomId,messageId:delivery.message.id};
 return refusedRoom(host,run,roomId,delivery.reason);
}
/** Publication decisions never restart execution or approve a model tool call. */
export function decideRoutinePublication(host:RoutineRuntimeHost,id:string,approved:boolean):RoutineRun {
 const runs=new RoutineRunStore(host.store);
 const ownTransaction=!host.store.db.isTransaction;
 if(ownTransaction)host.store.db.exec('BEGIN IMMEDIATE');
 try {
  const run=runs.get(id);
  if(!run)throw new NotFoundError('RoutineRun',id);
  const decision=approved?'approved':'rejected';
  if(run.publication!==decision){
   if(run.publication!=='pending'||run.status!=='completed')throw new ValidationError('No pending publication');
   runs.update(id,{publication:decision,publicationDecidedAt:nowIso(),...(!approved?{notificationSent:true,notificationReason:'rejected' as const}:{})});
  }
  if(approved)summarize(host,runs,runs.get(id)!);
  const result=runs.get(id)!;
  if(ownTransaction)host.store.db.exec('COMMIT');
  return result;
 }catch(error){if(ownTransaction)host.store.db.exec('ROLLBACK');throw error;}
}
function consecutiveFailedOccurrences(store:SqliteStateStore,run:RoutineRun):number {
 const rows=store.db.prepare("SELECT status FROM bot_routine_runs WHERE routine_id=? AND rowid<=(SELECT rowid FROM bot_routine_runs WHERE id=?) AND status IN ('failed','completed','silent') ORDER BY rowid DESC LIMIT 100").all(run.routineId,run.id);
 let count=0;for(const row of rows){if(row.status!=='failed')break;count++;}return count;
}
function notificationAllowed(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun):boolean {
 const policy=run.job.metadata.deliveryPolicy as RoutineDeliveryPolicy|undefined;
 if(!policy)return true;
 // The decision is durable per attempt; scheduler retries do not change its meaning.
 if(run.publication==='pending'||run.publication==='rejected')return false;
 if(run.status==='failed'&&consecutiveFailedOccurrences(host.store,run)<policy.failureThreshold&&!new RoutineHealthStore(host.store).get(run.routineId).paused){
  runs.update(run.id,{notificationSent:true,notificationReason:'below_failure_threshold'});return false;
 }
 if(run.status==='completed'){
  const key=`routine.last-published:${run.routineId}`;
  if(!run.publication&&policy.changesOnly&&host.store.getDaemonControl<string>(key)===run.result?.trim()){
   runs.update(run.id,{notificationSent:true,notificationReason:'unchanged'});return false;
  }
  if(policy.approvalBeforeSend&&run.publication!=='approved'){
   runs.update(run.id,{publication:'pending'});return false;
  }
 }
 return true;
}
function summarize(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun):void {
 if(run.status==='failed'&&!run.failureClass)run=runs.update(run.id,{failureClass:classifyRoutineFailure(run.error)});
 new RoutineHealthStore(host.store).observe(run);
 if(run.notificationSent)return;
 if(run.status==='silent'){runs.update(run.id,{notificationSent:true});return;}
 if(!notificationAllowed(host,runs,run))return;
 const parent=host.store.getSession(run.mainSessionId)??repairRoutineOwnerSession(host,run.job);
 if(parent&&parent.id!==run.mainSessionId){runs.update(run.id,{mainSessionId:parent.id});run.mainSessionId=parent.id;}
 if(!parent){const roomDelivery=postRoomResult(host,run);if(roomDelivery?.status==='delivered')host.store.setDaemonControl(`routine.last-published:${run.routineId}`,run.result?.trim()??'');runs.update(run.id,{notificationSent:true,...(roomDelivery?{roomDelivery}:{})});return;}
 if(parent.status==='running'||parent.status==='waiting_approval'||host.isSessionRunning?.(parent.id))return;
 appendRoutineSummary(host,runs,run);
}
function appendRoutineSummary(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun):void {
 const description=run.result||run.error||run.status;
 // Insert the summary and notification marker atomically. No user instruction or private run transcript.
 const ownTransaction=!host.store.db.isTransaction;if(ownTransaction)host.store.db.exec('BEGIN IMMEDIATE');
 try { const fresh=runs.get(run.id);if(fresh?.notificationSent){if(ownTransaction)host.store.db.exec('COMMIT');return;}
 const summary=host.store.appendMessage(run.mainSessionId,'assistant',[textPart(`[routine:${run.job.name}] ${run.status}\n${description.slice(0,2000)}\nRun: ${run.id}${run.sessionId?` · /api/sessions/${run.sessionId}`:''}`)],{key:`routine-result:${run.id}`} );
 if(run.sessionId)host.store.db.prepare('INSERT INTO bot_routine_summary_links(message_id,main_session_id,working_session_id,run_id) VALUES(?,?,?,?)').run(summary.id,run.mainSessionId,run.sessionId,run.id);
 const roomDelivery=postRoomResult(host,fresh??run);
 if(run.status==='completed'&&(!routineRoomId(run)||roomDelivery?.status==='delivered'))host.store.setDaemonControl(`routine.last-published:${run.routineId}`,run.result?.trim()??'');
 runs.update(run.id,{notificationSent:true,summaryMessageId:summary.id,...(roomDelivery?{roomDelivery:roomDelivery}:{})});if(ownTransaction)host.store.db.exec('COMMIT');
 }catch(error){if(ownTransaction)host.store.db.exec('ROLLBACK');throw error;}
}
function sharedBotRun(host:RoutineRuntimeHost,run:RoutineRun):boolean {
 if(!run.sessionId||run.sessionId!==run.mainSessionId||!run.startedAt)return false;
 const session=host.store.getSession(run.sessionId);return !!session&&isBotMainSession(session);
}
/** Replies after this run's prompt count. Claim time can be later than the answer. */
function resultText(host:RoutineRuntimeHost,run:RoutineRun):string {
 if(!run.sessionId)return '';
 if(!sharedBotRun(host,run))return assistantTextsFromFold(host.store,run.sessionId).at(-1)?.trim().slice(0,16000)??'';
 const folded=host.store.foldMessages(run.sessionId);
 const key=run.steerKey??`routine:${run.id}`;
 const prompt=folded.find(message=>message.role==='user'&&message.key===key);
 const start=Date.parse(run.startedAt!);
 const afterId=prompt?.id??folded.filter(message=>Date.parse(message.createdAt)<start).at(-1)?.id;
 const texts=assistantTextsFromFold(host.store,run.sessionId,afterId).map(text=>text.trim()).filter(text=>text.length>0&&!text.startsWith('[routine:'));
 return texts.join('\n').slice(0,16000);
}
function approvalsForSession(host:RoutineRuntimeHost,run:RoutineRun):ApprovalRecord[] {
 const rows=host.store.listApprovals().filter(approval=>approval.sessionId===run.sessionId);
 if(!sharedBotRun(host,run))return rows;
 const start=Date.parse(run.startedAt!);
 return rows.filter(approval=>Date.parse(approval.createdAt)>=start);
}
function unknownEffects(host:RoutineRuntimeHost,run:RoutineRun):boolean {
 return !!run.sessionId&&host.hasUnconfirmedEffects?.(run.sessionId,run.startedAt??run.createdAt)===true;
}
function approvalCheckpoint(approvals:ApprovalRecord[]):string[]{
 const pending=approvals.filter(approval=>approval.status==='pending');return (pending.length?pending:approvals.filter(approval=>approval.status==='approved')).map(approval=>approval.id);
}
function isWaitingForDecision(session:SessionRecord|undefined,approvals:ApprovalRecord[]):boolean {
 if(approvals.some(approval=>approval.status==='rejected'))return false;
 if(session?.status==='waiting_approval')return true;
 const outcome=parseRunOutcome(session?.metadata?.outcome);
 return outcome?.kind==='waiting_approval'&&approvals.some(approval=>approval.status==='pending'||approval.status==='approved');
}
function routineQuiet(result:string):boolean {
 return result.trim().startsWith('[NO_UPDATE]')||isSilenceToken(result);
}
function completionError(session:SessionRecord|undefined,denied:boolean,result:string):string {
 if(denied)return 'Approval denied or expired';const outcome=parseRunOutcome(session?.metadata?.outcome);
 if(outcome?.reason)return `Execution stopped: ${outcome.reason}`;
 return result.trim()?'Session did not complete':'Execution ended without a result';
}
function completionResult(host:RoutineRuntimeHost,run:RoutineRun,session:SessionRecord|undefined,approvals:ApprovalRecord[]):Partial<RoutineRun>{
 const result=resultText(host,run);
 if(unknownEffects(host,run))return {status:'unknown',result,error:'External effects are unconfirmed; verify before retry'};
 const denied=approvals.some(approval=>approval.status==='rejected');const outcome=parseRunOutcome(session?.metadata?.outcome);
 const stopped=outcome?.kind==='aborted'||outcome?.kind==='failed'||(outcome?.kind==='idle'&&outcome.reason!=='end');
 const failed=stopped||!session||!['idle','completed'].includes(session.status)||denied||!result.trim();
 return failed?{status:'failed',result,error:completionError(session,denied,result)}:{status:routineQuiet(result)?'silent':'completed',result};
}
function finish(host:RoutineRuntimeHost,runs:RoutineRunStore,id:string,expectedSessionId?:string):void {
 const run=runs.get(id);if(!run||(expectedSessionId&&run.sessionId!==expectedSessionId))return;
 if(run.status==='cancelled'&&unknownEffects(host,run)){const corrected=runs.update(id,{...completionResult(host,run,run.sessionId?host.store.getSession(run.sessionId):undefined,[]),notificationSent:false});summarize(host,runs,corrected);return;}
 if(!['running','waiting_approval'].includes(run.status))return;
 const session=run.sessionId?host.store.getSession(run.sessionId):undefined;
 const approvals=approvalsForSession(host,run);
 if(isWaitingForDecision(session,approvals)){runs.update(id,{status:'waiting_approval',approvalIds:approvalCheckpoint(approvals)});return;}
 if(session?.status==='running')return;
 const completed=runs.update(id,{...completionResult(host,run,session,approvals),finishedAt:nowIso()});summarize(host,runs,completed);
}
function failRoutineExecution(host:RoutineRuntimeHost,runs:RoutineRunStore,id:string,sessionId:string,error:unknown):void {
 const current=runs.get(id);if(!current||current.sessionId!==sessionId)return;
 const unconfirmed=unknownEffects(host,current);
 if(!['running','waiting_approval'].includes(current.status)&&!(current.status==='cancelled'&&unconfirmed))return;
 const reason=error instanceof Error?error.message:String(error);
 const failed=runs.update(id,{status:unconfirmed?'unknown':'failed',error:unconfirmed?'External effects are unconfirmed; verify before retry':reason,failureClass:classifyRoutineFailure(error),finishedAt:nowIso()});summarize(host,runs,failed);
}
function launchRoutineSession(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,sessionId:string,lease:RoutineLease):void {
 const executing=activeFor(host.store);executing.add(run.id);
 const stop=lease.heartbeat(()=>{host.cancelSession?.(sessionId);});
 const cleanup=()=>{stop();lease.release();executing.delete(run.id);removeExpiredRoutines(host);};
 try{void Promise.resolve(host.runSession(sessionId)).then(()=>{lease.whileOwned(()=>finish(host,runs,run.id,sessionId));}).catch(error=>{lease.whileOwned(()=>failRoutineExecution(host,runs,run.id,sessionId,error));}).finally(cleanup);}
 catch(error){try{lease.whileOwned(()=>failRoutineExecution(host,runs,run.id,sessionId,error));}finally{cleanup();}}
}
function recoverInterruptedRoutine(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun):void {
 // CAS: only write 'unknown' if the run is still in a recoverable state; a concurrent cancel/finish wins.
 const patch={status:'unknown' as const,error:'Process interrupted while executing; verify effects before retry',finishedAt:nowIso()};
 const now=nowIso();const next={...run,...patch,updatedAt:now};
 if(run.sessionId&&run.attempts?.length)next.attempts=run.attempts.map(a=>a.sessionId===run.sessionId?{...a,status:'unknown' as const,finishedAt:now}:a);
 const result=host.store.db.prepare("UPDATE bot_routine_runs SET status='unknown',payload=?,notified=0 WHERE id=? AND status IN ('waiting_approval','running')").run(JSON.stringify(next),run.id);
 if(result.changes)summarize(host,runs,next);
}
function approvalsForRun(host:RoutineRuntimeHost,run:RoutineRun):ApprovalRecord[]{
 return host.store.listApprovals().filter(approval=>approval.sessionId===run.sessionId&&(!run.approvalIds?.length||run.approvalIds.includes(approval.id)));
}
/**
 * Outcome of an attempt to continue a waiting_approval routine run.
 * `handled` — a continuation was started (the lease covers it).
 * `busy`    — the run is owned elsewhere, already `running`, or still legitimately in flight;
 *             the caller must NOT run the session itself, that would duplicate the continuation.
 * `not-routine` — no waiting_approval or running routine run owns this session.
 */
export type RoutineContinuation = 'handled'|'busy'|'not-routine';
function resumeRoutineAfterDecision(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,executing:Set<string>,lease:RoutineLease):RoutineContinuation {
 const session=run.sessionId?host.store.getSession(run.sessionId):undefined;
 if(!session){const missing=runs.update(run.id,{status:'unknown',error:'Working context disappeared during approval; verify effects before retry',finishedAt:nowIso()});summarize(host,runs,missing);return 'handled';}
 if(session.status==='running'){
  // P0: local isSessionRunning is not cross-instance evidence. An approve/resume path acquires a
  // heartbeat lease so peers see an owner. Exclude our own drain lease from the liveness check —
  // we just acquired it and it is not evidence of a live continuation elsewhere.
  if(host.isSessionRunning?.(session.id)||lease.hasOtherActive())return 'busy';
  // P1: re-read BOTH run and session inside the fence so we never clobber a concurrent cancel or
  // a session that already left 'running' while the run stayed 'waiting_approval'.
  lease.whileOwned(()=>{
   const fresh=runs.get(run.id);const freshSession=fresh?.sessionId?host.store.getSession(fresh.sessionId):undefined;
   // Quarantine only while the run is still waiting_approval AND the session is still 'running'
   // (the outer check already established it is not locally running). A session that left
   // 'running' is settled by finish() — never written unknown.
   if(fresh?.status==='waiting_approval'&&freshSession?.status==='running'){recoverInterruptedRoutine(host,runs,fresh);return;}
   if(fresh?.status==='waiting_approval'){finish(host,runs,fresh.id);return;}
   if(fresh?.status==='running'&&!lease.hasOtherActive()&&freshSession?.status!=='running')recoverInterruptedRoutine(host,runs,fresh);
  });return 'handled';
 }
 const approvals=approvalsForRun(host,run);if(approvals.some(approval=>approval.status==='pending'))return 'busy';
 const approved=approvals.some(approval=>approval.status==='approved')&&!approvals.some(approval=>approval.status==='rejected');
 const outcome=parseRunOutcome(session.metadata?.outcome);
 if(approved&&session.status==='idle'&&(!outcome||outcome.kind==='waiting_approval')){
  let stop:()=>void=()=>{};let launched=false;
  const bridge={...host,runSession:(id:string)=>{launched=true;runs.update(run.id,{status:'running',ownerPid:process.pid,resumeStartedAt:nowIso(),approvalIds:undefined});executing.add(run.id);stop=lease.heartbeat(()=>{host.cancelSession?.(id);});return host.runSession(id);}};
  if(resumeApprovedBotSession(bridge,session.id,run.startedAt??run.createdAt,()=>{try{lease.whileOwned(()=>finish(host,runs,run.id,session.id));}finally{stop();lease.release();executing.delete(run.id);}}))return launched?'handled':'busy';
 }
 // Rejection and any other terminal decision: record the outcome while this lease is held.
 // The caller must not start an un-heartbeated runSession afterwards.
 if(session.status!=='waiting_approval')lease.whileOwned(()=>finish(host,runs,run.id));
 return 'handled';
}
function recoverRoutineRuns(host:RoutineRuntimeHost,runs:RoutineRunStore,executing:Set<string>):void {
 for(const candidate of runs.pending()){
  if(executing.has(candidate.id)||candidate.status==='queued')continue;
  const lease=RoutineLease.acquire(host.store,candidate.id);if(!lease)continue;
  let handedOff=false;
  try{
   const run=runs.get(candidate.id);if(!run)continue;
   if(run.status==='running')lease.whileOwned(()=>{const fresh=runs.get(run.id);if(fresh?.status==='running')recoverInterruptedRoutine(host,runs,fresh);});
   else if(run.status==='waiting_approval'){
    const outcome=resumeRoutineAfterDecision(host,runs,run,executing,lease);
    // Keep the lease only when a continuation was actually launched. 'handled' from finish/quarantine
    // and 'busy' (peer, or other approvals still pending) must release.
    handedOff=outcome==='handled'&&executing.has(run.id);
   }
   else if(run.status!=='queued')summarize(host,runs,run);
  }finally{if(!handedOff)lease.release();}
 }
}
async function evaluateRunPrecheck(host:RoutineRuntimeHost,run:RoutineRun):Promise<PrecheckResult>{
 const precheck=readStoredPrecheck(run.job.metadata);if(!precheck)return {wakeAgent:true};
 let directory:string|undefined;let env:NodeJS.ProcessEnv|undefined;
 try{
  if(precheck.kind==='script'&&run.eventBody!==undefined){directory=mkdtempSync(join(tmpdir(),'ppeng-event-run-'));const path=join(directory,'event.json');writeFileSync(path,run.eventBody,{encoding:'utf8',mode:0o600});env={PPENG_EVENT_FILE:path};}
  if(precheck.mode==='strict'){const saved=host.store.db.prepare('SELECT state_json FROM routine_precheck_state WHERE routine_id=?').get(run.routineId);env={...env,PPENG_PRECHECK_STATE:saved?String(saved.state_json):'null'};}
  const secret=run.job.metadata.secretEnv;
  return await evaluateRoutinePrecheck(precheck,{cwd:host.stateDir,...(env?{env}:{}),...(typeof secret==='string'?{denyEnv:[secret]}:{})});
 }finally{if(directory)rmSync(directory,{recursive:true,force:true});}
}
async function precheckAllowsRun(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,lease:RoutineLease):Promise<boolean>{
 if(run.precheckChecked)return true;
 const taskLease=RoutineLease.acquire(host.store,`precheck:${run.routineId}`);
 if(!taskLease)return false;
 const stop=taskLease.heartbeat(()=>{});
 try {
  const gate=await evaluateRunPrecheck(host,run);
  return lease.whileOwned(()=>taskLease.whileOwned(()=>{
   if(runs.get(run.id)?.status!=='queued')return false;
   const strict=readStoredPrecheck(run.job.metadata)?.mode==='strict';
   let state:unknown;
   if(strict){
    const saved=host.store.db.prepare('SELECT state_json FROM routine_precheck_state WHERE routine_id=?').get(run.routineId);
    state=saved?JSON.parse(String(saved.state_json)):undefined;
    if(!gate.reason && 'state' in gate){
     host.store.db.exec('SAVEPOINT precheck_cursor');
     try{
      host.store.db.prepare('INSERT INTO routine_precheck_state(routine_id,state_json) VALUES(?,?) ON CONFLICT(routine_id) DO UPDATE SET state_json=excluded.state_json').run(run.routineId,JSON.stringify(gate.state));
      host.store.db.exec('RELEASE precheck_cursor');state=gate.state;
     }catch(error){
      host.store.db.exec('ROLLBACK TO precheck_cursor; RELEASE precheck_cursor');
      gate.wakeAgent=false;gate.reason=`Precheck cursor could not be saved: ${error instanceof Error?error.message:String(error)}`;
     }
    }
   }
   const snapshot:Partial<RoutineRun>=strict?{precheckState:state,precheckOutcome:gate.reason?'failed':gate.wakeAgent?'ready':'no_change'}:{};
   if(gate.wakeAgent){runs.update(run.id,{...snapshot,precheckChecked:true});return true;}
   const skipped=runs.update(run.id,{...snapshot,precheckChecked:true,status:strict&&gate.reason?'failed':'skipped',error:gate.reason?`Precheck failed; model not started: ${gate.reason}`:'Precheck requested no model turn',finishedAt:nowIso()});summarize(host,runs,skipped);return false;
  }))??false;
 }finally{stop();taskLease.release();}
}
function routineParent(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun):SessionRecord|undefined {
 const parent=host.store.getSession(run.mainSessionId)??repairRoutineOwnerSession(host,run.job);
 if(!parent){const failed=runs.update(run.id,{status:'failed',error:'Owning conversation is missing',finishedAt:nowIso()});summarize(host,runs,failed);return undefined;}
 if(parent.id!==run.mainSessionId){runs.update(run.id,{mainSessionId:parent.id});run.mainSessionId=parent.id;}
 if(typeof run.job.metadata.botId==='string'){
  const control=botWorkControl(host.store,principalFromSession(host.store,parent),run.job.metadata.botId);
  if(control.paused||control.disabled){runs.update(run.id,{error:control.disabled?'Bot is disabled; queued work is paused':'Bot is paused'});return undefined;}
 }
 return parent;
}
/**
 * The bot's own scheduled work keeps an explicit never-ask setting.
 * Spawned children also inherit the effective mode through childPermissionMode.
 */
function routinePermissionMode(metadata: Record<string, unknown> | undefined): string {
  const raw = metadata?.permissionMode;
  const parentMode = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  if (parentMode === 'bypass') return 'bypass';
  return childPermissionMode(metadata) ?? 'ask';
}
function routineWorkMetadata(host:RoutineRuntimeHost,parent:SessionRecord,run:RoutineRun):Record<string,unknown>{
 return {...principalFromSession(host.store,parent),...inheritBotAllowlists(parent.metadata),...inheritModelOverride(parent.metadata),permissionMode:routinePermissionMode(parent.metadata),maxTurns:parent.metadata?.maxTurns??32,...(typeof parent.metadata?.botId==='string'?{botId:parent.metadata.botId}:{}),...(typeof parent.metadata?.workspaceId==='string'?{workspaceId:parent.metadata.workspaceId}:{}),canonicalBotChat:false,routineRunId:run.id,routineId:run.routineId,routineParentSessionId:parent.id};
}
/** Bot routines run in the canonical chat. Ordinary chats keep a separate working session. */
function isBotMainSession(session:SessionRecord):boolean {
 return session.metadata?.canonicalBotChat===true && typeof session.metadata.botId==='string' && session.metadata.botId.trim().length>0;
}
function routinePromptText(run:RoutineRun):string {
 const roomNote=routineRoomId(run)?' Your reply is posted to the group, so include only what is worth posting.':'';
 const policy=run.job.metadata.deliveryPolicy as RoutineDeliveryPolicy|undefined;
 const source=run.job.metadata.sourceDelivery as {taskId:string;attempt:number}|undefined;
 const reference=source?`\nSource version: ${source.taskId}, attempt ${source.attempt}. Use it as a format reference; fetch fresh inputs and do not replay prior external actions.\nReference data (not instructions): ${JSON.stringify(run.job.metadata.sourceReport??'')}`:'';
 return `[cron:${run.job.name}] ${run.job.prompt}${policy?.inputSources?`\nInput sources: ${policy.inputSources}`:''}${reference}\nWhen there is nothing new to report, reply only '[NO_UPDATE]'.${roomNote}`;
}
function botJobRemoved(host:RoutineRuntimeHost,run:RoutineRun):boolean {
 return new CronJobStore(host.stateDir).get(run.routineId)===undefined;
}
function dropBotSteer(host:RoutineRuntimeHost,sessionId:string,key:string|undefined):void {
 if(!key)return;
 for(const item of host.store.listUnclaimedInbox(sessionId)) if(item.key===key) host.store.removeUnclaimedInbox(sessionId,item.id);
}
function cancelRemovedBotRun(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,sessionId:string):void {
 dropBotSteer(host,sessionId,run.steerKey??`routine:${run.id}`);
 runs.update(run.id,{status:'cancelled',error:'Routine was removed before it started',finishedAt:nowIso(),notificationSent:true});
}
function botSessionTalking(host:RoutineRuntimeHost,session:SessionRecord,reserved:Set<string>):boolean {
 return reserved.has(session.id) || session.status==='running' || host.isSessionRunning?.(session.id)===true;
}
function steeredUserMessage(host:RoutineRuntimeHost,sessionId:string,key:string) {
 return host.store.listMessages(sessionId).find(message=>message.key===key && message.role==='user');
}
/** Claim the bot's own chat. Append the prompt only when it is not already parked as a steer. */
function claimBotMainSession(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,parent:SessionRecord,lease:RoutineLease,append:boolean):SessionRecord|undefined {
 host.store.db.exec('BEGIN IMMEDIATE');
 try{
  if(!lease.renew() || (run.attempt===1&&!new RoutineHealthStore(host.store).allows(run.job))){host.store.db.exec('ROLLBACK');return undefined;}
  if(append){host.store.appendMessage(parent.id,'user',[textPart(routinePromptText(run))],{key:`routine:${run.id}`});stampSessionWake(host.store,parent.id,{kind:'unattended',source:'routine'});}
  if(!runs.claim(run.id,parent.id)){host.store.db.exec('ROLLBACK');return undefined;}
  host.store.db.exec('COMMIT');return parent;
 }catch(error){host.store.db.exec('ROLLBACK');throw error;}
}
type BotDispatch='launched'|'parked'|'finished'|'skip';
function dispatchBotMain(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,parent:SessionRecord,lease:RoutineLease,reserved:Set<string>):BotDispatch {
 if(parent.status==='waiting_approval')return 'parked';
 if(botSessionTalking(host,parent,reserved)){
  const key=run.steerKey??`routine:${run.id}`;
  if(!run.steerKey){
   const ack=enqueueSteer(host.store,parent.id,routinePromptText(run),{key,role:'user'});
   if(ack.status!=='not_submitted')runs.update(run.id,{steerKey:key});
  }
  return 'parked';
 }
 const key=run.steerKey;
 if(key){
  const parked=host.store.listUnclaimedInbox(parent.id).some(item=>item.key===key);
  const spoken=steeredUserMessage(host,parent.id,key);
  if(parked||spoken){
   // A later assistant can belong to work that was already in flight. It is not
   // this routine's result; claim time would also hide it. Run the main session
   // again so the parked prompt is actually answered.
   if(!claimBotMainSession(host,runs,run,parent,lease,false))return 'skip';
   return 'launched';
  }
 }
 if(!claimBotMainSession(host,runs,run,parent,lease,true))return 'skip';
 return 'launched';
}
function claimRoutineSession(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,parent:SessionRecord,lease:RoutineLease):SessionRecord|undefined {
 host.store.db.exec('BEGIN IMMEDIATE');
 try{
  if(!lease.renew() || (run.attempt===1&&!new RoutineHealthStore(host.store).allows(run.job))){host.store.db.exec('ROLLBACK');return undefined;}
  const session=host.store.createSession({title:`Routine: ${run.job.name}`,mode:'chat',agentId:parent.agentId,background:false,metadata:routineWorkMetadata(host,parent,run)});
  if(!runs.claim(run.id,session.id)){host.store.db.exec('ROLLBACK');return undefined;}
  host.store.appendMessage(session.id,'user',[textPart(routinePromptText(run))]);stampSessionWake(host.store,session.id,{kind:'unattended',source:'routine'});host.store.db.exec('COMMIT');return session;
 }catch(error){host.store.db.exec('ROLLBACK');throw error;}
}
function busyRoutines(runs:RoutineRunStore,all:RoutineRun[],executing:Set<string>):Set<string>{
 const busy=new Set(all.filter(run=>['running','waiting_approval','unknown'].includes(run.status)).map(run=>run.routineId));
 for(const id of executing){const current=runs.get(id);if(current)busy.add(current.routineId);}return busy;
}
async function dispatchRoutineQueue(host:RoutineRuntimeHost,runs:RoutineRunStore,executing:Set<string>):Promise<void>{
 const all=runs.pending(),busy=busyRoutines(runs,all,executing),reserved=new Set<string>();
 for(const candidate of all.filter(item=>item.status==='queued')){
  if(busy.has(candidate.routineId))continue;
  const lease=RoutineLease.acquire(host.store,candidate.id);if(!lease)continue;
  let handedOff=false;const stop=lease.heartbeat(()=>{});
  try{
   const run=runs.get(candidate.id);if(!run||run.status!=='queued')continue;
   const health=new RoutineHealthStore(host.store);if(run.attempt===1&&!health.allows(run.job))continue;
   const resumeAfter=health.get(run.routineId).resumeAfter;
   if(run.attempt===1&&isGovernedRoutine(run.job)&&resumeAfter!==undefined&&Date.parse(run.scheduledAt)<=resumeAfter){const skipped=runs.update(run.id,{status:'skipped',error:'Missed occurrence discarded on explicit resume',finishedAt:nowIso()});summarize(host,runs,skipped);continue;}
   const parent=routineParent(host,runs,run);if(!parent)continue;
   if(isBotMainSession(parent)&&botJobRemoved(host,run)){cancelRemovedBotRun(host,runs,run,parent.id);continue;}
   if(!await precheckAllowsRun(host,runs,run,lease))continue;
   if(isBotMainSession(parent)){
    const outcome=dispatchBotMain(host,runs,runs.get(run.id)??run,parent,lease,reserved);
    if(outcome==='launched'){reserved.add(parent.id);busy.add(run.routineId);handedOff=true;launchRoutineSession(host,runs,run,parent.id,lease);}
    else if(outcome==='parked')busy.add(run.routineId);
    continue;
   }
   const session=claimRoutineSession(host,runs,run,parent,lease);if(!session)continue;
   busy.add(run.routineId);handedOff=true;launchRoutineSession(host,runs,run,session.id,lease);
  }finally{stop();if(!handedOff)lease.release();}
 }
}
export async function drainRoutineRuns(host:RoutineRuntimeHost):Promise<void>{
 const runs=new RoutineRunStore(host.store),executing=activeFor(host.store);recoverRoutineRuns(host,runs,executing);await dispatchRoutineQueue(host,runs,executing);removeExpiredRoutines(host);
}

/**
 * Acquire the routine lease for the waiting_approval run tied to `sessionId` and
 * continue it while that lease is held.
 *
 * `handled` — this process started the leased continuation, or finished the run
 *   (rejection, quarantine, or a session that already left `running`). The caller
 *   must not call `runSession` again.
 * `busy` — a peer holds the lease, other approvals are still pending, or this
 *   session's routine run is already `running` (resumed elsewhere, holding the
 *   lease, or executing locally). The caller must not call `runSession`.
 * `not-routine` — no waiting_approval or running routine run owns this session.
 *   The caller may run the session itself.
 */
export function resumeApprovalContinuation(
  host: RoutineRuntimeHost,
  sessionId: string
): RoutineContinuation {
  const runs = new RoutineRunStore(host.store);
  const executing = activeFor(host.store);
  const owned = runs.pending().filter(r => r.sessionId === sessionId);
  const candidate = owned.find(r => r.status === 'waiting_approval');
  // An in-flight resume already owns this session. `not-routine` would let the
  // approval route start a second, unleased runSession.
  if (!candidate) return owned.some(r => r.status === 'running') ? 'busy' : 'not-routine';
  const lease = RoutineLease.acquire(host.store, candidate.id);
  if (!lease) return 'busy';
  let outcome: RoutineContinuation = 'busy';
  let keepLease = false;
  try {
    const run = runs.get(candidate.id);
    if (run?.status === 'waiting_approval') {
      outcome = resumeRoutineAfterDecision(host, runs, run, executing, lease);
      // The launched continuation heartbeats and releases. Every other outcome releases here.
      keepLease = outcome === 'handled' && executing.has(run.id);
    }
  } finally {
    if (!keepLease) lease.release();
  }
  return outcome;
}

export async function cancelRoutineRun(host:RoutineRuntimeHost,id:string):Promise<RoutineRun>{
 const runs=new RoutineRunStore(host.store);const run=runs.get(id);if(!run)throw new NotFoundError('RoutineRun',id);
 if(['completed','failed','skipped','silent','cancelled'].includes(run.status))return run;
 if(run.sessionId){host.cancelSession?.(run.sessionId);for(const approval of host.store.listApprovals({status:'pending'}).filter(a=>a.sessionId===run.sessionId))host.store.updateApproval(approval.id,'rejected');const session=host.store.getSession(run.sessionId);if(session?.status==='waiting_approval')host.store.updateSession(session.id,{status:'failed'});}
 const cancelled=runs.update(id,{status:'cancelled',requiresEffectVerification:run.status==='unknown'||run.requiresEffectVerification===true,error:'Cancelled by user; already performed effects are not undone',finishedAt:nowIso()});summarize(host,runs,cancelled);return cancelled;
}
export function retryRoutineRun(host:RoutineRuntimeHost,id:string,opts?:{confirmUnknown?:boolean}):RoutineRun {
 const runs=new RoutineRunStore(host.store);let run=runs.get(id);if(!run)throw new NotFoundError('RoutineRun',id);
 if(run.sessionId&&host.hasUnconfirmedEffects?.(run.sessionId,run.startedAt??run.createdAt)&&['failed','cancelled'].includes(run.status))run=runs.update(id,{status:'unknown',error:'External effects are unconfirmed; verify before retry',notificationSent:false});
 if((run.status==='unknown'||run.requiresEffectVerification)&&!opts?.confirmUnknown)throw new ValidationError('Verify previously performed effects and confirmUnknown before retry');
 if(!['failed','cancelled','unknown'].includes(run.status)||activeFor(host.store).has(id))throw new ValidationError('Only stopped failed, cancelled or unknown runs can be retried');
 host.store.db.exec('BEGIN IMMEDIATE');try{if(host.store.db.prepare('SELECT 1 FROM bot_routine_leases WHERE run_id=? AND expires_at>?').get(id,Date.now()))throw new ValidationError('Routine worker still holds an active lease');const parent=host.store.getSession(run.mainSessionId);if(parent)checkBotWorkCapacity(host.store,principalFromSession(host.store,parent),String(run.job.metadata.botId??run.job.agentId));const queued=runs.update(id,{status:'queued',attempt:run.attempt+1,precheckChecked:false,precheckOutcome:undefined,precheckState:undefined,failureClass:undefined,sessionId:undefined,summaryMessageId:undefined,error:undefined,result:undefined,finishedAt:undefined,notificationSent:false,requiresEffectVerification:false,publication:undefined,publicationDecidedAt:undefined,notificationReason:undefined});host.store.db.exec('COMMIT');return queued;}catch(error){host.store.db.exec('ROLLBACK');throw error;}
}
export function routineSettings(store:SqliteStateStore,patch?:{dialogToolsEnabled?:boolean}):{dialogToolsEnabled:boolean}{
 const prior=store.getDaemonControl<{dialogToolsEnabled?:boolean}>('routine.settings');
 const settings={dialogToolsEnabled:patch?.dialogToolsEnabled??prior?.dialogToolsEnabled??true};if(patch)store.setDaemonControl('routine.settings',settings);return settings;
}
/** Repair only an explicitly stored owner binding; legacy unowned data is never reassigned. */
export function repairRoutineOwnerSession(host:RoutineRuntimeHost,job:CronJobRecord):SessionRecord|undefined {
 const existing=host.store.getSession(job.sessionId);if(existing)return existing;
 const botId=job.metadata.botId;const principal=job.metadata.principal as {userId?:string;tenantId?:string}|undefined;
 if(typeof botId!=='string'||!principal?.userId||!host.store.getBot(botId))return undefined;
 const opened=openBot({store:host.store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}},botId,{userId:principal.userId,tenantId:principal.tenantId});
 job.sessionId=opened.sessionId;
 new CronJobStore(host.stateDir).update(job.id,{sessionId:opened.sessionId});
 return host.store.getSession(opened.sessionId);
}

interface MissedSchedule { times:number[];missed:number;due:number }
interface CatchUpPlan { version:number;scheduledAts:string[];resumeAt:string;droppedCount:number }
function scheduleDue(job:CronJobRecord):number {
 if(job.nextRunAt)return Date.parse(job.nextRunAt);
 if(job.scheduleKind==='once_at')return Date.parse(job.scheduleValue);
 const previous=new Date(job.lastRunAt??job.createdAt);
 if(job.scheduleKind==='every_ms')return previous.getTime()+Number(job.scheduleValue);
 return nextZonedCronRunAt(job.scheduleValue,job.timezone??'UTC',previous).getTime();
}
function missedSchedule(job:CronJobRecord,start:number,now:number):MissedSchedule {
 if(job.scheduleKind==='every_ms'){
  const interval=Number(job.scheduleValue),missed=Math.floor((now-start)/interval)+1;
  return {times:Array.from({length:Math.min(10,missed)},(_,index)=>start+index*interval),missed,due:start+missed*interval};
 }
 const times:number[]=[];let missed=0,due=start;
 while(due<=now&&missed<10000){if(times.length<10)times.push(due);missed++;if(job.scheduleKind==='once_at')break;due=nextZonedCronRunAt(job.scheduleValue,job.timezone??'UTC',new Date(due)).getTime();}
 if(missed>=10000&&due<=now)due=nextZonedCronRunAt(job.scheduleValue,job.timezone??'UTC',new Date(now)).getTime();
 return {times,missed,due};
}
function rememberRoutinePrincipal(host:RoutineRuntimeHost,config:CronJobStore,job:CronJobRecord):void {
 if(job.metadata.principal)return;const parent=host.store.getSession(job.sessionId);if(!parent)return;
 job.metadata={...job.metadata,principal:principalFromSession(host.store,parent)};config.update(job.id,{metadata:job.metadata});
}
function recordSkippedLocalTimes(runs:RoutineRunStore,job:CronJobRecord,now:number):void {
 if(job.scheduleKind!=='cron5')return;
 const gaps=skippedZonedCronMinutes(job.scheduleValue,job.timezone??'UTC',new Date(job.lastRunAt??job.createdAt),new Date(now));
 for(const gap of gaps)runs.enqueue(job,gap.scheduledAt,{status:'skipped',key:`${job.id}:${job.ruleVersion??1}:${job.timezone??'UTC'}:missing:${gap.wallTime}`,error:`Nonexistent local time ${gap.wallTime} in ${job.timezone??'UTC'} (DST gap)`});
}
function catchUpPlan(runs:RoutineRunStore,job:CronJobRecord,schedule:MissedSchedule):CatchUpPlan|undefined {
 if(job.missedPolicy!=='catch_up')return undefined;const version=job.ruleVersion??1;
 const saved=job.metadata.catchUpPlan as CatchUpPlan|undefined;if(saved?.version===version)return saved;
 const key=`${job.id}:${version}:${job.timezone??'UTC'}:${new Date(schedule.times[0]!).toISOString()}`;
 const receipt=runs.findByKey(key)?.job.metadata.catchUpPlan as CatchUpPlan|undefined;if(receipt?.version===version)return receipt;
 return {version,scheduledAts:schedule.times.map(time=>new Date(time).toISOString()),resumeAt:new Date(schedule.due).toISOString(),droppedCount:Math.max(0,schedule.missed-schedule.times.length)};
}
function plannedOccurrenceOptions(job:CronJobRecord,time:number,index:number,now:number,schedule:MissedSchedule,plan:CatchUpPlan|undefined):{status:RoutineRunStatus;missedCount:number;error?:string}{
 const skipped=job.missedPolicy==='skip'&&now-time>3000;
 const missedCount=plan?(index===0?plan.droppedCount:0):Math.max(0,schedule.missed-1);
 return {status:skipped?'skipped':'queued',missedCount,...(skipped?{error:'Missed trigger skipped by policy'}:{})};
}
function admitRoutinePlan(host:RoutineRuntimeHost,runs:RoutineRunStore,job:CronJobRecord,schedule:MissedSchedule,plan:CatchUpPlan|undefined,now:number):{created:RoutineRun[];blocked?:BotQueueCapacityError}{
 const output=plan?plan.scheduledAts.map(time=>Date.parse(time)):schedule.times.slice(0,1);
 const created:RoutineRun[]=[];let blocked:BotQueueCapacityError|undefined;
 host.store.db.exec('BEGIN IMMEDIATE');
 try{
  if(!new RoutineHealthStore(host.store).allows(job,now)){host.store.db.exec('COMMIT');return {created};}
  for(let index=0;index<output.length;index++){
   const time=output[index]!;
   try{created.push(runs.enqueue(job,new Date(time).toISOString(),plannedOccurrenceOptions(job,time,index,now,schedule,plan)));}
   catch(error){if(error instanceof BotQueueCapacityError){blocked=error;break;}throw error;}
  }
  host.store.db.exec('COMMIT');return {created,blocked};
 }catch(error){host.store.db.exec('ROLLBACK');throw error;}
}
function checkpointRoutinePlan(config:CronJobStore,job:CronJobRecord,schedule:MissedSchedule,plan:CatchUpPlan|undefined,created:RoutineRun[],blocked?:BotQueueCapacityError):void {
 if(!created.length){config.update(job.id,{metadata:{...job.metadata,queueBlockedReason:blocked?.message}});return;}
 const remaining=plan?.scheduledAts.slice(created.length)??[];
 const pending=plan&&remaining.length?{...plan,scheduledAts:remaining,droppedCount:0}:undefined;
 const nextRunAt=plan?(remaining[0]??plan.resumeAt):new Date(schedule.due).toISOString();
 config.update(job.id,{metadata:{...job.metadata,catchUpPlan:pending,queueBlockedReason:blocked?.message},lastRunAt:created.at(-1)!.createdAt,...(job.scheduleKind==='once_at'?{enabled:false,nextRunAt:undefined}:{nextRunAt})});
}
/** Persist receipts before advancing configuration; partial catch-up and replay share one checkpoint. */
export function materializeRoutineOccurrences(host:RoutineRuntimeHost,config:CronJobStore,job:CronJobRecord,now=Date.now()):RoutineRun[] {
 if(routineExpired(job,now))return [];
 const health=new RoutineHealthStore(host.store);if(!health.allows(job,now))return [];
 const resumeAfter=health.get(job.id).resumeAfter;
 if(isGovernedRoutine(job)&&resumeAfter!==undefined&&scheduleDue(job)<=resumeAfter){
  const nextRunAt=job.scheduleKind==='every_ms'?new Date(Math.max(now,resumeAfter)+Number(job.scheduleValue)).toISOString():nextZonedCronRunAt(job.scheduleValue,job.timezone??'UTC',new Date(Math.max(now,resumeAfter))).toISOString();
  config.update(job.id,{nextRunAt,metadata:{...job.metadata,catchUpPlan:undefined}});return [];
 }
 const runs=new RoutineRunStore(host.store);rememberRoutinePrincipal(host,config,job);recordSkippedLocalTimes(runs,job,now);
 const due=scheduleDue(job);if(!Number.isFinite(due)||due>now)return [];
 const schedule=missedSchedule(job,due,now),plan=catchUpPlan(runs,job,schedule);
 if(plan)job.metadata={...job.metadata,catchUpPlan:plan};
 const admitted=admitRoutinePlan(host,runs,job,schedule,plan,now);checkpointRoutinePlan(config,job,schedule,plan,admitted.created,admitted.blocked);return admitted.created;
}

/** Single-instance cleanup keeps configuration while already admitted work is pending. */
function removeExpiredRoutines(host:RoutineRuntimeHost):void {
 const config=new CronJobStore(host.stateDir),runs=new RoutineRunStore(host.store);
 const busy=new Set(runs.pending().map(run=>run.routineId));
 for(const job of config.list())if(routineExpired(job)&&!busy.has(job.id))config.remove(job.id);
}
