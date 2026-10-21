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
  role?: 'planner' | 'generator' | 'evaluator' | 'researcher' | 'main';
  factory?: {operation:string};
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
  orchestrator: ['spawn_subagent'], self_heal: ['goal_self_heal_start'], evolution: ['goal_evolution_start'], factory: ['factory_dispatch']
};
const specialties = new Set<GoalStrategy>(['orchestrator', 'self_heal', 'evolution', 'factory']);
export function goalWorkKind(text: string): GoalWorkKind {
  if (/\b(swarm|pipeline)\b|角色流水线/i.test(text)) return 'role_pipeline';
  if (/\b(dag|dependency)\b|依赖关系|任务图/i.test(text)) return 'dependency_plan';
  if (/\b(batch|ptc)\b|批量|汇总.*数据/i.test(text)) return 'batch';
  if (/\b(browser|webpage)\b|浏览器|网页操作/i.test(text)) return 'browser';
  if (/\b(desktop|computer)\b|桌面操作|电脑|操作.*桌面/i.test(text)) return 'computer';
  if (/\b(research|investigate)\b|调研|研究/i.test(text)) return 'research';
  return 'general';
}
export function goalSpecialty(text: string): GoalStrategy | undefined {
  if (/不要|禁止|do not|don't|never/i.test(text)) return undefined;
  if (/^(?:请)?自愈|(?:启动|运行|执行|开启|使用).{0,12}自愈|\b(?:start|run|launch|execute)\b.{0,16}\bself[-_ ]?heal\b/i.test(text)) return 'self_heal';
  if (/(?:启动|运行|执行|开启).{0,16}(?:evolution|演进|进化)|\b(?:start|run|launch|execute)\b.{0,16}\bevolution\b/i.test(text)) return 'evolution';
  if (/^(?:请)?工厂|(?:启动|运行|执行|使用).{0,12}工厂|\b(?:start|run|launch|execute|use)\b.{0,16}\bfactory\b/i.test(text)) return 'factory';
  if (/^(?:请)?编排|\b(?:orchestrate|start orchestrator)\b|规划.*开发.*验证/i.test(text)) return 'orchestrator';
  return undefined;
}
export function goalSpecialist(text: string): GoalRouteRequest['role'] {
  if (/\b(evaluate|review)\b|^(?:请|请帮我)?(?:验收|评估|审查|验证结果)/i.test(text.trim())) return 'evaluator';
  if (/\b(plan|planner|specification)\b|制定.*规划|设计方案|规划方案/i.test(text)) return 'planner';
  if (/\b(implement|generate|build)\b|实现|开发功能/i.test(text)) return 'generator';
  if (goalWorkKind(text) === 'research') return 'researcher';
  return undefined;
}
export function availableGoalTools(capabilities: GoalCapabilities): Set<string> {
  const allowed = capabilities.allowedTools && new Set(capabilities.allowedTools);
  return new Set(capabilities.registeredTools.filter(name => !allowed || allowed.has(name)));
}
export function goalStrategyUnavailable(strategy: GoalStrategy, request: GoalRouteRequest, capabilities: GoalCapabilities): string | undefined {
  if (!capabilities.enabledStrategies.includes(strategy)) return 'Execution strategy is not enabled';
  if (capabilities.healthyStrategies && !capabilities.healthyStrategies.includes(strategy)) return 'Execution adapter is unavailable';
  if (request.independentWork && strategy === 'direct') return 'An independent concurrent task needs an isolated executor';
  if (strategy === 'ptc' && !capabilities.ptcEnabled) return 'PTC is not enabled for this execution';
  if (strategy === 'team_dag' && !capabilities.hasWorkspace) return 'Team execution requires a workspace';
  if (strategy === 'bot_delegate' && !request.delegateBotId) return 'No authorized destination Bot was selected';
  const available = availableGoalTools(capabilities);
  const strategyTools = strategy === 'factory' && request.factory?.operation === 'develop' ? ['goal_factory_develop'] : toolsByStrategy[strategy];
  const missing = [...strategyTools, ...(request.requiredTools ?? [])].filter(name => !available.has(name));
  if (missing.length) return `Required tools are unavailable or unauthorized: ${missing.join(', ')}`;
  if (request.workKind === 'browser' && ![...available].some(name => /^(browser_|playwright_)/.test(name))) return 'Browser tools are unavailable or unauthorized';
  if (request.workKind === 'computer' && ![...available].some(name => /^(computer_|desktop_|lcu_)/.test(name))) return 'Computer tools are unavailable or unauthorized';
  return undefined;
}
export function selectGoalRoute(request: GoalRouteRequest, capabilities: GoalCapabilities): GoalRoute {
  request = {...request, workKind: request.workKind ?? goalWorkKind(request.task)};
  const taskMode = request.workKind === 'research' ? 'deep_research' : request.workKind === 'browser' ? 'browser' : request.workKind === 'computer' ? 'computer' : 'auto';
  const rejected: GoalRoute['rejected'] = [];
  if (capabilities.budgetRemaining !== undefined && (!Number.isFinite(capabilities.budgetRemaining) || capabilities.budgetRemaining <= 0)) return { taskMode, blocked: true, reason: 'Goal budget is exhausted', rejected };
  const requiredSpecialty = goalSpecialty(request.task);
  const inferred: GoalStrategy = requiredSpecialty ?? (request.delegateBotId ? 'bot_delegate' : request.workKind === 'batch' ? 'ptc' : request.workKind === 'dependency_plan' ? 'team_dag' : request.workKind === 'role_pipeline' ? 'swarm' : request.independentWork || request.role || goalSpecialist(request.task) ? 'subagent' : 'direct');
  const requestedSpecialty = requiredSpecialty ?? (request.preferredStrategy && specialties.has(request.preferredStrategy) ? request.preferredStrategy : undefined);
  const candidates = requestedSpecialty ? [requestedSpecialty] : [...new Set([request.preferredStrategy ?? inferred, inferred, request.independentWork ? 'subagent' as const : 'direct' as const])];
  for (const strategy of candidates) {
    const unavailable = goalStrategyUnavailable(strategy, request, capabilities);
    if (unavailable) { rejected.push({strategy, reason: unavailable}); continue; }
    const explanation = rejected.length ? `Fallback to ${strategy}: ${rejected.map(item => `${item.strategy}: ${item.reason}`).join('; ')}` : `Selected ${strategy} for ${request.independentWork ? 'independent concurrent work' : request.workKind ?? 'general work'} using available authorized capabilities`;
    return { strategy, taskMode: strategy === 'ptc' ? 'dynamic_workflow' : taskMode, blocked: false, reason: explanation, rejected };
  }
  return { taskMode, blocked: true, reason: rejected.map(item => `${item.strategy}: ${item.reason}`).join('; '), rejected };
}
