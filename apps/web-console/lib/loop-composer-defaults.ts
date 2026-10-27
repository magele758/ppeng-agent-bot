export type LabTaskMode =
  | 'computer'
  | 'browser'
  | 'auto'
  | 'deep_research'
  | 'planner'
  | 'teams'
  | 'fast'
  | 'dynamic_workflow';

export type LabSkillScope = 'full' | 'requested';
export type OrchestrationEngine = 'legacy' | 'ptc';
export type SteerInterruptPolicy = 'queue' | 'steer' | 'disabled';

const TASK_MODES = new Set<LabTaskMode>([
  'computer',
  'browser',
  'auto',
  'deep_research',
  'planner',
  'teams',
  'fast',
  'dynamic_workflow'
]);

export function parseLabTaskMode(raw: unknown): LabTaskMode | undefined {
  if (raw === 'standard') return 'auto';
  return typeof raw === 'string' && TASK_MODES.has(raw as LabTaskMode) ? (raw as LabTaskMode) : undefined;
}

export function parseLabSkillScope(raw: unknown): LabSkillScope | undefined {
  return raw === 'full' || raw === 'requested' ? raw : undefined;
}

export function savedSteerPolicy(raw: unknown): SteerInterruptPolicy {
  return raw === 'steer' || raw === 'disabled' || raw === 'queue' ? raw : 'queue';
}

export function composerRunSelection(input: {
  hasSession: boolean;
  touched: boolean;
  currentTaskMode: LabTaskMode;
  currentSkillScope: LabSkillScope;
  currentEngine: OrchestrationEngine;
  savedTaskMode: unknown;
  savedSkillScope: unknown;
  /** False while the saved defaults have not been read yet. A new chat then leaves the choice to the server. */
  settingsLoaded?: boolean;
}): { taskMode: LabTaskMode; skillScope: LabSkillScope; orchestrationEngine: OrchestrationEngine; deferred: boolean } {
  if (input.hasSession || input.touched) {
    return {
      taskMode: input.currentTaskMode,
      skillScope: input.currentSkillScope,
      orchestrationEngine: input.currentEngine,
      deferred: false
    };
  }
  const savedTaskMode = parseLabTaskMode(input.savedTaskMode);
  const savedSkillScope = parseLabSkillScope(input.savedSkillScope);
  if (input.settingsLoaded === false && savedTaskMode === undefined && savedSkillScope === undefined) {
    return { taskMode: 'auto', skillScope: 'full', orchestrationEngine: 'legacy', deferred: true };
  }
  const taskMode = savedTaskMode ?? 'auto';
  const skillScope = savedSkillScope ?? 'full';
  return {
    taskMode,
    skillScope,
    orchestrationEngine: taskMode === 'dynamic_workflow' ? 'ptc' : 'legacy',
    deferred: false
  };
}
