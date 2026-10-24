import type { MessagePart, SessionRecord } from '../../types.js';
import { createLogger } from '../../logger.js';
import { stableJsonHash } from '../../runtime/helpers.js';
import { TeamPlanStore } from '../../teams/store.js';
import { getBotTask, cancelBotTask } from '../bot-work.js';
import { principalFromSession } from '../bot-identity.js';
import { inheritBotIdentityMetadata } from '../../memory/bot-memory-scope.js';
import { childPermissionMode, inheritBotAllowlists, inheritModelOverride } from '../../runtime/spawn-policy.js';
import { inheritForkRetrievalMetadata, forkOpeningMessage } from '../fork-inheritance.js';
import { childSessionTrace } from '../../stores/trace-visible.js';
import { announceGoalState, bindGoalExecution, goalAlreadyHandled, goalScope, judgeChildCompletion, settleGoalExecution, type GoalRuntimeHost } from './runtime-host.js';
import type { BotGoal, GoalExecution, GoalReport } from './types.js';

const ticking = new WeakSet<object>();
const ended = new Set(['completed', 'failed', 'cancelled', 'unknown', 'expired', 'rejected', 'timed_out']);
interface AuthorizedWait { goalId: string; source: string; correlationId: string }

function delegatedChildSettled(host: GoalRuntimeHost, parent: SessionRecord, taskId: string): boolean {
 return host.store.listSessions().some(session => {
  if (session.metadata.botWorkTaskId !== taskId || session.metadata.canonicalBotChat === true || host.isRunning(session.id)) return false;
  const outcome = session.metadata.outcome as {kind?: string} | undefined;
  if (outcome?.kind === 'completed' || outcome?.kind === 'failed' || session.status === 'completed' || session.status === 'failed') return true;
  if (session.status !== 'idle') return false;
  return host.store.foldMessages(session.id).some(message => message.role === 'assistant' && message.parts.some(part => part.type === 'text' && part.text.trim().length > 0));
 });
}

function authorizedWait(host: GoalRuntimeHost, goal: BotGoal, executions: GoalExecution[]): boolean {
 const wait = goal.wait;
 if (!wait) return false;
 return executions.some(execution => {
  const session = execution.sessionId ? host.store.getSession(execution.sessionId) : undefined;
  const entries = session?.metadata.botGoalAuthorizedWaits;
  return Array.isArray(entries) && entries.some((entry: AuthorizedWait) => entry?.goalId === goal.id && entry.source === wait.source && entry.correlationId === wait.correlationId);
 });
}

/** Reads only an execution reference actually returned by the authorized dispatch gateway. */
function waitStatus(host: GoalRuntimeHost, parent: SessionRecord, goal: BotGoal, executions: GoalExecution[]): string | undefined {
 const wait = goal.wait;
 if (!wait || !authorizedWait(host, goal, executions)) return 'unauthorized';
 const ownedSessions = new Set(executions.flatMap(e => e.sessionId ? [e.sessionId] : []));
 if (wait.source === 'session') {
  const session = host.store.getSession(wait.correlationId);
  if (!session || session.metadata.botGoalScopeSessionId !== parent.id || session.metadata.botGoalId !== goal.id) return 'unauthorized';
  if (host.isRunning(session.id) || session.status === 'waiting_approval') return 'running';
  const outcome = session.metadata.outcome as {kind?: string} | undefined;
  if (session.status === 'failed' || session.status === 'unknown') return session.status;
  return outcome?.kind === 'completed' || outcome?.kind === 'idle' || session.status === 'idle' ? 'completed' : undefined;
 }
 if (wait.source === 'bot_task') {
  const task = getBotTask(host.store, principalFromSession(host.store, parent), wait.correlationId);
  if (task?.requesterBotId !== goal.botId) return 'unauthorized';
  const childSettled = delegatedChildSettled(host, parent, wait.correlationId);
  if (task.status === 'queued' || task.status === 'running' || task.status === 'waiting_approval') return childSettled ? 'completed' : task.status;
  return task.status;
 }
 if (wait.source === 'team_dag') {
  const plan = new TeamPlanStore(host.store.db).get(wait.correlationId);
  // Missing execution evidence requires reconciliation, never another dispatch.
  if (!plan) return 'missing';
  return plan.sessionId && ownedSessions.has(plan.sessionId) ? plan.status : 'unauthorized';
 }
 if (wait.source === 'swarm') {
  return host.store.swarm().getRun(wait.correlationId)?.status ?? 'missing';
 }
 if (wait.source === 'self_heal' || wait.source === 'factory' || wait.source === 'evolution') return specialtyWaitStatus(host, parent, goal);
 return 'unsupported';
}

function externalWorkers(host: GoalRuntimeHost, goal: BotGoal): SessionRecord[] {
 const wait = goal.wait;
 if (!wait) return [];
 return host.store.listSessions().filter(session =>
  wait.source === 'session' ? session.id === wait.correlationId :
  wait.source === 'swarm' ? session.metadata.swarmRunId === wait.correlationId :
  wait.source === 'team_dag' ? session.metadata.teamPlanId === wait.correlationId :
  wait.source === 'self_heal' ? session.metadata.selfHealRunId === wait.correlationId :
  wait.source === 'bot_task' ? session.metadata.botWorkTaskId === wait.correlationId || (session.metadata.botGoalId === goal.id && session.id !== goal.sessionId) :
  wait.source === 'factory' ? session.metadata.factoryRunId === wait.correlationId :
  wait.source === 'evolution' ? session.metadata.evolutionRunId === wait.correlationId : false);
}
function specialtyWaitStatus(host: GoalRuntimeHost, parent: SessionRecord, goal: BotGoal): string {
 const inspected = host.inspectSpecialty?.(parent, goal).status;
 if (inspected && inspected !== 'unsupported') return inspected;
 if (goal.wait?.source === 'self_heal') return 'unsupported';
 const workers = externalWorkers(host, goal);
 if (!workers.length) return 'unsupported';
 if (workers.some(worker => host.isRunning(worker.id) || worker.status === 'waiting_approval')) return 'running';
 if (workers.some(worker => worker.status === 'failed' || (worker.metadata.outcome as {kind?: string} | undefined)?.kind === 'failed')) return 'failed';
 return 'completed';
}

async function drainExternal(host: GoalRuntimeHost, parent: SessionRecord, goal: BotGoal, executions: GoalExecution[]): Promise<void> {
 const scope = goalScope(host.store, parent)!;
 const wait = goal.wait;
 if (!wait) return;
 const state = waitStatus(host, parent, goal, executions);
 if (state === 'unauthorized' || state === 'unsupported') {
  if(goal.status==='queued')scope.service.block(goal.botId,goal.id,'External execution cancellation is unavailable; reconciliation is required');
  scope.service.setDraining(goal.botId,goal.id,true,'External execution cancellation is unavailable; reconciliation is required');
  return;
 }
 if (wait.source === 'self_heal' || wait.source === 'factory' || wait.source === 'evolution') {
  let stopped=false;
  try { stopped=await host.cancelSpecialty?.(parent,goal)===true; } catch { /* Preserve draining until the external outcome can be reconciled. */ }
  if(stopped&&goal.status==='queued')scope.service.finishAmendDrain(goal.botId,goal.id,waitEvidence(host,parent,goal,'stopped after constraints changed',executions));
  else scope.service.setDraining(goal.botId,goal.id,!stopped,stopped?undefined:'External execution is stopping or awaiting reconciliation; no new work will be dispatched');
  return;
 }
 // Persist terminal dispatch state first; only then interrupt already-running workers.
 if (wait.source === 'swarm' && !ended.has(state ?? '')) host.store.swarm().updateRunStatus(wait.correlationId,'cancelled');
 else if (wait.source === 'team_dag' && !ended.has(state ?? '')) new TeamPlanStore(host.store.db).updateStatus(wait.correlationId,'cancelled');
 else if (wait.source === 'bot_task' && !ended.has(state ?? '')) cancelBotTask({store:host.store,runSession:host.run,isSessionRunning:host.isRunning,cancelSession:host.cancel,log:createLogger('bot-goal-cancel')},principalFromSession(host.store,parent),wait.correlationId);
 const workers = externalWorkers(host,goal);
 for (const worker of workers) {
  if (!host.isRunning(worker.id) && worker.status !== 'waiting_approval') continue;
  host.cancel(worker.id);
  if (!host.isRunning(worker.id)) {
   const live=host.store.getSession(worker.id);
   if(live)host.store.updateSession(worker.id,{status:'idle',metadata:{...live.metadata,outcome:{kind:'aborted',reason:'Goal paused or cancelled'},botGoalExternalCancelled:true}});
  }
 }
 const draining = workers.some(worker => host.isRunning(worker.id));
 if(!draining&&goal.status==='queued')scope.service.finishAmendDrain(goal.botId,goal.id,waitEvidence(host,parent,goal,'stopped after constraints changed',executions));
 else scope.service.setDraining(goal.botId,goal.id,draining,goal.status==='blocked'?goal.blockedReason:draining ? 'External workers are stopping; completed effects are not rolled back' : undefined);
}

function waitEvidence(host: GoalRuntimeHost, parent: SessionRecord, goal: BotGoal, status: string, executions: GoalExecution[]): {summary:string;evidence:string[];costUsd:number} {
 const wait=goal.wait!;
 const evidence:string[]=[`${wait.source} ${wait.correlationId} reported ${status}; verify against goal conditions`];
 if(wait.source==='bot_task') {
  const task=getBotTask(host.store,principalFromSession(host.store,parent),wait.correlationId);
  if(task?.result)evidence.push(task.result.slice(-12000));
  if(task?.failureReason)evidence.push(task.failureReason.slice(-2000));
 }
 if(wait.source==='team_dag') {
  const plan=new TeamPlanStore(host.store.db).get(wait.correlationId);
  if(plan)evidence.push(JSON.stringify({tasks:plan.tasks,gates:plan.gates}).slice(-16000));
 }
 if(wait.source==='swarm') evidence.push(JSON.stringify(host.store.swarm().listTasks(wait.correlationId)).slice(-16000));
 if(wait.source==='self_heal'||wait.source==='factory'||wait.source==='evolution') evidence.push(...(host.inspectSpecialty?.(parent,goal).evidence ?? []).map(item=>item.slice(-16000)));
 let costUsd=0;
 for(const worker of externalWorkers(host,goal)) {
  const output=host.store.foldMessages(worker.id).filter(m=>m.role==='assistant').flatMap(m=>m.parts.filter(p=>p.type==='text').map(p=>p.text)).join('\n').slice(-8000);
  if(output)evidence.push(`Session ${worker.id}: ${output}`);
  // Executions already settled into this Goal own their own cost accounting.
  if(worker.metadata.canonicalBotChat !== true && !executions.some(e=>e.sessionId===worker.id)) {
   const cost=Number(worker.metadata.usageCostUsd??0);
   if(Number.isFinite(cost)&&cost>0)costUsd+=cost;
  }
 }
 return {summary:`${wait.source} ${wait.correlationId}: ${status}. Inspect recorded evidence before continuing.`,evidence,costUsd};
}

function spawnContinuation(host: GoalRuntimeHost, parent: SessionRecord, goal: BotGoal): void {
 const scope = goalScope(host.store, parent)!;
 const permissionMode = childPermissionMode(parent.metadata);
 const child = host.store.createSession({
  title: goal.title, mode: 'subagent', agentId: parent.agentId, taskId: parent.taskId,
  parentSessionId: parent.id, background: true,
  metadata: {
   parentSessionId: parent.id, spawnSource: 'bot-goal-continuation', subagentRole: parent.agentId,
   ...inheritBotAllowlists(parent.metadata, {agentAllowedTools: host.store.getAgent(parent.agentId)?.allowedTools}),
   ...inheritModelOverride(parent.metadata), ...inheritBotIdentityMetadata(parent, host.store),
   ...inheritForkRetrievalMetadata(parent.metadata), ...(permissionMode ? {permissionMode} : {}),
   botId: goal.botId, botGoalId: goal.id, botGoalScopeSessionId: parent.id
  }
 });
 const taskText = `Continue goal ${goal.id} under revision ${goal.revision}.\nObjective: ${goal.objective}\nConstraints: ${JSON.stringify(goal.constraints)}\nPrevious progress: ${goal.progress}\nEvidence: ${JSON.stringify(goal.evidence)}\nNext step: ${goal.nextStep ?? 'Inspect the prior result and continue safely.'}\nDo not repeat external operations whose result is unknown.`;
 host.store.appendMessage(child.id, 'user', forkOpeningMessage({store:host.store,parentSessionId:parent.id,childSessionId:child.id,taskText}));
 if (!bindGoalExecution(host, child)) {
  host.store.deleteSession(child.id);
  return;
 }
 host.emitTrace?.(parent.id, childSessionTrace(child.id, 'bot-goal-continuation'));
 // Claiming and binding happen synchronously before run() so concurrent ticks cannot duplicate dispatch.
 try {
  void host.run(child.id).then(() => settleGoalExecution(host,child.id)).catch(async error => {
   try { await settleGoalExecution(host,child.id,error); }
   catch { scope.service.block(goal.botId,goal.id,'Continuation failed; execution requires reconciliation'); }
  });
 } catch (error) {
  void settleGoalExecution(host,child.id,error).catch(() => scope.service.block(goal.botId,goal.id,'Continuation failed; execution requires reconciliation'));
 }
}

function resumeApprovedDispatch(host: GoalRuntimeHost, session: SessionRecord, goal: BotGoal, execution: GoalExecution): boolean {
 const dispatch=session.metadata.botGoalDispatch as {executionId?:string;request?:Record<string,unknown>;result?:{waitingApproval?:boolean}}|undefined;
 if(dispatch?.executionId!==execution.id||!dispatch.result?.waitingApproval)return false;
 const scope=goalScope(host.store,session);
 if(!scope)return false;
 const ledger=host.store.getDaemonControl<{parts:MessagePart[]}[]>(`bot.goal-tool-ledger:${session.id}:${execution.id}`)??[];
 const calls=new Map<string,Extract<MessagePart,{type:'tool_call'}>>();
 const results=new Map<string,Extract<MessagePart,{type:'tool_result'}>>();
 for(const part of ledger.flatMap(m=>m.parts)) {
  if(part.type==='tool_call')calls.set(part.toolCallId,part);
  if(part.type==='tool_result')results.set(part.toolCallId,part);
 }
 const waiting=[...results.values()].filter(result=>{try{return JSON.parse(result.content)?.status==='goal_dispatch_waiting_approval';}catch{return false;}});
 const approvals=host.store.listApprovals();
 const decisions=waiting.map(result=>{
  const call=calls.get(result.toolCallId);
  return call?approvals.filter(a=>a.sessionId===session.id&&a.toolName===call.name&&stableJsonHash(call.name,a.args)===stableJsonHash(call.name,call.input)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]:undefined;
 });
 if(!decisions.length||decisions.some(d=>!d||d.status==='pending')) {
  if(execution.leaseUntil>Date.now())scope.service.updateExecution(goal.botId,execution.id,{leaseUntil:Date.now()+scope.service.readSettings().leaseMs});
  return true;
 }
 const renewUntil=Date.now()+scope.service.readSettings().leaseMs;
 const liveExecution=scope.service.executions(goal.botId,goal.id).find(item=>item.id===execution.id);
 if(!liveExecution||liveExecution.status!=='running')return false;
 if(liveExecution.leaseUntil<=Date.now())scope.service.renewRunningLease(goal.botId,execution.id,renewUntil);
 if(decisions.some(d=>d?.status==='rejected')) {
  if(host.isRunning(session.id)){host.cancel(session.id);return true;}
  scope.service.report(goal.botId,execution.id,{kind:'blocked',summary:'Goal execution approval was rejected',owner:execution.owner,fence:execution.fence});
  return true;
 }
 if(host.isRunning(session.id))return false;
 const key=decisions.map(d=>`${d!.id}:${d!.updatedAt}`).sort().join('|');
 if(session.metadata.botGoalApprovalResume===key)return true;
 host.store.updateSession(session.id,{status:'idle',metadata:{...session.metadata,botGoalApprovalResume:key}});
 const request=dispatch.request??{};
 const args=Object.fromEntries(['preferredStrategy','workKind','delegateBotId','tasks','role','factory'].filter(k=>request[k]!==undefined).map(k=>[k,request[k]]));
 host.store.enqueueSteer(session.id,`[goal approval resolved] Resume goal_dispatch with exactly these approved selection arguments: ${JSON.stringify(args)}. The original execution and stable call IDs remain active. Do not create a new independent operation.`,{role:'system',key:`goal-approval:${execution.id}:${key}`});
 try {void host.run(session.id).then(()=>settleGoalExecution(host,session.id)).catch(error=>settleGoalExecution(host,session.id,error)).catch(()=>{});}
 catch(error){void settleGoalExecution(host,session.id,error).catch(()=>{});}
 return true;
}

type GoalService = NonNullable<ReturnType<typeof goalScope>>['service'];

function canonicalParents(host: GoalRuntimeHost): SessionRecord[] {
 return host.store.listSessions().filter(s => s.metadata.canonicalBotChat === true);
}
function executionSession(host: GoalRuntimeHost, execution: GoalExecution): SessionRecord | undefined {
 return execution.sessionId ? host.store.getSession(execution.sessionId) : undefined;
}
function sessionRunning(host: GoalRuntimeHost, session: SessionRecord | undefined): boolean {
 return !!session && host.isRunning(session.id);
}
function resumeIfApproved(host: GoalRuntimeHost, session: SessionRecord | undefined, goal: BotGoal, execution: GoalExecution): boolean {
 return !!session && goal.status === 'running' && resumeApprovedDispatch(host, session, goal, execution);
}
function stopControlledExecution(host: GoalRuntimeHost, service: GoalService, botId: string, session: SessionRecord | undefined, execution: GoalExecution, running: boolean): void {
 if (running && session) host.cancel(session.id);
 if (!session || !host.isRunning(session.id)) service.report(botId, execution.id, {kind:'cancelled', summary:'Execution stopped following user control', owner:execution.owner, fence:execution.fence});
}
function renewOrExpireLease(host: GoalRuntimeHost, service: GoalService, botId: string, session: SessionRecord, goal: BotGoal, execution: GoalExecution): void {
 if (execution.leaseUntil > Date.now()) service.updateExecution(botId, execution.id, {leaseUntil:Date.now()+service.readSettings().leaseMs});
 else { host.cancel(session.id); service.block(botId, goal.id, 'Execution lease expired; stopping before recovery'); }
}
function sessionOutcomeText(host: GoalRuntimeHost, session: SessionRecord): string {
 return host.store.foldMessages(session.id).filter(message => message.role === 'assistant').flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n').slice(-2000);
}
function finishedExecutionReport(host: GoalRuntimeHost, session: SessionRecord): {kind:'candidate_completed'|'failed'|'cancelled';summary:string;evidence?:string[]} | undefined {
 const outcome = session.metadata.outcome as {kind?: string; reason?: string} | undefined;
 const text = sessionOutcomeText(host, session);
 if (session.status === 'failed' || outcome?.kind === 'failed') return {kind:'failed', summary:outcome?.reason || text || 'Execution failed', ...(text ? {evidence:[text]} : {})};
 if (outcome?.kind === 'aborted' || outcome?.kind === 'cancelled') return {kind:'cancelled', summary:outcome.reason || 'Execution stopped'};
 if (outcome?.kind === 'completed' || session.status === 'completed') return {kind:'candidate_completed', summary:text || 'Execution finished', ...(text ? {evidence:[text]} : {})};
 return undefined;
}
function settleRunningLease(host: GoalRuntimeHost, service: GoalService, botId: string, session: SessionRecord | undefined, goal: BotGoal, execution: GoalExecution, running: boolean): void {
 if (!session) return;
 if (running || session.status === 'waiting_approval') {
  renewOrExpireLease(host, service, botId, session, goal, execution);
  return;
 }
 const report = finishedExecutionReport(host, session);
 if (report) service.report(botId, execution.id, {...report, owner:execution.owner, fence:execution.fence});
}
function controlOrLease(host: GoalRuntimeHost, service: GoalService, botId: string, session: SessionRecord | undefined, goal: BotGoal, execution: GoalExecution, running: boolean): void {
 if (goal.status === 'paused' || goal.status === 'cancelled') stopControlledExecution(host, service, botId, session, execution, running);
 else settleRunningLease(host, service, botId, session, goal, execution, running);
}
function childRunRef(execution: GoalExecution, parentSessionId: string | undefined): string | undefined {
 const ref = execution.runRef;
 if (!ref?.startsWith('session:')) return undefined;
 const childId = ref.slice('session:'.length);
 if (!childId || childId === parentSessionId) return undefined;
 return childId;
}
/** A brand-new child is idle too. Only an ended turn, or a failed/unknown child, is a result. */
function childEnded(child: SessionRecord): boolean {
 const outcome = child.metadata.outcome as {kind?: string} | undefined;
 if (child.status === 'failed' || child.status === 'unknown' || child.status === 'completed') return true;
 // Subagent turns finish as idle. The outcome is what distinguishes that from a session that has not run.
 return child.status === 'idle' && (outcome?.kind === 'completed' || outcome?.kind === 'idle' || outcome?.kind === 'failed');
}
function childSettlement(childId: string, status: string, output: string, judged?: GoalReport): GoalReport {
 if (status === 'failed' || status === 'unknown') return {kind:'blocked', summary:output || `Child session ${childId} ${status}`, evidence:output ? [output] : [`session ${childId} ${status}`]};
 const base: GoalReport = {kind:'candidate_completed', summary:output || `Child session ${childId} finished`, evidence:output ? [output] : [`session ${childId} ${status}`], verified:false};
 // No judge, or a judge that threw, leaves the pending completion. Progress would clear the
 // execution and dispatch a new child instead of keeping this result for review.
 if (!judged) return base;
 if (judged.kind !== 'candidate_completed' && judged.kind !== 'progress') return base;
 const evidence = [...(judged.evidence ?? [])];
 for (const item of base.evidence ?? []) if (item && !evidence.includes(item)) evidence.push(item);
 return {...base, kind:judged.kind, summary:judged.summary || base.summary, evidence: evidence.length ? evidence : base.evidence, verified:judged.verified === true, nextStep:judged.nextStep};
}
/** A finished child is the execution result. The parent turn staying idle must not keep the goal running. */
async function settleFinishedChild(host: GoalRuntimeHost, service: GoalService, botId: string, goal: BotGoal, execution: GoalExecution): Promise<boolean> {
 const childId = childRunRef(execution, execution.sessionId);
 if (!childId || host.isRunning(childId)) return false;
 const child = host.store.getSession(childId);
 if (!child || !childEnded(child)) return false;
 const output = host.store.foldMessages(childId).filter(m => m.role === 'assistant').flatMap(m => m.parts.filter(p => p.type === 'text').map(p => p.text)).join('\n').slice(-8000);
 const judged = child.status === 'failed' || child.status === 'unknown' ? undefined : await judgeChildCompletion(host, goal, childId, output);
 service.report(botId, execution.id, {...childSettlement(childId, child.status, output, judged), owner:execution.owner, fence:execution.fence});
 return true;
}
async function settleRunningExecution(host: GoalRuntimeHost, service: GoalService, botId: string, goal: BotGoal, execution: GoalExecution): Promise<void> {
 const session = executionSession(host, execution);
 const running = sessionRunning(host, session);
 if (resumeIfApproved(host, session, goal, execution)) return;
 if (!running && await settleFinishedChild(host, service, botId, goal, execution)) return;
 controlOrLease(host, service, botId, session, goal, execution, running);
}
async function tickRunningGoal(host: GoalRuntimeHost, service: GoalService, botId: string, parent: SessionRecord, goal: BotGoal): Promise<void> {
 if (goal.wait && goal.draining) await drainExternal(host, parent, goal, service.executions(botId, goal.id));
 for (const execution of service.executions(botId, goal.id).filter(e => e.status === 'running')) await settleRunningExecution(host, service, botId, goal, execution);
}
function blockUnauthorizedWait(service: GoalService, botId: string, goal: BotGoal, status: string | undefined): boolean {
 if (status === 'missing') {
  service.block(botId, goal.id, 'External execution record is missing');
  return true;
 }
 if (status !== 'unauthorized' && status !== 'unsupported') return false;
 service.block(botId, goal.id, 'Wait reference is not an authorized supported execution');
 return true;
}
function blockSpecialtyWait(host: GoalRuntimeHost, parent: SessionRecord, service: GoalService, botId: string, goal: BotGoal, status: string | undefined): boolean {
 if (status !== 'blocked') return false;
 const evidence = host.inspectSpecialty?.(parent, goal).evidence.join('\n');
 service.block(botId, goal.id, evidence || 'External execution is blocked');
 return true;
}
function wakeFinishedWait(host: GoalRuntimeHost, parent: SessionRecord, service: GoalService, botId: string, goal: BotGoal): void {
 const executions = service.executions(botId, goal.id);
 const status = waitStatus(host, parent, goal, executions);
 if (blockSpecialtyWait(host, parent, service, botId, goal, status)) return;
 if (blockUnauthorizedWait(service, botId, goal, status)) return;
 if (status && ended.has(status)) service.wake(botId, {goalId:goal.id, eventId:`${goal.wait!.source}:${goal.wait!.correlationId}:${status}:${goal.attempts}`, source:goal.wait!.source, correlationId:goal.wait!.correlationId, ...waitEvidence(host, parent, goal, status, executions)});
}
function deferredContinuation(host: GoalRuntimeHost, parent: SessionRecord, goal: BotGoal): SessionRecord | undefined {
 return host.store.listSessions().find(s => s.parentSessionId === parent.id && s.metadata.botGoalId === goal.id && s.metadata.botGoalScopeSessionId === parent.id && !host.isRunning(s.id));
}
function skipFreshQueued(host: GoalRuntimeHost, parent: SessionRecord, goal: BotGoal): boolean {
 if (!(goal.attempts === 0 && goal.sourceMessageId)) return false;
 return !deferredContinuation(host, parent, goal) && !goal.resumeRequested;
}
function atConcurrencyCap(service: GoalService, botId: string): boolean {
 return service.list(botId).filter(g => g.activeExecutionId).length >= service.readSettings().maxConcurrent;
}
function tickQueued(host: GoalRuntimeHost, parent: SessionRecord, service: GoalService, botId: string, goal: BotGoal): boolean {
 if (goalAlreadyHandled(host, parent, goal)) return false;
 if (skipFreshQueued(host, parent, goal)) return false;
 if (atConcurrencyCap(service, botId)) return true;
 spawnContinuation(host, parent, goal);
 return false;
}
function tickQueuedGoals(host: GoalRuntimeHost, parent: SessionRecord, service: GoalService, botId: string): void {
 for (const goal of service.list(botId).filter(g => g.status === 'queued' && !g.activeExecutionId && !g.draining)) {
  if (tickQueued(host, parent, service, botId, goal)) break;
 }
}
function tickWaitingGoals(host: GoalRuntimeHost, parent: SessionRecord, service: GoalService, botId: string): void {
 for (const goal of service.list(botId).filter(g => g.status === 'waiting')) wakeFinishedWait(host, parent, service, botId, goal);
}
function announceGoals(host: GoalRuntimeHost, service: GoalService, botId: string): void {
 for (const goal of service.list(botId)) announceGoalState(host, goal);
}
async function tickParent(host: GoalRuntimeHost, parent: SessionRecord): Promise<void> {
 const scope = goalScope(host.store, parent);
 if (!scope) return;
 const {service, botId} = scope;
 for (const goal of service.list(botId)) await tickRunningGoal(host, service, botId, parent, goal);
 service.recover(botId);
 tickWaitingGoals(host, parent, service, botId);
 tickQueuedGoals(host, parent, service, botId);
 announceGoals(host, service, botId);
}
export async function tickBotGoals(host: GoalRuntimeHost): Promise<void> {
 if (ticking.has(host.store)) return;
 ticking.add(host.store);
 try {
  for (const parent of canonicalParents(host)) await tickParent(host, parent);
 } finally { ticking.delete(host.store); }
}
