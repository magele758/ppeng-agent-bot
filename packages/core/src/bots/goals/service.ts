import { randomUUID } from 'node:crypto';
import type { BotGoal, GoalExecution, GoalIntent, GoalReport, GoalSettings, GoalSnapshot, GoalStore } from './types.js';
import { mutateGoalSnapshot, readGoalSnapshot } from './store.js';
import { readGoalSettings, writeGoalSettings } from './settings.js';
const terminal = new Set(['completed', 'cancelled', 'failed']);
export class BotGoalService {
 constructor(private readonly store: GoalStore, private readonly clock: () => number = Date.now, private readonly scopeSessionId?: string) {}
 private date(): string { return new Date(this.clock()).toISOString(); }
 private visible(g: BotGoal): boolean { return !this.scopeSessionId || g.sessionId === this.scopeSessionId; }
 private find(state: GoalSnapshot, id: string): BotGoal { const goal = state.goals.find(g => g.id === id && this.visible(g)); if (!goal) throw new Error('Goal not found'); return goal; }
 private event(s: GoalSnapshot, type: string, goal?: BotGoal, detail?: string): void { s.events.push({ id: randomUUID(), type, goalId: goal?.id, at: this.date(), detail }); if (goal) goal.updatedAt = this.date(); }
 readSettings(): GoalSettings { return readGoalSettings(this.store, this.scopeSessionId); }
 updateSettings(patch: Partial<GoalSettings>): GoalSettings { return writeGoalSettings(this.store, patch, this.scopeSessionId); }
 list(botId: string): BotGoal[] { return readGoalSnapshot(this.store, botId).goals.filter(g => this.visible(g)).sort((a,b) => b.priority-a.priority || a.createdAt.localeCompare(b.createdAt)); }
 get(botId: string, id: string): BotGoal | undefined { return this.list(botId).find(g => g.id === id); }
 executions(botId: string, goalId: string): GoalExecution[] { if (!this.get(botId, goalId)) return []; return readGoalSnapshot(this.store,botId).executions.filter(e => e.goalId === goalId); }
 findBySource(botId: string, sourceMessageId: string): BotGoal | undefined { return this.list(botId).find(g => g.sourceMessageId === sourceMessageId); }
 create(input: { botId: string; sessionId: string; title: string; objective: string; sourceMessageId?: string; constraints?: string[]; completionCriteria?: string[]; resources?: string[]; priority?: number; parentGoalId?: string }): BotGoal {
  if (this.scopeSessionId && input.sessionId !== this.scopeSessionId) throw new Error('Goal session mismatch');
  if (!input.objective.trim()) throw new Error('Goal objective required');
  return mutateGoalSnapshot(this.store,input.botId,s => {
   const existing = input.sourceMessageId && s.goals.find(g => g.sessionId === input.sessionId && g.sourceMessageId === input.sourceMessageId); if (existing) return existing;
   if (input.parentGoalId) this.find(s,input.parentGoalId);
   const g: BotGoal = { ...input, id: `goal_${randomUUID()}`, constraints: input.constraints ?? [], completionCriteria: input.completionCriteria ?? [input.objective], resources: input.resources ?? [], priority: input.priority ?? 0, revision: 1, status: 'queued', progress: '', evidence: [], budgetUsd: this.readSettings().defaultBudgetUsd, costUsd: 0, attempts: 0, noProgress: 0, createdAt: this.date(), updatedAt: this.date() };
   s.goals.push(g);this.event(s,'created',g);return g;
  });
 }
 applyIntent(botId: string, intent: GoalIntent): { goal?: BotGoal; goals?: BotGoal[]; clarification?: boolean; duplicate?: boolean } {
  if (intent.kind === 'query') return { goals: intent.goalId ? this.list(botId).filter(g => g.id === intent.goalId) : this.list(botId) };
  if (intent.kind === 'new_goal') return { goal: this.create({ botId, sessionId: this.scopeSessionId ?? intent.sessionId ?? '', title: intent.text ?? '', objective: intent.text ?? '', sourceMessageId: intent.sourceMessageId }) };
  const candidates = this.list(botId).filter(g => intent.goalId ? g.id === intent.goalId : !terminal.has(g.status));
  if (candidates.length !== 1) return { clarification: true };
  const goal = candidates[0]!;
  return mutateGoalSnapshot(this.store,botId,s => {
   const key = `intent:${goal.sessionId}:${goal.id}:${intent.kind}:${intent.sourceMessageId}`;
   if (intent.sourceMessageId && s.processed.includes(key)) return { goal: this.find(s,goal.id), duplicate: true };
   const g=this.find(s,goal.id);
   if (intent.kind === 'amend_goal') this.amendState(s,g,intent.text ?? ''); else if (intent.kind === 'pause' || intent.kind === 'resume' || intent.kind === 'cancel') this.controlState(s,g,intent.kind);
   if (intent.sourceMessageId) s.processed.push(key);return { goal:g };
  });
 }
 private amendState(s: GoalSnapshot,g: BotGoal,constraint: string): void {
  if (!constraint.trim()) throw new Error('Constraint required');
  if (terminal.has(g.status)) throw new Error('Cannot amend terminal goal');
  g.constraints.push(constraint);g.revision++;g.nextStep='Apply updated constraints; reconcile previous actions';
  if (g.activeExecutionId) { g.draining=true;g.blockedReason='Constraints changed; current execution must reconcile at a safe boundary'; }
  else if (g.status !== 'paused') {g.status='queued';if(g.wait){g.draining=true;g.blockedReason='Constraints changed; previous external execution must stop before applying the new revision';}}this.event(s,'amended',g,constraint);
 }
 amend(botId:string,id:string,constraint:string): BotGoal { return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);this.amendState(s,g,constraint);return g;}); }
 private controlState(s:GoalSnapshot,g:BotGoal,action:'pause'|'resume'|'cancel'): void {
  if (terminal.has(g.status)) throw new Error('Cannot control terminal goal');
  if(action==='resume'){if(g.activeExecutionId||g.draining)throw new Error('Execution still draining');g.status='queued';g.blockedReason=undefined;g.wait=undefined;g.resumeRequested=true;}
  else {g.status=action==='pause'?'paused':'cancelled';g.revision++;g.draining=Boolean(g.activeExecutionId||g.wait);}
  this.event(s,action,g);
 }
 control(botId:string,id:string,action:'pause'|'resume'|'cancel'):BotGoal{return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);this.controlState(s,g,action);return g;});}
 setDraining(botId:string,id:string,draining:boolean,reason?:string):BotGoal{return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);g.draining=draining;g.blockedReason=reason;this.event(s,'draining',g,reason);return g;});}
 finishAmendDrain(botId:string,id:string,result:{summary:string;evidence:string[];costUsd:number}):void{mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);if(g.status!=='queued'||!g.wait)return;g.draining=false;g.wait=undefined;g.blockedReason=undefined;g.nextStep='Reconcile partial previous actions against the updated constraints before continuing';this.applyWakeData(s,g,result);this.event(s,'revision_drained',g);});}
 reprioritize(botId:string,id:string,priority:number):BotGoal{if(!Number.isSafeInteger(priority))throw new Error('Priority must be an integer');return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);g.priority=priority;this.event(s,'reprioritized',g);return g;});}
 block(botId:string,id:string,reason:string):BotGoal{return mutateGoalSnapshot(this.store,botId,s=>{const g=this.find(s,id);if(!terminal.has(g.status)&&g.status!=='paused'){g.status='blocked';g.blockedReason=reason;this.event(s,'blocked',g,reason);}return g;});}
 claim(botId:string,id:string,options:{strategy:string;strategyReason?:string;owner?:string;leaseMs?:number;safeToRetry?:boolean}):GoalExecution|undefined {
  return mutateGoalSnapshot(this.store,botId,s=>{
   const g=this.find(s,id);if(g.status!=='queued'||g.activeExecutionId||g.draining)return undefined;
   const settings=this.readSettings();if(this.limit(g,settings))return undefined;
   const active=s.executions.filter(e=>e.status==='running');
   if(active.filter(e=>s.goals.some(x=>x.id===e.goalId&&x.sessionId===g.sessionId)).length>=settings.maxConcurrent){g.blockedReason='Waiting for concurrency capacity';return undefined;}
   const conflicts=s.goals.find(other=>other.id!==id&&(other.activeExecutionId||(other.wait&&(other.status==='waiting'||other.draining)))&&other.resources.some(r=>g.resources.includes(r)));
   if(conflicts){g.blockedReason='Waiting for resource held by another active goal';return undefined;}
   const e:GoalExecution={id:`exec_${randomUUID()}`,goalId:id,goalRevision:g.revision,strategy:options.strategy,owner:options.owner??'runtime',fence:++s.fence,leaseUntil:this.clock()+(options.leaseMs??settings.leaseMs),safeToRetry:options.safeToRetry??false,status:'running',startedAt:this.date()};
   s.executions.push(e);g.activeExecutionId=e.id;g.status='running';g.resumeRequested=false;g.strategy=options.strategy;g.strategyReason=options.strategyReason;g.attempts++;g.blockedReason=undefined;this.event(s,'claimed',g);return e;
  });
 }
 updateExecution(botId:string,id:string,patch:{runRef?:string;sessionId?:string;safeToRetry?:boolean;leaseUntil?:number}):void {mutateGoalSnapshot(this.store,botId,s=>{const e=s.executions.find(x=>x.id===id);if(!e)throw new Error('Execution not found');this.find(s,e.goalId);if(e.status!=='running'||e.leaseUntil<=this.clock())throw new Error('Execution lease expired');Object.assign(e,patch);});}
 private limit(g:BotGoal,settings:GoalSettings):boolean {
  const reason=g.costUsd>=g.budgetUsd?'Goal budget exhausted':g.attempts>=settings.maxAttempts?'Attempt limit reached':g.noProgress>=settings.maxNoProgress?'No progress limit reached':undefined;
  if(reason){g.status='blocked';g.blockedReason=reason;g.nextStep='User review required';return true;}return false;
 }
 report(botId:string,id:string,result:GoalReport):BotGoal {
  return mutateGoalSnapshot(this.store,botId,s=>{
   const e=s.executions.find(x=>x.id===id);if(!e)throw new Error('Execution not found');const g=this.find(s,e.goalId);
   if ((result.owner !== undefined && result.owner !== e.owner) || (result.fence !== undefined && result.fence !== e.fence)) throw new Error('Execution fence mismatch');
   const eventKey=`result:${id}:${result.eventId??'final'}`;if(s.processed.includes(eventKey)||e.status!=='running')return g;
   s.processed.push(eventKey);e.status='finished';e.summary=result.summary;e.endedAt=this.date();g.activeExecutionId=undefined;g.draining=false;
   const cost=typeof result.costUsd==='number'&&Number.isFinite(result.costUsd)?Math.max(0,result.costUsd):0;g.costUsd+=cost;
   if(g.parentGoalId){const parent=this.find(s,g.parentGoalId);parent.costUsd+=cost;this.limit(parent,this.readSettings());}
   g.evidence.push(...(result.evidence??[]));
   if(terminal.has(g.status)||g.status==='paused'){if(result.wait){g.wait=result.wait;g.draining=true;}else if(g.wait)g.draining=true;this.event(s,'late_result',g,result.summary);return g;}
   if(e.leaseUntil<=this.clock()){g.status='blocked';g.blockedReason='Execution lease expired; reconcile result before retry';this.event(s,'expired_result',g,result.summary);return g;}
   if(e.goalRevision!==g.revision){g.status='queued';if(result.wait){g.wait=result.wait;g.draining=true;}g.blockedReason='Previous result used outdated constraints; reconciliation required';this.event(s,'stale_result',g,result.summary);return g;}
   g.noProgress=result.advanced === true || (result.advanced === undefined && result.summary&&result.summary!==g.progress)?0:g.noProgress+1;g.progress=result.summary;g.nextStep=result.nextStep;g.blockedReason=undefined;
   switch(result.kind){
    case 'candidate_completed':g.status=result.verified&&Boolean(result.evidence?.length)?'completed':'blocked';if(g.status==='blocked')g.blockedReason='Completion evidence requires verification';break;
    case 'waiting':if(!result.wait?.source||!result.wait.correlationId){g.status='blocked';g.blockedReason='Missing durable wait condition';}else{const wake=s.wakeEvents?.find(w=>(!w.goalId||w.goalId===g.id)&&w.source===result.wait!.source&&w.correlationId===result.wait!.correlationId&&(!w.sessionId||w.sessionId===g.sessionId)&&!w.consumedBy.includes(g.id));if(wake){wake.consumedBy.push(g.id);g.status='queued';g.nextStep=`Inspect authorized ${wake.source} result ${wake.correlationId} before continuing`;g.wait=undefined;this.applyWakeData(s,g,wake);}else{g.status='waiting';g.wait=result.wait;}}break;
    case 'blocked':g.status='blocked';g.blockedReason=result.summary||'Execution blocked';if(result.wait){g.wait=result.wait;g.draining=true;}break;
    case 'failed':g.status='blocked';g.blockedReason=result.summary||'Execution failed';break;
    case 'cancelled':g.status='cancelled';break;
    case 'progress':g.status='queued';break;
   }
   if(!terminal.has(g.status))this.limit(g,this.readSettings());this.event(s,'result',g,result.summary);return g;
  });
 }
 private applyWakeData(s:GoalSnapshot,g:BotGoal,event:{summary?:string;evidence?:string[];costUsd?:number}):void{if(event.summary)g.progress=event.summary;g.evidence.push(...(event.evidence??[]));const cost=Number.isFinite(event.costUsd)?Math.max(0,event.costUsd!):0;g.costUsd+=cost;if(g.parentGoalId){const parent=this.find(s,g.parentGoalId);parent.costUsd+=cost;this.limit(parent,this.readSettings());}this.limit(g,this.readSettings());}
 wake(botId:string,event:{goalId?:string;eventId:string;source:string;correlationId:string;summary?:string;evidence?:string[];costUsd?:number}):BotGoal[]{return mutateGoalSnapshot(this.store,botId,s=>{
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
  for(const g of s.goals){if(this.visible(g)&&g.status==='waiting'&&g.wait?.deadline!==undefined&&g.wait.deadline<=this.clock()){g.status='blocked';g.blockedReason='Wait deadline exceeded';this.event(s,'wait_timeout',g);changed.push(g);}}
  return changed;
 });}
}
