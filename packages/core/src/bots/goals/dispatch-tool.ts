import type { RunContext, ToolContract } from '../../types.js';
import { createGoalExecutionAdapters, type GoalAdapterResult, type GoalExecutionAdapterHost, type GoalExecutionRequest } from './adapters.js';
import type { GoalCapabilities, GoalStrategy, GoalWorkKind } from './routing.js';

export interface GoalDispatchToolHost {
  /** Resolve and authorize ONLY the current session's active goal/execution. */
  resolveRequest(context: RunContext): GoalExecutionRequest | undefined | Promise<GoalExecutionRequest | undefined>;
  getCapabilities(context: RunContext, request: GoalExecutionRequest): GoalCapabilities | Promise<GoalCapabilities>;
  runSessionExecution(context: RunContext, request: Parameters<GoalExecutionAdapterHost['runSessionExecution']>[0]): Promise<GoalAdapterResult>;
  /** Normal runtime gateway: policy + approval + executeSingleTool + paired transcript/audit. */
  invokeAuthorizedTool(context: RunContext, name: string, args: Record<string, unknown>, request: GoalExecutionRequest): Promise<{ok: boolean; content: string; waitingApproval?: boolean}>;
  onResult?(context: RunContext, request: GoalExecutionRequest, result: GoalAdapterResult): void | Promise<void>;
}
interface GoalDispatchArgs extends Record<string, unknown> {
  preferredStrategy?: GoalStrategy;
  workKind?: GoalWorkKind;
  delegateBotId?: string;
  tasks?: unknown[];
  role?: GoalExecutionRequest["role"];
  factory?: GoalExecutionRequest["factory"];
}
const dispatchStrategies: GoalStrategy[] = ['subagent','bot_delegate','ptc','team_dag','swarm','orchestrator','self_heal','evolution','factory'];
const workKinds: GoalWorkKind[] = ['general','research','browser','computer','batch','dependency_plan','role_pipeline'];
export function createGoalDispatchTool(host: GoalDispatchToolHost): ToolContract<GoalDispatchArgs> {
  return {
    name:'goal_dispatch',
    description:'Choose and launch an authorized execution strategy for this session’s current persistent goal. Use for isolated subagents, Bot delegation, PTC, Team DAG, Swarm, original main/planner/generator/evaluator Agents, self-heal or factory work. Select automatically from the task; never ask the user to configure modes. Explain the returned route to the user. When dispatch returns waiting, briefly acknowledge and end this turn; the scheduler will resume you with actual results. Do not poll or sleep to wait for workers. A waiting or returned execution is not proof the goal is complete. No other goal or session can be selected.',
    inputSchema:{type:'object',properties:{preferredStrategy:{type:'string',enum:dispatchStrategies},workKind:{type:'string',enum:workKinds},delegateBotId:{type:'string'},tasks:{type:'array',items:{type:'object'}},role:{type:'string',enum:['planner','generator','evaluator','researcher','main']},factory:{type:'object',properties:{machineId:{type:'string'},repositoryId:{type:'string'},operation:{type:'string',enum:['snapshot','count-files','read-log','develop']},logId:{type:'string'},baseline:{type:'string'}},required:['machineId','repositoryId','operation'],additionalProperties:false}},additionalProperties:false},
    // Nested side effects are separately checked by the host's normal execution gateway.
    approvalMode:'never',sideEffectLevel:'none',
    async execute(context,args) {
      const forbidden = Object.keys(args).filter(key => !['preferredStrategy','workKind','delegateBotId','tasks','role','factory'].includes(key));
      if ((args.role && !["planner","generator","evaluator","researcher","main"].includes(args.role)) || forbidden.length || (args.preferredStrategy && !dispatchStrategies.includes(args.preferredStrategy)) || (args.workKind && !workKinds.includes(args.workKind))) return {ok:false,content:'Invalid dispatch arguments; goal identity and task are resolved from the current session'};
      const current = await host.resolveRequest(context);
      if (!current) return {ok:false,content:'No authorized active goal execution in this session'};
      const request: GoalExecutionRequest = {...current,...args,independentWork:true};
      const adapters = createGoalExecutionAdapters({
        getCapabilities: req => host.getCapabilities(context,req),
        runSessionExecution: req => host.runSessionExecution(context,req),
        invokeAuthorizedTool: (name,toolArgs,req) => host.invokeAuthorizedTool(context,name,toolArgs,req)
      });
      const result = await adapters.start(request);
      await host.onResult?.(context,request,result);
      return {ok:result.status !== 'blocked' && result.status !== 'failed',content:JSON.stringify(result)};
    }
  };
}
