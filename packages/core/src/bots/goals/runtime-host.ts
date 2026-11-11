import { botConversationRequest } from '../conversation-reply.js';
import {hasWaitReceipt} from '../../waits/receipt.js';
import {DurableWaitStore} from '../../waits/store.js';
import {DURABLE_WAIT_DEFAULT,parkGoalDurableWait} from '../../waits/default-park.js';
import { createHash } from 'node:crypto';
import { GOAL_JUDGE_TIMEOUT_MS } from './judge-budget.js';
import { evidenceTranscript, goalExecutionEvidence } from './execution-evidence.js';
import { buildCompletionEvidence, completionReport, COMPLETION_JUDGE_PROMPT, type CompletionEvidence } from './completion-evidence.js';
import type { SqliteStateStore } from '../../storage.js';
import type { SessionRecord, ToolContract, ModelAdapter } from '../../types.js';
import { BotGoalService } from './service.js';
import { classifyGoalIntents, isSelfContainedBotWork, releaseOpenInquiry, releaseSelfContainedBotWork, type GoalIntentProposal } from './intake.js';
import { GOAL_INTAKE_BUSY_WAIT_MS, withSqliteBusyWait } from './store.js';
import { selectGoalRoute, goalNeedsIsolatedExecutor, goalSpecialist, goalWorkKind, type GoalCapabilities, type GoalStrategy, type GoalWorkKind } from './routing.js';
import type { BotGoal, GoalReport } from './types.js';
import { listPendingHumanWork } from '../../session/human-continuation.js';
import { preserveGoalBudgetReport } from './budget.js';
import { isGoalWorkerCurrent } from './worker-fence.js';
import { WriterClaimError } from '../../session/writer-claim.js';
import { readBotFinishSettings } from './finish-settings.js';
import { CONTINUE_UNBOUND_INSTRUCTION, FOLLOWUP_JUDGE_PROMPT, followupInstruction, followupKind, isOpenGoal, mayConcernGoal, parseFollowupVerdict, planFollowup, recentOpenGoal, type FollowupKind, type FollowupPlan } from './followup.js';
import { TURN_LIMIT_REASON } from '../../session/run-outcome.js';

/** Trace kinds the goal runtime writes. */
export type GoalTraceKind = 'child_session' | 'goal_eval' | 'goal_intake' | 'finish_check' | 'finish_wake';

export interface GoalRuntimeHost {
 store: SqliteStateStore;
 isRunning(id:string):boolean;
 cancel(id:string):void;
 run(id:string):Promise<unknown>;
 capabilities(session:SessionRecord,goal:BotGoal):GoalCapabilities;
 inspectSpecialty?(parent:SessionRecord,goal:BotGoal):{status:string;evidence:string[];draining?:boolean};
 cancelSpecialty?(parent:SessionRecord,goal:BotGoal):boolean|Promise<boolean>;
 judge?: ModelAdapter['completeText'];
 judgeForSession?(session: SessionRecord): ModelAdapter['completeText'];
 emitTrace?(sessionId: string, event: { kind: GoalTraceKind; payload: Record<string, unknown> }): void;
 /** True when this process no longer owns the execution, including after a restart. */
 executionInterrupted?(sessionId: string): boolean;
 /** Missing means the external effect is unverified and must not be resumed. */
 hasUnconfirmedEffects?(sessionId: string, startedAt: string): boolean;
}
/** Short terminal notice — keep the chat quiet; Lab surfaces still hold full state. */
export function formatQuietGoalNotice(goal:BotGoal):string {
 const title=(goal.title??'').trim()||goal.id;
 const reason=(goal.blockedReason??'').trim();
 if(goal.status==='completed')return `[goal update] Done: ${title}`;
 if(goal.status==='failed')return `[goal update] Failed: ${title}${reason?` — ${reason}`:''}`;
 if(goal.status==='blocked')return `[goal update] Blocked: ${title}${reason?` — ${reason}`:''}`;
 if(goal.status==='pending_review')return `[goal update] Result returned (not automatically verified): ${title}`;
 return `[goal update] ${title}: ${goal.status}`;
}
export function announceGoalState(host:GoalRuntimeHost,goal:BotGoal):void {
 host.store.transaction(()=>{
 goal=new BotGoalService(host.store,Date.now,goal.sessionId).get(goal.botId,goal.id)??goal;
 if(!['completed','blocked','failed'].includes(goal.status))return;
 const key=`bot.goal-notice:${goal.id}`;
 const version=`${goal.revision}:${goal.status}:${goal.blockedReason??''}`;
 if(host.store.getDaemonControl<string>(key)===version)return;
  host.store.setDaemonControl(key,version);
  host.store.appendMessage(goal.sessionId,'system',[{type:'text',text:formatQuietGoalNotice(goal)}],{key:`goal-notice:${goal.id}:${version}`});
 });
}
export function usesDurableBotGoals(store:Pick<SqliteStateStore,'getSession'>,session:SessionRecord):boolean {
 const botId=session.metadata?.botId;
 const sessionId=session.metadata?.canonicalBotChat===true?session.id:session.metadata?.botGoalScopeSessionId;
 if(typeof botId!=='string'||typeof sessionId!=='string')return false;
 const parent=store.getSession(sessionId);
 if(!parent||parent.metadata?.botId!==botId||parent.metadata?.canonicalBotChat!==true)return false;
 if(parent.metadata.userId!==session.metadata.userId||parent.metadata.tenantId!==session.metadata.tenantId)return false;
 if(session.id===parent.id)return true;
 const visited=new Set<string>();
 let ancestor=session.parentSessionId;
 while(ancestor&&!visited.has(ancestor)) {
  if(ancestor===parent.id)return true;
  visited.add(ancestor);
  ancestor=store.getSession(ancestor)?.parentSessionId;
 }
 return false;
}
export function goalScope(store:SqliteStateStore,session:SessionRecord):{botId:string;sessionId:string;service:BotGoalService}|undefined {
 if(!usesDurableBotGoals(store,session))return undefined;
 const botId=session.metadata.botId as string;
 const sessionId=(session.metadata.canonicalBotChat===true?session.id:session.metadata.botGoalScopeSessionId) as string;
 return {botId,sessionId,service:new BotGoalService(store,Date.now,sessionId)};
}
/** Durable Bot goals own completion; session goals remain available for ordinary chats. */
export function resolveSessionBotGoal(store:SqliteStateStore,session:SessionRecord):BotGoal|undefined {
 const scope=goalScope(store,session);
 const id=session.metadata.botGoalId;
 if(!scope||typeof id!=='string')return undefined;
 return scope.service.get(scope.botId,id);
}
export { goalWorkKind };
export function goalExecutionTask(goal:BotGoal):string {
 const next=goal.nextStep?.trim();
 if (next && !/^(Inspect authorized|Reconcile partial|Apply updated constraints)/.test(next)) return next;
 return goal.evidence.length || next ? 'Verify existing execution evidence against the objective and constraints; continue only the remaining work.' : goal.objective;
}

/** Every receipt is associated before the existing concurrent-fork planner sees it. */
const intakeLocks=new WeakMap<object,Map<string,Promise<void>>>();
export async function prepareGoalIntake(host:GoalRuntimeHost,session:SessionRecord):Promise<void> {
 let locks=intakeLocks.get(host.store);if(!locks){locks=new Map();intakeLocks.set(host.store,locks);}
 const prior=locks.get(session.id)??Promise.resolve();
 const current=prior.catch(()=>{}).then(()=>applyGoalIntake(host,session));locks.set(session.id,current);
 try{await current;}finally{if(locks.get(session.id)===current)locks.delete(session.id);}
}
function sessionJudge(host:GoalRuntimeHost,session:SessionRecord) {
 return host.judgeForSession ? host.judgeForSession(session) : host.judge;
}
function workspaceResources(session:SessionRecord,text:string):string[] {
 if(!/(修复|修改|实现|部署|删除|写入|\b(fix|implement|deploy|delete|write|modify)\b)/i.test(text))return [];
 return [`workspace:${session.workspaceId??'default'}`];
}
function newGoalSource(known:Record<string,string>,receiptId:string,sourceId:string):string {
 return known[receiptId]?.startsWith('goal_')?sourceId:receiptId;
}
function applyNewGoal(service:BotGoalService,session:SessionRecord,botId:string,intent:{text:string},known:Record<string,string>,receiptId:string,sourceId:string) {
 const goal=service.create({botId,sessionId:session.id,title:intent.text.slice(0,120),objective:intent.text,sourceMessageId:newGoalSource(known,receiptId,sourceId),resources:workspaceResources(session,intent.text),resumeRequested:known[receiptId]?.startsWith('goal_')});
 if(!known[receiptId]?.startsWith('goal_'))known[receiptId]=goal.id;
 return goal;
}
function steerRunningIntent(host:GoalRuntimeHost,sessionId:string,executionSessionId:string,intentKind:string,revision:number,constraints:unknown,receiptId:string):void {
 if(intentKind==='pause'||intentKind==='cancel'){host.cancel(executionSessionId);return;}
 if(intentKind!=='amend_goal')return;
 host.store.enqueueSteer(executionSessionId,`[goal revision ${revision}] Updated constraints: ${JSON.stringify(constraints)}. Reconcile previous actions.`,{role:'system',key:`goal-amend:${receiptId}`});
 host.cancel(executionSessionId);
}
function followRunningIntents(host:GoalRuntimeHost,botId:string,goalId:string,intentKind:string,revision:number,constraints:unknown,receiptId:string,service:BotGoalService):void {
 for(const execution of service.executions(botId,goalId).filter(execution=>execution.status==='running')){
  if(!execution.sessionId)continue;
  steerRunningIntent(host,goalId,execution.sessionId,intentKind,revision,constraints,receiptId);
 }
}
function askPriority(host:GoalRuntimeHost,sessionId:string,sourceId:string):void {
 host.store.enqueueSteer(sessionId,'[goal coordination] Ask which goal should change priority; keep other goals unchanged.',{role:'system',key:`goal-priority:${sourceId}`});
}
function intentResult(service:BotGoalService,session:SessionRecord,botId:string,intent:{kind:string;text:string;goalId?:string},known:Record<string,string>,receiptId:string,sourceId:string) {
 if(intent.kind==='new_goal')return {goal:applyNewGoal(service,session,botId,intent,known,receiptId,sourceId)};
 if(!known[receiptId]?.startsWith('goal_'))known[receiptId]=intent.kind;
 return service.applyIntent(botId,{...intent,kind:intent.kind as 'amend_goal',sourceMessageId:sourceId,sessionId:session.id});
}
function announceClarification(host:GoalRuntimeHost,sessionId:string,sourceId:string,result:{duplicate?:boolean;clarification?:boolean}):boolean {
 if(result.duplicate)return true;
 if(!result.clarification)return false;
 host.store.enqueueSteer(sessionId,'[goal coordination] The latest message has an ambiguous goal reference. Ask which goal is intended; do not modify or cancel any goal.',{role:'system',key:`goal-clarify:${sourceId}`});
 return true;
}
function announceQuery(host:GoalRuntimeHost,session:SessionRecord,receiptId:string,goals:BotGoal[]|undefined):void {
 host.store.enqueueSteer(session.id,`[goal status] ${JSON.stringify(goals?.map(goal=>({id:goal.id,title:goal.title,status:goal.status,progress:goal.progress,nextStep:goal.nextStep,reason:goal.blockedReason,...(goal.wait&&['self_heal','factory','evolution'].includes(goal.wait.source)?{execution:host.inspectSpecialty?.(session,goal)}:{})})))}`,{role:'system',key:`goal-query:${receiptId}`});
}
function announceIntake(host:GoalRuntimeHost,session:SessionRecord,sourceId:string,receiptId:string,intent:{kind:string},result:{duplicate?:boolean;clarification?:boolean;goal?:BotGoal;goals?:BotGoal[]},service:BotGoalService,botId:string):void {
 if(announceClarification(host,session.id,sourceId,result))return;
 if(intent.kind==='query'){announceQuery(host,session,receiptId,result.goals);return;}
 if(result.goal&&intent.kind!=='new_goal')followRunningIntents(host,botId,result.goal.id,intent.kind,result.goal.revision,result.goal.constraints,receiptId,service);
}
function applyIntakeIntent(host:GoalRuntimeHost,session:SessionRecord,service:BotGoalService,botId:string,known:Record<string,string>,receiptId:string,intent:GoalIntentProposal,index:number):void {
 const sourceId=index===0?receiptId:`${receiptId}:${index}`;
 if(intent.kind==='chat')return;
 if(intent.kind==='reprioritize'){
  if(intent.goalId)service.reprioritize(botId,intent.goalId,intent.priority);
  else askPriority(host,session.id,sourceId);
  return;
 }
 try {
  announceIntake(host,session,sourceId,receiptId,intent,intentResult(service,session,botId,intent,known,receiptId,sourceId),service,botId);
 } catch(error) {
  if(!['resume','pause','cancel','amend_goal'].includes(intent.kind))throw error;
  host.store.enqueueSteer(session.id,`[goal control not applied] ${String(error)}. Explain the current state and available next action; preserve the existing execution and do not create replacement work.`,{role:'system',key:`goal-control-refused:${sourceId}`});
 }
}
interface IntakeRecord {
 messageId:string;
 text:string;
 intents:Array<{kind:string;goalId?:string}>;
 /** Why a message did not become the goal work its wording suggests. */
 downgrades:string[];
 followup?:{kind:FollowupKind|'continue_unbound';goalId?:string;action:string;reason:string};
}
interface ClassifiedReceipt { id:string; intents:GoalIntentProposal[]; record:IntakeRecord; plan?:FollowupPlan; continueUnbound?:boolean }
const ATTACH_PREFIX='bot.goal-attach:';
/** Receipts whose turn works on an existing goal instead of a new one. */
export function readGoalAttachments(store:Pick<SqliteStateStore,'getDaemonControl'>,sessionId:string):Record<string,string> {
 return store.getDaemonControl<Record<string,string>>(ATTACH_PREFIX+sessionId)??{};
}
function writeGoalAttachments(store:SqliteStateStore,sessionId:string,attachments:Record<string,string>):void {
 store.setDaemonControl(ATTACH_PREFIX+sessionId,attachments);
}
function receiptText(message:{parts:{type:string;text?:string}[]}|undefined):string {
 return message?.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';
}
/** Another human message since the goal last moved means a bare follow-up may be about that instead. */
function humanSpokeSince(messages:Iterable<{id:string;role:string;key?:string;createdAt:string;parts:{type:string;text?:string}[]}>,since:string,pending:Set<string>):boolean {
 for(const message of messages){
  if(message.role!=='user'||message.key||pending.has(message.id)||message.createdAt<=since)continue;
  if(!followupKind(receiptText(message)))return true;
 }
 return false;
}
function downgradeReasons(raw:GoalIntentProposal[],opened:GoalIntentProposal[],released:GoalIntentProposal[]):string[] {
 const reasons:string[]=[];
 released.forEach((intent,index)=>{
  if(raw[index]!.kind!==opened[index]!.kind)reasons.push('open_inquiry');
  else if(opened[index]!.kind!==intent.kind)reasons.push('self_contained');
  else if(intent.kind==='chat'&&/[?？]\s*$/.test(intent.text))reasons.push('question_mark');
 });
 return reasons;
}
async function confirmedAboutGoal(host:GoalRuntimeHost,session:SessionRecord,text:string,goal:BotGoal):Promise<boolean> {
 const judge=sessionJudge(host,session);
 if(!judge)return false;
 try{
  const output=await judge({system:FOLLOWUP_JUDGE_PROMPT,user:JSON.stringify({message:text,goal:{title:goal.title.slice(0,300),status:goal.status,progress:goal.progress.slice(0,600)}}),jsonMode:true,signal:AbortSignal.timeout(GOAL_JUDGE_TIMEOUT_MS)});
  return parseFollowupVerdict(output);
 }catch{return false;}
}
interface FollowupContext { host:GoalRuntimeHost; session:SessionRecord; goals:BotGoal[]; messages:Map<string,{id:string;role:string;key?:string;createdAt:string;parts:{type:string;text?:string}[]}>; pending:Set<string> }
async function followupFor(ctx:FollowupContext,text:string):Promise<{plan?:FollowupPlan;continueUnbound?:boolean}> {
 const settings=readBotFinishSettings(ctx.host.store);
 if(!settings.followupAttachEnabled||/^\s*\[goal:/.test(text))return {};
 const kind=followupKind(text);
 const goal=recentOpenGoal(ctx.goals,Date.now(),settings.followupWindowHours*3_600_000);
 if(kind&&goal&&!humanSpokeSince(ctx.messages.values(),goal.updatedAt,ctx.pending))return {plan:planFollowup(kind,goal)};
 if(kind==='continue'&&ctx.goals.filter(isOpenGoal).length!==1)return {continueUnbound:true};
 if(!kind&&goal&&mayConcernGoal(text)&&await confirmedAboutGoal(ctx.host,ctx.session,text,goal))return {plan:planFollowup('about_goal',goal)};
 return {};
}
async function classifyReceipt(ctx:FollowupContext,service:BotGoalService,botId:string,known:Record<string,string>,receipt:{id:string}):Promise<ClassifiedReceipt|undefined> {
 if(known[receipt.id])return;
 const text=receiptText(ctx.messages.get(receipt.id));
 if(!text.trim())return;
 const record:IntakeRecord={messageId:receipt.id,text:text.slice(0,200),intents:[],downgrades:[]};
 const request=botConversationRequest(text);
 if(request && request!=='format-receipt'){
  record.downgrades.push('conversation_request');
  return {id:receipt.id,intents:[{kind:'chat',text}],record};
 }
 const follow=await followupFor(ctx,text);
 if(follow.plan||follow.continueUnbound)return {id:receipt.id,intents:[{kind:'chat',text}],record,...follow};
 const raw=await classifyGoalIntents(text,service.list(botId));
 const opened=raw.map(releaseOpenInquiry);
 const released=opened.map(releaseSelfContainedBotWork);
 record.downgrades.push(...downgradeReasons(raw,opened,released));
 return {id:receipt.id,intents:released,record};
}
/** Make an idle goal claimable by this turn. A goal that cannot be reopened stays as it is. */
function reopenForFollowup(service:BotGoalService,botId:string,goal:BotGoal):boolean {
 try{
  if(goal.status==='blocked'||goal.status==='paused')service.control(botId,goal.id,'resume');
  else if(goal.status==='pending_review')service.control(botId,goal.id,'verify',{accepted:false,reason:'Check the recorded result against the objective, finish what remains, then report.'});
  return service.get(botId,goal.id)?.status==='queued';
 }catch{return false;}
}
function reportGoalStatus(host:GoalRuntimeHost,session:SessionRecord,receiptId:string,goal:BotGoal,note:string):void {
 host.store.enqueueSteer(session.id,`[goal status] ${JSON.stringify({id:goal.id,title:goal.title,status:goal.status,progress:goal.progress,nextStep:goal.nextStep,reason:goal.blockedReason})}\n${note}`,{role:'system',key:`goal-query:${receiptId}`});
}
function applyFollowup(host:GoalRuntimeHost,session:SessionRecord,scope:{botId:string;service:BotGoalService},known:Record<string,string>,item:ClassifiedReceipt):void {
 const plan=item.plan!;
 const goal=scope.service.get(scope.botId,plan.goalId);
 if(!goal)return;
 if(plan.action==='attach'&&reopenForFollowup(scope.service,scope.botId,goal)){
  writeGoalAttachments(host.store,session.id,{...readGoalAttachments(host.store,session.id),[item.id]:goal.id});
  host.store.enqueueSteer(session.id,followupInstruction(plan.kind,goal),{role:'system',key:`goal-followup:${item.id}`});
  known[item.id]=`attach:${goal.id}`;
  item.record.followup={kind:plan.kind,goalId:goal.id,action:'attach',reason:plan.reason};
  return;
 }
 const live=scope.service.get(scope.botId,goal.id)??goal;
 reportGoalStatus(host,session,item.id,live,'This goal is not started again by this message. Tell the user where it stands; do not start duplicate work.');
 item.record.followup={kind:plan.kind,goalId:goal.id,action:'status',reason:plan.action==='attach'?'reopen_refused':plan.reason};
}
function applyClassified(host:GoalRuntimeHost,session:SessionRecord,scope:{botId:string;service:BotGoalService},known:Record<string,string>,item:ClassifiedReceipt):void {
 if(item.plan){applyFollowup(host,session,scope,known,item);return;}
 if(item.continueUnbound){
  host.store.enqueueSteer(session.id,CONTINUE_UNBOUND_INSTRUCTION,{role:'system',key:`goal-followup:${item.id}`});
  item.record.followup={kind:'continue_unbound',action:'none',reason:'no_recent_goal'};
  return;
 }
 for(const [index,intent] of item.intents.entries())applyIntakeIntent(host,session,scope.service,scope.botId,known,item.id,intent,index);
}
function recordIntake(host:GoalRuntimeHost,session:SessionRecord,known:Record<string,string>,item:ClassifiedReceipt):void {
 item.record.intents=item.intents.map(intent=>({kind:intent.kind,...('goalId' in intent&&intent.goalId?{goalId:intent.goalId}:{})}));
 const created=known[item.id];
 host.emitTrace?.(session.id,{kind:'goal_intake',payload:{...item.record,...(created?.startsWith('goal_')?{createdGoalId:created}:{})}});
}
function prunedAttachments(store:SqliteStateStore,sessionId:string,pending:Set<string>):void {
 const attachments=readGoalAttachments(store,sessionId);
 const kept=Object.fromEntries(Object.entries(attachments).filter(([receipt])=>pending.has(receipt)));
 if(Object.keys(kept).length!==Object.keys(attachments).length)writeGoalAttachments(store,sessionId,kept);
}
async function ingestPending(host:GoalRuntimeHost,session:SessionRecord,scope:{botId:string;sessionId:string;service:BotGoalService}):Promise<void> {
 const pending=listPendingHumanWork(host.store,session.id);
 if(!pending.length)return;
 const messages=new Map(host.store.foldMessages(session.id).map(message=>[message.id,message]));
 const known=host.store.getDaemonControl<Record<string,string>>(`bot.goal-intake:${session.id}`)??{};
 const pendingIds=new Set(pending.map(receipt=>receipt.id));
 const ctx:FollowupContext={host,session,goals:scope.service.list(scope.botId),messages,pending:pendingIds};
 const classified:ClassifiedReceipt[]=[];
 for(const receipt of pending){
  const item=await classifyReceipt(ctx,scope.service,scope.botId,known,receipt);
  if(!item)continue;
  known[receipt.id]='chat';
  classified.push(item);
 }
 withSqliteBusyWait(host.store.db,GOAL_INTAKE_BUSY_WAIT_MS,()=>{
  prunedAttachments(host.store,session.id,pendingIds);
  for(const item of classified)applyClassified(host,session,scope,known,item);
  host.store.setDaemonControl(`bot.goal-intake:${session.id}`,known);
 });
 for(const item of classified)recordIntake(host,session,known,item);
}
async function applyGoalIntake(host:GoalRuntimeHost,session:SessionRecord):Promise<void> {
 try {
  if(session.metadata?.canonicalBotChat!==true)return;
  const scope=goalScope(host.store,session);
  if(!scope)return;
  await ingestPending(host,session,scope);
 } catch { return; }
}

function currentGoalOf(service:BotGoalService,botId:string,session:SessionRecord):BotGoal|undefined {
 return typeof session.metadata?.botGoalId==='string'?service.get(botId,session.metadata.botGoalId):undefined;
}
function substantiveText(part:{type:string;text?:string}):boolean {
 return part.type==='text'&&!!part.text?.trim()&&part.text.trim()!=='…';
}
function answeredInChat(host:GoalRuntimeHost,session:SessionRecord,goal:BotGoal):boolean {
 const messages=host.store.foldMessages(session.id);
 const sourceAt=goal.sourceMessageId?messages.find(message=>message.id===goal.sourceMessageId)?.createdAt:undefined;
 return messages.some(message=>message.role==='assistant'&&message.parts.some(substantiveText)&&(!sourceAt||message.createdAt>=sourceAt));
}
/** A goal the current chat already answered, with no unfinished next step and no request for another executor. */
export function goalAlreadyHandled(host:GoalRuntimeHost,session:SessionRecord,goal:BotGoal):boolean {
 if(session.metadata?.canonicalBotChat!==true||goal.attempts>0||goal.evidence.length>0)return false;
 if(goal.nextStep?.trim()||goal.resumeRequested)return false;
 const task=goalExecutionTask(goal);
 if(goalWorkKind(task)!=='general'||!isSelfContainedBotWork(task)||goalNeedsIsolatedExecutor(task)||goalSpecialist(task))return false;
 return answeredInChat(host,session,goal);
}
function executionStillRunning(service:BotGoalService,botId:string,session:SessionRecord,goal:BotGoal,currentId:string):boolean {
 const active=service.executions(botId,goal.id).find(execution=>execution.id===currentId);
 return goal.status==='running'&&active?.status==='running'&&active.sessionId===session.id&&active.goalRevision===goal.revision&&active.leaseUntil>Date.now();
}
function activeExecutionDecision(service:BotGoalService,botId:string,session:SessionRecord):boolean|undefined {
 const currentId=session.metadata?.botGoalExecutionId;
 const currentGoal=currentGoalOf(service,botId,session);
 if(typeof currentId!=='string'||!currentId||currentGoal?.activeExecutionId!==currentId)return undefined;
 return executionStillRunning(service,botId,session,currentGoal,currentId);
}
function blockedSubagent(session:SessionRecord,goal:BotGoal|undefined):boolean {
 return session.mode==='subagent'&&!!goal&&goal.status!=='queued';
}
/** The idle fork planner reserves the first unforked receipt for the foreground. */
function unforkedQueued(host:GoalRuntimeHost,session:SessionRecord,service:BotGoalService,botId:string):{goal:BotGoal;attached:boolean}|undefined {
 const forks=Array.isArray(session.metadata.concurrentBotForks)?session.metadata.concurrentBotForks:[];
 const forked=new Set(forks.map((fork:{sourceMessageId?:string})=>fork.sourceMessageId));
 const pending=listPendingHumanWork(host.store,session.id);
 if(!pending.length)return undefined;
 const goals=service.list(botId).filter(goal=>goal.status==='queued');
 const queued=new Map(goals.map(goal=>[goal.sourceMessageId,goal]));
 const attachments=readGoalAttachments(host.store,session.id);
 for(const receipt of pending){
  if(forked.has(receipt.id))continue;
  const attached=goals.find(goal=>goal.id===attachments[receipt.id]);
  if(attached)return {goal:attached,attached:true};
  const goal=queued.get(receipt.id);
  if(goal)return {goal,attached:false};
 }
 return undefined;
}
function queuedGoal(host:GoalRuntimeHost,session:SessionRecord,service:BotGoalService,botId:string,currentGoal:BotGoal|undefined):BotGoal|undefined {
 if(session.metadata?.canonicalBotChat!==true)return currentGoal?.status==='queued'?currentGoal:undefined;
 const queued=unforkedQueued(host,session,service,botId);
 if(!queued)return undefined;
 // A follow-up attached to an old goal is a request to work on it, whatever the chat already said.
 return !queued.attached&&goalAlreadyHandled(host,session,queued.goal)?undefined:queued.goal;
}
function modePreferenceOf(strategy:string):GoalWorkKind|undefined {
 if(strategy==='deep_research')return 'research';
 if(strategy==='browser')return 'browser';
 if(strategy==='computer')return 'computer';
 return undefined;
}
function preferredRoute(strategy:string,modePreference:GoalWorkKind|undefined):{preferredStrategy?:GoalStrategy} {
 if(strategy==='auto'||modePreference)return {};
 return {preferredStrategy:strategy as GoalStrategy};
}
function claimStrategy(session:SessionRecord,strategy:string|undefined):string {
 return session.mode==='subagent'&&strategy==='direct'?'subagent':strategy!;
}
function originalProfile(metadata:SessionRecord['metadata']):{taskRunMode:unknown;orchestrationEngine:unknown} {
 return {taskRunMode:metadata.taskRunMode??null,orchestrationEngine:metadata.orchestrationEngine??null};
}
function decidedBind(host:GoalRuntimeHost,session:SessionRecord,scope:NonNullable<ReturnType<typeof goalScope>>):{done:true;result:boolean}|{done:false;goal:BotGoal} {
 const active=activeExecutionDecision(scope.service,scope.botId,session);
 if(active!==undefined)return {done:true,result:active};
 const currentGoal=currentGoalOf(scope.service,scope.botId,session);
 if(blockedSubagent(session,currentGoal))return {done:true,result:false};
 const goal=queuedGoal(host,session,scope.service,scope.botId,currentGoal);
 if(!goal){
  // A settled foreground binding is still present on older sessions. Do not let
  // a new chat turn (or a child it spawns) inherit that execution's identity.
  if(session.metadata.canonicalBotChat===true && currentGoal && listPendingHumanWork(host.store,session.id).length){
   host.store.updateSession(session.id,{metadata:{...session.metadata,botGoalId:undefined,botGoalExecutionId:undefined,botGoalCheckpoint:undefined}});
  }
  return {done:true,result:true};
 }
 return {done:false,goal};
}
function startBoundGoal(host:GoalRuntimeHost,session:SessionRecord,scope:NonNullable<ReturnType<typeof goalScope>>,goal:BotGoal):boolean {
 const settings=scope.service.readSettings();
 const modePreference=modePreferenceOf(settings.preferredStrategy);
 const executionTask=goalExecutionTask(goal);
 const route=selectGoalRoute({task:executionTask,workKind:modePreference??goalWorkKind(executionTask),independentWork:false,...preferredRoute(settings.preferredStrategy,modePreference)},host.capabilities(session,goal));
 if(route.blocked){announceGoalState(host,scope.service.block(scope.botId,goal.id,route.reason));return false;}
 const execution=scope.service.claim(scope.botId,goal.id,{strategy:claimStrategy(session,route.strategy),strategyReason:route.reason,safeToRetry:false});
 if(!execution)return false;
 scope.service.updateExecution(scope.botId,execution.id,{sessionId:session.id,messageStartSeq:host.store.listSurfaceNodes(session.id).at(-1)?.seq??0,runRef:`session:${session.id}`});
 host.store.updateSession(session.id,{metadata:{...session.metadata,botGoalId:goal.id,botGoalExecutionId:execution.id,botGoalScopeSessionId:scope.sessionId,botGoalCostStart:Number(session.metadata.usageCostUsd??0),botGoalCheckpoint:undefined,botGoalOriginalProfile:originalProfile(session.metadata),taskRunMode:route.strategy==='direct'?route.taskMode:'auto',orchestrationEngine:'legacy'}});
 host.store.enqueueSteer(session.id,goalInstructions(goal,route.strategy!,route.reason),{role:'system',key:`goal-execution:${execution.id}`});
 return true;
}
/** An attached follow-up is used once. When the goal could not start, the turn explains why. */
function settleAttachment(host:GoalRuntimeHost,session:SessionRecord,scope:NonNullable<ReturnType<typeof goalScope>>,goal:BotGoal,bound:boolean):void {
 const attachments=readGoalAttachments(host.store,session.id);
 const receipt=Object.keys(attachments).find(id=>attachments[id]===goal.id);
 if(!receipt)return;
 const {[receipt]:_used,...rest}=attachments;
 writeGoalAttachments(host.store,session.id,rest);
 if(bound)return;
 const live=scope.service.get(scope.botId,goal.id)??goal;
 reportGoalStatus(host,session,receipt,live,'This goal could not be started in this turn. Tell the user its state and the reason; do not start replacement work.');
}
function answerCanonicalChat(session:SessionRecord,bound:boolean):boolean {
 return bound||session.metadata.canonicalBotChat===true;
}
export function bindGoalExecution(host:GoalRuntimeHost,session:SessionRecord):boolean {
 if(session.metadata.botWorkTaskId)return true;
 const scope=goalScope(host.store,session);
 if(!scope)return true;
 if(session.metadata.botGoalWorker===true)return isGoalWorkerCurrent(host.store,session);
 const decided=decidedBind(host,session,scope);
 const bound=decided.done?decided.result:startBoundGoal(host,session,scope,decided.goal);
 if(!decided.done)settleAttachment(host,session,scope,decided.goal,bound);
 return answerCanonicalChat(session,bound);
}
function goalInstructions(goal:BotGoal,strategy:string,reason:string):string {
 return `[goal ${goal.id} revision ${goal.revision}] Objective: ${goal.objective}\nResources: ${JSON.stringify(goal.resources)}\nConstraints: ${JSON.stringify(goal.constraints)}\nCompletion conditions: ${JSON.stringify(goal.completionCriteria)}\nExecution: ${strategy}. ${reason}\nPrevious progress: ${goal.progress}\nEvidence: ${JSON.stringify(goal.evidence)}\nNext step: ${goal.nextStep??''}\nTool observations are recorded automatically. Use goal_checkpoint only when available to preserve concrete progress or a durable wait condition; do not substitute another storage tool or create extra files just to record verification evidence. Report verification results in your response. Returning a response does not complete the goal. When Execution is not direct, your first action must be goal_dispatch to launch that executor (factory may first discover targets). A direct answer does not fulfill a selected specialist execution. For subagent/orchestrator/self_heal/factory/team_dag/swarm/bot_delegate use goal_dispatch to launch the selected executor. For PTC use goal_dispatch to create an isolated dynamic-workflow worker. Select the next workKind and specialist role yourself from the task and existing evidence; never ask the user to configure modes. When goal_dispatch returns waiting, the runtime parks this goal on a durable wait by default and ends the turn; the scheduler resumes once with actual results. Do not poll worker history, cron, or sleep. ${DURABLE_WAIT_DEFAULT} Call wait_for yourself for any other owned observable; it persists the checkpoint and ends this tool turn until fresh evidence is ready. Inspect existing results before launching another phase; do not repeat completed or unconfirmed external actions. For factory discover authorized targets through factory_status, then pass factory details to goal_dispatch.`;
}

function executionIds(metadata:SessionRecord['metadata']):{goalId:string;executionId:string}|undefined {
 const goalId=metadata.botGoalId,executionId=metadata.botGoalExecutionId;
 if(typeof goalId!=='string'||typeof executionId!=='string')return undefined;
 return {goalId,executionId};
}
function loadedSettleSession(host:GoalRuntimeHost,sessionId:string):{session:SessionRecord;scope:NonNullable<ReturnType<typeof goalScope>>}|undefined {
 const session=host.store.getSession(sessionId);
 if(!session)return undefined;
 const scope=goalScope(host.store,session);
 if(!scope)return undefined;
 return {session,scope};
}
function runningGoalExecution(service:BotGoalService,botId:string,metadata:SessionRecord['metadata']) {
 const ids=executionIds(metadata);
 if(!ids)return undefined;
 const execution=service.executions(botId,ids.goalId).find(e=>e.id===ids.executionId&&e.status==='running');
 return execution?{ids,execution}:undefined;
}
function settleContext(host:GoalRuntimeHost,sessionId:string,error?:unknown) {
 if(error instanceof WriterClaimError)return undefined;
 const loaded=loadedSettleSession(host,sessionId);
 if(!loaded||loaded.session.metadata.botWorkTaskId)return undefined;
 const running=runningGoalExecution(loaded.scope.service,loaded.scope.botId,loaded.session.metadata);
 if(!running)return undefined;
 return {...loaded,...running};
}
function dispatchNeedsHold(session:SessionRecord,executionId:string):boolean {
 const dispatch=session.metadata.botGoalDispatch as {executionId?:string;result?:{waitingApproval?:boolean}}|undefined;
 return Boolean(!session.metadata.botGoalBudgetExceeded&&dispatch?.executionId===executionId&&dispatch.result?.waitingApproval);
}
function alreadyWaiting(session:SessionRecord,outcome:{kind?:string}|undefined):boolean {
 return !session.metadata.botGoalBudgetExceeded&&(session.status==='waiting_approval'||outcome?.kind==='waiting_approval');
}
function holdForApproval(host:GoalRuntimeHost,sessionId:string,session:SessionRecord,executionId:string):boolean {
 if(dispatchNeedsHold(session,executionId)){host.store.updateSession(sessionId,{status:'waiting_approval'});return true;}
 const outcome=session.metadata.outcome as {kind?:string;reason?:string}|undefined;
 return alreadyWaiting(session,outcome);
}
function assistantTranscript(messages:ReturnType<GoalRuntimeHost['store']['foldMessages']>,startedAt:string) {
 const tail=messages.filter(m=>Date.parse(m.createdAt)>=Date.parse(startedAt));
 const final=tail.findLast(m=>m.role==='assistant'&&m.parts.some(p=>p.type==='text'));
 const assistant=(final?.parts.filter(p=>p.type==='text').map(p=>p.text).join('\n')??'').slice(-6000);
 return {tail,assistant};
}
function baseReport(checkpoint:GoalReport|undefined,assistant:string,goal:BotGoal):GoalReport {
 if(checkpoint)return {...checkpoint,advanced:false};
 if(assistant.trim())return {kind:'candidate_completed',summary:assistant,evidence:[assistant],advanced:false};
 if(goal.evidence.length)return {kind:'progress',summary:goal.progress||'Recorded result kept for review',evidence:[],advanced:false,nextStep:goal.nextStep};
 return {kind:'candidate_completed',summary:'Execution returned without completion evidence',evidence:[],advanced:false};
}
function interruptedReport(error:unknown,status:string):GoalReport|undefined {
 if(error||status==='failed'||status==='unknown')return {kind:'blocked',summary:`Execution interrupted: ${String(error??status)}`};
 return undefined;
}
function abortedReport(outcome:{kind?:string}|undefined):GoalReport|undefined {
 if(outcome?.kind!=='aborted')return undefined;
 return {kind:'blocked',summary:'Execution was interrupted; review progress before resuming'};
}
/** Every completion verdict is traced, including the ones let through because the judge failed. */
function traceCompletionVerdict(host:GoalRuntimeHost,sessionId:string,goal:BotGoal,stage:CompletionStage,report:GoalReport,failure?:{error:string;timedOut:boolean}):void {
 const met=report.kind==='candidate_completed'&&report.verified===true;
 host.emitTrace?.(sessionId,{kind:'goal_eval',payload:{
  source:'bot_goal_completion',stage,goalId:goal.id,title:goal.title.slice(0,120),
  met,verdict:report.kind,verified:report.verified===true,
  reason:(failure?.error??report.nextStep??report.summary??'').slice(0,400),
  failOpen:Boolean(failure),...(failure?{error:failure.error.slice(0,400),timedOut:failure.timedOut}:{}),
  continuations:goal.attempts,
 }});
}
type CompletionStage='before_end'|'settle'|'child';
async function verifyCompletion(host:GoalRuntimeHost,goal:BotGoal,tail:ReturnType<GoalRuntimeHost['store']['foldMessages']>,assistant:string,report:GoalReport,sessionId=goal.sessionId,signal?:AbortSignal,prepared?:CompletionEvidence,stage:CompletionStage='settle'):Promise<GoalReport> {
 const session=host.store.getSession(sessionId);
 const judge=session ? sessionJudge(host,session) : host.judge;
 if(!judge){
  const unverified={...report,verified:false};
  traceCompletionVerdict(host,sessionId,goal,stage,unverified,{error:'No completion judge is available',timedOut:false});
  return unverified;
 }
 const timeout=AbortSignal.timeout(GOAL_JUDGE_TIMEOUT_MS);
 try {
  const packet=prepared??verificationPacket(host,goal,assistant);
  const result=await judge({system:COMPLETION_JUDGE_PROMPT,user:JSON.stringify(packet),jsonMode:true,signal:signal?AbortSignal.any([signal,timeout]):timeout});
  const verdict=completionReport(JSON.parse(result),packet,goal);
  traceCompletionVerdict(host,sessionId,goal,stage,verdict);
  return verdict;
 }catch(error){
  const kept:GoalReport={...report,kind:'candidate_completed',verified:false,summary:report.summary||assistant||'Completion verification unavailable; recorded result kept for review',evidence:report.evidence?.length?report.evidence:[assistant].filter(Boolean)};
  traceCompletionVerdict(host,sessionId,goal,stage,kept,{error:String(error),timedOut:timeout.aborted});
  return kept;
 }
}
type CompletionReview = { executionId:string; revision:number; fingerprint?:string; report?:GoalReport };
// Verified reports are process-local, never accepted from caller-editable metadata.
const completionReviews = new WeakMap<SqliteStateStore,Map<string,CompletionReview>>();
function reviewCache(host:GoalRuntimeHost):Map<string,CompletionReview> {
 let cache=completionReviews.get(host.store);if(!cache){cache=new Map();completionReviews.set(host.store,cache);}return cache;
}
function verificationPacket(host:GoalRuntimeHost,goal:BotGoal,assistant:string):CompletionEvidence {
 return buildCompletionEvidence(goal,goalExecutionEvidence(host.store,goal),assistant);
}
function completionFingerprint(packet:CompletionEvidence):string {
 return createHash('sha256').update(JSON.stringify(packet)).digest('hex');
}
function cachedCompletion(host:GoalRuntimeHost,goal:BotGoal,tail:ReturnType<GoalRuntimeHost['store']['foldMessages']>,assistant:string,sessionId:string):GoalReport|undefined {
 const session=host.store.getSession(sessionId);
 const cached=reviewCache(host).get(sessionId);
 if(!cached?.report||cached.executionId!==executionIds(session!.metadata)?.executionId||cached.revision!==goal.revision)return undefined;
 try{return cached.fingerprint===completionFingerprint(verificationPacket(host,goal,assistant))?cached.report:undefined;}catch{return undefined;}
}
function reusableCompletionReview(prior: CompletionReview | undefined, executionId: string, revision: number, packet: CompletionEvidence, fingerprint: string): boolean {
 if(prior?.executionId!==executionId||prior.revision!==revision)return false;
 return packet.userInstructions.length===0||prior.fingerprint===fingerprint;
}
/** Recheck additive steering while progress changes; the existing run budget still bounds work. */
export async function reviewDirectGoalBeforeEnd(host:GoalRuntimeHost,sessionId:string,signal?:AbortSignal,finalTurn=false):Promise<{met:boolean;action?:'continue';systemMessage?:string}|undefined> {
 const ctx=settleContext(host,sessionId);
 if(!ctx||ctx.execution.strategy!=='direct'||holdForApproval(host,sessionId,ctx.session,ctx.ids.executionId)||signal?.aborted)return undefined;
 const goal=ctx.scope.service.get(ctx.scope.botId,ctx.ids.goalId)!;
 const cache=reviewCache(host);
 const prior=cache.get(sessionId);
 if(!prior&&cache.size>=512)return undefined;
 const {tail,assistant}=assistantTranscript(evidenceTranscript(host.store,sessionId),ctx.execution.startedAt);
 let packet:CompletionEvidence;try{packet=verificationPacket(host,goal,assistant);}catch{return undefined;}
 const fingerprint=completionFingerprint(packet);
 if(reusableCompletionReview(prior,ctx.ids.executionId,goal.revision,packet,fingerprint))return {met:true};
 cache.set(sessionId,{executionId:ctx.ids.executionId,revision:goal.revision});
 const report=await verifyCompletion(host,goal,tail,assistant,baseReport(undefined,assistant,goal),sessionId,signal,packet,'before_end');
 const live=settleContext(host,sessionId);
 if(!live||live.ids.executionId!==ctx.ids.executionId||signal?.aborted||live.scope.service.get(live.scope.botId,goal.id)?.revision!==goal.revision)return {met:true};
 cache.set(sessionId,{executionId:ctx.ids.executionId,revision:goal.revision,fingerprint,report});
 if(report.kind!=='progress'||!report.nextStep||report.correctionNeeded===false)return {met:true};
 // The turn limit already closed the tools. The settlement requeues the goal from this verdict.
 if(finalTurn){traceBeforeEnd(host,sessionId,goal,'turn_limit',report.nextStep);return {met:true};}
 traceBeforeEnd(host,sessionId,goal,'continue',report.nextStep);
 return {met:false,action:'continue',systemMessage:`[completion review] The requested outcome is not complete: ${report.nextStep}\nContinue within the existing turn budget until the original objective and all live user instructions are addressed. Complete only this remaining work using existing observations. Do not replay confirmed side effects or create extra records just to preserve evidence. Honor the current user's exact output requirements. If a required action is blocked, honor any user-specified failure reply or stop condition exactly, without extra explanation; otherwise report the remaining gap honestly.`};
}
function traceBeforeEnd(host:GoalRuntimeHost,sessionId:string,goal:BotGoal,decision:'continue'|'turn_limit',reason:string):void {
 host.emitTrace?.(sessionId,{kind:'goal_eval',payload:{source:'bot_goal_before_end',goalId:goal.id,title:goal.title.slice(0,120),met:false,decision,reason:reason.slice(0,400),failOpen:false,continuations:decision==='continue'?1:0}});
}
async function maybeVerify(host:GoalRuntimeHost,goal:BotGoal,tail:ReturnType<GoalRuntimeHost['store']['foldMessages']>,assistant:string,report:GoalReport,sessionId:string):Promise<GoalReport> {
 if(report.kind!=='candidate_completed'&&report.kind!=='progress')return report;
 return cachedCompletion(host,goal,tail,assistant,sessionId)??verifyCompletion(host,goal,tail,assistant,{...report,verified:false},sessionId);
}
/** Child-session completion uses the same judge as a direct turn. Assistant text alone is not verification. */
export async function judgeChildCompletion(host:GoalRuntimeHost,goal:BotGoal,childId:string,assistant:string):Promise<GoalReport|undefined> {
 if(!assistant.trim())return undefined;
 const transcript=evidenceTranscript(host.store,childId);
 return verifyCompletion(host,goal,transcript,assistant,{kind:'candidate_completed',summary:assistant,evidence:[assistant],verified:false},childId,undefined,undefined,'child');
}
/** A waiting dispatch becomes a durable wait. The model does not have to call wait_for for it. */
function parkDispatchWait(host:GoalRuntimeHost,goal:BotGoal,checkpoint:GoalReport|undefined,session:SessionRecord,execution:{id:string}):GoalReport|undefined {
 if(checkpoint?.kind!=='waiting'||checkpoint.wait?.source==='durable_wait')return undefined;
 return parkGoalDurableWait(host.store,session,goal,execution.id,checkpoint.wait??{source:'',correlationId:''},checkpoint.summary);
}
function unlaunchedExecutor(session:SessionRecord,execution:{strategy:string;id:string},goal:BotGoal):GoalReport|undefined {
 const dispatch=session.metadata.botGoalDispatch as {executionId?:string}|undefined;
 if(session.metadata.botGoalWorker||session.mode==='subagent'||execution.strategy==='direct'||goal.evidence.length)return undefined;
 if(dispatch?.executionId===execution.id)return undefined;
 return {kind:'progress',summary:'The selected executor has not been launched; a direct response cannot verify that execution.',advanced:false,nextStep:`Call goal_dispatch with preferredStrategy=${execution.strategy} to execute the original objective, then inspect its actual result.`};
}
async function settledReport(host:GoalRuntimeHost,goal:BotGoal,tail:ReturnType<GoalRuntimeHost['store']['foldMessages']>,assistant:string,checkpoint:GoalReport|undefined,error:unknown,status:string,outcome:{kind?:string}|undefined,session:SessionRecord,execution:{strategy:string;id:string}):Promise<GoalReport> {
 const failed=interruptedReport(error,status)??abortedReport(outcome);
 if(failed)return failed;
 const parked=parkDispatchWait(host,goal,checkpoint,session,execution);
 if(parked)return parked;
 if(checkpoint?.kind==='waiting'&&checkpoint.wait?.source==='durable_wait'){
  const wait=new DurableWaitStore(host.store).get(checkpoint.wait.correlationId);
  const receiptOk=!!wait&&(wait.hostRegistered===true||hasWaitReceipt(host.store,session.id,wait.id));
  if(wait?.owner.id===goal.id&&wait.owner.executionId===execution.id&&wait.owner.revision===goal.revision&&receiptOk)return checkpoint;
  if(wait?.owner.id===goal.id&&!wait.hostRegistered)new DurableWaitStore(host.store).cancel(wait.id,'Wait tool wave did not close');
  if(wait?.owner.id===goal.id&&wait.hostRegistered)return checkpoint;
  return {kind:'blocked',summary:'Wait registration lacks a complete tool checkpoint; verify effects before continuing'};
 }
 const unlaunched=unlaunchedExecutor(session,execution,goal);
 if(unlaunched)return unlaunched;
 return maybeVerify(host,goal,tail,assistant,baseReport(checkpoint,assistant,goal),session.id);
}
function reportCost(metadata:SessionRecord['metadata']):number {
 return Math.max(0,Number(metadata.usageCostUsd??0)-Number(metadata.botGoalCostStart??0));
}
function withCheckpointWait(report:GoalReport,checkpoint:GoalReport|undefined,costUsd:number):GoalReport {
 const wait=report.wait?.source==='durable_wait'?report.wait:checkpoint?.wait;
 return {...report,...(wait?{wait}:{}),costUsd};
}
function restoreOriginalProfile(host:GoalRuntimeHost,sessionId:string):void {
 const live=host.store.getSession(sessionId);
 const profile=live?.metadata.botGoalOriginalProfile as {taskRunMode?:unknown;orchestrationEngine?:unknown}|undefined;
 if(!(live&&profile))return;
 host.store.updateSession(sessionId,{metadata:{...live.metadata,taskRunMode:profile.taskRunMode??undefined,orchestrationEngine:profile.orchestrationEngine??undefined,botGoalOriginalProfile:undefined}});
}
/** A turn limit is not a finished goal. Unverified results go back to the queue instead of waiting for review. */
function turnLimitReport(report:GoalReport,outcome:{reason?:string}|undefined):GoalReport {
 if(outcome?.reason!==TURN_LIMIT_REASON||report.kind!=='candidate_completed'||report.verified===true)return report;
 return {...report,kind:'progress',nextStep:report.nextStep??'The turn limit ended the previous run. Check what is done against the objective and finish the remaining work.'};
}
/** The chat would otherwise look stopped while the goal waits for its next run. */
function announceTurnLimitContinuation(host:GoalRuntimeHost,goal:BotGoal,outcome:{reason?:string}|undefined,maxAttempts:number):void {
 if(outcome?.reason!==TURN_LIMIT_REASON||goal.status!=='queued')return;
 const title=(goal.title??'').trim()||goal.id;
 const limit=maxAttempts+(goal.extraAttempts??0);
 host.store.appendMessage(goal.sessionId,'system',[{type:'text',text:`[goal-continuing] ${title} — this run reached its step limit before the goal was confirmed complete. The goal is queued and continues automatically (attempt ${goal.attempts} of ${limit}).`}],{key:`goal-turn-limit:${goal.id}:${goal.attempts}`});
}
async function finishSettlement(host:GoalRuntimeHost,sessionId:string,ctx:NonNullable<ReturnType<typeof settleContext>>,error?:unknown):Promise<void> {
 if(ctx.execution.leaseUntil>Date.now())ctx.scope.service.updateExecution(ctx.scope.botId,ctx.execution.id,{messageEndSeq:host.store.listSurfaceNodes(sessionId).at(-1)?.seq??0});
 const checkpoint=ctx.session.metadata.botGoalCheckpoint as GoalReport|undefined;
 const {tail,assistant}=assistantTranscript(evidenceTranscript(host.store,sessionId),ctx.execution.startedAt);
 const outcome=ctx.session.metadata.outcome as {kind?:string;reason?:string}|undefined;
 const goal=ctx.scope.service.get(ctx.scope.botId,ctx.ids.goalId)!;
 const report=turnLimitReport(await settledReport(host,goal,tail,assistant,checkpoint,error,ctx.session.status,outcome,ctx.session,ctx.execution),outcome);
 const settled=ctx.scope.service.report(ctx.scope.botId,ctx.ids.executionId,preserveGoalBudgetReport(host,sessionId,{...withCheckpointWait(report,checkpoint,reportCost(ctx.session.metadata)),owner:ctx.execution.owner,fence:ctx.execution.fence}));
 announceGoalState(host,settled);
 announceTurnLimitContinuation(host,settled,outcome,ctx.scope.service.readSettings().maxAttempts);
 restoreOriginalProfile(host,sessionId);
}
export async function settleGoalExecution(host:GoalRuntimeHost,sessionId:string,error?:unknown):Promise<void> {
 const ctx=settleContext(host,sessionId,error);
 if(!ctx)return;
 if(holdForApproval(host,sessionId,ctx.session,ctx.ids.executionId))return;
 try{await finishSettlement(host,sessionId,ctx,error);}finally{reviewCache(host).delete(sessionId);}
}

function assignedCheckpointGoal(store:SqliteStateStore,session:SessionRecord):{goalId:string}|undefined {
 if(session.metadata.botWorkTaskId)return undefined;
 const scope=goalScope(store,session);
 const goalId=session.metadata.botGoalId;
 if(!scope||typeof goalId!=='string')return undefined;
 const goal=scope.service.get(scope.botId,goalId);
 if(!goal||!['running','waiting'].includes(goal.status))return undefined;
 if(session.metadata.botGoalWorker===true) {
  if(!isGoalWorkerCurrent(store,session))return undefined;
 } else if(!activeExecutionDecision(scope.service,scope.botId,session))return undefined;
 return {goalId};
}
function checkpointKind(kind:string):string|undefined {
 if(!['progress','waiting','blocked','candidate_completed'].includes(kind))return undefined;
 return kind;
}
function checkpointWaitAuthorized(wait:{source?:unknown;correlationId?:unknown}|undefined,authorized:Array<{goalId:string;source:string;correlationId:string}>|undefined,goalId:string):boolean {
 return !!wait&&!!authorized?.some(w=>w.goalId===goalId&&w.source===wait.source&&w.correlationId===wait.correlationId);
}
function checkpointRecord(args:{summary?:unknown;evidence?:unknown;nextStep?:unknown;wait?:unknown},kind:string) {
 const evidence=Array.isArray(args.evidence)?args.evidence.filter((e):e is string=>typeof e==='string').slice(0,20):[];
 return {kind,summary:String(args.summary??'').slice(0,6000),evidence,nextStep:typeof args.nextStep==='string'?args.nextStep:undefined,wait:args.wait};
}
export function createGoalCheckpointTool(store:SqliteStateStore):ToolContract {
 return {name:'goal_checkpoint',description:'Save progress for the current assigned goal. kind: progress, waiting, blocked, candidate_completed. Waiting requires source and correlationId of an authorized session, bot_task, team_dag, or swarm run. Completion is independently verified.',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['progress','waiting','blocked','candidate_completed']},summary:{type:'string'},evidence:{type:'array',items:{type:'string'}},nextStep:{type:'string'},wait:{type:'object',properties:{source:{type:'string'},correlationId:{type:'string'},description:{type:'string'},deadline:{type:'number'}}}},required:['kind','summary']},approvalMode:'never',sideEffectLevel:'none',async execute(ctx,args){
  const assigned=assignedCheckpointGoal(store,store.getSession(ctx.session.id)??ctx.session);
  if(!assigned)return {ok:false,content:'No goal is assigned to this execution',metadata:{retry:false}};
  const kind=checkpointKind(String(args.kind));
  if(!kind)return {ok:false,content:'Invalid checkpoint kind',metadata:{retry:false,endReason:'goal_checkpoint_invalid_kind'}};
  const live=store.getSession(ctx.session.id)!;
  const wait=args.wait as {source?:unknown;correlationId?:unknown}|undefined;
  const authorized=live.metadata.botGoalAuthorizedWaits as Array<{goalId:string;source:string;correlationId:string}>|undefined;
  if(kind==='waiting'&&!checkpointWaitAuthorized(wait,authorized,assigned.goalId))return {ok:false,content:'Waiting requires an execution reference authorized by goal_dispatch',metadata:{retry:false,endReason:'goal_checkpoint_wait_unauthorized'}};
  store.updateSession(live.id,{metadata:{...live.metadata,botGoalCheckpoint:checkpointRecord(args,kind)}});
  return {ok:true,content:'Checkpoint saved. Completion remains subject to verification.'};
 }};
}
