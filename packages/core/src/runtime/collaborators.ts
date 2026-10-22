/**
 * Construct L5 collaborators (self-heal, swarm, orchestration, image ingest).
 */

import { SelfHealScheduler, type SelfHealContext } from '../self-heal/self-heal-scheduler.js';
import type { Logger } from '../logger.js';
import { SocialScheduleService } from '../services/social-schedule-service.js';
import { AutonomousScheduler } from '../services/autonomous-scheduler.js';
import { SwarmExecutor } from '../swarm/executor.js';
import { TeamDagExecutor } from '../teams/executor.js';
import { readTeamsDagSettings } from '../teams/settings.js';
import type { WorkspaceManager } from '../workspaces.js';
import { OrchestrationEngine } from '../orchestrator/engine.js';
import { ImageIngestService } from '../services/image-ingest-service.js';
import { AttachmentIngestService } from '../ingestion/attachment-ingest-service.js';
import { createSwarmId, nowIso as swarmNowIso } from '../swarm/store.js';
import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord, TaskRecord, WorkspaceRecord } from '../types.js';
import { sessionTeammateFinished } from './scheduler-host.js';
import { textPart } from './session-facade.js';
import {
  runOrchestrationResearch,
  runOrchestrationSubagentStage,
  type SpawnHost
} from './spawn-host.js';

export function createRuntimeCollaborators(input: {
  store: SqliteStateStore;
  repoRoot: string;
  stateDir: string;
  log: Logger;
  createTaskSession: (args: {
    title: string;
    description?: string;
    message?: string;
    imageAssetIds?: string[];
    agentId?: string;
    blockedBy?: string[];
    background?: boolean;
    metadata?: Record<string, unknown>;
  }) => { task: TaskRecord; session: SessionRecord };
  createTeammateSession: (args: {
    name: string;
    role: string;
    prompt: string;
    taskId?: string;
    parentSessionId?: string;
    background?: boolean;
    metadata?: Record<string, unknown>;
  }) => SessionRecord;
  runSession: (sessionId: string) => Promise<void>;
  bindWorkspaceForTask: (taskId: string) => Promise<string | undefined>;
  workspaceManager?: WorkspaceManager;
  completeText?: (input: { system: string; user: string }) => Promise<string>;
  spawnHost: () => SpawnHost;
  emitTrace?: SelfHealContext['emitTrace'];
}): {
  selfHeal: SelfHealScheduler;
  socialSchedule: SocialScheduleService;
  autonomousScheduler: AutonomousScheduler;
  swarmExecutor: SwarmExecutor;
  teamDagExecutor: TeamDagExecutor;
  orchestrationEngine: OrchestrationEngine;
  imageIngest: ImageIngestService;
  attachmentIngest: AttachmentIngestService;
} {
  const selfHealCtx: SelfHealContext = {
    store: input.store,
    repoRoot: input.repoRoot,
    createTaskSession: (args) => input.createTaskSession(args),
    runSession: (sid) => input.runSession(sid),
    bindWorkspaceForTask: (tid) => input.bindWorkspaceForTask(tid),
    emitTrace: input.emitTrace,
  };
  const selfHeal = new SelfHealScheduler(selfHealCtx);
  const socialSchedule = new SocialScheduleService(input.store);
  const autonomousScheduler = new AutonomousScheduler({
    store: input.store,
    runSession: (sid) => input.runSession(sid),
    isSelfHealControlled: (session) =>
      (session.metadata as { selfHealControlled?: boolean }).selfHealControlled === true,
    log: input.log
  });
  const swarmExecutor = new SwarmExecutor({
    store: input.store.swarm(),
    listSessions: () => input.store.listSessions(),
    getSession: (id) => input.store.getSession(id),
    createTeammateSession: (args) => input.createTeammateSession(args),
    runSession: (sid) => input.runSession(sid),
    enqueueSchedulerWake: (sid, reason) => input.store.enqueueSchedulerWake(sid, reason),
    sessionTeammateFinished: (sid) => sessionTeammateFinished(input.store, sid)
  });
  const teamDagExecutor = new TeamDagExecutor({
    store: input.store.teams(),
    settings: () => readTeamsDagSettings(input.store),
    stateDir: input.stateDir,
    sourceRoot: input.repoRoot,
    listSessions: () => input.store.listSessions(),
    getSession: (id) => input.store.getSession(id),
    createTeammateSession: (args) => input.createTeammateSession(args),
    createTask: (args) => input.store.createTask(args),
    bindWorkspaceForTask: (tid) => input.bindWorkspaceForTask(tid),
    workspaceManager: input.workspaceManager,
    completeText: input.completeText,
    registerWorkspace: (workspace: WorkspaceRecord, taskId: string, sessionId?: string) => {
      try {
        input.store.createWorkspace(workspace);
      } catch {
        /* already registered */
      }
      input.store.updateTask(taskId, { workspaceId: workspace.id });
      if (sessionId) {
        input.store.updateSession(sessionId, { workspaceId: workspace.id });
      }
    },
    createMail: (args) => {
      input.store.createMail(args);
    },
    runSession: (sid) => input.runSession(sid),
    enqueueSchedulerWake: (sid, reason) => input.store.enqueueSchedulerWake(sid, reason),
    sessionTeammateFinished: (sid) => sessionTeammateFinished(input.store, sid)
  });
  const orchestrationEngine = new OrchestrationEngine({
    store: input.store.orchestrator(),
    startSwarmForRun: async (run) => {
      const swarmStore = input.store.swarm();
      const swarmId = createSwarmId('srun');
      swarmStore.createRun({
        id: swarmId,
        goal: run.title,
        orchestrationRunId: run.id,
        status: 'pending',
        strategy: 'pipeline',
        budget: { maxTeammates: 3, maxTurnsPerAgent: 20, maxDurationMs: 600_000 },
        qualityGate: ['completed'],
        createdAt: swarmNowIso(),
        updatedAt: swarmNowIso()
      });
      swarmExecutor.startRun(swarmId, [
        { title: run.title, requiredRole: 'implementer' }
      ]);
    },
    tickSwarm: () => swarmExecutor.tick(),
    getSwarmForOrchestrationRun: (orchestrationRunId) =>
      input.store
        .swarm()
        .listRuns({ limit: 100 })
        .find((r) => r.orchestrationRunId === orchestrationRunId),
    runResearch: (run) => runOrchestrationResearch(input.spawnHost(), run),
    runReview: (run) => runOrchestrationSubagentStage(input.spawnHost(), run, 'review'),
    runTest: (run) => runOrchestrationSubagentStage(input.spawnHost(), run, 'test')
  });
  const imageIngest = new ImageIngestService({
    store: input.store,
    stateDir: input.stateDir,
    log: input.log,
    appendSystemNote: (sessionId, note) =>
      input.store.appendMessage(sessionId, 'system', [textPart(note)])
  });
  const attachmentIngest = new AttachmentIngestService({
    store: input.store,
    stateDir: input.stateDir,
    log: input.log
  });
  return {
    selfHeal,
    socialSchedule,
    autonomousScheduler,
    swarmExecutor,
    teamDagExecutor,
    orchestrationEngine,
    imageIngest,
    attachmentIngest
  };
}
