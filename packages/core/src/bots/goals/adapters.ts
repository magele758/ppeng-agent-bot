import { selectGoalRoute, goalSpecialist, type GoalCapabilities, type GoalRoute, type GoalRouteRequest, type GoalStrategy } from './routing.js';

export interface GoalExecutionRequest extends GoalRouteRequest {
  goalId: string;
  revision: number;
  executionId: string;
  sessionId?: string;
  tasks?: unknown[];
  progress?: string;
  evidence?: string[];
  constraints?: string[];
  factory?: { machineId: string; repositoryId: string; operation: 'snapshot' | 'count-files' | 'read-log' | 'develop'; logId?: string; baseline?: string };
}
export interface GoalAdapterResult {
  status: 'progress' | 'waiting' | 'blocked' | 'candidate_completed' | 'failed' | 'cancelled';
  reference?: string;
  content: string;
  route?: GoalRoute;
  waitingApproval?: boolean;
}
export interface GoalExecutionAdapterHost {
  getCapabilities(request: GoalExecutionRequest): GoalCapabilities | Promise<GoalCapabilities>;
  /** Must create an execution-local context; metadata must not change the parent Bot's mode. */
  runSessionExecution(request: GoalExecutionRequest & { strategy: GoalStrategy; taskMode: GoalRoute['taskMode']; metadata: Record<string, unknown> }): Promise<GoalAdapterResult>;
  /** Must use the normal tool gateway (authorization, approvals, audit, sandbox), never ToolContract.execute directly. */
  invokeAuthorizedTool(name: string, args: Record<string, unknown>, request: GoalExecutionRequest): Promise<{ok: boolean; content: string; waitingApproval?: boolean}>;
  inspectExecution?(reference: string, strategy: GoalStrategy): Promise<GoalAdapterResult>;
  cancelExecution?(reference: string, strategy: GoalStrategy): Promise<boolean>;
  steerExecution?(reference: string, strategy: GoalStrategy, task: string): Promise<boolean>;
}
function referenceFrom(content: string, wrapper?: string): string | undefined {
  try {
    const parsed = JSON.parse(content);
    const record = wrapper ? parsed[wrapper] : parsed;
    return typeof record?.id === 'string' && record.id.length ? record.id : undefined;
  } catch { return undefined; }
}
export function createGoalExecutionAdapters(host: GoalExecutionAdapterHost) {
  return {
    async start(request: GoalExecutionRequest): Promise<GoalAdapterResult> {
      const route = selectGoalRoute(request, await host.getCapabilities(request));
      const strategy = route.strategy;
      if (route.blocked || !strategy) return {status:'blocked',content:route.reason,route};
      const routeRequest = request;
      const role = strategy === 'orchestrator' ? 'main' : request.role ?? (strategy === 'subagent' ? goalSpecialist(request.task) : undefined);
      request = {...request,task:[request.task, request.progress ? `Previous progress: ${request.progress}` : '', request.evidence?.length ? `Evidence: ${JSON.stringify(request.evidence)}` : '', request.constraints?.length ? `Constraints: ${JSON.stringify(request.constraints)}` : ''].filter(Boolean).join('\n')};
      let knownReference: string | undefined;
      try {
        if (strategy === 'direct' || strategy === 'subagent' || strategy === 'ptc' || strategy === 'orchestrator') {
          request = {...request, role};
          const result = await host.runSessionExecution({...request,strategy,taskMode:route.taskMode,metadata:{goalId:request.goalId,goalRevision:request.revision,goalExecutionId:request.executionId,taskRunMode:route.taskMode,...(strategy === 'ptc' ? {orchestrationEngine:'ptc'} : {})}});
          return {...result,route};
        }
        const external = await startExternalExecution(host, request, route, strategy);
        if (external) return external;
        const team = strategy === 'team_dag';
        const createName = team ? 'lab_team_plan_create' : 'lab_swarm_run_create';
        const createArgs = team ? {objective:request.task,sessionId:request.sessionId,tasks:request.tasks} : {goal:request.task,strategy:'pipeline'};
        const created = await host.invokeAuthorizedTool(createName,createArgs,request);
        if (created.waitingApproval) return {status:'waiting',waitingApproval:true,content:created.content,route};
        const reference = created.ok ? referenceFrom(created.content,team ? 'plan' : 'run') : undefined;
        if (!reference) return {status:'blocked',content:created.content,route};
        knownReference = reference;
        // Revalidate after creation; a policy change must prevent the start side effect.
        const fresh = selectGoalRoute({...routeRequest,preferredStrategy:strategy},await host.getCapabilities(routeRequest));
        if (fresh.strategy !== strategy || fresh.blocked) return {status:'blocked',reference,content:`Created but not started: ${fresh.reason}`,route:fresh};
        const started = await host.invokeAuthorizedTool(team ? 'lab_team_plan_start' : 'lab_swarm_run_start',team ? {planId:reference} : {runId:reference,tasks:request.tasks},request);
        return {status:started.ok || started.waitingApproval ? 'waiting' : 'blocked',waitingApproval:started.waitingApproval,reference,content:started.content,route};
      } catch (error) {
        // The external side effect may have happened. Caller must reconcile rather than blindly retry.
        return {status:'blocked',reference:knownReference,content:`Execution outcome requires reconciliation: ${error instanceof Error ? error.message : String(error)}`,route};
      }
    },
    async inspect(reference: string, strategy: GoalStrategy): Promise<GoalAdapterResult> {
      return host.inspectExecution ? host.inspectExecution(reference,strategy) : {status:'blocked',reference,content:'This adapter does not support state inspection; reconcile before retrying'};
    },
    async cancel(reference: string, strategy: GoalStrategy): Promise<boolean> { return host.cancelExecution ? host.cancelExecution(reference,strategy) : false; },
    async steer(reference: string, strategy: GoalStrategy, task: string): Promise<boolean> { return host.steerExecution ? host.steerExecution(reference,strategy,task) : false; }
  };
}

async function startExternalExecution(host: GoalExecutionAdapterHost, request: GoalExecutionRequest, route: GoalRoute, strategy: GoalStrategy): Promise<GoalAdapterResult | undefined> {
        if (strategy === 'self_heal' || strategy === 'evolution' || strategy === 'factory') {
          if (strategy === 'factory' && !request.factory) return {status:'blocked',content:'Discover the authorized machine and repository with factory_status, then supply factory task details. Do not guess a target or substitute ordinary execution.',route};
          const name = strategy === 'factory' ? request.factory?.operation === 'develop' ? 'goal_factory_develop' : 'factory_dispatch' : strategy === 'self_heal' ? 'goal_self_heal_start' : 'goal_evolution_start';
          const result = await host.invokeAuthorizedTool(name,strategy === 'factory' ? {...request.factory} : {},request);
          if (result.waitingApproval) return {status:'waiting',waitingApproval:true,content:result.content,route};
          const reference = result.ok ? referenceFrom(result.content) ?? referenceFrom(result.content,'run') : undefined;
          return {status:reference ? 'waiting' : 'blocked',reference,content:result.content,route};
        }
        if (strategy === 'bot_delegate') {
          const result = await host.invokeAuthorizedTool('bot_delegate',{target:request.delegateBotId,input:request.task,idempotencyKey:request.executionId},request);
          if (result.waitingApproval) return {status:'waiting',waitingApproval:true,content:result.content,route};
          const reference = result.ok ? referenceFrom(result.content) : undefined;
          return {status:reference ? 'waiting' : 'blocked',reference,content:result.content,route};
        }
  return undefined;
}
