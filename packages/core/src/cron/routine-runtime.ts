/** Durable occurrence ledger. Configuration and individual execution have independent lifecycles. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteStateStore } from '../storage.js';
import { createId, nowIso } from '../id.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ApprovalRecord, SessionRecord } from '../types.js';
import { childPermissionMode, inheritBotAllowlists, inheritModelOverride } from '../runtime/spawn-policy.js';
import { textPart } from '../runtime/session-facade.js';
import { stampSessionWake } from '../approval/unattended-approval.js';
import { parseRunOutcome } from '../session/run-outcome.js';
import { assistantTextsFromFold } from '../session/visible-assistant.js';
import { BotQueueCapacityError, checkBotWorkCapacity, botWorkControl, resumeApprovedBotSession } from '../bots/bot-work.js';
import { openBot } from '../bots/bot-facade.js';
import { principalFromSession } from '../bots/bot-identity.js';
import { CronJobStore, type CronJobRecord } from './cron-store.js';
import { evaluateRoutinePrecheck, readStoredPrecheck } from './routine-precheck.js';
import { nextZonedCronRunAt, skippedZonedCronMinutes } from './cron-next.js';
export type RoutineRunStatus = 'queued'|'running'|'waiting_approval'|'completed'|'failed'|'cancelled'|'unknown'|'skipped';
export interface RoutineAttempt { number:number;sessionId:string;startedAt:string;finishedAt?:string;status:RoutineRunStatus;result?:string;error?:string }
export interface RoutineRun {
 id:string; routineId:string; scheduledAt:string; timezone:string; status:RoutineRunStatus;
 approvalIds?:string[];resumeStartedAt?:string; attempts?:RoutineAttempt[]; sessionId?:string; mainSessionId:string; attempt:number; result?:string; error?:string;
 precheckChecked?:boolean; missedCount:number; createdAt:string; updatedAt:string; startedAt?:string; finishedAt?:string; ownerPid?:number;
 eventBody?:string; notificationSent?:boolean; requiresEffectVerification?:boolean; job:CronJobRecord;
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
  const activeRows=this.store.db.prepare("SELECT rowid AS sequence,payload FROM bot_routine_runs WHERE routine_id=? AND status IN ('queued','running','waiting_approval','unknown') ORDER BY rowid DESC").all(routineId);
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
function summarize(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun):void {
 if(run.notificationSent)return;
 const parent=host.store.getSession(run.mainSessionId)??repairRoutineOwnerSession(host,run.job);
 if(parent&&parent.id!==run.mainSessionId){runs.update(run.id,{mainSessionId:parent.id});run.mainSessionId=parent.id;}
 if(!parent){runs.update(run.id,{notificationSent:true});return;}
 if(parent.status==='running'||parent.status==='waiting_approval'||host.isSessionRunning?.(parent.id))return;
 const description=run.result||run.error||run.status;
 // Insert the summary and notification marker atomically. No user instruction or private run transcript.
 host.store.db.exec('BEGIN IMMEDIATE');
 try { const fresh=runs.get(run.id);if(fresh?.notificationSent){host.store.db.exec('COMMIT');return;}
 host.store.appendMessage(run.mainSessionId,'assistant',[textPart(`[routine:${run.job.name}] ${run.status}\n${description.slice(0,2000)}\nRun: ${run.id}${run.sessionId?` · /api/sessions/${run.sessionId}`:''}`)]);
 runs.update(run.id,{notificationSent:true});host.store.db.exec('COMMIT');
 }catch(error){host.store.db.exec('ROLLBACK');throw error;}
}
function resultText(host:RoutineRuntimeHost,id:string):string {return assistantTextsFromFold(host.store,id).at(-1)?.slice(0,16000)??'';}
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
function completionError(session:SessionRecord|undefined,denied:boolean,result:string):string {
 if(denied)return 'Approval denied or expired';const outcome=parseRunOutcome(session?.metadata?.outcome);
 if(outcome?.reason)return `Execution stopped: ${outcome.reason}`;
 return result.trim()?'Session did not complete':'Execution ended without a result';
}
function completionResult(host:RoutineRuntimeHost,run:RoutineRun,session:SessionRecord|undefined,approvals:ApprovalRecord[]):Partial<RoutineRun>{
 const result=run.sessionId?resultText(host,run.sessionId):'';
 if(unknownEffects(host,run))return {status:'unknown',result,error:'External effects are unconfirmed; verify before retry'};
 const denied=approvals.some(approval=>approval.status==='rejected');const outcome=parseRunOutcome(session?.metadata?.outcome);
 const stopped=outcome?.kind==='aborted'||outcome?.kind==='failed'||(outcome?.kind==='idle'&&outcome.reason!=='end');
 const failed=stopped||!session||!['idle','completed'].includes(session.status)||denied||!result.trim();
 return failed?{status:'failed',result,error:completionError(session,denied,result)}:{status:'completed',result};
}
function finish(host:RoutineRuntimeHost,runs:RoutineRunStore,id:string,expectedSessionId?:string):void {
 const run=runs.get(id);if(!run||(expectedSessionId&&run.sessionId!==expectedSessionId))return;
 if(run.status==='cancelled'&&unknownEffects(host,run)){const corrected=runs.update(id,{...completionResult(host,run,run.sessionId?host.store.getSession(run.sessionId):undefined,[]),notificationSent:false});summarize(host,runs,corrected);return;}
 if(!['running','waiting_approval'].includes(run.status))return;
 const session=run.sessionId?host.store.getSession(run.sessionId):undefined;
 const approvals=host.store.listApprovals().filter(approval=>approval.sessionId===run.sessionId);
 if(isWaitingForDecision(session,approvals)){runs.update(id,{status:'waiting_approval',approvalIds:approvalCheckpoint(approvals)});return;}
 if(session?.status==='running')return;
 const completed=runs.update(id,{...completionResult(host,run,session,approvals),finishedAt:nowIso()});summarize(host,runs,completed);
}
function failRoutineExecution(host:RoutineRuntimeHost,runs:RoutineRunStore,id:string,sessionId:string,error:unknown):void {
 const current=runs.get(id);if(!current||current.sessionId!==sessionId)return;
 const unconfirmed=unknownEffects(host,current);
 if(!['running','waiting_approval'].includes(current.status)&&!(current.status==='cancelled'&&unconfirmed))return;
 const reason=error instanceof Error?error.message:String(error);
 const failed=runs.update(id,{status:unconfirmed?'unknown':'failed',error:unconfirmed?'External effects are unconfirmed; verify before retry':reason,finishedAt:nowIso()});summarize(host,runs,failed);
}
function launchRoutineSession(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,sessionId:string):void {
 const executing=activeFor(host.store);executing.add(run.id);
 try{void Promise.resolve(host.runSession(sessionId)).then(()=>finish(host,runs,run.id,sessionId)).catch(error=>failRoutineExecution(host,runs,run.id,sessionId,error)).finally(()=>executing.delete(run.id));}
 catch(error){executing.delete(run.id);failRoutineExecution(host,runs,run.id,sessionId,error);}
}
function recoverInterruptedRoutine(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun):void {
 if(run.ownerPid&&run.ownerPid!==process.pid){try{process.kill(run.ownerPid,0);return;}catch{/* previous worker is gone */}}
 const interrupted=runs.update(run.id,{status:'unknown',error:'Process interrupted while executing; verify effects before retry',finishedAt:nowIso()});summarize(host,runs,interrupted);
}
function approvalsForRun(host:RoutineRuntimeHost,run:RoutineRun):ApprovalRecord[]{
 return host.store.listApprovals().filter(approval=>approval.sessionId===run.sessionId&&(!run.approvalIds?.length||run.approvalIds.includes(approval.id)));
}
function resumeRoutineAfterDecision(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,executing:Set<string>):void {
 const session=run.sessionId?host.store.getSession(run.sessionId):undefined;
 if(!session){const missing=runs.update(run.id,{status:'unknown',error:'Working context disappeared during approval; verify effects before retry',finishedAt:nowIso()});summarize(host,runs,missing);return;}
 if(session.status==='running'){
  if(host.isSessionRunning?.(session.id)===false){const interrupted=runs.update(run.id,{status:'unknown',error:'Approval continuation was interrupted; verify effects before retry',finishedAt:nowIso()});summarize(host,runs,interrupted);}return;
 }
 const approvals=approvalsForRun(host,run);if(approvals.some(approval=>approval.status==='pending'))return;
 const approved=approvals.some(approval=>approval.status==='approved')&&!approvals.some(approval=>approval.status==='rejected');
 const outcome=parseRunOutcome(session?.metadata?.outcome);
 if(approved&&session?.status==='idle'&&(!outcome||outcome.kind==='waiting_approval')){
  const bridge={...host,runSession:(id:string)=>{runs.update(run.id,{status:'running',ownerPid:process.pid,resumeStartedAt:nowIso(),approvalIds:undefined});executing.add(run.id);return host.runSession(id);}};
  if(resumeApprovedBotSession(bridge,session.id,run.startedAt??run.createdAt,()=>{try{finish(host,runs,run.id,session.id);}finally{executing.delete(run.id);}}))return;
 }
 if(session?.status!=='waiting_approval')finish(host,runs,run.id);
}
function recoverRoutineRuns(host:RoutineRuntimeHost,runs:RoutineRunStore,executing:Set<string>):void {
 for(const run of runs.pending()){
  if(executing.has(run.id))continue;
  if(run.status==='running')recoverInterruptedRoutine(host,runs,run);
  else if(run.status==='waiting_approval')resumeRoutineAfterDecision(host,runs,run,executing);
  else if(run.status!=='queued')summarize(host,runs,run);
 }
}
async function evaluateRunPrecheck(host:RoutineRuntimeHost,run:RoutineRun):Promise<{wakeAgent:boolean;reason?:string}>{
 const precheck=readStoredPrecheck(run.job.metadata);if(!precheck)return {wakeAgent:true};
 let directory:string|undefined;let env:NodeJS.ProcessEnv|undefined;
 try{
  if(precheck.kind==='script'&&run.eventBody!==undefined){directory=mkdtempSync(join(tmpdir(),'ppeng-event-run-'));const path=join(directory,'event.json');writeFileSync(path,run.eventBody,{encoding:'utf8',mode:0o600});env={PPENG_EVENT_FILE:path};}
  const secret=run.job.metadata.secretEnv;
  return await evaluateRoutinePrecheck(precheck,{cwd:host.stateDir,...(env?{env}:{}),...(typeof secret==='string'?{denyEnv:[secret]}:{})});
 }finally{if(directory)rmSync(directory,{recursive:true,force:true});}
}
async function precheckAllowsRun(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun):Promise<boolean>{
 if(run.precheckChecked)return true;const gate=await evaluateRunPrecheck(host,run);
 if(gate.wakeAgent){runs.update(run.id,{precheckChecked:true});return true;}
 const skipped=runs.update(run.id,{precheckChecked:true,status:'skipped',error:gate.reason?`Precheck failed; model not started: ${gate.reason}`:'Precheck requested no model turn',finishedAt:nowIso()});summarize(host,runs,skipped);return false;
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
function routineWorkMetadata(host:RoutineRuntimeHost,parent:SessionRecord,run:RoutineRun):Record<string,unknown>{
 return {...principalFromSession(host.store,parent),...inheritBotAllowlists(parent.metadata),...inheritModelOverride(parent.metadata),permissionMode:childPermissionMode(parent.metadata)??'ask',maxTurns:parent.metadata?.maxTurns??32,...(typeof parent.metadata?.botId==='string'?{botId:parent.metadata.botId}:{}),...(typeof parent.metadata?.workspaceId==='string'?{workspaceId:parent.metadata.workspaceId}:{}),canonicalBotChat:false,routineRunId:run.id,routineId:run.routineId,routineParentSessionId:parent.id};
}
function claimRoutineSession(host:RoutineRuntimeHost,runs:RoutineRunStore,run:RoutineRun,parent:SessionRecord):SessionRecord|undefined {
 host.store.db.exec('BEGIN IMMEDIATE');
 try{
  const session=host.store.createSession({title:`Routine: ${run.job.name}`,mode:'chat',agentId:parent.agentId,background:false,metadata:routineWorkMetadata(host,parent,run)});
  if(!runs.claim(run.id,session.id)){host.store.db.exec('ROLLBACK');return undefined;}
  host.store.appendMessage(session.id,'user',[textPart(`[cron:${run.job.name}] ${run.job.prompt}`)]);stampSessionWake(host.store,session.id,{kind:'unattended',source:'routine'});host.store.db.exec('COMMIT');return session;
 }catch(error){host.store.db.exec('ROLLBACK');throw error;}
}
function busyRoutines(runs:RoutineRunStore,all:RoutineRun[],executing:Set<string>):Set<string>{
 const busy=new Set(all.filter(run=>['running','waiting_approval','unknown'].includes(run.status)).map(run=>run.routineId));
 for(const id of executing){const current=runs.get(id);if(current)busy.add(current.routineId);}return busy;
}
async function dispatchRoutineQueue(host:RoutineRuntimeHost,runs:RoutineRunStore,executing:Set<string>):Promise<void>{
 const all=runs.pending(),busy=busyRoutines(runs,all,executing);
 for(const run of all.filter(item=>item.status==='queued')){
  if(busy.has(run.routineId))continue;const parent=routineParent(host,runs,run);if(!parent)continue;
  if(!await precheckAllowsRun(host,runs,run))continue;const session=claimRoutineSession(host,runs,run,parent);if(!session)continue;
  busy.add(run.routineId);launchRoutineSession(host,runs,run,session.id);
 }
}
export async function drainRoutineRuns(host:RoutineRuntimeHost):Promise<void>{
 const runs=new RoutineRunStore(host.store),executing=activeFor(host.store);recoverRoutineRuns(host,runs,executing);await dispatchRoutineQueue(host,runs,executing);
}

export async function cancelRoutineRun(host:RoutineRuntimeHost,id:string):Promise<RoutineRun>{
 const runs=new RoutineRunStore(host.store);const run=runs.get(id);if(!run)throw new NotFoundError('RoutineRun',id);
 if(['completed','failed','skipped','cancelled'].includes(run.status))return run;
 if(run.sessionId){host.cancelSession?.(run.sessionId);for(const approval of host.store.listApprovals({status:'pending'}).filter(a=>a.sessionId===run.sessionId))host.store.updateApproval(approval.id,'rejected');const session=host.store.getSession(run.sessionId);if(session?.status==='waiting_approval')host.store.updateSession(session.id,{status:'failed'});}
 const cancelled=runs.update(id,{status:'cancelled',requiresEffectVerification:run.status==='unknown'||run.requiresEffectVerification===true,error:'Cancelled by user; already performed effects are not undone',finishedAt:nowIso()});summarize(host,runs,cancelled);return cancelled;
}
export function retryRoutineRun(host:RoutineRuntimeHost,id:string,opts?:{confirmUnknown?:boolean}):RoutineRun {
 const runs=new RoutineRunStore(host.store);let run=runs.get(id);if(!run)throw new NotFoundError('RoutineRun',id);
 if(run.sessionId&&host.hasUnconfirmedEffects?.(run.sessionId,run.startedAt??run.createdAt)&&['failed','cancelled'].includes(run.status))run=runs.update(id,{status:'unknown',error:'External effects are unconfirmed; verify before retry',notificationSent:false});
 if((run.status==='unknown'||run.requiresEffectVerification)&&!opts?.confirmUnknown)throw new ValidationError('Verify previously performed effects and confirmUnknown before retry');
 if(!['failed','cancelled','unknown'].includes(run.status)||activeFor(host.store).has(id))throw new ValidationError('Only stopped failed, cancelled or unknown runs can be retried');
 host.store.db.exec('BEGIN IMMEDIATE');try{const parent=host.store.getSession(run.mainSessionId);if(parent)checkBotWorkCapacity(host.store,principalFromSession(host.store,parent),String(run.job.metadata.botId??run.job.agentId));const queued=runs.update(id,{status:'queued',attempt:run.attempt+1,sessionId:undefined,error:undefined,result:undefined,finishedAt:undefined,notificationSent:false,requiresEffectVerification:false});host.store.db.exec('COMMIT');return queued;}catch(error){host.store.db.exec('ROLLBACK');throw error;}
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
 const runs=new RoutineRunStore(host.store);rememberRoutinePrincipal(host,config,job);recordSkippedLocalTimes(runs,job,now);
 const due=scheduleDue(job);if(!Number.isFinite(due)||due>now)return [];
 const schedule=missedSchedule(job,due,now),plan=catchUpPlan(runs,job,schedule);
 if(plan)job.metadata={...job.metadata,catchUpPlan:plan};
 const admitted=admitRoutinePlan(host,runs,job,schedule,plan,now);checkpointRoutinePlan(config,job,schedule,plan,admitted.created,admitted.blocked);return admitted.created;
}
