import { stampSessionWake, withApprovalWake } from '../approval/unattended-approval.js';
import { mergeOutcomeMetadata, parseRunOutcome, runOutcomeFromEnd } from '../session/run-outcome.js';
import { assistantTextsFromFold } from '../session/visible-assistant.js';
import { retireTaskContextSources } from '../session/task-context.js';
import { closeOpenToolWave } from '../session/tool-wave-close.js';
import { createWaitingApprovalInterrupt, mergeInterruptMetadata, unmatchedToolCallsFromFold } from '@ppeng/agent-loop/session';
import { createId, nowIso } from '../id.js';
import { AppError, ValidationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import type { Logger } from '../logger.js';
import type { MessagePart, SessionRecord, ToolContract } from '../types.js';
import type { SessionFacadeHost } from '../runtime/session-facade.js';
import { createBot, openBot } from './bot-facade.js';
import { resolveBotPrincipal, principalFromSession, botPrincipalKey, sameBotPrincipal, botDefinitionOwner, type BotPrincipal } from './bot-identity.js';
import { ROOM_HUMAN_STEP_NOTICE, ROOM_HUMAN_STEP_REASON, memberNeedsHuman, privateHandbackText, roomMetadataAfterHandOff } from '../rooms/human-step.js';
export { resolveBotPrincipal, principalFromSession } from './bot-identity.js';
export type { BotPrincipal } from './bot-identity.js';

export interface BotWorkHost { store: SqliteStateStore; runSession(id: string): Promise<unknown>; isSessionRunning?(id: string): boolean; cancelSession?(id:string):void; hasUnconfirmedEffects?(sessionId:string,startedAt:string):boolean; log: Logger }
export interface BotMessageInput { principal: BotPrincipal; senderBotId: string; targetBotId: string; message: string; idempotencyKey?: string; taskId?: string; replyTo?: string; wake?: boolean; relayHop?: number; sourceRoomId?: string }
export interface BotTask { id: string; principal: BotPrincipal; requesterBotId: string; targetBotId: string; input: string; status: string; attempt: number; deadline?: string; result?: string; failureReason?: string; createdAt: string; updatedAt: string }
const initialized = new WeakSet<object>();
const activeRuns = new WeakMap<SqliteStateStore, Set<string>>();
const taskDeadlineTimers = new WeakMap<SqliteStateStore,Map<string,ReturnType<typeof setTimeout>>>();
function clearBotTaskDeadline(store:SqliteStateStore,id:string):void {const timers=taskDeadlineTimers.get(store),timer=timers?.get(id);if(timer)clearTimeout(timer);timers?.delete(id);}
function active(store: SqliteStateStore): Set<string> { let set=activeRuns.get(store); if(!set){set=new Set();activeRuns.set(store,set);}return set; }

/** Idempotent schema bootstrap; parent registers this at startup and migration. */
export function ensureBotWorkSchema(store: Pick<SqliteStateStore,'db'>): void {
 if(initialized.has(store))return;
 store.db.exec(`
 CREATE TABLE IF NOT EXISTS bot_definition_owners(bot_id TEXT PRIMARY KEY,principal TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_work_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,principal TEXT NOT NULL,sender_bot TEXT NOT NULL,target_bot TEXT NOT NULL,session_id TEXT NOT NULL,
 body TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'message',idem TEXT,task_id TEXT,reply_to TEXT,wake INTEGER NOT NULL DEFAULT 1,hop INTEGER NOT NULL DEFAULT 0,source_room TEXT,status TEXT NOT NULL DEFAULT 'pending',
 message_ref TEXT,attempt INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(principal,sender_bot,idem));
 CREATE INDEX IF NOT EXISTS bot_work_pending ON bot_work_messages(status,seq);
 CREATE TABLE IF NOT EXISTS bot_work_tasks (id TEXT PRIMARY KEY,principal TEXT NOT NULL,requester_bot TEXT NOT NULL,target_bot TEXT NOT NULL,input TEXT NOT NULL,
 idem TEXT,status TEXT NOT NULL DEFAULT 'queued',attempt INTEGER NOT NULL DEFAULT 0,deadline TEXT,result TEXT,failure_reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(principal,requester_bot,idem));
 CREATE TABLE IF NOT EXISTS bot_work_leases (session_id TEXT PRIMARY KEY,owner TEXT NOT NULL,fence INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_work_bindings (principal TEXT NOT NULL,bot_id TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(principal,bot_id));
 `);
 const columns=store.db.prepare('PRAGMA table_info(bot_work_messages)').all() as {name:string}[];
 if(!columns.some(c=>c.name==='kind'))store.db.exec("ALTER TABLE bot_work_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'");
 if(!columns.some(c=>c.name==='source_room'))store.db.exec('ALTER TABLE bot_work_messages ADD COLUMN source_room TEXT');
 initialized.add(store);
}
function facade(host: BotWorkHost): SessionFacadeHost {
 return { store:host.store, runImageRetention:async()=>{}, wakeAllAutonomousSessions(){}, wakeAgentSessions(){} } as SessionFacadeHost;
}
/** A leftover approval, or a waiting interrupt, means this chat still owes a person a decision. */
function privateChatHasPendingApproval(store: SqliteStateStore, sessionId: string): boolean {
 if (store.listApprovals({ status: 'pending' }).some(approval => approval.sessionId === sessionId)) return true;
 const session = store.getSession(sessionId);
 const interrupt = session?.metadata?.interrupt;
 return !!interrupt && typeof interrupt === 'object' && (interrupt as { kind?: unknown }).kind === 'waiting_approval';
}
/** Statuses that are still doing work. A failed, cancelled or unknown chat is free to take the step. */
const PRIVATE_CHAT_BUSY = new Set(['running', 'waiting_approval']);
/** The private chat can take a handed step when it is not running and not already waiting on its own approval. */
export function privateChatCanTakeHandOff(session: { status?: string } | undefined): boolean {
 return !!session && !PRIVATE_CHAT_BUSY.has(session.status ?? '');
}
/**
 * A Room member stopped on a step a person must approve, log in, or verify.
 * Move that pending approval and its unmatched tool call onto the bot's private chat
 * and leave the Room session idle, so approving in private runs the step there once
 * and cannot resume or replay the Room turn.
 *
 * When the private chat is running, already waiting on its own approval, or still
 * holds any pending approval, nothing is detached and its interrupt is left as-is.
 * The caller keeps the Room turn waiting and retries once that chat is free.
 * Pass `within` to write the Room notice and turn in the same transaction; a throw rolls all of it back.
 */
export function handRoomHumanStepToPrivateChat(host: Pick<BotWorkHost, 'store'>, input: { roomTitle: string; botId: string; principal: BotPrincipal; memberSessionId: string }, within?: () => void): { privateSessionId: string; notice: string; reason: string } | undefined {
 const member = host.store.getSession(input.memberSessionId);
 const pending = host.store.listApprovals({ status: 'pending' }).filter(approval => approval.sessionId === input.memberSessionId);
 if (!member || !memberNeedsHuman(member, pending)) return undefined;
 const chat = openBotWorkContext(host as BotWorkHost, input.botId, input.principal);
 const parked = host.store.getSession(chat.id);
 if (!privateChatCanTakeHandOff(parked) || privateChatHasPendingApproval(host.store, chat.id)) return undefined;
 const open = unmatchedToolCallsFromFold(host.store.foldMessages(input.memberSessionId));
 const apply = () => {
  const fresh = host.store.getSession(chat.id);
  // Re-check inside the transaction. A pending approval that landed after the first look must defer, not be overwritten.
  if (!privateChatCanTakeHandOff(fresh) || privateChatHasPendingApproval(host.store, chat.id)) return false;
  // Only the rows this statement re-points. A chat that already has a pending approval never reaches here.
  const movedIds = (host.store.db.prepare(`UPDATE approvals SET session_id=?, expires_at=NULL, wake_source=NULL, updated_at=? WHERE session_id=? AND status='pending' RETURNING id`).all(chat.id, nowIso(), input.memberSessionId) as { id: string }[]).map(row => row.id);
  host.store.appendMessage(chat.id, 'user', [{ type: 'text', text: privateHandbackText(input.roomTitle) }]);
  if (open.length) {
   const calls: MessagePart[] = open.map(call => ({ type: 'tool_call', toolCallId: call.toolCallId, name: call.name, input: call.input }));
   host.store.appendMessage(chat.id, 'assistant', calls);
   // Drop only the unmatched call. A sibling call that already has a result stays, so the next Room turn is not left with a dangling tool_result.
   // An assistant row that held nothing else is deleted. The store path also refreshes the history search index.
   const handedIds = new Set(open.map(call => call.toolCallId));
   for (const message of host.store.listMessages(input.memberSessionId)) {
    if (message.role !== 'assistant') continue;
    if (!message.parts.some(part => part.type === 'tool_call' && handedIds.has(part.toolCallId))) continue;
    const kept = message.parts.filter(part => part.type !== 'tool_call' || !handedIds.has(part.toolCallId));
    host.store.rewriteMessageParts(input.memberSessionId, message.id, kept);
   }
  }
  // member.metadata already carries the roomDelivery cursor written before this run. Spread it; do not rebuild metadata from scratch.
  host.store.updateSession(input.memberSessionId, { status: 'idle', metadata: roomMetadataAfterHandOff(member.metadata) });
  const waiting = host.store.getSession(chat.id) ?? fresh!;
  const outcome = runOutcomeFromEnd({ reason: 'waiting_approval', sessionStatus: 'waiting_approval' });
  const interrupt = createWaitingApprovalInterrupt({
   toolCallIds: open.map(call => call.toolCallId),
   approvalIds: movedIds
  });
  host.store.updateSession(chat.id, {
   status: 'waiting_approval',
   metadata: withApprovalWake(mergeInterruptMetadata(mergeOutcomeMetadata(waiting.metadata, outcome), interrupt), { kind: 'human', source: 'room-handoff' })
  });
  if (within) within();
  return true;
 };
 // `within` is not a transaction. Only skip BEGIN when one is already open, so a throw rolls the approval move back with the Room turn.
 if (host.store.db.isTransaction) {
  if (!apply()) return undefined;
 } else {
  host.store.db.exec('BEGIN IMMEDIATE');
  try {
   if (!apply()) { host.store.db.exec('ROLLBACK'); return undefined; }
   host.store.db.exec('COMMIT');
  } catch (error) { host.store.db.exec('ROLLBACK'); throw error; }
 }
 return { privateSessionId: chat.id, notice: ROOM_HUMAN_STEP_NOTICE, reason: ROOM_HUMAN_STEP_REASON };
}
export function openBotWorkContext(host: BotWorkHost, botId: string, principal: BotPrincipal): SessionRecord {
 ensureBotWorkSchema(host.store);
 const opened=openBot(facade(host),botId,principal);
 host.store.db.prepare('INSERT INTO bot_work_bindings(principal,bot_id,session_id) VALUES(?,?,?) ON CONFLICT(principal,bot_id) DO UPDATE SET session_id=excluded.session_id').run(botPrincipalKey(principal),botId,opened.sessionId);
 return host.store.getSession(opened.sessionId)!;
}
/** CAS fencing prevents a stale completion from committing after recovery. */
export function claimBotSession(store: SqliteStateStore, sessionId: string, owner: string, ttl=60_000): number | undefined {
 ensureBotWorkSchema(store);
 const row=store.db.prepare(`INSERT INTO bot_work_leases(session_id,owner,fence,expires) VALUES(?,?,1,?)
 ON CONFLICT(session_id) DO UPDATE SET owner=excluded.owner,fence=bot_work_leases.fence+1,expires=excluded.expires
 WHERE bot_work_leases.expires<=? RETURNING fence`).get(sessionId,owner,Date.now()+ttl,Date.now()) as {fence:number}|undefined;
 return row?.fence;
}
export function releaseBotSession(store: SqliteStateStore, sessionId: string, owner: string, fence: number): boolean {
 return Number(store.db.prepare('UPDATE bot_work_leases SET expires=0 WHERE session_id=? AND owner=? AND fence=?').run(sessionId,owner,fence).changes)>0;
}
function leaseValid(store:SqliteStateStore,id:string,owner:string,fence:number):boolean { return !!store.db.prepare('SELECT 1 FROM bot_work_leases WHERE session_id=? AND owner=? AND fence=?').get(id,owner,fence); }
function taskRow(row: Record<string,unknown>):BotTask { return { id:String(row.id),principal:JSON.parse(String(row.principal)).reduce((o:BotPrincipal,v:string,i:number)=>i===0?({...o,...(v?{tenantId:v}:{})}):({...o,userId:v}),{} as BotPrincipal),requesterBotId:String(row.requester_bot),targetBotId:String(row.target_bot),input:String(row.input),status:String(row.status),attempt:Number(row.attempt),...(row.deadline?{deadline:String(row.deadline)}:{}),...(row.result!==null?{result:String(row.result)}:{}),...(row.failure_reason?{failureReason:String(row.failure_reason)}:{}),createdAt:String(row.created_at),updatedAt:String(row.updated_at) }; }
const UNRESOLVED_BOT_TASKS = ['queued','running','waiting_approval','unknown'];
export function listBotTasks(store:SqliteStateStore,principal:BotPrincipal):BotTask[] {
 ensureBotWorkSchema(store);const key=botPrincipalKey(principal);
 const unresolved=store.db.prepare("SELECT * FROM bot_work_tasks WHERE principal=? AND status IN ('queued','running','waiting_approval','unknown') ORDER BY rowid DESC").all(key) as Record<string,unknown>[];
 const history=store.db.prepare("SELECT * FROM bot_work_tasks WHERE principal=? AND status NOT IN ('queued','running','waiting_approval','unknown') ORDER BY rowid DESC LIMIT 500").all(key) as Record<string,unknown>[];
 return [...unresolved,...history].map(taskRow);
}
export function botTaskPage(store:SqliteStateStore,principal:BotPrincipal,options?:{cursor?:string;limit?:number}):{tasks:BotTask[];activeTasks:BotTask[];historyTasks:BotTask[];hasMore:boolean;nextCursor:string|null;counts:Record<string,number>} {
 ensureBotWorkSchema(store);const key=botPrincipalKey(principal),limit=options?.limit??50;
 if(!Number.isInteger(limit)||limit<1||limit>200)throw new ValidationError('Task page limit must be 1–200');
 let snapshot=Number((store.db.prepare('SELECT COALESCE(max(rowid),0) AS n FROM bot_work_tasks WHERE principal=?').get(key) as {n:number}).n),before=snapshot+1;
 if(options?.cursor){try{const decoded=JSON.parse(Buffer.from(options.cursor,'base64url').toString());if(!Number.isSafeInteger(decoded.before)||!Number.isSafeInteger(decoded.snapshot)||decoded.before<1||decoded.snapshot<0)throw new Error();before=decoded.before;snapshot=decoded.snapshot;}catch{throw new ValidationError('Invalid task history cursor');}}
 const activeTasks=(store.db.prepare("SELECT * FROM bot_work_tasks WHERE principal=? AND status IN ('queued','running','waiting_approval','unknown') ORDER BY rowid DESC").all(key) as Record<string,unknown>[]).map(taskRow);
 const rows=store.db.prepare("SELECT rowid AS history_seq,* FROM bot_work_tasks WHERE principal=? AND rowid<=? AND rowid<? AND status NOT IN ('queued','running','waiting_approval','unknown') ORDER BY rowid DESC LIMIT ?").all(key,snapshot,before,limit+1) as Record<string,unknown>[];
 const hasMore=rows.length>limit,selected=rows.slice(0,limit),historyTasks=selected.map(taskRow),last=selected.at(-1);
 const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({before:Number(last.history_seq),snapshot})).toString('base64url'):null;
 const counts=Object.fromEntries((store.db.prepare('SELECT status,count(*) AS n FROM bot_work_tasks WHERE principal=? GROUP BY status').all(key) as {status:string;n:number}[]).map(row=>[row.status,row.n]));
 return {tasks:[...activeTasks,...historyTasks],activeTasks,historyTasks,hasMore,nextCursor,counts};
}
export function getBotTask(store:SqliteStateStore,principal:BotPrincipal,id:string):BotTask|undefined { ensureBotWorkSchema(store); const row=store.db.prepare('SELECT * FROM bot_work_tasks WHERE id=? AND principal=?').get(id,botPrincipalKey(principal)) as Record<string,unknown>|undefined;return row?taskRow(row):undefined; }

export function botWorkControl(store:SqliteStateStore,principal:BotPrincipal,botId:string):{paused:boolean;disabled:boolean} { return store.getDaemonControl<{paused:boolean;disabled:boolean}>(`bot.control:${botPrincipalKey(principal)}:${botId}`)??{paused:false,disabled:false}; }
export function setBotWorkControl(host:BotWorkHost,principal:BotPrincipal,botId:string,input:{paused:boolean;disabled:boolean}):ReturnType<typeof botWorkControl> { openBotWorkContext(host,botId,principal);if(typeof input.paused!=='boolean'||typeof input.disabled!=='boolean')throw new ValidationError('paused and disabled must be booleans');host.store.setDaemonControl(`bot.control:${botPrincipalKey(principal)}:${botId}`,input);return input; }
export function botWorkSettings(store:SqliteStateStore):{perBot:number;perPrincipal:number} { const saved=store.getDaemonControl<{perBot?:number;perPrincipal?:number}>('bot.workSettings');return {perBot:saved?.perBot??1000,perPrincipal:saved?.perPrincipal??10000}; }
export function updateBotWorkSettings(store:SqliteStateStore,input:{perBot:number;perPrincipal:number}):ReturnType<typeof botWorkSettings> { for(const n of [input.perBot,input.perPrincipal])if(!Number.isInteger(n)||n<1||n>100000)throw new ValidationError('Queue limit must be an integer in 1–100000');store.setDaemonControl('bot.workSettings',input);return botWorkSettings(store); }
export class BotQueueCapacityError extends AppError { readonly retryable=true; constructor(public readonly usage:{total:number;byBot:Record<string,number>},public readonly limits:ReturnType<typeof botWorkSettings>){super('QUEUE_FULL','QUEUE_FULL: Pending work capacity reached; retry later. Previously accepted work is retained.',429);} }
/** A steer is counted in its unclaimed inbox or continuation ledger, never both. */
function pendingHumanBotWork(store:SqliteStateStore,principal:BotPrincipal):{bot_id:string;n:number}[] {
 const prefix='session.humanContinuation:';
 return store.db.prepare(`WITH pending AS (
  SELECT substr(d.key,?) AS session_id FROM daemon_control d JOIN json_each(d.value_json,'$.pending') request
  WHERE d.key GLOB ? AND (coalesce(json_extract(request.value,'$.kind'),'human')!='steer'
    OR NOT EXISTS(SELECT 1 FROM session_inbox inbox WHERE inbox.id=json_extract(request.value,'$.id') AND inbox.claimed_at IS NULL))
  UNION ALL SELECT inbox.session_id FROM session_inbox inbox WHERE inbox.claimed_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM daemon_control d JOIN json_each(d.value_json,'$.pending') request
    WHERE d.key=(? || inbox.session_id) AND json_extract(request.value,'$.kind')='steer'
     AND json_extract(request.value,'$.summaryId')=inbox.id)
 ), bound AS (SELECT s.metadata_json,coalesce(
  CASE WHEN json_type(s.metadata_json,'$.botId')='text' THEN nullif(trim(json_extract(s.metadata_json,'$.botId')),'') END,
  (SELECT b.id FROM bots b WHERE b.id=s.agent_id LIMIT 1),
  (SELECT b.id FROM bots b WHERE b.agent_id=s.agent_id AND b.hidden=0 ORDER BY b.name COLLATE NOCASE LIMIT 1)) AS bot_id
 FROM pending p JOIN sessions s ON s.id=p.session_id)
 SELECT s.bot_id,count(*) AS n FROM bound s WHERE s.bot_id IS NOT NULL
 AND json_array(
  CASE WHEN json_type(s.metadata_json,'$.userId')='text' AND trim(json_extract(s.metadata_json,'$.userId'))!=''
   AND json_type(s.metadata_json,'$.tenantId')='text' THEN trim(json_extract(s.metadata_json,'$.tenantId')) ELSE '' END,
  CASE WHEN json_type(s.metadata_json,'$.userId')='text' AND trim(json_extract(s.metadata_json,'$.userId'))!=''
   THEN trim(json_extract(s.metadata_json,'$.userId')) ELSE ? END)=?
 GROUP BY bot_id`).all(prefix.length+1,prefix+'*',prefix,resolveBotPrincipal(store).userId,botPrincipalKey(principal)) as {bot_id:string;n:number}[];
}
/** Count outstanding target work across private messages, Routine occurrences and Room members. */
export function botQueueUsage(store:SqliteStateStore,principal:BotPrincipal):{total:number;byBot:Record<string,number>} {
 ensureBotWorkSchema(store);const key=botPrincipalKey(principal),byBot:Record<string,number>={};
 const add=(id:string,n:number)=>{byBot[id]=(byBot[id]??0)+n;};
 for(const row of store.db.prepare("SELECT target_bot,count(*) AS n FROM bot_work_messages WHERE principal=? AND status IN ('pending','processing') GROUP BY target_bot").all(key) as {target_bot:string;n:number}[])add(row.target_bot,row.n);
 for(const row of pendingHumanBotWork(store,principal))add(row.bot_id,row.n);
 const exists=(name:string)=>!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(exists('bot_routine_runs')){
  const local=resolveBotPrincipal(store).userId;
  const rows=store.db.prepare(`SELECT COALESCE(json_extract(r.payload,'$.job.metadata.botId'),json_extract(r.payload,'$.job.agentId')) AS bot_id,count(*) AS n
  FROM bot_routine_runs r LEFT JOIN sessions s ON s.id=json_extract(r.payload,'$.mainSessionId')
  WHERE r.status IN ('queued','running','waiting_approval') AND json_array(COALESCE(json_extract(r.payload,'$.job.metadata.principal.tenantId'),json_extract(s.metadata_json,'$.tenantId'),''),COALESCE(json_extract(r.payload,'$.job.metadata.principal.userId'),json_extract(s.metadata_json,'$.userId'),?))=? GROUP BY bot_id`).all(local,key) as {bot_id:string;n:number}[];
  for(const row of rows)add(row.bot_id,row.n);
 }
 if(exists('bot_room_turns')&&exists('bot_rooms')){
  for(const row of store.db.prepare(`WITH remaining AS (
    SELECT member.value AS bot_id,ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY CAST(member.key AS INTEGER)) AS rank,
      COALESCE(json_extract(t.data,'$.maxBotTurns'),8)-COALESCE(json_extract(t.data,'$.botTurns'),0) AS budget
    FROM bot_room_turns t JOIN bot_rooms r ON r.id=t.room_id
      JOIN json_each(json_extract(t.data,'$.botIds')) member
      JOIN json_each(json_extract(r.data,'$.botIds')) roster ON roster.value=member.value
    WHERE r.principal_id=? AND t.status IN ('queued','running','waiting_approval')
      AND CAST(member.key AS INTEGER)>=COALESCE(json_extract(t.data,'$.cursor'),0))
    SELECT bot_id,count(*) AS n FROM remaining WHERE rank<=budget GROUP BY bot_id`).all(key) as {bot_id:string;n:number}[])add(row.bot_id,row.n);
 }
 return {total:Object.values(byBot).reduce((n,count)=>n+count,0),byBot};
}
/** Call inside the receiver's SQLite transaction, after checking its idempotency receipt. */
export function checkBotQueueCapacity(store:SqliteStateStore,principal:BotPrincipal,targets:readonly string[]):void {
 const usage=botQueueUsage(store,principal),limits=botWorkSettings(store),extra:Record<string,number>={};for(const target of targets)extra[target]=(extra[target]??0)+1;
 if(usage.total+targets.length>limits.perPrincipal||Object.entries(extra).some(([id,count])=>(usage.byBot[id]??0)+count>limits.perBot))throw new BotQueueCapacityError(usage,limits);
}
export function checkBotWorkCapacity(store:SqliteStateStore,principal:BotPrincipal,botId:string,additional=1):void { if(!Number.isInteger(additional)||additional<1||additional>100000)throw new ValidationError('Invalid additional queue capacity');checkBotQueueCapacity(store,principal,Array(additional).fill(botId)); }


export function enqueueBotMessage(host:BotWorkHost,input:BotMessageInput):{accepted:true;messageId:string;sessionId:string;queued:boolean;startedRun:boolean} {
 ensureBotWorkSchema(host.store);
 if(!input.message.trim() || input.message.length>4000)throw new ValidationError('Message must contain 1–4000 characters');
 // Validate both principals before persisting an accepted message.
 openBotWorkContext(host,input.senderBotId,input.principal);
 const target=openBotWorkContext(host,input.targetBotId,input.principal);
 const id=createId('bmsg'),now=nowIso(),key=botPrincipalKey(input.principal);
 const sourceRoom=typeof input.sourceRoomId==='string'&&input.sourceRoomId.trim()?input.sourceRoomId.trim():null;
 host.store.db.exec('BEGIN IMMEDIATE');
 try {
 const duplicate=input.idempotencyKey?host.store.db.prepare('SELECT id FROM bot_work_messages WHERE principal=? AND sender_bot=? AND idem=?').get(key,input.senderBotId,input.idempotencyKey):undefined;
 if(!duplicate)checkBotWorkCapacity(host.store,input.principal,input.targetBotId);
 host.store.db.prepare(`INSERT INTO bot_work_messages(id,principal,sender_bot,target_bot,session_id,body,idem,task_id,reply_to,wake,hop,source_room,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(principal,sender_bot,idem) DO NOTHING`).run(id,key,input.senderBotId,input.targetBotId,target.id,input.message,input.idempotencyKey??null,input.taskId??null,input.replyTo??null,input.wake===false?0:1,input.relayHop??0,sourceRoom,now,now);host.store.db.exec('COMMIT');
 }catch(error){host.store.db.exec('ROLLBACK');throw error;}
 const row=(input.idempotencyKey?host.store.db.prepare('SELECT * FROM bot_work_messages WHERE principal=? AND sender_bot=? AND idem=?').get(key,input.senderBotId,input.idempotencyKey):host.store.db.prepare('SELECT * FROM bot_work_messages WHERE id=?').get(id)) as Record<string,unknown>;
 const storedRoom=row.source_room==null||row.source_room===''?null:String(row.source_room);
 if(String(row.body)!==input.message || String(row.target_bot)!==input.targetBotId || storedRoom!==sourceRoom)throw new ValidationError('Idempotency key was already used for different message');
 const started=drainBotSession(host,target.id);
 const fresh=host.store.db.prepare('SELECT status FROM bot_work_messages WHERE id=?').get(String(row.id)) as {status:string};
 return {accepted:true,messageId:String(row.id),sessionId:target.id,queued:fresh.status==='pending',startedRun:started};
}
export function dispatchBotTask(host:BotWorkHost,input:{principal:BotPrincipal;requesterBotId:string;targetBotId:string;input:string;idempotencyKey?:string;deadline?:string}):BotTask {
 ensureBotWorkSchema(host.store);
 if(!input.input.trim()||input.input.length>3500)throw new ValidationError('Task input must contain 1–3500 characters');
 if(input.deadline&&!Number.isFinite(Date.parse(input.deadline)))throw new ValidationError('Invalid deadline');
 openBotWorkContext(host,input.requesterBotId,input.principal);openBotWorkContext(host,input.targetBotId,input.principal);
 const key=botPrincipalKey(input.principal),now=nowIso(),id=createId('btask');
 // Task and inbox commit together. Side effects only begin after COMMIT.
 host.store.db.exec('BEGIN IMMEDIATE');
 let task:BotTask;
 try {
 const duplicate=input.idempotencyKey?host.store.db.prepare('SELECT id FROM bot_work_tasks WHERE principal=? AND requester_bot=? AND idem=?').get(key,input.requesterBotId,input.idempotencyKey):undefined;
 if(!duplicate)checkBotWorkCapacity(host.store,input.principal,input.targetBotId);
 host.store.db.prepare('INSERT INTO bot_work_tasks(id,principal,requester_bot,target_bot,input,idem,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(principal,requester_bot,idem) DO NOTHING').run(id,key,input.requesterBotId,input.targetBotId,input.input,input.idempotencyKey??null,input.deadline??null,now,now);
 const row=(input.idempotencyKey?host.store.db.prepare('SELECT * FROM bot_work_tasks WHERE principal=? AND requester_bot=? AND idem=?').get(key,input.requesterBotId,input.idempotencyKey):host.store.db.prepare('SELECT * FROM bot_work_tasks WHERE id=?').get(id)) as Record<string,unknown>;
 task=taskRow(row);if(task.input!==input.input||task.targetBotId!==input.targetBotId)throw new ValidationError('Idempotency key was already used for another task');
 const context=openBotWorkContext(host,input.targetBotId,input.principal);
 host.store.db.prepare("INSERT INTO bot_work_messages(id,principal,sender_bot,target_bot,session_id,body,kind,idem,task_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'task',?,?,?,?) ON CONFLICT(principal,sender_bot,idem) DO NOTHING").run(createId('bmsg'),key,input.requesterBotId,input.targetBotId,context.id,`Delegated task ${task.id}: ${input.input}\nReport the concrete result; this execution is tracked automatically.`,`task:${task.id}`,task.id,now,now);
 host.store.db.exec('COMMIT');
 }catch(err){host.store.db.exec('ROLLBACK');throw err;}
 return task;
}
function lastAssistant(store:SqliteStateStore,sessionId:string,afterId:string):string {
 return assistantTextsFromFold(store, sessionId, afterId).join('\n').slice(-12000);
}
export function hasPendingSessionWake(store:SqliteStateStore,sessionId:string):boolean { return !!store.db.prepare('SELECT 1 FROM scheduler_wake WHERE session_id=? LIMIT 1').get(sessionId); }
/** True means the approved continuation is in flight; never treats approval itself as completion. */
export function resumeApprovedBotSession(host:Pick<BotWorkHost,'store'|'runSession'|'isSessionRunning'> & {log?:Pick<Logger,'warn'>},sessionId:string,startedAt:string,onSettled?:(error?:unknown)=>void):boolean {
 if(active(host.store).has(sessionId)||host.isSessionRunning?.(sessionId))return true;
 const session=host.store.getSession(sessionId);if(!session||session.status!=='idle'||parseRunOutcome(session.metadata?.outcome)?.kind!=='waiting_approval')return false;
 const approvals=host.store.listApprovals().filter(item=>item.sessionId===sessionId&&Date.parse(item.createdAt)>=Date.parse(startedAt));
 if(!approvals.some(item=>item.status==='approved')||approvals.some(item=>item.status==='pending'||item.status==='rejected'))return false;
 active(host.store).add(sessionId);
 const settle=(error?:unknown)=>{if(error){const live=host.store.getSession(sessionId);if(live)host.store.updateSession(sessionId,{status:'failed',metadata:{...live.metadata,outcome:{kind:'failed',reason:'approval_resume_error'}}});host.log?.warn('Approved Bot continuation failed',{sessionId,error:String(error)});}active(host.store).delete(sessionId);onSettled?.(error);};
 try{void Promise.resolve(host.runSession(sessionId)).then(()=>settle(),error=>settle(error)).catch(error=>host.log?.warn('Bot continuation completion callback failed',{sessionId,error:String(error)}));}
 catch(error){settle(error);}
 return true;
}
interface ProcessingContext {
  session?: SessionRecord;
  taskId?: string;
  priorTask?: {status:string;failure_reason?:string};
  outcome?: ReturnType<typeof parseRunOutcome>;
  denied: boolean;
  unconfirmed: boolean;
  error?: unknown;
}
type ProcessingStatus = 'completed'|'failed'|'cancelled'|'unknown';
function processingContext(host:BotWorkHost,row:Record<string,unknown>,error?:unknown):ProcessingContext {
  const sessionId=String(row.session_id);
  const session=host.store.getSession(sessionId);
  const taskId=row.kind==='task'?String(row.task_id):undefined;
  const priorTask=taskId?host.store.db.prepare('SELECT status,failure_reason FROM bot_work_tasks WHERE id=?').get(taskId) as ProcessingContext['priorTask']:undefined;
  const denied=host.store.listApprovals({status:'rejected'}).some(item=>item.sessionId===sessionId&&Date.parse(item.createdAt)>=Date.parse(String(row.updated_at)));
  return {session,taskId,priorTask,denied,outcome:parseRunOutcome(session?.metadata?.outcome),error,
    unconfirmed:host.hasUnconfirmedEffects?.(sessionId,String(row.updated_at))===true};
}
function processingAwaitsApproval(host:BotWorkHost,row:Record<string,unknown>,context:ProcessingContext):boolean {
  if(context.priorTask?.status==='unknown'||context.priorTask?.status==='cancelled')return false;
  if(hasPendingSessionWake(host.store,String(row.session_id)))return true;
  if(context.denied)return false;
  if(context.session?.status==='waiting_approval') {
    if(context.taskId)host.store.db.prepare("UPDATE bot_work_tasks SET status='waiting_approval',updated_at=? WHERE id=? AND status='running'").run(nowIso(),context.taskId);
    return true;
  }
  return !context.error&&context.outcome?.kind==='waiting_approval'&&context.session?.status==='idle';
}
function processingStatus(context:ProcessingContext,result:string):ProcessingStatus {
  if(!context.session||context.unconfirmed||context.priorTask?.status==='unknown')return 'unknown';
  if(context.priorTask?.status==='cancelled'||context.outcome?.kind==='aborted')return 'cancelled';
  if(context.error||context.denied||context.session.status==='failed')return 'failed';
  if(context.outcome?.kind==='failed')return 'failed';
  if(context.outcome?.kind==='idle'&&context.outcome.reason!=='end')return 'failed';
  if(context.taskId&&!result.trim())return 'failed';
  return 'completed';
}
function processingFailure(context:ProcessingContext,status:ProcessingStatus,result:string):string|null {
  if(!context.session)return 'Execution context missing; verify effects before retry';
  if(context.unconfirmed)return 'External write outcome is unconfirmed; verify effects before retry';
  if(context.denied)return 'Approval denied or expired';
  if(context.outcome?.kind==='aborted')return `Execution aborted: ${context.outcome.reason}`;
  if(context.priorTask?.status==='unknown')return context.priorTask.failure_reason??'Side effects unconfirmed';
  if(context.error instanceof Error)return context.error.message;
  if(context.error)return String(context.error);
  if(status!=='failed')return null;
  if(context.outcome)return `Execution ended without completion: ${context.outcome.reason}`;
  return result?'Bot execution failed':'Bot produced no result';
}
function publishBotTaskResult(host:BotWorkHost,row:Record<string,unknown>,taskId:string,status:ProcessingStatus,result:string,failure:string|null):void {
  const task=host.store.db.prepare('SELECT * FROM bot_work_tasks WHERE id=?').get(taskId) as Record<string,unknown>;
  const dest=openBotWorkContext(host,String(task.requester_bot),taskRow(task).principal);
  host.store.db.prepare(`INSERT INTO bot_work_messages(id,principal,sender_bot,target_bot,session_id,body,kind,idem,task_id,reply_to,wake,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'result',?,?,?,1,?,?) ON CONFLICT(principal,sender_bot,idem) DO NOTHING`).run(createId('bmsg'),String(row.principal),String(row.target_bot),String(task.requester_bot),dest.id,`Task ${task.id} ${status}: ${(failure??result).slice(0,3500)}`,`result:${task.id}:${task.attempt}`,taskId,String(row.id),nowIso(),nowIso());
}
function persistProcessingResult(host:BotWorkHost,row:Record<string,unknown>,context:ProcessingContext,status:ProcessingStatus,result:string,failure:string|null,owner:string,fence:number):void {
  host.store.db.exec('BEGIN IMMEDIATE');
  try {
    host.store.db.prepare("UPDATE bot_work_messages SET status=?,updated_at=? WHERE id=? AND status='processing'").run(status==='completed'?'processed':'failed',nowIso(),String(row.id));
    if(context.taskId&&(context.priorTask?.status!=='cancelled'||status==='unknown'))host.store.db.prepare("UPDATE bot_work_tasks SET status=?,result=?,failure_reason=?,updated_at=? WHERE id=? AND (status IN ('running','waiting_approval') OR (status='cancelled' AND ?='unknown'))").run(status,result,failure,nowIso(),context.taskId,status);
    if(context.taskId)publishBotTaskResult(host,row,context.taskId,status,result,failure);
    const fresh=host.store.getSession(String(row.session_id));
    if(fresh&&fresh.metadata?.botWorkTaskId===context.taskId)host.store.updateSession(fresh.id,{metadata:{...fresh.metadata,botWorkTaskId:undefined}});
    releaseBotSession(host.store,String(row.session_id),owner,fence);
    host.store.db.exec('COMMIT');if(context.taskId)clearBotTaskDeadline(host.store,context.taskId);
  }catch(error){host.store.db.exec('ROLLBACK');throw error;}
}
function completeProcessing(host:BotWorkHost,row:Record<string,unknown>,fence:number,owner:string,error?:unknown):void {
  if(!leaseValid(host.store,String(row.session_id),owner,fence))return;
  const context=processingContext(host,row,error);
  if(processingAwaitsApproval(host,row,context))return;
  const result=lastAssistant(host.store,String(row.session_id),String(row.message_ref));
  const status=processingStatus(context,result);
  persistProcessingResult(host,row,context,status,result,processingFailure(context,status,result),owner,fence);
}
function sessionCanDrain(host:BotWorkHost,session:SessionRecord|undefined):session is SessionRecord {
  if(!session)return false;
  if(hasPendingSessionWake(host.store,session.id))return false;
  if(host.store.db.prepare("SELECT 1 FROM bot_work_messages WHERE session_id=? AND status='processing' LIMIT 1").get(session.id))return false;
  if(active(host.store).has(session.id)||host.isSessionRunning?.(session.id))return false;
  return session.status!=='running'&&session.status!=='waiting_approval';
}
function pendingMessageCanRun(host:BotWorkHost,row:Record<string,unknown>):boolean {
  const [tenantId,userId]=JSON.parse(String(row.principal)) as [string,string];
  const control=botWorkControl(host.store,{userId,...(tenantId?{tenantId}:{})},String(row.target_bot));
  if(control.paused||control.disabled)return false;
  if(row.kind!=='task')return true;
  const task=host.store.db.prepare('SELECT status,deadline FROM bot_work_tasks WHERE id=?').get(String(row.task_id)) as {status:string;deadline?:string};
  if(task.status!=='cancelled'&&(!task.deadline||Date.parse(task.deadline)>Date.now()))return true;
  host.store.db.prepare("UPDATE bot_work_messages SET status='failed' WHERE id=?").run(String(row.id));
  if(task.status!=='cancelled')host.store.db.prepare("UPDATE bot_work_tasks SET status='failed',failure_reason='Deadline elapsed before execution',updated_at=? WHERE id=?").run(nowIso(),String(row.task_id));
  return false;
}
function claimPendingMessage(host:BotWorkHost,session:SessionRecord,row:Record<string,unknown>,owner:string):number|undefined {
  const taskId=row.kind==='task'?String(row.task_id):undefined;
  host.store.db.exec('BEGIN IMMEDIATE');
  try {
    const fence=claimBotSession(host.store,session.id,owner);
    if(fence===undefined){host.store.db.exec('COMMIT');return undefined;}
    const sender=host.store.getBot(String(row.sender_bot));
    const sourceRoom=typeof row.source_room==='string'&&row.source_room?row.source_room:undefined;
    const fromRoom=sourceRoom?` (from room ${sourceRoom})`:'';
    const written=host.store.appendMessage(session.id,'user',[{type:'text',text:`Message from ${sender?.name??row.sender_bot} / ${row.sender_bot}${fromRoom}: ${row.body}`}]);
    row.message_ref=written.id;row.updated_at=nowIso();
    const prior={...(host.store.getSession(session.id)!.metadata??{})};
    delete prior.sourceRoomId;
    host.store.updateSession(session.id,{metadata:{...prior,relayHop:Number(row.hop),relayHopMessageId:written.id,botWorkTaskId:taskId,outcome:undefined,botWorkStartBarrier:undefined}});
    host.store.db.prepare("UPDATE bot_work_messages SET status=?,message_ref=?,attempt=attempt+1,updated_at=? WHERE id=? AND status='pending'").run(row.wake?'processing':'processed',written.id,nowIso(),String(row.id));
    if(taskId)host.store.db.prepare("UPDATE bot_work_tasks SET status='running',attempt=attempt+1,updated_at=? WHERE id=? AND status='queued'").run(nowIso(),taskId);
    if(row.wake)stampSessionWake(host.store,session.id,{kind:'unattended',source:taskId?'delegation':'bot-message'});
    else releaseBotSession(host.store,session.id,owner,fence);
    host.store.db.exec('COMMIT');return fence;
  }catch(error){host.store.db.exec('ROLLBACK');throw error;}
}
function armBotTaskDeadline(host:BotWorkHost,row:Record<string,unknown>):ReturnType<typeof setTimeout>|undefined {
  if(row.kind!=='task')return undefined;
  const task=host.store.db.prepare('SELECT deadline FROM bot_work_tasks WHERE id=?').get(String(row.task_id)) as {deadline?:string};
  if(!task.deadline)return undefined;
  const id=String(row.task_id);clearBotTaskDeadline(host.store,id);
  let timers=taskDeadlineTimers.get(host.store);if(!timers){timers=new Map();taskDeadlineTimers.set(host.store,timers);}
  const timer=setTimeout(()=>{timers!.delete(id);expireOverdueBotWork(host,String(row.session_id));},Math.max(1,Date.parse(task.deadline)-Date.now()));
  timers.set(id,timer);
  timer.unref();return timer;
}
function startClaimedBotRun(host:BotWorkHost,session:SessionRecord,row:Record<string,unknown>,owner:string,fence:number):void {
  if(session.status==='failed'||session.status==='completed')host.store.updateSession(session.id,{status:'idle'});
  active(host.store).add(session.id);
  const deadline=armBotTaskDeadline(host,row);
  const heartbeat=setInterval(()=>{
    try{host.store.db.prepare('UPDATE bot_work_leases SET expires=? WHERE session_id=? AND owner=? AND fence=?').run(Date.now()+60_000,session.id,owner,fence);}
    catch{clearInterval(heartbeat);}
  },15_000);heartbeat.unref();
  const cleanup=()=>{if(deadline){const state=host.store.db.prepare('SELECT status FROM bot_work_messages WHERE id=?').get(String(row.id)) as {status:string};if(state.status!=='processing')clearBotTaskDeadline(host.store,String(row.task_id));}clearInterval(heartbeat);active(host.store).delete(session.id);};
  try {
    void Promise.resolve(host.runSession(session.id))
      .then(()=>completeProcessing(host,row,fence,owner),error=>completeProcessing(host,row,fence,owner,error))
      .catch(error=>host.log.warn('Bot work completion failed',{sessionId:session.id,error:String(error)}))
      .finally(cleanup);
  }catch(error){cleanup();completeProcessing(host,row,fence,owner,error);}
}
/** Receive and lease claim commit before the model starts; one session has one executor. */
export function drainBotSession(host:BotWorkHost,sessionId:string):boolean {
  ensureBotWorkSchema(host.store);const session=host.store.getSession(sessionId);
  if(!sessionCanDrain(host,session))return false;
  const row=host.store.db.prepare("SELECT * FROM bot_work_messages WHERE session_id=? AND status='pending' ORDER BY seq LIMIT 1").get(sessionId) as Record<string,unknown>|undefined;
  if(!row||!pendingMessageCanRun(host,row))return false;
  const owner=createId('worker'),fence=claimPendingMessage(host,session,row,owner);
  if(fence===undefined||!row.wake)return false;
  startClaimedBotRun(host,session,row,owner,fence);
  return true;
}
function pendingHumanSources(store:SqliteStateStore,sessionId:string,messages:ReturnType<SqliteStateStore['foldMessages']>):Set<string> {
 const receipts=store.getDaemonControl<{pending?:{id:string;kind?:string;key?:string;role?:string;seq:number;summaryId?:string;summarySeqFloor?:number;deliveryKey?:string;deliverySeqFloor?:number}[]}>(`session.humanContinuation:${sessionId}`)?.pending??[];
 const humans=receipts.filter(receipt=>receipt.kind!=='steer'),ids=new Set(humans.map(receipt=>receipt.id));
 for(const receipt of humans.filter(item=>item.deliveryKey))for(const message of messages)if(message.role==='user'&&message.key===receipt.deliveryKey&&Number(message.seq)>(receipt.deliverySeqFloor??receipt.seq))ids.add(message.id);
 for(const receipt of receipts.filter(item=>item.kind==='steer'))for(const message of messages){
  const key=receipt.summaryId?'inbox-overflow':receipt.key,role=receipt.summaryId?'system':receipt.role;
  if(key&&message.key===key&&message.role===role&&Number(message.seq)>(receipt.summarySeqFloor??receipt.seq))ids.add(message.id);
 }
 return ids;
}
/** Hide retired execution ranges atomically while keeping accepted human source ids visible. */
function retireBotExecution(store:SqliteStateStore,sessionId:string,entries:Record<string,unknown>[],reason:string):void {
 const session=store.getSession(sessionId);if(!session)return;
 closeOpenToolWave(store,sessionId,'interrupted');
 const messages=store.foldMessages(sessionId),protectedIds=pendingHumanSources(store,sessionId,messages);
 const anchors=entries.map(row=>(store.db.prepare('SELECT seq FROM session_messages WHERE session_id=? AND id=?').get(sessionId,String(row.message_ref)) as {seq:number}|undefined)?.seq).filter((seq):seq is number=>seq!==undefined);
 const first=anchors.length?Math.min(...anchors):Infinity,retiredIds=new Set<string>();let start:number|undefined,end:number|undefined;
 const flush=()=>{if(start!==undefined&&end!==undefined)store.hideRange(sessionId,start,end);start=undefined;end=undefined;};
 for(const message of messages){const seq=Number(message.seq);if(seq<first)continue;if(protectedIds.has(message.id)){flush();continue;}retiredIds.add(message.id);if(end!==undefined&&seq!==end+1)flush();start??=seq;end=seq;}flush();
 const lastUser=store.foldMessages(sessionId).filter(message=>message.role==='user'&&!protectedIds.has(message.id)).at(-1)?.id??null;
 store.appendMessage(sessionId,'system',[{type:'text',text:`[recovery:unknown] ${reason}. Previous execution of messages ${entries.map(row=>row.id).join(', ')} and tasks ${entries.filter(row=>row.kind==='task').map(row=>row.task_id).join(', ')||'(none)'} is retired. Any effects are UNCONFIRMED. Do not resume or repeat those actions without explicit verification. Process only fresh accepted input. Original traces remain searchable.`}],{key:`recovery:${entries[0]!.id}`});
 const retiredContext=retireTaskContextSources(session,retiredIds);
 store.updateSession(sessionId,{status:'idle',todo:retiredContext.todo,metadata:{...retiredContext.metadata,outcome:{kind:'idle',reason:'end'},botRecoveryUnknown:entries.map(row=>row.id),botWorkStartBarrier:{lastUserId:lastUser,reason}}});
}
/** A parked old execution needs fresh input or an explicitly verified task retry. */
export function isBotWorkSessionBlocked(store:SqliteStateStore,sessionId:string):boolean {
 ensureBotWorkSchema(store);
 if(store.db.prepare("SELECT 1 FROM bot_work_messages m JOIN bot_work_tasks t ON t.id=m.task_id WHERE m.session_id=? AND m.status='processing' AND (t.status IN ('unknown','cancelled') OR (t.deadline IS NOT NULL AND t.deadline<=?)) LIMIT 1").get(sessionId,nowIso()))return true;
 const session=store.getSession(sessionId),barrier=session?.metadata?.botWorkStartBarrier as {lastUserId:string|null}|undefined;if(!barrier)return false;
 if((store.getDaemonControl<{pending?:unknown[]}>(`session.humanContinuation:${sessionId}`)?.pending?.length??0)>0||store.db.prepare('SELECT 1 FROM session_inbox WHERE session_id=? AND claimed_at IS NULL LIMIT 1').get(sessionId))return false;
 return (store.foldMessages(sessionId).filter(message=>message.role==='user').at(-1)?.id??null)===barrier.lastUserId;
}
/** Also retires cancelled paused work. Invoke before approve/start, not only from scheduler ticks. */
export function expireOverdueBotWork(host:BotWorkHost,sessionId?:string):boolean {
 ensureBotWorkSchema(host.store);
 const rows=host.store.db.prepare(`SELECT m.*,t.status AS task_status FROM bot_work_messages m JOIN bot_work_tasks t ON t.id=m.task_id
  WHERE m.status='processing' AND (? IS NULL OR m.session_id=?) AND (t.status='cancelled' OR (t.deadline IS NOT NULL AND t.deadline<=? AND t.status IN ('running','waiting_approval','unknown')))`)
  .all(sessionId??null,sessionId??null,nowIso()) as Record<string,unknown>[];
 for(const row of rows){const id=String(row.session_id);
  host.store.db.exec('BEGIN IMMEDIATE');try{
   host.store.db.prepare("UPDATE bot_work_tasks SET status='unknown',failure_reason='Deadline exceeded; verify effects before retry',updated_at=? WHERE id=? AND status IN ('running','waiting_approval')").run(nowIso(),String(row.task_id));
   host.store.db.prepare('UPDATE bot_work_leases SET fence=fence+1,expires=0 WHERE session_id=?').run(id);host.store.db.exec('COMMIT');
  }catch(error){host.store.db.exec('ROLLBACK');throw error;}
  host.cancelSession?.(id);
  if(active(host.store).has(id)||host.isSessionRunning?.(id)||host.store.getSession(id)?.status==='running')continue;
  host.store.db.exec('BEGIN IMMEDIATE');try{
   for(const approval of host.store.listApprovals({status:'pending'}).filter(item=>item.sessionId===id&&Date.parse(item.createdAt)>=Date.parse(String(row.updated_at))))host.store.markApprovalExpired(approval.id,row.task_status==='cancelled'?'Task cancelled before execution':'Task deadline expired before execution');
   retireBotExecution(host.store,id,[row],row.task_status==='cancelled'?'Task cancelled':'Task deadline elapsed');host.store.db.exec('COMMIT');
  }catch(error){host.store.db.exec('ROLLBACK');throw error;}
  const lease=host.store.db.prepare('SELECT owner,fence FROM bot_work_leases WHERE session_id=?').get(id) as {owner:string;fence:number}|undefined;
  if(lease)completeProcessing(host,row,lease.fence,lease.owner);
 }
 return rows.length>0;
}
/** Boot recovery fences old attempts; unconfirmed processing is never blindly rerun. */
export function recoverBotWork(store:SqliteStateStore):void {
 ensureBotWorkSchema(store);
 const interrupted=store.db.prepare("SELECT * FROM bot_work_messages WHERE status='processing' AND session_id IN (SELECT id FROM sessions WHERE status != 'waiting_approval')").all() as Record<string,unknown>[];
 store.db.exec('BEGIN IMMEDIATE');
 try {
  for(const id of new Set(interrupted.map(row=>String(row.session_id)))) {
   retireBotExecution(store,id,interrupted.filter(row=>row.session_id===id),'Execution interrupted');
  }
  store.db.exec("UPDATE bot_work_tasks SET status='unknown',failure_reason='Execution context missing; verify effects before retry',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('running','waiting_approval') AND id IN (SELECT task_id FROM bot_work_messages WHERE status='processing' AND session_id NOT IN (SELECT id FROM sessions)); UPDATE bot_work_messages SET status='failed' WHERE status='processing' AND session_id NOT IN (SELECT id FROM sessions); UPDATE bot_work_tasks SET status='waiting_approval' WHERE status='running' AND id IN (SELECT task_id FROM bot_work_messages WHERE status='processing' AND session_id IN (SELECT id FROM sessions WHERE status='waiting_approval')); UPDATE bot_work_tasks SET status='unknown',failure_reason='Process interrupted; verify side effects before retry',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='running'; UPDATE bot_work_messages SET status='failed' WHERE status='processing' AND session_id NOT IN (SELECT id FROM sessions WHERE status='waiting_approval') AND (kind != 'task' OR task_id IN (SELECT id FROM bot_work_tasks WHERE status='unknown')); UPDATE bot_work_leases SET fence=fence+1,expires=0;");
  store.db.exec('COMMIT');
 }catch(err){store.db.exec('ROLLBACK');throw err;}
}
export async function tickBotWork(host:BotWorkHost):Promise<void> {
 ensureBotWorkSchema(host.store);expireOverdueBotWork(host);
 // A missing chat does not revoke already accepted pending work. Repair only its recorded principal.
 for(const row of host.store.db.prepare("SELECT m.* FROM bot_work_messages m LEFT JOIN sessions s ON s.id=m.session_id WHERE m.status='pending' AND s.id IS NULL").all() as Record<string,unknown>[]){
  try{const [tenantId,userId]=JSON.parse(String(row.principal)) as [string,string];const context=openBotWorkContext(host,String(row.target_bot),{userId,...(tenantId?{tenantId}:{})});host.store.db.prepare("UPDATE bot_work_messages SET session_id=?,updated_at=? WHERE id=? AND status='pending'").run(context.id,nowIso(),String(row.id));}catch(error){host.log.warn('Pending Bot context repair blocked',{messageId:row.id,error:String(error)});}
 }
 // Approvals resume through the existing runtime; completion is observed after it ends.
 for(const row of host.store.db.prepare("SELECT * FROM bot_work_messages WHERE status='processing'").all() as Record<string,unknown>[]){
 const id=String(row.session_id);if(active(host.store).has(id)||host.isSessionRunning?.(id))continue;
 const session=host.store.getSession(id);if(session?.status==='running'||session?.status==='waiting_approval')continue;
 const lease=host.store.db.prepare('SELECT owner,fence FROM bot_work_leases WHERE session_id=?').get(id) as {owner:string;fence:number}|undefined;
 if(lease){if(resumeApprovedBotSession(host,id,String(row.updated_at),error=>completeProcessing(host,row,lease.fence,lease.owner,error)))continue;completeProcessing(host,row,lease.fence,lease.owner);}
 }
 for(const row of host.store.db.prepare("SELECT DISTINCT session_id FROM bot_work_messages WHERE status='pending'").all() as {session_id:string}[])drainBotSession(host,row.session_id);
 // Allow immediately resolved deterministic runners to commit within this tick.
 await Promise.resolve();
}
export function cancelBotTask(host:BotWorkHost,principal:BotPrincipal,id:string):BotTask {
 const task=getBotTask(host.store,principal,id);if(!task)throw new ValidationError('Task not found');
 if(['completed','failed','unknown','cancelled'].includes(task.status))return task;
 host.store.db.prepare("UPDATE bot_work_tasks SET status='cancelled',updated_at=? WHERE id=? AND principal=?").run(nowIso(),id,botPrincipalKey(principal));
 host.store.db.prepare("UPDATE bot_work_messages SET status='failed' WHERE task_id=? AND status='pending'").run(id);
 const running=host.store.db.prepare("SELECT session_id FROM bot_work_messages WHERE task_id=? AND status='processing'").get(id) as {session_id:string}|undefined;
 if(running)expireOverdueBotWork(host,running.session_id);
 return getBotTask(host.store,principal,id)!;
}
export function retryBotTask(host:BotWorkHost,principal:BotPrincipal,id:string,confirmUnknown=false):BotTask {
 const task=getBotTask(host.store,principal,id);if(!task)throw new ValidationError('Task not found');
 if(!['failed','unknown','cancelled'].includes(task.status))throw new ValidationError('Only failed, unknown or cancelled tasks can be retried');
 if(task.status==='unknown'&&!confirmUnknown)throw new ValidationError('Confirm side-effect verification before retrying unknown work');
 const message=host.store.db.prepare("SELECT session_id FROM bot_work_messages WHERE task_id=? AND kind='task'").get(id) as {session_id:string}|undefined;
 if(!message)throw new ValidationError('Task input message missing');
 if(active(host.store).has(message.session_id)||host.isSessionRunning?.(message.session_id))throw new ValidationError('Previous execution is still active');
 host.store.db.exec('BEGIN IMMEDIATE');
 try{host.store.db.prepare("UPDATE bot_work_tasks SET status='queued',failure_reason=NULL,result=NULL,deadline=NULL,updated_at=? WHERE id=?").run(nowIso(),id);host.store.db.prepare("UPDATE bot_work_messages SET status='pending',message_ref=NULL,updated_at=? WHERE task_id=? AND kind='task'").run(nowIso(),id);host.store.db.prepare('UPDATE bot_work_leases SET expires=0,fence=fence+1 WHERE session_id=?').run(message.session_id);host.store.db.exec('COMMIT');}catch(err){host.store.db.exec('ROLLBACK');throw err;}
 return getBotTask(host.store,principal,id)!;
}
/** Project canonical ids before hydrating; isolated Routine/Room contexts never enter this view. */
function canonicalChatsForPrincipal(store:SqliteStateStore,principal:BotPrincipal,installation:BotPrincipal):Map<string,NonNullable<ReturnType<SqliteStateStore['getSession']>>> {
 const rows=store.db.prepare(`SELECT id FROM sessions
  WHERE json_extract(metadata_json,'$.canonicalBotChat')=1 AND (
   (json_type(metadata_json,'$.userId')='text' AND trim(json_extract(metadata_json,'$.userId'))=?
    AND coalesce(trim(json_extract(metadata_json,'$.tenantId')),'')=?)
   OR (?=1 AND (json_type(metadata_json,'$.userId') IS NULL
    OR json_type(metadata_json,'$.userId')!='text' OR trim(json_extract(metadata_json,'$.userId'))=''))
  ) ORDER BY updated_at DESC`).all(principal.userId,principal.tenantId??'',sameBotPrincipal(principal,installation)?1:0) as {id:string}[];
 const chats=new Map<string,NonNullable<ReturnType<SqliteStateStore['getSession']>>>();
 for(const row of rows){const session=store.getSession(row.id);if(session&&!chats.has(session.agentId))chats.set(session.agentId,session);}
 return chats;
}
export function botWorkStatus(host:BotWorkHost,principal:BotPrincipal):unknown[] {
 ensureBotWorkSchema(host.store);const tasks=listBotTasks(host.store,principal).filter(task=>UNRESOLVED_BOT_TASKS.includes(task.status));const countsByBot=new Map<string,Record<string,number>>();for(const row of host.store.db.prepare('SELECT target_bot,status,count(*) AS n FROM bot_work_tasks WHERE principal=? GROUP BY target_bot,status').all(botPrincipalKey(principal)) as {target_bot:string;status:string;n:number}[]){const counts=countsByBot.get(row.target_bot)??{};counts[row.status]=row.n;countsByBot.set(row.target_bot,counts);}const installation=resolveBotPrincipal(host.store);const chats=canonicalChatsForPrincipal(host.store,principal,installation);
 return host.store.listBots({includeHidden:true}).flatMap(bot=>{
  const canonical=host.store.getSession(bot.canonicalSessionId);
  const owner=canonical?principalFromSession(host.store,canonical):botDefinitionOwner(host.store,bot.id);if(!owner)return [];if(!sameBotPrincipal(owner,principal)&&!sameBotPrincipal(owner,installation))return [];
  const mine=chats.get(bot.id);
  const pending=host.store.db.prepare("SELECT count(*) AS n FROM bot_work_messages WHERE principal=? AND target_bot=? AND status='pending'").get(botPrincipalKey(principal),bot.id) as {n:number};
  return [{bot,control:botWorkControl(host.store,principal,bot.id),sessionId:mine?.id??null,status:mine?.status??(canonical?'idle':'unknown'),pending:pending.n,taskCounts:countsByBot.get(bot.id)??{},tasks:tasks.filter(t=>t.targetBotId===bot.id)}];
 });
}
export function ensureSuperBot(host:BotWorkHost,principal:BotPrincipal):{bot:ReturnType<typeof createBot>;sessionId:string;createdSession:boolean} {
 const key='bot.superBotId';let id=host.store.getDaemonControl<string>(key);let bot=id?host.store.getBot(id):undefined;
 if(!bot){const name=host.store.getBotByName('Super Bot')?'Super Bot (builtin)':'Super Bot';bot=createBot(facade(host),{name,title:'Team coordinator',description:'Coordinate authorized bots. Use bot_team_status, bot_delegate and bot_task_results. You can also create and update bots, group chats, and saved Lab settings with bot_create, bot_update, bot_room_create, bot_room_update, and lab_settings_update. Do not claim you lack that ability. Track task ids, report failures and unfinished work accurately. Never bypass another bot permission or approve for the user.'},{builtin:true});host.store.setDaemonControl(key,bot.id);}
 const opened=openBot(facade(host),bot.id,principal);return {...opened,bot};
}
export function createBotManagementTools(host:BotWorkHost):ToolContract<any>[] {
 const schema={type:'object',properties:{}};
 return [
 {name:'bot_team_status',description:'List authorized bots, current session and delegated task statuses. Includes hidden bots.',inputSchema:schema,approvalMode:'never',sideEffectLevel:'none',async execute(ctx){return {ok:true,content:JSON.stringify(botWorkStatus(host,principalFromSession(host.store,ctx.session)))};}},
 {name:'bot_delegate',description:'Persist and track a task for an authorized bot, even while it is busy. Returns task ID and queued status; does not mean completed.',inputSchema:{type:'object',properties:{target:{type:'string'},input:{type:'string'},idempotencyKey:{type:'string'},deadline:{type:'string'}},required:['target','input','idempotencyKey']},approvalMode:'never',sideEffectLevel:'none',async execute(ctx,args){try{if(ctx.session.metadata?.permissionMode==='plan')throw new ValidationError('Delegation is blocked in plan mode');const target=host.store.listBots({includeHidden:true}).find(b=>b.id===args.target||b.name===args.target);if(!target)throw new ValidationError('Unknown bot');const task=dispatchBotTask(host,{principal:principalFromSession(host.store,ctx.session),requesterBotId:String(ctx.session.metadata?.botId??ctx.agent.id),targetBotId:target.id,input:String(args.input??''),idempotencyKey:String(args.idempotencyKey??''),deadline:args.deadline});void tickBotWork(host);return {ok:true,content:JSON.stringify(task)};}catch(err){return {ok:false,content:JSON.stringify({error:String(err),...(err instanceof BotQueueCapacityError?{accepted:false,retryable:true,error_code:err.code,usage:err.usage,limits:err.limits}:{})})};}}},
 {name:'bot_task_results',description:'Query all unresolved tasks plus a paged terminal history. Follow nextCursor to inspect older results. Never infer completion from dispatch.',inputSchema:{type:'object',properties:{cursor:{type:'string'},limit:{type:'number'}}},approvalMode:'never',sideEffectLevel:'none',async execute(ctx,args){try{return {ok:true,content:JSON.stringify(botTaskPage(host.store,principalFromSession(host.store,ctx.session),{cursor:args?.cursor,limit:args?.limit}))};}catch(error){return {ok:false,content:JSON.stringify({error:String(error)})};}}}
 ];
}
