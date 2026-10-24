import { randomUUID } from 'node:crypto';
import type { BotGoal, GoalExecution, GoalIntent, GoalReport, GoalSettings, GoalSnapshot, GoalStore } from './types.js';
import { mutateGoalSnapshot, readGoalSnapshot } from './store.js';
import { readGoalSettings, writeGoalSettings } from './settings.js';
const terminal = new Set(['completed', 'cancelled', 'failed']);
export function occupiesGoalCapacity(goal: BotGoal): boolean {
 return Boolean(goal.activeExecutionId || goal.draining || goal.wait);
}
const PENDING_REVIEW = 'Completion evidence requires verification';
function finiteReportCost(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}
function reportAdvanced(result: GoalReport, goal: BotGoal): boolean {
  return result.advanced === true || (result.advanced === undefined && !!result.summary && result.summary !== goal.progress);
}
function sameWakeIdentity(event: { goalId?: string; source: string; correlationId: string }, goal: BotGoal, wait: { source: string; correlationId: string }): boolean {
  return (!event.goalId || event.goalId === goal.id) && event.source === wait.source && event.correlationId === wait.correlationId;
}
function wakeSessionMatches(event: { sessionId?: string }, goal: BotGoal): boolean {
  return !event.sessionId || event.sessionId === goal.sessionId;
}
function wakeMatches(event: { goalId?: string; source: string; correlationId: string; sessionId?: string; consumedBy: string[] }, goal: BotGoal, wait: { source: string; correlationId: string }): boolean {
  if (!sameWakeIdentity(event, goal, wait)) return false;
  return wakeSessionMatches(event, goal) && !event.consumedBy.includes(goal.id);
}
export class BotGoalService {
 constructor(private readonly store: GoalStore, private readonly clock: () => number = Date.now, private readonly scopeSessionId?: string) {}
 private date(): string { return new Date(this.clock()).toISOString(); }
 private visible(g: BotGoal): boolean { return !this.scopeSessionId || g.sessionId === this.scopeSessionId; }
 private find(state: GoalSnapshot, id: string): BotGoal { const goal = state.goals.find(g => g.id === id && this.visible(g)); if (!goal) throw new Error('Goal not found'); return goal; }
 private event(s: GoalSnapshot, type: string, goal?: BotGoal, detail?: string): void { s.events.push({ id: randomUUID(), type, goalId: goal?.id, at: this.date(), detail }); if (goal) goal.updatedAt = this.date(); }
 extendLimits(botId:string,id:string,patch:{additionalBudgetUsd?:number;additionalAttempts?:number}):BotGoal {
  return mutateGoalSnapshot(this.store,botId,s=>{
   const g=this.find(s,id);
   if(terminal.has(g.status))throw new Error('Cannot extend terminal goal');
   const budget=patch.additionalBudgetUsd??0,attempts=patch.additionalAttempts??0;
   if(!Number.isFinite(budget)||budget<0||!Number.isSafeInteger(attempts)||attempts<0||!(budget>0||attempts>0))throw new Error('Positive additional budget or attempts required');
   if(!Number.isFinite(g.budgetUsd+budget)||!Number.isSafeInteger((g.extraAttempts??0)+attempts))throw new Error('Goal limit overflow');
   g.budgetUsd+=budget;g.extraAttempts=(g.extraAttempts??0)+attempts;
   this.event(s,'limits_extended',g,JSON.stringify({additionalBudgetUsd:budget,additionalAttempts:attempts}));return g;
  });
 }
 readSettings(): GoalSettings { return readGoalSettings(this.store, this.scopeSessionId); }
 updateSettings(patch: Partial<GoalSettings>): GoalSettings { return writeGoalSettings(this.store, patch, this.scopeSessionId); }
 list(botId: string): BotGoal[] { return readGoalSnapshot(this.store, botId).goals.filter(g => this.visible(g)).sort((a,b) => b.priority-a.priority || a.createdAt.localeCompare(b.createdAt)); }
 get(botId: string, id: string): BotGoal | undefined { return this.list(botId).find(g => g.id === id); }
 executions(botId: string, goalId: string): GoalExecution[] { if (!this.get(botId, goalId)) return []; return readGoalSnapshot(this.store,botId).executions.filter(e => e.goalId === goalId); }
 findBySource(botId: string, sourceMessageId: string): BotGoal | undefined { return this.list(botId).find(g => g.sourceMessageId === sourceMessageId); }
 create(input: { botId: string; sessionId: string; title: string; objective: string; sourceMessageId?: string; constraints?: string[]; completionCriteria?: string[]; resources?: string[]; priority?: number; parentGoalId?: string; resumeRequested?: boolean }): BotGoal {
  if (this.scopeSessionId && input.sessionId !== this.scopeSessionId) throw new Error('Goal session mismatch');
  if (!input.objective.trim()) throw new Error('Goal objective required');
  return mutateGoalSnapshot(this.store,input.botId,s => {
   const existing = input.sourceMessageId && s.goals.find(g => g.sessionId === input.sessionId && g.sourceMessageId === input.sourceMessageId); if (existing) return existing;
   if (input.parentGoalId) this.find(s,input.parentGoalId);
   const g: BotGoal = { ...input, id: `goal_${randomUUID()}`, constraints: input.constraints ?? [], completionCriteria: input.completionCriteria ?? [input.objective], resources: input.resources ?? [], priority: input.priority ?? 0, revision: 1, status: 'queued', progress: '', evidence: [], budgetUsd: this.readSettings().defaultBudgetUsd, costUsd: 0, attempts: 0, noProgress: 0, createdAt: this.date(), updatedAt: this.date() };
   s.goals.push(g);this.event(s,'created',g);return g;
  });
 }
 private duplicateIntent(s: GoalSnapshot, goal: BotGoal, intent: GoalIntent): { goal: BotGoal; duplicate: true } | undefined {
  const key = `intent:${goal.sessionId}:${goal.id}:${intent.kind}:${intent.sourceMessageId}`;
  if (intent.sourceMessageId && s.processed.includes(key)) return { goal: this.find(s, goal.id), duplicate: true };
  return undefined;
 }
 private applyIntentControl(s: GoalSnapshot, goal: BotGoal, intent: GoalIntent): void {
  if (intent.kind === 'pause' || intent.kind === 'resume' || intent.kind === 'cancel') this.controlState(s, goal, intent.kind);
 }
 private applyIntentChange(s: GoalSnapshot, goal: BotGoal, intent: GoalIntent): void {
  if (intent.kind === 'amend_goal') { this.amendState(s, goal, intent.text ?? ''); return; }
  this.applyIntentControl(s, goal, intent);
 }
 private rememberIntent(s: GoalSnapshot, goal: BotGoal, intent: GoalIntent): void {
  if (!intent.sourceMessageId) return;
  s.processed.push(`intent:${goal.sessionId}:${goal.id}:${intent.kind}:${intent.sourceMessageId}`);
 }
 private commitIntent(s: GoalSnapshot, goal: BotGoal, intent: GoalIntent): { goal: BotGoal; duplicate?: true } {
  const duplicate = this.duplicateIntent(s, goal, intent);
  if (duplicate) return duplicate;
  const current = this.find(s, goal.id);
  this.applyIntentChange(s, current, intent);
  this.rememberIntent(s, goal, intent);
  return { goal: current };
 }
 applyIntent(botId: string, intent: GoalIntent): { goal?: BotGoal; goals?: BotGoal[]; clarification?: boolean; duplicate?: boolean } {
  if (intent.kind === 'query') return { goals: intent.goalId ? this.list(botId).filter(g => g.id === intent.goalId) : this.list(botId) };
  if (intent.kind === 'new_goal') return { goal: this.create({ botId, sessionId: this.scopeSessionId ?? intent.sessionId ?? '', title: intent.text ?? '', objective: intent.text ?? '', sourceMessageId: intent.sourceMessageId }) };
  const candidates = this.list(botId).filter(g => intent.goalId ? g.id === intent.goalId : !terminal.has(g.status));
  if (candidates.length !== 1) return { clarification: true };
  const goal = candidates[0]!;
  return mutateGoalSnapshot(this.store, botId, s => this.commitIntent(s, goal, intent));
 }
 private amendState(s: GoalSnapshot,g: BotGoal,constraint: string): void {
  if (!constraint.trim()) throw new Error('Constraint required');
  if (terminal.has(g.status)) throw new Error('Cannot amend terminal goal');
  g.constraints.push(constraint);g.revision++;g.nextStep='Apply updated constraints; reconcile previous actions';
  if (g.activeExecutionId) { g.draining=true;g.blockedReason='Constraints changed; current execution must reconcile at a safe boundary'; }
  else if (g.status !== 'paused' && g.status !== 'pending_review') {g.status='queued';if(g.wait){g.draining=true;g.blockedReason='Constraints changed; previous external execution must stop before applying the new revision';}}this.event(s,'amended',g,constraint);
 }
 amend(botId:string,id:string,constraint:string): BotGoal { return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);this.amendState(s,g,constraint);return g;}); }
 private resumeState(g:BotGoal):void {
  if(g.status==='pending_review')throw new Error('Completion is pending verification');
  if(g.activeExecutionId||g.draining)throw new Error('Execution still draining');
  if(g.status==='waiting')throw new Error('Goal is waiting for its existing execution');
  if(g.status!=='paused'&&g.status!=='blocked')throw new Error('Only paused or blocked goals can resume');
  if(g.wait)throw new Error('External wait requires reconciliation before resuming');
  g.status='queued';g.blockedReason=undefined;g.resumeRequested=true;
 }
 private controlState(s:GoalSnapshot,g:BotGoal,action:'pause'|'resume'|'cancel'): void {
  if (terminal.has(g.status)) throw new Error('Cannot control terminal goal');
  if(action==='resume')this.resumeState(g);
  else {g.status=action==='pause'?'paused':'cancelled';g.revision++;g.draining=Boolean(g.activeExecutionId||g.wait);}
  this.event(s,action,g);
 }
 control(botId:string,id:string,action:'pause'|'resume'|'cancel'|'verify',decision?:{accepted:boolean;reason?:string}):BotGoal{return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);if(action==='verify'){this.verifyState(s,g,decision);return g;}this.controlState(s,g,action);return g;});}
 private verifyState(s:GoalSnapshot,g:BotGoal,decision?:{accepted:boolean;reason?:string}):void {
  if(g.status!=='pending_review')throw new Error('Goal is not pending verification');
  if(decision?.accepted!==true&&decision?.accepted!==false)throw new Error('Verification decision required');
  if(decision.accepted){if(!g.evidence.length)throw new Error('Completion evidence required');g.status='completed';g.blockedReason=undefined;this.event(s,'verified',g,decision.reason);return;}
  g.status='queued';g.blockedReason=undefined;g.resumeRequested=true;g.nextStep=decision.reason?.trim()||'Recorded completion was rejected; continue the remaining work without repeating confirmed effects';this.event(s,'verification_rejected',g,decision.reason);
 }
 setDraining(botId:string,id:string,draining:boolean,reason?:string):BotGoal{return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);g.draining=draining;if(!draining)g.wait=undefined;g.blockedReason=reason;this.event(s,'draining',g,reason);return g;});}
 finishAmendDrain(botId:string,id:string,result:{summary:string;evidence:string[];costUsd:number}):void{mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);if(g.status!=='queued'||!g.wait)return;g.draining=false;g.wait=undefined;g.blockedReason=undefined;g.nextStep='Reconcile partial previous actions against the updated constraints before continuing';this.applyWakeData(s,g,result);this.event(s,'revision_drained',g);});}
 reprioritize(botId:string,id:string,priority:number):BotGoal{if(!Number.isSafeInteger(priority))throw new Error('Priority must be an integer');return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);g.priority=priority;this.event(s,'reprioritized',g);return g;});}
 block(botId:string,id:string,reason:string):BotGoal{return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);if(!terminal.has(g.status)&&g.status!=='paused'&&g.status!=='pending_review'){g.status='blocked';g.blockedReason=reason;this.event(s,'blocked',g,reason);}return g;});}
 claim(botId:string,id:string,options:{strategy:string;strategyReason?:string;owner?:string;leaseMs?:number;safeToRetry?:boolean}):GoalExecution|undefined {
  return mutateGoalSnapshot(this.store,botId,s=>{
   const g=this.find(s,id);if(g.status!=='queued'||g.activeExecutionId||g.draining)return undefined;
   const settings=this.readSettings();if(this.limit(g,settings))return undefined;
   const active=s.goals.filter(other=>other.sessionId===g.sessionId&&occupiesGoalCapacity(other));
   if(active.length>=settings.maxConcurrent){g.blockedReason='Waiting for concurrency capacity';return undefined;}
   const conflicts=s.goals.find(other=>other.id!==id&&(other.activeExecutionId||(other.wait&&(other.status==='waiting'||other.draining)))&&other.resources.some(r=>g.resources.includes(r)));
   if(conflicts){g.blockedReason='Waiting for resource held by another active goal';return undefined;}
   const e:GoalExecution={id:`exec_${randomUUID()}`,goalId:id,goalRevision:g.revision,strategy:options.strategy,owner:options.owner??'runtime',fence:++s.fence,leaseUntil:this.clock()+(options.leaseMs??settings.leaseMs),safeToRetry:options.safeToRetry??false,status:'running',startedAt:this.date()};
   s.executions.push(e);g.activeExecutionId=e.id;g.status='running';g.resumeRequested=false;g.strategy=options.strategy;g.strategyReason=options.strategyReason;g.attempts++;g.blockedReason=undefined;this.event(s,'claimed',g);return e;
  });
 }
 updateExecution(botId:string,id:string,patch:{runRef?:string;sessionId?:string;safeToRetry?:boolean;leaseUntil?:number;messageStartSeq?:number;messageEndSeq?:number}):void {mutateGoalSnapshot(this.store,botId,s=>{const e=s.executions.find(x=>x.id===id);if(!e)throw new Error('Execution not found');this.find(s,e.goalId);if(e.status!=='running'||e.leaseUntil<=this.clock())throw new Error('Execution lease expired');Object.assign(e,patch);});}
 renewRunningLease(botId:string,id:string,leaseUntil:number):void {mutateGoalSnapshot(this.store,botId,s=>{const e=s.executions.find(x=>x.id===id);if(!e)throw new Error('Execution not found');const goal=this.find(s,e.goalId);if(e.status!=='running'||goal.status!=='running'||goal.activeExecutionId!==e.id)throw new Error('Execution lease expired');e.leaseUntil=leaseUntil;});}
 private limit(g:BotGoal,settings:GoalSettings,waiting=false):boolean {
  if(terminal.has(g.status)||g.status==='pending_review')return false;
  const reason=g.costUsd>=g.budgetUsd?'Goal budget exhausted':!waiting&&g.attempts>=settings.maxAttempts+(g.extraAttempts??0)?'Attempt limit reached':!waiting&&g.noProgress>=settings.maxNoProgress+(g.extraAttempts??0)?'No progress limit reached':undefined;
  if(reason){g.status='blocked';if(g.wait)g.draining=true;g.blockedReason=reason;g.nextStep='User review required';return true;}return false;
 }
 report(botId:string,id:string,result:GoalReport):BotGoal {
  return mutateGoalSnapshot(this.store,botId,s => this.applyReport(s,id,result));
 }
 private applyReport(s:GoalSnapshot,id:string,result:GoalReport):BotGoal {
  const opened=this.openReportedExecution(s,id,result);
  if(opened.stopped)return opened.goal;
  this.recordReportProgress(opened.goal,result);
  this.applyReportKind(s,opened.goal,result);
  if(!terminal.has(opened.goal.status)&&opened.goal.status!=='pending_review')this.limit(opened.goal,this.readSettings(),opened.goal.status==='waiting');
  this.event(s,'result',opened.goal,result.summary);
  return opened.goal;
 }
 private openReportedExecution(s:GoalSnapshot,id:string,result:GoalReport):{goal:BotGoal;stopped:boolean} {
  const execution=this.requireExecution(s,id);
  const goal=this.find(s,execution.goalId);
  this.assertReportFence(execution,result);
  if(this.duplicateReport(s,id,result,execution))return {goal,stopped:true};
  this.acceptReport(s,id,execution,goal,result);
  return this.settleReportGuards(s,execution,goal,result);
 }
 private requireExecution(s:GoalSnapshot,id:string):GoalExecution {
  const execution=s.executions.find(item=>item.id===id);
  if(!execution)throw new Error('Execution not found');
  return execution;
 }
 private assertReportFence(execution:GoalExecution,result:GoalReport):void {
  if((result.owner!==undefined&&result.owner!==execution.owner)||(result.fence!==undefined&&result.fence!==execution.fence))throw new Error('Execution fence mismatch');
 }
 private duplicateReport(s:GoalSnapshot,id:string,result:GoalReport,execution:GoalExecution):boolean {
  return s.processed.includes(`result:${id}:${result.eventId??'final'}`)||execution.status!=='running';
 }
 private acceptReport(s:GoalSnapshot,id:string,execution:GoalExecution,goal:BotGoal,result:GoalReport):void {
  s.processed.push(`result:${id}:${result.eventId??'final'}`);
  execution.status='finished';execution.summary=result.summary;execution.endedAt=this.date();
  goal.activeExecutionId=undefined;goal.draining=false;
  this.addReportCost(s,goal,result);
  goal.evidence.push(...(result.evidence??[]));
 }
 private addReportCost(s:GoalSnapshot,goal:BotGoal,result:GoalReport):void {
  const cost=finiteReportCost(result.costUsd);
  goal.costUsd+=cost;
  if(goal.parentGoalId)this.chargeParent(s,goal.parentGoalId,cost);
 }
 private chargeParent(s:GoalSnapshot,parentGoalId:string,cost:number):void {
  const parent=this.find(s,parentGoalId);
  parent.costUsd+=cost;
  this.limit(parent,this.readSettings());
 }
 private settleReportGuards(s:GoalSnapshot,execution:GoalExecution,goal:BotGoal,result:GoalReport):{goal:BotGoal;stopped:boolean} {
  if(this.lateReport(s,goal,result))return {goal,stopped:true};
  if(this.expiredReport(s,execution,goal,result))return {goal,stopped:true};
  if(this.staleReport(s,execution,goal,result))return {goal,stopped:true};
  return {goal,stopped:false};
 }
 private lateReport(s:GoalSnapshot,goal:BotGoal,result:GoalReport):boolean {
  if(!terminal.has(goal.status)&&goal.status!=='paused')return false;
  if(result.wait){goal.wait=result.wait;goal.draining=true;}
  else if(goal.wait)goal.draining=true;
  this.event(s,'late_result',goal,result.summary);
  return true;
 }
 private expiredReport(s:GoalSnapshot,execution:GoalExecution,goal:BotGoal,result:GoalReport):boolean {
  if(execution.leaseUntil>this.clock())return false;
  goal.status='blocked';goal.blockedReason='Execution lease expired; reconcile result before retry';
  this.event(s,'expired_result',goal,result.summary);
  return true;
 }
 private staleReport(s:GoalSnapshot,execution:GoalExecution,goal:BotGoal,result:GoalReport):boolean {
  if(execution.goalRevision===goal.revision)return false;
  goal.status='queued';
  if(result.wait){goal.wait=result.wait;goal.draining=true;}
  goal.blockedReason='Previous result used outdated constraints; reconciliation required';
  this.event(s,'stale_result',goal,result.summary);
  return true;
 }
 private recordReportProgress(goal:BotGoal,result:GoalReport):void {
  goal.noProgress=result.kind==='candidate_completed'&&result.verified!==true?0:reportAdvanced(result,goal)?0:goal.noProgress+1;
  goal.progress=result.summary;goal.nextStep=result.nextStep;goal.blockedReason=undefined;
 }
 private applyReportKind(s:GoalSnapshot,goal:BotGoal,result:GoalReport):void {
  if(result.kind==='candidate_completed'||result.kind==='waiting'){this.applyCompletionOrWait(s,goal,result);return;}
  this.applyTerminalReportKind(goal,result);
 }
 private applyCompletionOrWait(s:GoalSnapshot,goal:BotGoal,result:GoalReport):void {
  if(result.kind==='candidate_completed')this.markCandidateCompleted(goal,result);
  else this.markWaiting(s,goal,result);
 }
 private markCandidateCompleted(goal:BotGoal,result:GoalReport):void {
  if(result.verified&&Boolean(result.evidence?.length)){goal.status='completed';goal.blockedReason=undefined;return;}
  goal.status='pending_review';
  goal.blockedReason=PENDING_REVIEW;
  goal.noProgress=0;
 }
 private markWaiting(s:GoalSnapshot,goal:BotGoal,result:GoalReport):void {
  if(!result.wait?.source||!result.wait.correlationId){goal.status='blocked';goal.blockedReason='Missing durable wait condition';return;}
  const wake=s.wakeEvents?.find(event=>wakeMatches(event,goal,result.wait!));
  if(wake)this.consumeWake(s,goal,wake);
  else {goal.status='waiting';goal.wait=result.wait;}
 }
 private consumeWake(s:GoalSnapshot,goal:BotGoal,wake:{source:string;correlationId:string;consumedBy:string[];completionCandidate?:boolean;summary?:string;evidence?:string[];costUsd?:number}):void {
  wake.consumedBy.push(goal.id);
  goal.status='queued';
  goal.nextStep=`Inspect authorized ${wake.source} result ${wake.correlationId} before continuing`;
  goal.wait=undefined;
  this.applyWakeData(s,goal,wake);
 }
 private applyTerminalReportKind(goal:BotGoal,result:GoalReport):void {
  if(result.kind==='blocked'||result.kind==='failed')this.markBlockedReport(goal,result);
  else if(result.kind==='cancelled')goal.status='cancelled';
  else if(result.kind==='progress')goal.status='queued';
 }
 private markBlockedReport(goal:BotGoal,result:GoalReport):void {
  goal.status=result.kind==='failed'?'failed':'blocked';
  goal.blockedReason=result.summary||(result.kind==='failed'?'Execution failed':'Execution blocked');
  if(result.kind==='blocked'&&result.wait){goal.wait=result.wait;goal.draining=true;}
 }
 private applyWakeData(s:GoalSnapshot,g:BotGoal,event:{summary?:string;evidence?:string[];costUsd?:number;completionCandidate?:boolean}):void{if(event.summary)g.progress=event.summary;g.evidence.push(...(event.evidence??[]));const cost=Number.isFinite(event.costUsd)?Math.max(0,event.costUsd!):0;g.costUsd+=cost;if(g.parentGoalId){const parent=this.find(s,g.parentGoalId);parent.costUsd+=cost;this.limit(parent,this.readSettings());}if(this.limit(g,this.readSettings())&&event.completionCandidate){g.status='pending_review';g.blockedReason=PENDING_REVIEW;g.noProgress=0;}}
 wake(botId:string,event:{completionCandidate?:boolean;goalId?:string;eventId:string;source:string;correlationId:string;summary?:string;evidence?:string[];costUsd?:number}):BotGoal[]{return mutateGoalSnapshot(this.store,botId,s=>{
  const key=`wake:${this.scopeSessionId??'*'}:${event.goalId??'*'}:${event.source}:${event.eventId}`;if(s.processed.includes(key))return [];s.processed.push(key);
  const wake={...event,sessionId:this.scopeSessionId,consumedBy:[] as string[]};(s.wakeEvents??=[]).push(wake);
  const goals=s.goals.filter(g=>this.visible(g)&&(!event.goalId||event.goalId===g.id)&&g.status==='waiting'&&g.wait?.source===event.source&&g.wait.correlationId===event.correlationId);
  for(const g of goals){wake.consumedBy.push(g.id);g.status='queued';g.nextStep=`Inspect authorized ${event.source} result ${event.correlationId} before continuing`;g.wait=undefined;this.applyWakeData(s,g,event);this.event(s,'awakened',g);}return goals;
 });}
 recover(botId:string):BotGoal[]{return mutateGoalSnapshot(this.store,botId,s=>{
  const changed:BotGoal[]=[];
  for(const e of s.executions){const g=s.goals.find(x=>x.id===e.goalId&&this.visible(x));if(!g||e.status!=='running'||e.leaseUntil>this.clock())continue;
   e.status='interrupted';e.endedAt=this.date();g.activeExecutionId=undefined;g.draining=false;
   if(!terminal.has(g.status)&&g.status!=='paused'){g.status=e.safeToRetry?'queued':'blocked';g.blockedReason=e.safeToRetry?undefined:'Execution interrupted; verify external effects before retry';}
   this.event(s,'recovered',g);changed.push(g);
  }
  for(const g of s.goals){if(this.visible(g)&&g.status==='waiting'&&g.wait?.deadline!==undefined&&g.wait.deadline<=this.clock()){g.status='blocked';g.draining=true;g.blockedReason='Wait deadline exceeded';this.event(s,'wait_timeout',g);changed.push(g);}}
  return changed;
 });}
}
