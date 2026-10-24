import type { SqliteStateStore } from '../../storage.js';
import type { MessagePart, RunContext, ToolContract } from '../../types.js';
import type { FileApprovalPolicy, ToolLoopDeps } from '../../runtime/tool-loop.js';
import { stableJsonHash } from '../../runtime/helpers.js';
import { createGoalDispatchTool } from './dispatch-tool.js';
import { goalScope, goalWorkKind, goalExecutionTask, type GoalRuntimeHost } from './runtime-host.js';
import { invokeGoalTool } from './tool-gateway.js';
import type { GoalAdapterResult, GoalExecutionAdapterHost, GoalExecutionRequest } from './adapters.js';
import type { GoalReport } from './types.js';

export interface RuntimeGoalDispatchHost {
  store: SqliteStateStore;
  goalHost: GoalRuntimeHost;
  deps(): ToolLoopDeps;
  filePolicy(): Promise<FileApprovalPolicy | undefined>;
  authorizedTools(context: RunContext, request?: GoalExecutionRequest): ToolContract<any>[];
  /** PTC must be an isolated child with inherited restrictions and scoped execution metadata. */
  runWorker?(context: RunContext, request: Parameters<GoalExecutionAdapterHost['runSessionExecution']>[0]): Promise<GoalAdapterResult>;
}
interface DispatchRecord { executionId: string; request: GoalExecutionRequest; result: GoalAdapterResult }
function selectionKey(request: GoalExecutionRequest): string {
  return stableJsonHash('goal_dispatch',{preferredStrategy:request.preferredStrategy,workKind:request.workKind,delegateBotId:request.delegateBotId,tasks:request.tasks,role:request.role,factory:request.factory});
}
export function createRuntimeGoalDispatchTool(host: RuntimeGoalDispatchHost): ToolContract<any> {
  const freshContext = (context: RunContext): RunContext => ({...context,session:host.store.getSession(context.session.id) ?? context.session});
  const isCurrent = (context:RunContext,request:GoalExecutionRequest):boolean => {
    const fresh=freshContext(context),scope=goalScope(host.store,fresh.session);
    const goal=scope?.service.get(scope.botId,request.goalId);
    const execution=scope?.service.executions(scope.botId,request.goalId).find(item=>item.id===request.executionId);
    return Boolean(scope&&goal&&execution&&goal.status==='running'&&goal.activeExecutionId===request.executionId&&goal.revision===request.revision&&execution.goalRevision===request.revision&&execution.sessionId===fresh.session.id&&execution.status==='running'&&execution.leaseUntil>Date.now());
  };
  const invoke = async (context: RunContext,name: string,args: Record<string,unknown>,request: GoalExecutionRequest, worker?: ToolContract<any>['execute']) => {
    const fresh = freshContext(context);
    const deps = host.deps();
    const ledgerKey = `bot.goal-tool-ledger:${fresh.session.id}:${request.executionId}`;
    type AuditMessage = {role:'tool'|'user'|'assistant'|'system';parts:MessagePart[]};
    const readLedger = () => host.store.getDaemonControl<AuditMessage[]>(ledgerKey) ?? [];
    // Nested calls cannot enter the model transcript before the outer goal_dispatch result.
    // Keep the same durable paired audit and replay semantics in a separate execution ledger.
    const nestedDeps: ToolLoopDeps = {...deps,store:{
      assertCurrentWriter: id => deps.store.assertCurrentWriter?.(id),
      appendMessage: (id,role,parts) => {
        if(id!==fresh.session.id)throw new Error('Nested goal audit session mismatch');
        deps.store.assertCurrentWriter?.(id);
        host.store.setDaemonControl(ledgerKey,[...readLedger(),{role,parts}]);
      },
      foldMessages: id => id===fresh.session.id?readLedger():[],
      listApprovals: filter => deps.store.listApprovals(filter),
      createApproval: input => deps.store.createApproval(input),
      deleteApproval: id => deps.store.deleteApproval(id),
      getTask: id => deps.store.getTask(id),
      updateTask: (id,patch) => deps.store.updateTask(id,patch)
    }};
    const tools = host.authorizedTools(fresh,request).map(tool => tool.name===name ? {...tool,execute:async (toolContext:RunContext,toolArgs:Record<string,unknown>) => {
      if(!isCurrent(toolContext,request))return {ok:false,content:'Goal revision or execution changed before dispatch; reconcile before proceeding'};
      return worker?worker(toolContext,toolArgs):tool.execute(toolContext,toolArgs);
    }} : tool);
    return invokeGoalTool({deps:{...nestedDeps,tools},context:fresh,tools,filePolicy:await host.filePolicy(),name,args,callId:`${request.executionId}:${name}`});
  };
  return createGoalDispatchTool({
    resolveRequest(context) {
      const fresh = freshContext(context);
      if(fresh.session.metadata.botWorkTaskId)return undefined;
      const scope = goalScope(host.store,fresh.session);
      const goalId = fresh.session.metadata.botGoalId;
      const executionId = fresh.session.metadata.botGoalExecutionId;
      if (!scope || typeof goalId !== 'string' || typeof executionId !== 'string') return undefined;
      const goal = scope.service.get(scope.botId,goalId);
      const execution = scope.service.executions(scope.botId,goalId).find(e=>e.id===executionId);
      if (!goal || goal.status !== 'running' || goal.activeExecutionId !== executionId || !execution || execution.status !== 'running' || execution.sessionId !== fresh.session.id || execution.goalRevision !== goal.revision || execution.leaseUntil <= Date.now()) return undefined;
      const previous = fresh.session.metadata.botGoalDispatch as DispatchRecord | undefined;
      if (previous?.executionId === executionId) {
        if (!previous.result.waitingApproval) return undefined;
        return previous.request;
      }
      if (execution.runRef && execution.runRef !== `session:${fresh.session.id}`) return undefined;
      return {goalId,revision:goal.revision,executionId,sessionId:fresh.session.id,task:goalExecutionTask(goal),progress:`Objective: ${goal.objective}\nCompletion conditions: ${JSON.stringify(goal.completionCriteria)}\n${goal.progress}`,evidence:goal.evidence,constraints:goal.constraints,workKind:goalWorkKind(goalExecutionTask(goal))};
    },
    getCapabilities(context,request) {
      const fresh = freshContext(context);
      const scope = goalScope(host.store,fresh.session);
      const goal = scope?.service.get(scope.botId,request.goalId);
      const previous = fresh.session.metadata.botGoalDispatch as DispatchRecord | undefined;
      const tools = host.authorizedTools(fresh,request);
      if (!scope || !goal || goal.revision !== request.revision || goal.status !== 'running' || goal.activeExecutionId !== request.executionId || (previous?.executionId===request.executionId && previous.result.waitingApproval && selectionKey(previous.request)!==selectionKey(request))) return {registeredTools:[],allowedTools:[],enabledStrategies:[]};
      const capabilities = host.goalHost.capabilities(fresh.session,goal);
      return {...capabilities,registeredTools:tools.map(tool=>tool.name),allowedTools:tools.map(tool=>tool.name),ptcEnabled:Boolean(host.runWorker&&tools.some(tool=>tool.name==='ptc_exec')),budgetRemaining:Math.max(0,goal.budgetUsd-goal.costUsd)};
    },
    async runSessionExecution(context,request) {
      if(!isCurrent(context,request))return {status:'blocked',content:'Goal revision or execution changed before worker launch'};
      if (request.strategy === 'ptc') {
        if (!host.runWorker) return {status:'blocked',content:'No isolated PTC worker adapter is available'};
        return host.runWorker(freshContext(context),request);
      }
      let spawnedChildId: string | undefined;
      const result = await invoke(context,'spawn_subagent',{prompt:request.task,...(request.role?{role:request.role}:{})},request,async (workerContext, toolArgs) => {
        if (host.runWorker) {
          const worker = await host.runWorker(freshContext(workerContext),request);
          return {ok:worker.status!=='failed'&&worker.status!=='blocked',content:JSON.stringify({goalWorker:worker})};
        }
        const spawnTool = host.authorizedTools(freshContext(workerContext), request).find(tool => tool.name === 'spawn_subagent') ?? host.deps().tools.find(tool => tool.name === 'spawn_subagent');
        const spawned = spawnTool ? await spawnTool.execute(workerContext, toolArgs) : undefined;
        if (typeof spawned?.metadata?.childSessionId === 'string') spawnedChildId = spawned.metadata.childSessionId;
        return spawned ?? {ok:false,content:'spawn_subagent is unavailable'};
      });
      if(host.runWorker && !result.waitingApproval) {
        try {
          const worker = JSON.parse(result.content)?.goalWorker as GoalAdapterResult | undefined;
          if(worker && ['progress','waiting','blocked','candidate_completed','failed','cancelled'].includes(worker.status) && typeof worker.content==='string') return worker;
        } catch { /* Normal gateway refusals and unknown outcomes remain blocked below. */ }
      }
      const childSessionId = spawnedChildId ?? (typeof result.metadata?.childSessionId === 'string' ? result.metadata.childSessionId : undefined);
      if (childSessionId) return {status:'waiting',reference:`session:${childSessionId}`,content:result.content,waitingApproval:result.waitingApproval};
      return {status:result.waitingApproval?'waiting':result.ok?'candidate_completed':'blocked',waitingApproval:result.waitingApproval,content:result.content};
    },
    invokeAuthorizedTool:invoke,
    onResult(context,request,result) {
      const fresh = freshContext(context);
      const scope = goalScope(host.store,fresh.session);
      if (!scope) return;
      const goal = scope.service.get(scope.botId,request.goalId);
      if (!goal) return;
      const prior = fresh.session.metadata.botGoalDispatch as DispatchRecord | undefined;
      if (prior?.executionId===request.executionId && prior.result.waitingApproval && selectionKey(prior.request)!==selectionKey(request)) return;
      const source = result.route?.strategy === 'self_heal' ? 'self_heal' : result.route?.strategy === 'factory' ? 'factory' : result.route?.strategy === 'evolution' ? 'evolution' : result.route?.strategy === 'bot_delegate' ? 'bot_task' : result.route?.strategy === 'team_dag' ? 'team_dag' : result.route?.strategy === 'swarm' ? 'swarm' : 'session';
      const reference = source==='session' && result.reference?.startsWith('session:') ? result.reference.slice(8) : result.reference;
      const existing = Array.isArray(fresh.session.metadata.botGoalAuthorizedWaits) ? fresh.session.metadata.botGoalAuthorizedWaits as Array<Record<string,unknown>> : [];
      const authorized = reference ? [...existing.filter(wait=>wait.executionId!==request.executionId),{source,correlationId:reference,goalId:request.goalId,executionId:request.executionId}] : existing;
      let checkpoint: GoalReport | undefined;
      if (!result.waitingApproval) {
        if (result.status === 'waiting' && reference) checkpoint={kind:'waiting',summary:result.content,wait:{source,correlationId:reference}};
        else if (result.status === 'candidate_completed') checkpoint={kind:'candidate_completed',summary:result.content,evidence:[result.content],verified:false};
        else checkpoint={kind:result.status==='waiting'?'blocked':result.status,summary:result.status==='waiting'?'Execution is waiting without a verifiable run reference':result.content};
      }
      // Persist references even if cancellation or revision happened during dispatch: they need draining/reconciliation.
      host.store.updateSession(fresh.session.id,{metadata:{...fresh.session.metadata,botGoalDispatch:{executionId:request.executionId,request,result},botGoalAuthorizedWaits:authorized,...(checkpoint?{botGoalCheckpoint:checkpoint}:{})}});
      const execution=scope.service.executions(scope.botId,request.goalId).find(e=>e.id===request.executionId);
      if (reference && execution?.status==='running' && execution.leaseUntil>Date.now()) scope.service.updateExecution(scope.botId,request.executionId,{runRef:`${source}:${reference}`,safeToRetry:false});
    }
  });
}
