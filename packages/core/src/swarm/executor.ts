import { nowIso } from '../id.js';
import type { SessionRecord } from '../types.js';
import { SwarmStore, createSwarmId } from './store.js';
import type { SwarmRole, SwarmRun, SwarmTask, SwarmTaskStatus } from './types.js';

const ROLE_AGENT: Record<SwarmRole, string> = {
  planner: 'planner',
  researcher: 'researcher',
  implementer: 'implementer',
  reviewer: 'reviewer',
  evaluator: 'evaluator',
  sre: 'sre-oncall',
  security: 'general'
};

const TERMINAL_TASK: SwarmTaskStatus[] = ['done', 'failed'];
const ACTIVE_RUN = ['pending', 'planning', 'running', 'reviewing'] as const;

export interface SwarmExecutorDeps {
  store: SwarmStore;
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
  runSession: (sessionId: string) => Promise<void>;
  enqueueSchedulerWake: (sessionId: string, reason: string) => void;
  /** True when teammate session has produced work (not merely created idle). */
  sessionTeammateFinished: (sessionId: string) => boolean;
}

export class SwarmExecutor {
  private readonly launching = new Set<string>();

  constructor(private readonly deps: SwarmExecutorDeps) {}

  private launchTeammate(sessionId: string, runId: string): void {
    if (this.launching.has(sessionId)) return;
    this.launching.add(sessionId);
    void Promise.resolve()
      .then(() => {
        const status = this.deps.store.getRun(runId)?.status;
        if (status === 'running' || status === 'planning') return this.deps.runSession(sessionId);
      })
      .catch(() => {
        const task = this.deps.store.listTasks(runId).find((item) => item.artifacts.includes(`session:${sessionId}`));
        if (task && task.status === 'in_progress') this.deps.store.updateTask(task.id, { status: 'failed' });
        this.deps.enqueueSchedulerWake(sessionId, 'swarm.task');
      })
      .finally(() => {
        this.launching.delete(sessionId);
      });
  }

  async tick(nowMs: number = Date.now()): Promise<void> {
    for (const run of this.deps.store.getTimedOutRuns(nowMs)) {
      this.deps.store.updateRunStatus(run.id, 'failed');
    }

    for (const status of ['running', 'planning'] as const) {
      const runs = this.deps.store.listRuns({ status, limit: 50 });
      for (const run of runs) {
        // pipeline is the supported strategy; others fail closed with a clear review note
        if (run.strategy !== 'pipeline') {
          if (run.status === 'planning' || run.status === 'running') {
            this.deps.store.updateRunStatus(run.id, 'failed');
            this.deps.store.addReview({
              id: createSwarmId('srev'),
              swarmRunId: run.id,
              taskId: '',
              reviewerAgentId: 'system',
              role: 'evaluator',
              scores: { correctness: 0 },
              passed: false,
              feedback: `Unsupported swarm strategy "${run.strategy}" (only pipeline is implemented).`,
              createdAt: nowIso()
            });
          }
          continue;
        }
        await this.tickRun(run);
      }
    }
  }

  /** Start a pending run (API entry). */
  startRun(runId: string, seedTasks?: Array<Partial<SwarmTask> & { title: string }>): SwarmRun | null {
    const run = this.deps.store.getRun(runId);
    if (!run || run.status !== 'pending') return null;

    if (seedTasks?.length) {
      for (const t of seedTasks) {
        this.deps.store.createTask({
          id: createSwarmId('stask'),
          swarmRunId: runId,
          title: t.title,
          description: t.description,
          status: 'pending',
          requiredRole: t.requiredRole ?? 'implementer',
          ownerAgentId: t.ownerAgentId,
          capabilityTags: t.capabilityTags ?? [],
          acceptanceCriteria: t.acceptanceCriteria ?? [],
          artifacts: t.artifacts ?? [],
          blockedBy: t.blockedBy ?? [],
          budget: t.budget,
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      }
    }

    this.deps.store.updateRunStatus(runId, 'running');
    return this.deps.store.getRun(runId);
  }

  private isDispatchable(runId: string): boolean {
    const status = this.deps.store.getRun(runId)?.status;
    return status === 'running' || status === 'planning';
  }

  private async tickRun(run: SwarmRun): Promise<void> {
    if (!this.isDispatchable(run.id)) return;
    if (run.status === 'planning') {
      this.deps.store.updateRunStatus(run.id, 'running');
    }

    const tasks = this.deps.store.listTasks(run.id);
    const sessions = this.deps.listSessions().filter(
      (s) => (s.metadata as { swarmRunId?: string })?.swarmRunId === run.id
    );
    let activeCount = sessions.filter(
      (s) => s.status === 'running' || s.status === 'waiting_approval'
    ).length;

    for (const task of tasks) {
      if (task.status === 'in_progress') {
        this.advanceInProgressTask(run, task, sessions);
      }
    }

    for (const task of tasks) {
      if (!this.isDispatchable(run.id)) return;
      if (task.status !== 'pending') continue;
      if (!this.dependenciesMet(tasks, task)) continue;
      if (activeCount >= run.budget.maxTeammates) break;
      await this.dispatchTask(run, task);
      activeCount += 1;
    }

    if (!this.isDispatchable(run.id)) return;
    const refreshed = this.deps.store.listTasks(run.id);
    const stored = this.deps.store.getRun(run.id);
    if ((stored?.status === 'running' && refreshed.length === 0) || (refreshed.length > 0 && refreshed.every((t) => TERMINAL_TASK.includes(t.status)))) {
      const failed = refreshed.length === 0 || refreshed.some((t) => t.status === 'failed');
      this.deps.store.updateRunStatus(run.id, failed ? 'failed' : 'completed');
    }
  }

  private dependenciesMet(all: SwarmTask[], task: SwarmTask): boolean {
    if (!task.blockedBy.length) return true;
    return task.blockedBy.every((depId) => {
      const dep = all.find((t) => t.id === depId);
      return dep?.status === 'done';
    });
  }

  private sessionIdFromTask(task: SwarmTask): string | undefined {
    const tag = task.artifacts.find((a) => a.startsWith('session:'));
    return tag?.slice('session:'.length);
  }

  private async dispatchTask(run: SwarmRun, task: SwarmTask): Promise<void> {
    const agentId = ROLE_AGENT[task.requiredRole] ?? 'general';
    const claimed = this.deps.store.claimTask(task.id, agentId);
    if (!claimed) return;

    const prompt = [
      `Swarm goal: ${run.goal}`,
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : '',
      task.acceptanceCriteria.length
        ? `Acceptance:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
        : ''
    ]
      .filter(Boolean)
      .join('\n\n');

    const session = this.deps.createTeammateSession({
      name: `swarm-${task.id.slice(-6)}`,
      role: task.requiredRole,
      prompt,
      background: true,
      metadata: {
        swarmRunId: run.id,
        swarmTaskId: task.id,
        autoRun: true
      }
    });

    const artifacts = [...task.artifacts, `session:${session.id}`];
    this.deps.store.updateTask(task.id, {
      status: 'in_progress',
      ownerAgentId: agentId,
      artifacts
    });

    this.launchTeammate(session.id, run.id);
  }

  private advanceInProgressTask(run: SwarmRun, task: SwarmTask, sessions: SessionRecord[]): void {
    const sid = this.sessionIdFromTask(task);
    if (!sid) return;
    const session = sessions.find((s) => s.id === sid) ?? this.deps.getSession(sid);
    if (!session) return;

    if (session.status === 'running' || session.status === 'waiting_approval') return;

    if (session.status === 'failed') {
      this.deps.store.updateTask(task.id, { status: 'failed' });
      this.deps.store.addReview({
        id: createSwarmId('srev'),
        swarmRunId: run.id,
        taskId: task.id,
        reviewerAgentId: 'evaluator',
        role: 'evaluator',
        scores: { correctness: 0 },
        passed: false,
        feedback: `Teammate session ${sid} failed.`,
        createdAt: nowIso()
      });
      return;
    }

    if (session.status === 'completed' || this.deps.sessionTeammateFinished(sid)) {
      // qualityGate is a list of criterion labels; non-empty gate requires completed status
      const gate = run.qualityGate ?? [];
      const requiresCompleted = gate.length > 0;
      const passed = requiresCompleted ? session.status === 'completed' : true;
      const score = session.status === 'completed' ? 0.85 : 0.7;
      this.deps.store.updateTask(task.id, { status: passed ? 'done' : 'failed' });
      this.deps.store.addReview({
        id: createSwarmId('srev'),
        swarmRunId: run.id,
        taskId: task.id,
        reviewerAgentId: 'evaluator',
        role: 'evaluator',
        scores: { correctness: score },
        passed,
        feedback: passed
          ? `Teammate session ${sid} finished (score=${score}${gate.length ? `, gates=${gate.join(',')}` : ''}).`
          : `Teammate session ${sid} did not meet qualityGate (${gate.join(',') || 'default'}).`,
        createdAt: nowIso()
      });
    }
  }
}
