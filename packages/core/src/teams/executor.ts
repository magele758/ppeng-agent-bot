import { mkdirSync } from 'node:fs';
import { createId, nowIso } from '../id.js';
import type { SessionRecord, TaskRecord, WorkspaceRecord } from '../types.js';
import type { WorkspaceManager } from '../workspaces.js';
import { edgesFromTasks, evaluateTeamPlanDag, graphFromTasks, mergeDependsOnFromEdges } from './dag.js';
import {
  allGatesSettled,
  applyGateEvent,
  evaluateGate,
  gatesAllowRelease,
  initGatesFromSettings,
  nextRunnableGate
} from './gates.js';
import { TeamFileMailbox } from './mailbox.js';
import { mapRawTasks, planTeamObjective } from './planner.js';
import { defaultTeamsDagSettings, readTeamsDagSettings, type TeamsDagSettings } from './settings.js';
import { createTeamPlanId, TeamPlanStore } from './store.js';
import type { TeamDagRole, TeamDagTask, TeamGateName, TeamPlan } from './types.js';
import {
  createTeamWorkerWorkspace,
  syncWorkerResultToPlan,
  teamIntegrationDir,
  teamPlanDir,
  teamTaskWorkspaceDir
} from './workspace-sync.js';
import { inheritWorkspaceBinding, workspaceBindingFromMetadata } from '../workspace/index.js';

export interface TeamDagExecutorDeps {
  store: TeamPlanStore;
  settings: () => TeamsDagSettings;
  stateDir: string;
  sourceRoot: string;
  listSessions: () => SessionRecord[];
  getSession: (sessionId: string) => SessionRecord | undefined;
  createTeammateSession: (input: {
    name: string;
    role: string;
    prompt: string;
    taskId?: string;
    parentSessionId?: string;
    background?: boolean;
    metadata?: Record<string, unknown>;
  }) => SessionRecord;
  createTask: (input: {
    title: string;
    description?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }) => TaskRecord;
  bindWorkspaceForTask: (taskId: string) => Promise<string | undefined>;
  registerWorkspace?: (workspace: WorkspaceRecord, taskId: string, sessionId?: string) => void;
  workspaceManager?: WorkspaceManager;
  createMail: (input: {
    fromAgentId: string;
    toAgentId: string;
    type: string;
    content: string;
    sessionId?: string;
    taskId?: string;
    correlationId?: string;
  }) => void;
  runSession: (sessionId: string) => Promise<void>;
  enqueueSchedulerWake: (sessionId: string, reason: string) => void;
  sessionTeammateFinished: (sessionId: string) => boolean;
  completeText?: (input: { system: string; user: string }) => Promise<string>;
}

const ROLE_PROMPT: Record<TeamDagRole, string> = {
  planner: 'planner',
  coordinator: 'planner',
  worker: 'implementer',
  reviewer: 'reviewer'
};

const TERMINAL_PLAN: TeamPlan['status'][] = ['completed', 'failed', 'cancelled'];

export function defaultTasksForObjective(objective: string): Array<Omit<TeamDagTask, 'status'>> {
  return [
    {
      id: 'analyze',
      title: '分析与拆解',
      description: `澄清目标、约束与交付物：${objective}`,
      dependsOn: [],
      role: 'worker'
    },
    {
      id: 'execute',
      title: '执行',
      description: `按分析结果推进：${objective}`,
      dependsOn: ['analyze'],
      role: 'worker'
    }
  ];
}

export function normalizeIncomingTasks(raw: unknown, objective: string): TeamDagTask[] {
  const mapped = mapRawTasks(raw);
  if (mapped) return mapped;
  return defaultTasksForObjective(objective).map((t) => ({ ...t, status: 'pending' as const }));
}

function mailboxFor(plan: TeamPlan, stateDir: string): TeamFileMailbox {
  const planDir = plan.planDir ?? teamPlanDir(stateDir, plan.id);
  mkdirSync(planDir, { recursive: true });
  return new TeamFileMailbox(planDir);
}

export class TeamDagExecutor {
  constructor(private readonly deps: TeamDagExecutorDeps) {}

  async createPlan(input: {
    objective: string;
    sessionId?: string;
    tasks?: unknown;
  }): Promise<{ plan?: TeamPlan; error?: string }> {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      return { error: 'Teams DAG 已在 Lab 设置中关闭' };
    }

    let tasks: TeamDagTask[];
    let plannerSource: TeamPlan['plannerSource'] = 'explicit';
    if (Array.isArray(input.tasks) && input.tasks.length > 0) {
      tasks = normalizeIncomingTasks(input.tasks, input.objective);
      const dag = evaluateTeamPlanDag(tasks);
      if (!dag.ok) return { error: dag.detail };
    } else {
      const planned = await planTeamObjective({
        objective: input.objective,
        completeText: this.deps.completeText,
        useLlm: settings.usePlannerLlm
      });
      tasks = planned.tasks;
      plannerSource = planned.source;
      const dag = evaluateTeamPlanDag(tasks);
      if (!dag.ok) return { error: dag.detail };
    }

    mergeDependsOnFromEdges(tasks, edgesFromTasks(tasks));
    const now = nowIso();
    const id = createTeamPlanId();
    const planDir = teamPlanDir(this.deps.stateDir, id);
    mkdirSync(planDir, { recursive: true });
    const plan: TeamPlan = {
      id,
      sessionId: input.sessionId,
      objective: input.objective.trim() || 'untitled',
      status: 'drafting',
      tasks,
      edges: edgesFromTasks(tasks),
      gates: initGatesFromSettings(settings),
      workspaceSyncMode: settings.workspaceSyncMode,
      planDir,
      plannerSource,
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsert(plan);
    return { plan: this.deps.store.get(id) ?? plan };
  }

  start(planId: string): TeamPlan | null {
    const plan = this.deps.store.get(planId);
    if (!plan) return null;
    if (plan.status === 'completed' || plan.status === 'cancelled') return null;
    this.deps.store.updateStatus(planId, 'running');
    return this.deps.store.get(planId);
  }

  /** Resume unfinished plan after process restart. */
  resume(planId: string): TeamPlan | null {
    const plan = this.deps.store.get(planId);
    if (!plan) return null;
    if (TERMINAL_PLAN.includes(plan.status)) return plan;
    return this.rehydrate(plan, 'running');
  }

  decideGate(
    planId: string,
    gateName: TeamGateName,
    passed: boolean,
    feedback?: string
  ): TeamPlan | null {
    const plan = this.deps.store.get(planId);
    if (!plan) return null;
    const gates = plan.gates.map((g) => {
      if (g.name !== gateName) return g;
      let next = g;
      if (next.status === 'pending') next = applyGateEvent(next, 'start');
      if (next.status === 'running') next = applyGateEvent(next, 'need_human');
      return applyGateEvent(next, passed ? 'pass' : 'fail', feedback);
    });
    const next: TeamPlan = { ...plan, gates };
    const workersSettled = next.tasks.every(
      (t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'
    );
    if (workersSettled) this.finalizeIfGatesDone(next);
    this.deps.store.upsert(next);
    return this.deps.store.get(planId);
  }

  listMailbox(planId: string, limit = 50) {
    const plan = this.deps.store.get(planId);
    if (!plan) return [];
    return mailboxFor(plan, this.deps.stateDir).listRecent(limit);
  }

  async tick(): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enabled) return;
    for (const plan of this.deps.store.listActive()) {
      await this.tickPlan(plan, settings);
    }
  }

  private rehydrate(plan: TeamPlan, status: TeamPlan['status']): TeamPlan {
    const tasks = plan.tasks.map((task) => {
      if (task.status === 'running' || task.status === 'reviewing') {
        return {
          ...task,
          status: 'pending' as const,
          sessionId: undefined,
          error: 'reset on resume'
        };
      }
      return task;
    });
    const gates = plan.gates.map((gate) =>
      gate.status === 'running' ? { ...gate, status: 'pending' as const } : gate
    );
    const next: TeamPlan = { ...plan, tasks, gates, status };
    this.deps.store.upsert(next);
    return this.deps.store.get(plan.id) ?? next;
  }

  private async tickPlan(plan: TeamPlan, settings: TeamsDagSettings): Promise<void> {
    const tasks = [...plan.tasks];
    await this.recoverStale(tasks);
    await this.advanceFinished(plan, tasks);

    const completed = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    const excluded = new Set(
      tasks
        .filter(
          (t) =>
            t.status === 'failed' ||
            t.status === 'cancelled' ||
            t.status === 'running' ||
            t.status === 'reviewing'
        )
        .map((t) => t.id)
    );
    const graph = graphFromTasks(tasks);
    const readyIds = new Set(graph.getReadyTasks(completed, excluded));
    let running = tasks.filter((t) => t.status === 'running' || t.status === 'reviewing').length;

    for (const task of tasks) {
      if (task.status === 'pending' && readyIds.has(task.id)) {
        task.status = 'ready';
      }
    }

    for (const task of tasks) {
      if (task.status !== 'ready') continue;
      if (running >= settings.maxConcurrent) break;
      await this.dispatch(plan, task, settings);
      running += 1;
    }

    let gates = plan.gates.length ? plan.gates : initGatesFromSettings(settings);
    const workersSettled =
      tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled');
    const anyFailed = tasks.some((t) => t.status === 'failed');

    if (workersSettled && !anyFailed) {
      gates = await this.advanceGates(plan, gates);
    }

    const next: TeamPlan = {
      ...plan,
      tasks,
      edges: edgesFromTasks(tasks),
      gates,
      status: 'running'
    };
    if (workersSettled && anyFailed) {
      next.status = 'failed';
    } else if (workersSettled && allGatesSettled(gates)) {
      this.finalizeIfGatesDone(next);
    }
    this.deps.store.upsert(next);
  }

  private async recoverStale(tasks: TeamDagTask[]): Promise<void> {
    for (const task of tasks) {
      if (task.status !== 'running' && task.status !== 'reviewing') continue;
      if (!task.sessionId || !this.deps.getSession(task.sessionId)) {
        task.status = 'pending';
        task.sessionId = undefined;
        task.error = 'reset on resume';
      }
    }
  }

  private async advanceFinished(plan: TeamPlan, tasks: TeamDagTask[]): Promise<void> {
    for (const task of tasks) {
      if (task.status !== 'running' || !task.sessionId) continue;
      if (!this.deps.sessionTeammateFinished(task.sessionId)) continue;
      if (task.workspacePath) {
        try {
          await syncWorkerResultToPlan(
            task.workspacePath,
            teamIntegrationDir(this.deps.stateDir, plan.id)
          );
        } catch {
          /* sync is best-effort */
        }
      }
      task.status = 'done';
      task.reviewPassed = true;
    }
  }

  private async advanceGates(plan: TeamPlan, gates: TeamPlan['gates']): Promise<TeamPlan['gates']> {
    const current = nextRunnableGate(gates);
    if (!current || current.status === 'awaiting_human') return gates;
    let working = current;
    if (working.status === 'pending') {
      working = applyGateEvent(working, 'start');
    }
    if (working.status === 'running') {
      const result = await evaluateGate(working, {
        objective: plan.objective,
        completeText: this.deps.completeText
      });
      working = applyGateEvent(working, result.event, result.feedback);
      this.deps.store.addReview({
        id: createId('trev'),
        planId: plan.id,
        taskId: `gate:${working.name}`,
        passed: working.status === 'passed' || working.status === 'skipped',
        feedback: working.feedback ?? result.feedback,
        reviewerAgentId: `gate-${working.name}`,
        createdAt: nowIso()
      });
    }
    return gates.map((g) => (g.name === working.name ? working : g));
  }

  private finalizeIfGatesDone(plan: TeamPlan): void {
    if (!allGatesSettled(plan.gates)) return;
    if (gatesAllowRelease(plan.gates)) {
      plan.status = 'completed';
      plan.releasable = plan.gates.some((g) => g.name === 'release' && g.status === 'passed') || plan.releasable;
      if (plan.gates.every((g) => g.name !== 'release' || g.status === 'skipped')) {
        plan.releasable = plan.releasable ?? true;
      }
    } else {
      plan.status = 'failed';
    }
  }

  private async dispatch(plan: TeamPlan, task: TeamDagTask, settings: TeamsDagSettings): Promise<void> {
    const hostTask = this.deps.createTask({
      title: `[team-dag] ${task.title}`,
      description: task.description ?? plan.objective,
      metadata: { teamPlanId: plan.id, teamTaskId: task.id }
    });
    task.taskId = hostTask.id;

    const destRoot = teamTaskWorkspaceDir(this.deps.stateDir, plan.id, task.id);
    let workspaceRecord: WorkspaceRecord | undefined;
    const parent = plan.sessionId ? this.deps.getSession(plan.sessionId) : undefined;
    const inheritMeta = inheritWorkspaceBinding(parent?.metadata);
    const hostBinding = workspaceBindingFromMetadata(parent?.metadata);
    const hostBound = hostBinding.kind === 'project' || hostBinding.kind === 'cloud_folder';
    if (!hostBound) {
      try {
        const ws = await createTeamWorkerWorkspace({
          workspaceManager: this.deps.workspaceManager,
          sourceRoot: this.deps.sourceRoot,
          destRoot,
          taskId: hostTask.id,
          hint: task.title,
          mode: settings.workspaceSyncMode
        });
        task.workspacePath = ws.rootPath;
        workspaceRecord = ws.record;
        if (ws.record) task.workspaceId = ws.record.id;
      } catch {
        try {
          const fallback = await this.deps.bindWorkspaceForTask(hostTask.id);
          if (fallback) task.workspacePath = fallback;
        } catch {
          /* workspace optional */
        }
      }
    }

    const session = this.deps.createTeammateSession({
      name: `dag-${task.id}`,
      role: ROLE_PROMPT[task.role],
      prompt: [
        `You are the ${task.role} for team plan ${plan.id}.`,
        `Objective: ${plan.objective}`,
        `Task ${task.id}: ${task.title}`,
        task.description ?? '',
        task.dependsOn.length ? `Depends on: ${task.dependsOn.join(', ')}` : '',
        task.workspacePath ? `Isolated workspace is already bound. Write deliverables there.` : '',
        hostBound ? 'Inherit the host workspace binding; write deliverables in those roots.' : '',
        'Complete this task, then stop.'
      ]
        .filter(Boolean)
        .join('\n'),
      taskId: hostTask.id,
      parentSessionId: plan.sessionId,
      background: true,
      metadata: { teamPlanId: plan.id, teamTaskId: task.id, teamRole: task.role, ...inheritMeta }
    });
    if (workspaceRecord && this.deps.registerWorkspace) {
      this.deps.registerWorkspace(workspaceRecord, hostTask.id, session.id);
    }
    task.sessionId = session.id;
    task.status = 'running';
    this.postMail(plan, {
      from: 'team-coordinator',
      to: session.agentId || `worker-${task.id}`,
      type: 'task',
      content: `DAG task ${task.id} ready: ${task.title}\n${task.description ?? ''}`,
      sessionId: session.id,
      taskId: hostTask.id
    });
    this.deps.enqueueSchedulerWake(session.id, 'teams.dag.task');
  }

  private async postMail(
    plan: TeamPlan,
    input: {
      from: string;
      to: string;
      type: string;
      content: string;
      sessionId?: string;
      taskId?: string;
    }
  ): Promise<void> {
    try {
      const msg = await mailboxFor(plan, this.deps.stateDir).send({
        planId: plan.id,
        type: input.type,
        from: input.from,
        to: input.to,
        content: input.content,
        taskId: input.taskId
      });
      this.deps.createMail({
        fromAgentId: msg.from,
        toAgentId: msg.to,
        type: msg.type,
        content: msg.content,
        sessionId: input.sessionId,
        taskId: input.taskId,
        correlationId: plan.id
      });
    } catch {
      /* mail is best-effort */
    }
  }
}

export function createTeamDagExecutorFromStore(
  input: Omit<TeamDagExecutorDeps, 'settings'> & {
    settingsStore: { getDaemonControl<T>(key: string): T | undefined };
  }
): TeamDagExecutor {
  return new TeamDagExecutor({
    ...input,
    settings: () => {
      try {
        return readTeamsDagSettings(input.settingsStore);
      } catch {
        return defaultTeamsDagSettings();
      }
    }
  });
}
