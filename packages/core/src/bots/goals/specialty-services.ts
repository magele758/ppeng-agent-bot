import type { SqliteStateStore } from '../../storage.js';
import type { SessionRecord, ToolContract, SelfHealTestPreset } from '../../types.js';
import type { SelfHealScheduler } from '../../self-heal/self-heal-scheduler.js';
import type { FactoryService } from '../../factory/service.js';
import { principalFromSession } from '../bot-identity.js';
import { inheritBotIdentityMetadata } from '../../memory/bot-memory-scope.js';
import { inheritBotAllowlists, inheritModelOverride, childPermissionMode } from '../../runtime/spawn-policy.js';
import { goalScope } from './runtime-host.js';
import type { BotGoal } from './types.js';

export interface SpecialtyServices {
  store: SqliteStateStore;
  selfHeal: SelfHealScheduler;
  factory: FactoryService;
  cancelSession(id: string): void;
  isRunning(id: string): boolean;
}
export function selfHealPresetForTask(task:string):SelfHealTestPreset {
  if (/\be2e\b|playwright|端到端/i.test(task)) return 'e2e';
  if (/\bregression\b|回归/i.test(task)) return 'regression';
  if (/\bremote\b|远程测试/i.test(task)) return 'remote';
  if (/\bci\b|持续集成/i.test(task)) return 'ci';
  if (/\bbuild\b|编译|构建/i.test(task)) return 'build';
  return 'unit';
}
function recordStart(store:SqliteStateStore,session:SessionRecord,goalId:string,executionId:string,source:string,reference:string):void {
  const live=store.getSession(session.id)!;
  const waits=Array.isArray(live.metadata.botGoalAuthorizedWaits)?live.metadata.botGoalAuthorizedWaits:[];
  store.updateSession(live.id,{metadata:{...live.metadata,
    botGoalAuthorizedWaits:[...waits.filter(wait=>wait.executionId!==executionId),{goalId,executionId,source,correlationId:reference}],
    botGoalCheckpoint:{kind:'waiting',summary:`${source} ${reference} started; verify the result before completing`,wait:{source,correlationId:reference}}
  }});
  const scope=goalScope(store,live)!;
  scope.service.updateExecution(scope.botId,executionId,{runRef:`${source}:${reference}`,safeToRetry:false});
}
export function createGoalFactoryDevelopmentTool(host: Pick<SpecialtyServices,'store'|'factory'>): ToolContract {
  return {
    name:'goal_factory_develop',description:'Submit the assigned goal to an already authorized factory development workflow. Requires configured approved criteria and an exact baseline commit; never changes permissions, approves criteria or publishes. Discover targets with factory_status.',
    approvalMode:'always',sideEffectLevel:'system',
    inputSchema:{type:'object',properties:{machineId:{type:'string'},repositoryId:{type:'string'},baseline:{type:'string'},operation:{type:'string',enum:['develop']}},required:['machineId','repositoryId','baseline'],additionalProperties:false},
    async execute(context,args) {
      const session=host.store.getSession(context.session.id);
      const scope=session&&goalScope(host.store,session);
      const goal=scope?.service.get(scope.botId,String(session?.metadata.botGoalId));
      const execution=goal&&scope!.service.executions(scope!.botId,goal.id).find(e=>e.id===goal.activeExecutionId);
      if(!session||!scope||!goal||goal.status!=='running'||!execution||execution.sessionId!==session.id||execution.goalRevision!==goal.revision||execution.leaseUntil<=Date.now())return {ok:false,content:'No current authorized goal execution'};
      const principal=principalFromSession(host.store,session);
      const settings=host.factory.settings(principal);
      if(settings.coordinatorBotId!==scope.botId)return {ok:false,content:'Only the authorized factory coordinator may dispatch development'};
      const task=host.store.transaction(()=>{
        const submitted=host.factory.development.submit(principal,{machineId:args.machineId,repositoryId:args.repositoryId,baseline:args.baseline,
          requirement:`${goal.objective}\nConstraints: ${JSON.stringify(goal.constraints)}\nCompletion conditions: ${JSON.stringify(goal.completionCriteria)}\nPrevious progress: ${goal.progress}\nEvidence: ${JSON.stringify(goal.evidence)}`,
          requestKey:`goal:${execution.id}`,roomId:settings.roomId});
        recordStart(host.store,session,goal.id,execution.id,'factory',submitted.id);
        return submitted;
      });
      return {ok:true,content:JSON.stringify(task)};
    }
  };
}
export function createGoalSelfHealTool(host: Pick<SpecialtyServices, 'store' | 'selfHeal'>): ToolContract {
  return {
    name: 'goal_self_heal_start',
    description: 'Start the existing test/fix worktree lifecycle for the assigned Bot goal. Selects the requested test preset automatically (unit by default); retains the Bot permissions and specialist constraints. Does not merge, push, restart or grant external CLI access.',
    inputSchema: {type:'object',properties:{},additionalProperties:false},
    approvalMode: 'always', sideEffectLevel: 'system',
    async execute(context) {
      const session = host.store.getSession(context.session.id);
      const scope = session && goalScope(host.store, session);
      const goal = scope && scope.service.get(scope.botId, String(session!.metadata.botGoalId));
      const execution = goal && scope!.service.executions(scope!.botId, goal.id).find(e => e.id === goal.activeExecutionId);
      if (!session || !scope || !goal || goal.status !== 'running' || !execution || execution.sessionId !== session.id || execution.goalRevision !== goal.revision || execution.leaseUntil <= Date.now()) return {ok:false,content:'No current authorized goal execution'};
      const key = `bot.goal-self-heal:${execution.id}`;
      const existing = host.store.getDaemonControl<string>(key);
      if (existing) return {ok:true,content:JSON.stringify(host.selfHeal.getRun(existing))};
      const run = host.store.transaction(() => {
        const run = host.selfHeal.startRun({testPreset:selfHealPresetForTask(goal.objective),maxFixIterations:5,autoMerge:false,autoRestartDaemon:false,allowExternalAiTools:false,agentId:'self-healer'});
        host.store.setDaemonControl(key,run.id);
        host.store.setDaemonControl(`bot.goal-self-heal-owner:${run.id}`, {
          parentSessionId:session.id, objective:goal.objective, constraints:goal.constraints,
          metadata:{...inheritBotAllowlists(session.metadata),...inheritModelOverride(session.metadata),...inheritBotIdentityMetadata(session,host.store),
            permissionMode:childPermissionMode(session.metadata),botId:scope.botId,botGoalId:goal.id,botGoalScopeSessionId:scope.sessionId,
            botGoalWorker:true,botGoalWorkerRevision:goal.revision,botGoalWorkerExecutionId:execution.id,botGoalWorkerFence:execution.fence}
        });
        recordStart(host.store,session,goal.id,execution.id,'self_heal',run.id);
        return run;
      });
      return {ok:true,content:JSON.stringify(run)};
    }
  };
}

/** Called only for references already authenticated against the dispatch ledger. */
export function specialtyStatus(host: SpecialtyServices, parent: SessionRecord, goal: BotGoal): {status:string;evidence:string[];draining?:boolean} {
  const wait=goal.wait!;
  if (wait.source === 'self_heal') {
    const owner=host.store.getDaemonControl<{metadata:Record<string,unknown>}>(`bot.goal-self-heal-owner:${wait.correlationId}`);
    if (owner?.metadata.botGoalId !== goal.id || owner.metadata.botGoalScopeSessionId !== parent.id) return {status:'unauthorized',evidence:[]};
    const run=host.selfHeal.getRun(wait.correlationId);
    if (!run) return {status:'unknown',evidence:[]};
    return {status:run.stopped?'cancelled':run.status,evidence:[JSON.stringify(run)],draining:host.selfHeal.isRunInFlight(run.id)||Boolean(run.sessionId && host.isRunning(run.sessionId))};
  }
  if (wait.source === 'factory') {
    try {
      const task=host.factory.get(principalFromSession(host.store,parent),wait.correlationId);
      if (task.coordinatorBotId !== goal.botId) return {status:'unauthorized',evidence:[]};
      return {status:task.status==='succeeded'?'completed':task.status,evidence:[JSON.stringify(task)]};
    } catch { return {status:'unknown',evidence:[]}; }
  }
  return {status:'unsupported',evidence:[]};
}
export async function cancelSpecialty(host: SpecialtyServices, parent: SessionRecord, goal: BotGoal): Promise<boolean> {
  const state=specialtyStatus(host,parent,goal);
  if (state.status==='unauthorized'||state.status==='unsupported') return false;
  if (goal.wait!.source==='self_heal') {
    const run=host.selfHeal.getRun(goal.wait!.correlationId);
    if (!run) return false;
    if (!['completed','failed','stopped'].includes(run.status)) host.selfHeal.stopRun(run.id);
    if (run.sessionId) host.cancelSession(run.sessionId);
    return !host.selfHeal.isRunInFlight(run.id) && (!run.sessionId || !host.isRunning(run.sessionId));
  }
  if (goal.wait!.source==='factory') {
    const principal=principalFromSession(host.store,parent);
    const task=host.factory.get(principal,goal.wait!.correlationId);
    if(task.development && ['queued','running','unknown'].includes(task.status)) {
      const stopped=await host.factory.development.control(principal,task.id,'cancel');
      return ['cancelled','failed','timed_out','succeeded'].includes(stopped.status);
    }
    if (state.status==='queued') host.factory.cancel(principalFromSession(host.store,parent),goal.wait!.correlationId);
    // The existing read-only remote transport cannot interrupt an already running request.
    return ['queued','completed','failed','timed_out','cancelled'].includes(state.status);
  }
  return false;
}
