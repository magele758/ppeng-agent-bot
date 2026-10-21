import type { KernelHookListener } from '@ppeng/agent-loop';
import type { SqliteStateStore } from '../storage.js';
import { checkBotWorkCapacity } from '../bots/bot-work.js';
import { principalFromSession } from '../bots/bot-identity.js';
import { INBOX_OVERFLOW_KEY } from './inbox-overflow.js';
import type { InboxItem } from './step-inbox.js';
import { parseRunOutcome } from './run-outcome.js';

const PREFIX='session.humanContinuation:';
interface HumanRequest { id:string; seq:number; kind?:'steer'; text?:string; role?:string; key?:string; summaryId?:string; summarySeqFloor?:number; deliveryKey?:string; deliverySeqFloor?:number; }
interface ContinuationState { pending:HumanRequest[]; blockedReason?:string; }
const key=(id:string)=>PREFIX+id;
function state(store:SqliteStateStore,id:string):ContinuationState{return store.getDaemonControl<ContinuationState>(key(id))??{pending:[]};}
function transaction<T>(store:SqliteStateStore,execute:()=>T):T {
 const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');
 try{const result=execute();if(own)store.db.exec('COMMIT');return result;}
 catch(error){if(own)store.db.exec('ROLLBACK');throw error;}
}
function updateState(store:SqliteStateStore,id:string,change:(current:ContinuationState)=>ContinuationState):void {
 transaction(store,()=>{const current=state(store,id),next=change(current);if(next!==current)store.setDaemonControl(key(id),next);});
}
/** Only explicit human auto-run requests enter this ledger; raw appended history does not. */
export function requestHumanRun(store:SqliteStateStore,sessionId:string):void {
 updateState(store,sessionId,current=>{
  const row=store.db.prepare("SELECT id,seq FROM session_messages WHERE session_id=? AND role='user' ORDER BY seq DESC LIMIT 1").get(sessionId) as HumanRequest|undefined;
  const pending=[...current.pending];if(row&&!pending.some(request=>request.id===row.id))pending.push({id:row.id,seq:Number(row.seq)});
  return {...current,pending,blockedReason:undefined};
 });
}
/** Intake uses the same SQLite transaction for capacity, raw append, and its receipt. */
export function withHumanContinuationAdmission<T>(store:SqliteStateStore,sessionId:string,accept:()=>T):T {
 return transaction(store,()=>{
  const session=store.getSession(sessionId);if(!session)return accept();
  const explicit=typeof session.metadata.botId==='string'?session.metadata.botId.trim():'';
  const botId=explicit||(store.getBot(session.agentId)??store.listBots().find(bot=>bot.agentId===session.agentId))?.id;
  if(botId)checkBotWorkCapacity(store,principalFromSession(store,session),botId);return accept();
 });
}
/** Overflow deliberately folds receipts into a durable system inbox; record that lineage before it is claimed. */
function mapOverflowSources(store:SqliteStateStore,sessionId:string,pending:HumanRequest[],seq:number):HumanRequest[] {
 const summary=store.listUnclaimedInbox(sessionId).find(item=>item.key===INBOX_OVERFLOW_KEY);if(!summary)return pending;
 return pending.map(request=>{
  if(request.kind!=='steer')return request;
  const receipt=store.db.prepare('SELECT claimed_at FROM session_inbox WHERE id=?').get(request.id) as {claimed_at:string|null}|undefined;
  if(!receipt?.claimed_at)return request;
  const sourceKey=request.summaryId?INBOX_OVERFLOW_KEY:request.key;
  const floor=request.summarySeqFloor??request.seq;
  if(store.db.prepare('SELECT 1 FROM session_messages WHERE session_id=? AND key=? AND seq>? LIMIT 1').get(sessionId,sourceKey??'',floor))return request;
  return {...request,summaryId:summary.id,summarySeqFloor:seq};
 });
}
function preparedSteer(store:SqliteStateStore,request:HumanRequest,messages:import('../types.js').SessionMessage[]):boolean {
 const receiptId=request.summaryId??request.id;
 if(!store.db.prepare('SELECT 1 FROM session_inbox WHERE id=? AND claimed_at IS NOT NULL').get(receiptId))return false;
 const receiptKey=request.summaryId?INBOX_OVERFLOW_KEY:request.key;
 const role=request.summaryId?'system':request.role;
 return messages.some(message=>message.key===receiptKey&&message.role===role&&Number(message.seq)>(request.summarySeqFloor??request.seq));
}
/** Track a steer until its materialized message actually enters a successful model turn. */
export function requestSteerContinuation(store:SqliteStateStore,sessionId:string,item:InboxItem):void {
 updateState(store,sessionId,current=>{
  if(!item.key){item.key='human-steer:'+item.id;store.db.prepare('UPDATE session_inbox SET key=? WHERE id=? AND key IS NULL').run(item.key,item.id);}
  const pending=current.pending.filter(request=>request.id!==item.id&&!(item.key&&request.kind==='steer'&&request.key===item.key));
  const seq=Number((store.db.prepare('SELECT MAX(seq) AS seq FROM session_messages WHERE session_id=?').get(sessionId) as {seq:number|null}).seq??0);
  pending.push({id:item.id,seq,kind:'steer',text:item.text,role:item.role,key:item.key});return {...current,pending:mapOverflowSources(store,sessionId,pending,seq)};
 });
}
export function dropHumanSteerContinuation(store:SqliteStateStore,sessionId:string,itemId:string):void {
 updateState(store,sessionId,current=>({...current,pending:current.pending.filter(request=>request.id!==itemId&&request.summaryId!==itemId)}));
}
/** Cancellation preserves accepted inputs but prevents an automatic restart of them. */
export function blockHumanContinuations(store:SqliteStateStore,sessionId:string,reason='cancelled'):void {
 updateState(store,sessionId,current=>({...current,blockedReason:reason}));
}
const deliveredInputs=new WeakMap<SqliteStateStore,Map<string,Set<string>>>();
/** Called at the actual model boundary after final fitting and candidate-specific repacking. */
export function noteHumanModelInput(store:SqliteStateStore,sessionId:string,messages:import('../types.js').SessionMessage[]):void {
 let inputs=deliveredInputs.get(store);if(!inputs){inputs=new Map();deliveredInputs.set(store,inputs);}
 const delivered=new Set(messages.filter(message=>message.role==='user').map(message=>message.id));
 for(const request of state(store,sessionId).pending){if(request.kind==='steer'&&preparedSteer(store,request,messages))delivered.add(request.id);else if(request.deliveryKey&&messages.some(message=>message.key===request.deliveryKey&&message.role==='user'&&Number(message.seq)>(request.deliverySeqFloor??request.seq)))delivered.add(request.id);}
 inputs.set(sessionId,delivered);
}
export function releaseHumanModelInput(store:SqliteStateStore,sessionId:string):void {deliveredInputs.get(store)?.delete(sessionId);}
/** Kernel preparation precedes final fitting; only actual delivery can be acknowledged. */
export function createHumanContinuationObserver(store:SqliteStateStore,sessionId:string):KernelHookListener {
 releaseHumanModelInput(store,sessionId);
 return event=>{
  if(event.type!=='model_done')return;
  const delivered=deliveredInputs.get(store)?.get(sessionId);if(!delivered?.size)return;
  updateState(store,sessionId,current=>{const pending=current.pending.filter(request=>!delivered.has(request.id));return pending.length===current.pending.length?current:{...current,pending};});
  releaseHumanModelInput(store,sessionId);
 };
}
export interface HumanContinuationHost {
 store:SqliteStateStore;
 runSession(sessionId:string):Promise<unknown>;
 isSessionRunning(sessionId:string):boolean;
 hasActiveDomainLease?(sessionId:string):boolean;
 hasUnconfirmedEffects?(sessionId:string):boolean;
 log?:{warn(message:string,details?:unknown):void};
}
function hasTable(store:SqliteStateStore,name:string):boolean{return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
/** Keep the original task's completion callback ahead of any new writer in its chat. */
export function hasHumanContinuationLease(store:SqliteStateStore,sessionId:string):boolean {
 if(hasTable(store,'bot_work_messages')&&store.db.prepare("SELECT 1 FROM bot_work_messages WHERE session_id=? AND status='processing' LIMIT 1").get(sessionId))return true;
 if(hasTable(store,'bot_work_leases')&&store.db.prepare('SELECT 1 FROM bot_work_leases WHERE session_id=? AND expires>? LIMIT 1').get(sessionId,Date.now()))return true;
 if(hasTable(store,'bot_room_turns')&&store.db.prepare("SELECT 1 FROM bot_room_turns WHERE status IN ('queued','running','waiting_approval','unknown') AND json_extract(data,'$.currentSessionId')=? LIMIT 1").get(sessionId))return true;
 if(hasTable(store,'bot_routine_runs')&&store.db.prepare("SELECT 1 FROM bot_routine_runs WHERE status IN ('queued','running','waiting_approval','unknown') AND json_extract(payload,'$.sessionId')=? LIMIT 1").get(sessionId))return true;
 return false;
}
function cleanIdle(store:SqliteStateStore,id:string):boolean {
 const session=store.getSession(id);if(!session||session.status!=='idle'||session.activeWriterRunId)return false;
 const outcome=parseRunOutcome(session.metadata.outcome);
 if(outcome&&(!(outcome.kind==='idle'||outcome.kind==='completed')||outcome.reason!=='end'))return false;
 return !store.db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND status='pending' LIMIT 1").get(id);
}
function candidates(store:SqliteStateStore):string[]{
 const rows=store.db.prepare("SELECT key FROM daemon_control WHERE key LIKE ? AND json_array_length(value_json,'$.pending')>0 UNION SELECT ? || session_id AS key FROM session_inbox WHERE claimed_at IS NULL").all(PREFIX+'%',PREFIX) as {key:string}[];
 return rows.map(row=>row.key.slice(PREFIX.length));
}
function eligible(host:HumanContinuationHost,id:string):boolean {
 const current=state(host.store,id);if(current.blockedReason)return false;
 if(current.pending.length===0&&host.store.listUnclaimedInbox(id).length===0)return false;
 if(host.isSessionRunning(id)||!cleanIdle(host.store,id))return false;
 if(hasHumanContinuationLease(host.store,id)||host.hasActiveDomainLease?.(id)||host.hasUnconfirmedEffects?.(id))return false;
 return true;
}
const active=new WeakMap<SqliteStateStore,Set<string>>();
function activeFor(store:SqliteStateStore):Set<string>{let current=active.get(store);if(!current){current=new Set();active.set(store,current);}return current;}
function settleContinuation(host:HumanContinuationHost,id:string,before:string):void {
 if(!host.store.db.isOpen)return;
 updateState(host.store,id,after=>before&&after.pending.map(request=>request.id).join(',')===before&&cleanIdle(host.store,id)?{...after,blockedReason:'No pending input entered a model turn; explicitly resume to retry'}:after);
}
/** Recover only unseen sources hidden by compaction; preserve their receipt identity. */
function restorePendingSources(store:SqliteStateStore,id:string):void {
 updateState(store,id,current=>{
  const visible=store.foldMessages(id);let changed=false;
  const pending=current.pending.map(request=>{
   const steer=request.kind==='steer',sourceKey=request.summaryId?INBOX_OVERFLOW_KEY:request.key;
   const role=request.summaryId?'system':request.role??'user',floor=request.summarySeqFloor??request.seq;
   if(steer){if(!store.db.prepare('SELECT 1 FROM session_inbox WHERE id=? AND claimed_at IS NOT NULL').get(request.summaryId??request.id))return request;if(visible.some(message=>message.key===sourceKey&&Number(message.seq)>floor))return request;}
   else if(visible.some(message=>message.id===request.id||(request.deliveryKey&&message.key===request.deliveryKey&&Number(message.seq)>(request.deliverySeqFloor??request.seq))))return request;
   const source=(steer?store.db.prepare('SELECT role,parts_json,reply_to_json FROM session_messages WHERE session_id=? AND key=? AND seq>? AND role=? ORDER BY seq LIMIT 1').get(id,sourceKey??'',floor,role):store.db.prepare('SELECT role,parts_json,reply_to_json FROM session_messages WHERE session_id=? AND id=?').get(id,request.id)) as {role:import('../types.js').MessageRole;parts_json:string;reply_to_json:string|null}|undefined;
   if(!source)return request;
   const deliveryKey=steer?sourceKey:request.deliveryKey??'human-source:'+request.id;
   const deliverySeqFloor=Number((store.db.prepare('SELECT MAX(seq) AS seq FROM session_messages WHERE session_id=?').get(id) as {seq:number|null}).seq??0);
   visible.push(store.appendMessage(id,source.role,JSON.parse(source.parts_json),{key:deliveryKey,...(source.reply_to_json?{replyTo:JSON.parse(source.reply_to_json)}:{})}));changed=true;
   return steer?request:{...request,deliveryKey,deliverySeqFloor};
  });
  return changed?{...current,pending}:current;
 });
}
function dispatchContinuation(host:HumanContinuationHost,id:string,executing:Set<string>):void {
 const before=state(host.store,id).pending.map(request=>request.id).join(',');executing.add(id);
 const failed=(error:unknown)=>{if(!host.store.db.isOpen)return;blockHumanContinuations(host.store,id,'Continuation failed; explicitly resume to retry');host.log?.warn('Human continuation failed',{sessionId:id,error:String(error)});};
 try{restorePendingSources(host.store,id);void Promise.resolve(host.runSession(id)).then(()=>settleContinuation(host,id,before)).catch(failed).finally(()=>executing.delete(id));}
 catch(error){executing.delete(id);failed(error);}
}
/** Human work still waiting on this chat. Steers are corrections, not extra pieces. */
export function listPendingHumanWork(store: SqliteStateStore, sessionId: string): Array<{ id: string; seq: number }> {
  return state(store, sessionId).pending
    .filter((request) => request.kind !== 'steer')
    .map((request) => ({ id: request.id, seq: request.seq }));
}
function forkSourceId(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const id = (item as { sourceMessageId?: unknown }).sourceMessageId;
  return typeof id === 'string' ? id : undefined;
}
function forkedHumanIds(store: SqliteStateStore, sessionId: string): Set<string> {
  const raw = store.getSession(sessionId)?.metadata?.concurrentBotForks;
  const ids = new Set<string>();
  if (!Array.isArray(raw)) return ids;
  for (const item of raw) {
    const id = forkSourceId(item);
    if (id) ids.add(id);
  }
  return ids;
}
/** Pending human messages this joined run did not take and did not hand to a sub-agent. */
export function unansweredHumanWork(store: SqliteStateStore, sessionId: string, messageIds: readonly string[]): boolean {
  if (messageIds.length === 0) return false;
  const pending = new Set(listPendingHumanWork(store, sessionId).map((row) => row.id));
  const forked = forkedHumanIds(store, sessionId);
  return messageIds.some((id) => pending.has(id) && !forked.has(id));
}
/**
 * A send that joins an in-flight turn returns before the new message is read.
 * Run that message once the joined turn ends, unless a sub-agent already owns it.
 */
export async function runAnsweredHumanSession<T, O>(
  host: { store: SqliteStateStore; isRunning(sessionId: string): boolean; runSession(sessionId: string, options?: O): Promise<T> },
  sessionId: string,
  options?: O
): Promise<T> {
  const queued = listPendingHumanWork(host.store, sessionId).map((row) => row.id);
  const first = await host.runSession(sessionId, options);
  if (host.isRunning(sessionId) || !unansweredHumanWork(host.store, sessionId, queued)) return first;
  return host.runSession(sessionId, options);
}
/** Dispatch only: slow model/tool work never blocks the scheduler or another chat. */
export async function drainHumanContinuations(host:HumanContinuationHost):Promise<void> {
 const executing=activeFor(host.store);
 for(const id of candidates(host.store)){if(!executing.has(id)&&eligible(host,id))dispatchContinuation(host,id,executing);}
}
