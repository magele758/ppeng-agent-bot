/**
 * Generic 8-value TaskMode / RunProfile (HOW) × skill_scope (WHAT).
 * Assembly uses this repo's tool names only — no host-native overlay,
 * industry catalog, or ERP kind filters.
 */

export const TASK_MODES = [
  'computer',
  'browser',
  'auto',
  'deep_research',
  'planner',
  'teams',
  'fast',
  'dynamic_workflow'
] as const;

export type TaskMode = (typeof TASK_MODES)[number];

/** WHAT axis. No autoskill / host — those are product-universe concepts. */
export const SKILL_SCOPES = ['full', 'requested'] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

export type PersistentMemoryMode = 'full' | 'off';
export type PlanProtocol = 'full' | 'none';
export type OrchestrationKind = 'none' | 'dynamic_workflow';
export type OrchestrationEngine = 'legacy' | 'ptc';
export type OrchestrationReplay = 'soft' | 'hard';

export interface ToolPolicyLayer {
  allowlist?: readonly string[];
  denylist?: readonly string[];
  /** Specialty names forced visible even if optional groups hid them. */
  forceVisible?: readonly string[];
}

export interface RunProfile {
  mode: TaskMode;
  planProtocol: PlanProtocol;
  toolPolicyLayer?: ToolPolicyLayer;
  persistentMemory: PersistentMemoryMode;
  skillScope: SkillScope;
  orchestration: OrchestrationKind;
  orchestrationEngine: OrchestrationEngine;
  orchestrationReplay: OrchestrationReplay;
  teamsMode: boolean;
  workerConcurrencyCap?: number;
  convergenceMaxRounds?: number;
}

export const PLAN_PROTOCOL_TOOLS: readonly string[] = [
  'submit_plan',
  'request_confirmation',
  'confirm_plan',
  'start_step',
  'complete_step',
  'fail_step'
];

export const TEAMS_TOOLS: readonly string[] = [
  'spawn_subagent',
  'spawn_teammate',
  'list_team',
  'send_message',
  'read_inbox'
];

export const RESEARCH_TOOLS: readonly string[] = ['web_search', 'web_fetch'];

export const BROWSER_TOOLS: readonly string[] = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_screenshot'
];

/** Assembly names only — computer-use tools are implemented elsewhere. */
export const COMPUTER_USE_TOOLS: readonly string[] = [
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_move'
];

export const PTC_TOOLS: readonly string[] = ['ptc_exec'];

export const PERSISTENT_MEMORY_TOOLS: readonly string[] = [
  'memory_set',
  'memory_delete',
  'save_user_info'
];

export const FAST_MODE_TOOL_ALLOWLIST: readonly string[] = [
  'read_file',
  'grep_files',
  'glob_files',
  'write_file',
  'edit_file',
  'bash',
  'load_skill',
  'search_skills',
  'TodoWrite',
  'read_artifact_page',
  'search_artifact_content',
  'retrieve_tool_result',
  'spill_tool_result',
  'task_list',
  'task_get',
  'work_evidence'
];

export const PLANNER_READONLY_TOOLS: readonly string[] = [
  'read_file',
  'grep_files',
  'glob_files',
  'web_fetch',
  'task_get',
  'task_list',
  'memory_get',
  'memory_search',
  'memory_prefetch',
  'retrieve_tool_result',
  'read_artifact_page',
  'search_artifact_content',
  'load_skill',
  'search_skills',
  'workspace_list',
  'ask_user',
  'list_team'
];

export const DYNAMIC_WORKFLOW_WORKER_CONCURRENCY_CAP = 16;
export const DYNAMIC_WORKFLOW_CONVERGENCE_MAX_ROUNDS = 5;

export const TASK_RUN_MODE_BOUND_KEY = 'taskRunModeBound';

const TASK_MODE_SET = new Set<string>(TASK_MODES);

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function parseTaskMode(raw: unknown): TaskMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value === 'standard') return 'auto';
  return TASK_MODE_SET.has(value) ? (value as TaskMode) : undefined;
}

export function parseSkillScope(raw: unknown): SkillScope | undefined {
  return raw === 'full' || raw === 'requested' ? raw : undefined;
}

export function parseOrchestrationReplay(raw: unknown): OrchestrationReplay | undefined {
  return raw === 'soft' || raw === 'hard' ? raw : undefined;
}

export function resolveOrchestrationEngine(
  raw?: string | null,
  mode?: TaskMode | null
): OrchestrationEngine {
  if (raw === 'ptc' || raw === 'legacy') return raw;
  return mode === 'dynamic_workflow' ? 'ptc' : 'legacy';
}

function stringField(
  metadata: Record<string, unknown> | undefined,
  camel: string,
  snake: string
): unknown {
  return metadata?.[camel] ?? metadata?.[snake];
}

export function taskModeFromMetadata(
  metadata: Record<string, unknown> | undefined,
  fallback: TaskMode = 'auto'
): TaskMode {
  return parseTaskMode(stringField(metadata, 'taskRunMode', 'task_run_mode')) ?? fallback;
}

export function skillScopeFromMetadata(
  metadata: Record<string, unknown> | undefined,
  fallback: SkillScope = 'full'
): SkillScope {
  return parseSkillScope(stringField(metadata, 'skillScope', 'skill_scope')) ?? fallback;
}

export function orchestrationReplayFromMetadata(
  metadata: Record<string, unknown> | undefined
): OrchestrationReplay {
  return parseOrchestrationReplay(stringField(metadata, 'orchestrationReplay', 'orchestration_replay')) ??
    'soft';
}

export function requestedSkillNames(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.requestedSkills ?? metadata?.skills;
  if (!Array.isArray(raw)) return [];
  return uniqueStrings(raw.map((v) => (typeof v === 'string' ? v : '')));
}

export function filterSkillsByScope<T extends { name: string }>(
  skills: T[],
  scope: SkillScope,
  requested: readonly string[]
): T[] {
  if (scope !== 'requested') return skills;
  const allow = new Set(requested.map((n) => n.trim().toLowerCase()).filter(Boolean));
  return skills.filter((s) => allow.has(s.name.trim().toLowerCase()));
}

export function isTaskRunModeBound(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[TASK_RUN_MODE_BOUND_KEY] === true;
}

export type TaskModePatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; reason: 'bound'; bound: TaskMode };

/**
 * Lab may change mode while unbound. After first-turn seal, later writes
 * that disagree with the bound value are rejected.
 */
export function applyUnboundTaskModePatch(
  existing: Record<string, unknown> | undefined,
  incomingMode: TaskMode | undefined
): TaskModePatchResult {
  if (!incomingMode) return { ok: true, patch: {} };
  if (!isTaskRunModeBound(existing)) {
    return { ok: true, patch: { taskRunMode: incomingMode } };
  }
  const bound = taskModeFromMetadata(existing);
  if (bound === incomingMode) return { ok: true, patch: {} };
  return { ok: false, reason: 'bound', bound };
}

/** First turn seals the effective mode so later Lab switches cannot rewrite HOW. */
export function sealTaskRunModePatch(
  metadata: Record<string, unknown> | undefined,
  mode: TaskMode
): Record<string, unknown> {
  if (isTaskRunModeBound(metadata) && taskModeFromMetadata(metadata) === mode) {
    return {};
  }
  return { taskRunMode: mode, [TASK_RUN_MODE_BOUND_KEY]: true };
}

export function isResearchTool(name: string): boolean {
  return RESEARCH_TOOLS.includes(name) || name.startsWith('research_');
}

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOLS.includes(name) || name.startsWith('browser_');
}

export function isComputerUseTool(name: string): boolean {
  return COMPUTER_USE_TOOLS.includes(name) || name.startsWith('computer_');
}

export function resolveRunProfile(
  taskRunMode?: TaskMode | string | null,
  skillScope?: SkillScope | string | null,
  orchestrationEngine?: OrchestrationEngine | string | null,
  orchestrationReplay?: OrchestrationReplay | string | null
): RunProfile {
  const mode = parseTaskMode(taskRunMode) ?? 'auto';
  const resolvedSkillScope = parseSkillScope(skillScope) ?? 'full';
  const engine = resolveOrchestrationEngine(orchestrationEngine, mode);
  const replay = parseOrchestrationReplay(orchestrationReplay) ?? 'soft';
  const teamsMode = mode === 'teams';
  const hard = mode === 'dynamic_workflow' && replay === 'hard';

  if (mode === 'fast') {
    return {
      mode,
      planProtocol: 'none',
      toolPolicyLayer: {
        allowlist: FAST_MODE_TOOL_ALLOWLIST,
        denylist: [
          ...PLAN_PROTOCOL_TOOLS,
          ...PERSISTENT_MEMORY_TOOLS,
          ...TEAMS_TOOLS,
          ...PTC_TOOLS,
          ...BROWSER_TOOLS,
          ...COMPUTER_USE_TOOLS
        ]
      },
      persistentMemory: 'off',
      skillScope: resolvedSkillScope,
      orchestration: 'none',
      orchestrationEngine: engine,
      orchestrationReplay: 'soft',
      teamsMode
    };
  }

  if (mode === 'planner') {
    return {
      mode,
      planProtocol: 'full',
      toolPolicyLayer: {
        allowlist: [...PLAN_PROTOCOL_TOOLS, ...PLANNER_READONLY_TOOLS],
        denylist: [...TEAMS_TOOLS, ...PTC_TOOLS, ...BROWSER_TOOLS, ...COMPUTER_USE_TOOLS],
        forceVisible: PLAN_PROTOCOL_TOOLS
      },
      persistentMemory: 'full',
      skillScope: resolvedSkillScope,
      orchestration: 'none',
      orchestrationEngine: engine,
      orchestrationReplay: 'soft',
      teamsMode
    };
  }

  if (mode === 'teams') {
    return {
      mode,
      planProtocol: 'full',
      toolPolicyLayer: {
        denylist: [...PTC_TOOLS],
        forceVisible: TEAMS_TOOLS
      },
      persistentMemory: 'full',
      skillScope: resolvedSkillScope,
      orchestration: 'none',
      orchestrationEngine: engine,
      orchestrationReplay: 'soft',
      teamsMode: true
    };
  }

  if (mode === 'deep_research') {
    return {
      mode,
      planProtocol: 'full',
      toolPolicyLayer: {
        denylist: [...PTC_TOOLS, ...COMPUTER_USE_TOOLS, ...TEAMS_TOOLS],
        forceVisible: RESEARCH_TOOLS
      },
      persistentMemory: 'full',
      skillScope: resolvedSkillScope,
      orchestration: 'none',
      orchestrationEngine: engine,
      orchestrationReplay: 'soft',
      teamsMode
    };
  }

  if (mode === 'browser') {
    return {
      mode,
      planProtocol: 'full',
      toolPolicyLayer: {
        denylist: [...PTC_TOOLS, ...COMPUTER_USE_TOOLS],
        forceVisible: BROWSER_TOOLS
      },
      persistentMemory: 'full',
      skillScope: resolvedSkillScope,
      orchestration: 'none',
      orchestrationEngine: engine,
      orchestrationReplay: 'soft',
      teamsMode
    };
  }

  if (mode === 'computer') {
    return {
      mode,
      planProtocol: 'full',
      toolPolicyLayer: {
        denylist: [...PTC_TOOLS, ...BROWSER_TOOLS],
        forceVisible: COMPUTER_USE_TOOLS
      },
      persistentMemory: 'full',
      skillScope: resolvedSkillScope,
      orchestration: 'none',
      orchestrationEngine: engine,
      orchestrationReplay: 'soft',
      teamsMode
    };
  }

  if (mode === 'dynamic_workflow') {
    const deny = [...PLAN_PROTOCOL_TOOLS];
    if (engine === 'ptc' || hard) {
      deny.push(...TEAMS_TOOLS.filter((n) => n === 'spawn_subagent' || n === 'spawn_teammate'));
    }
    if (hard) deny.push(...PTC_TOOLS);
    return {
      mode,
      planProtocol: 'none',
      toolPolicyLayer: {
        denylist: uniqueStrings(deny),
        forceVisible: hard || engine === 'legacy' ? [] : PTC_TOOLS
      },
      persistentMemory: 'full',
      skillScope: resolvedSkillScope,
      orchestration: 'dynamic_workflow',
      orchestrationEngine: engine,
      orchestrationReplay: replay,
      teamsMode,
      workerConcurrencyCap: DYNAMIC_WORKFLOW_WORKER_CONCURRENCY_CAP,
      convergenceMaxRounds: DYNAMIC_WORKFLOW_CONVERGENCE_MAX_ROUNDS
    };
  }

  // auto: full surface; ptc_exec stays hidden unless engine is explicitly ptc
  return {
    mode: 'auto',
    planProtocol: 'full',
    toolPolicyLayer: {
      denylist: engine === 'ptc' ? [] : [...PTC_TOOLS],
      forceVisible: engine === 'ptc' ? PTC_TOOLS : []
    },
    persistentMemory: 'full',
    skillScope: resolvedSkillScope,
    orchestration: 'none',
    orchestrationEngine: engine,
    orchestrationReplay: 'soft',
    teamsMode: false
  };
}

export function runProfileFromSession(
  session: { metadata?: Record<string, unknown> },
  labDefault?: { taskMode?: TaskMode; skillScope?: SkillScope }
): RunProfile {
  const meta = session.metadata;
  const mode = taskModeFromMetadata(meta, labDefault?.taskMode ?? 'auto');
  const scope = skillScopeFromMetadata(meta, labDefault?.skillScope ?? 'full');
  const engineRaw = stringField(meta, 'orchestrationEngine', 'orchestration_engine');
  const engine = typeof engineRaw === 'string' ? engineRaw : undefined;
  return resolveRunProfile(mode, scope, engine, orchestrationReplayFromMetadata(meta));
}

export function applyRunProfileToTools<T extends { name: string }>(
  tools: T[],
  profile: RunProfile,
  assembled?: T[]
): T[] {
  const layer = profile.toolPolicyLayer;
  const deny = new Set(layer?.denylist ?? []);
  const allow = layer?.allowlist ? new Set(layer.allowlist) : undefined;
  const forced = new Set(layer?.forceVisible ?? []);

  let next = tools.filter((tool) => {
    if (deny.has(tool.name)) return false;
    if (profile.mode === 'deep_research' && isComputerUseTool(tool.name)) return false;
    if (allow && !allow.has(tool.name) && !forced.has(tool.name)) return false;
    return true;
  });

  const source = assembled ?? tools;
  for (const tool of source) {
    if (!forced.has(tool.name) && !(profile.mode === 'deep_research' && isResearchTool(tool.name))) {
      continue;
    }
    if (deny.has(tool.name)) continue;
    if (!next.some((t) => t.name === tool.name)) next.push(tool);
  }

  return next;
}

export function visibleToolNames(
  profile: RunProfile,
  assembledNames: readonly string[]
): string[] {
  const assembled = assembledNames.map((name) => ({ name }));
  return applyRunProfileToTools(assembled, profile, assembled).map((t) => t.name);
}
