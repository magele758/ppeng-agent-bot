/** Task policy is independent of executor lifetime and never expands tool authority. */
export type GoalStrategy = 'direct' | 'subagent' | 'bot_delegate' | 'ptc' | 'team_dag' | 'swarm' | 'orchestrator' | 'self_heal' | 'evolution' | 'factory';
export type GoalWorkKind = 'general' | 'research' | 'browser' | 'computer' | 'batch' | 'dependency_plan' | 'role_pipeline';
export interface GoalRouteRequest {
  task: string;
  independentWork?: boolean;
  preferredStrategy?: GoalStrategy;
  requiredTools?: string[];
  workKind?: GoalWorkKind;
  delegateBotId?: string;
}
export interface GoalCapabilities {
  registeredTools: string[];
  /** Already filtered by identity, session mode and tool access policy. Empty means no tools. */
  allowedTools?: string[];
  enabledStrategies: GoalStrategy[];
  healthyStrategies?: GoalStrategy[];
  hasWorkspace?: boolean;
  ptcEnabled?: boolean;
  budgetRemaining?: number;
}
export interface GoalRoute {
  strategy?: GoalStrategy;
  taskMode: 'auto' | 'deep_research' | 'browser' | 'computer' | 'dynamic_workflow';
  reason: string;
  blocked: boolean;
  rejected: Array<{strategy: GoalStrategy; reason: string}>;
}
const toolsByStrategy: Record<GoalStrategy, string[]> = {
  direct: [], subagent: ['spawn_subagent'], bot_delegate: ['bot_delegate'], ptc: ['ptc_exec'],
  team_dag: ['lab_team_plan_create', 'lab_team_plan_start'], swarm: ['lab_swarm_run_create', 'lab_swarm_run_start'],
  orchestrator: [], self_heal: [], evolution: [], factory: []
};
const specialties = new Set<GoalStrategy>(['orchestrator', 'self_heal', 'evolution', 'factory']);
export function availableGoalTools(capabilities: GoalCapabilities): Set<string> {
  const allowed = capabilities.allowedTools && new Set(capabilities.allowedTools);
  return new Set(capabilities.registeredTools.filter(name => !allowed || allowed.has(name)));
}
export function goalStrategyUnavailable(strategy: GoalStrategy, request: GoalRouteRequest, capabilities: GoalCapabilities): string | undefined {
  if (specialties.has(strategy)) return 'Specialty execution has no verified lifecycle adapter';
  if (!capabilities.enabledStrategies.includes(strategy)) return 'Execution strategy is not enabled';
  if (capabilities.healthyStrategies && !capabilities.healthyStrategies.includes(strategy)) return 'Execution adapter is unavailable';
  if (request.independentWork && strategy === 'direct') return 'An independent concurrent task needs an isolated executor';
  if (strategy === 'ptc' && !capabilities.ptcEnabled) return 'PTC is not enabled for this execution';
  if (strategy === 'team_dag' && !capabilities.hasWorkspace) return 'Team execution requires a workspace';
  if (strategy === 'bot_delegate' && !request.delegateBotId) return 'No authorized destination Bot was selected';
  const available = availableGoalTools(capabilities);
  const missing = [...toolsByStrategy[strategy], ...(request.requiredTools ?? [])].filter(name => !available.has(name));
  if (missing.length) return `Required tools are unavailable or unauthorized: ${missing.join(', ')}`;
  if (request.workKind === 'browser' && ![...available].some(name => /^(browser_|playwright_)/.test(name))) return 'Browser tools are unavailable or unauthorized';
  if (request.workKind === 'computer' && ![...available].some(name => /^(computer_|desktop_|lcu_)/.test(name))) return 'Computer tools are unavailable or unauthorized';
  return undefined;
}
export function selectGoalRoute(request: GoalRouteRequest, capabilities: GoalCapabilities): GoalRoute {
  const taskMode = request.workKind === 'research' ? 'deep_research' : request.workKind === 'browser' ? 'browser' : request.workKind === 'computer' ? 'computer' : 'auto';
  const rejected: GoalRoute['rejected'] = [];
  if (capabilities.budgetRemaining !== undefined && (!Number.isFinite(capabilities.budgetRemaining) || capabilities.budgetRemaining <= 0)) return { taskMode, blocked: true, reason: 'Goal budget is exhausted', rejected };
  const inferred: GoalStrategy = request.delegateBotId ? 'bot_delegate' : request.workKind === 'batch' ? 'ptc' : request.workKind === 'dependency_plan' ? 'team_dag' : request.workKind === 'role_pipeline' ? 'swarm' : request.independentWork ? 'subagent' : 'direct';
  const candidates = [...new Set([request.preferredStrategy ?? inferred, inferred, request.independentWork ? 'subagent' as const : 'direct' as const])];
  for (const strategy of candidates) {
    const unavailable = goalStrategyUnavailable(strategy, request, capabilities);
    if (unavailable) { rejected.push({strategy, reason: unavailable}); continue; }
    const explanation = rejected.length ? `Fallback to ${strategy}: ${rejected.map(item => `${item.strategy}: ${item.reason}`).join('; ')}` : `Selected ${strategy} for ${request.independentWork ? 'independent concurrent work' : request.workKind ?? 'general work'} using available authorized capabilities`;
    return { strategy, taskMode: strategy === 'ptc' ? 'dynamic_workflow' : taskMode, blocked: false, reason: explanation, rejected };
  }
  return { taskMode, blocked: true, reason: rejected.map(item => `${item.strategy}: ${item.reason}`).join('; '), rejected };
}
