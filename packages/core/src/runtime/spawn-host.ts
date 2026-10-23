/**
 * Subagent / teammate / background-job / orchestration spawn helpers.
 */

import { builtinAgents } from '../builtin-agents.js';
import { ResearchPipeline } from '../deepresearch/pipeline.js';
import { NotFoundError } from '../errors.js';
import { inheritBotIdentityMetadata } from '../memory/bot-memory-scope.js';
import { resolvePermissionMode } from '../approval/permission-mode.js';
import { CommandHardlineDeniedError, matchCommandHardline } from '../sandbox/command-hardline.js';
import { createAgentSandboxFromEnv } from '../sandbox/create-agent-sandbox.js';
import type { AgentSandbox } from '../sandbox/agent-sandbox-types.js';
import {
  DIRECT_ISOLATION_REFUSAL,
  decideShellIsolation,
  approvalGrantsDirectIsolation,
  shellIsolationAvailability
} from '../sandbox/model-isolation.js';
import {
  formatSubagentSummary,
  resolveSubagentAgentId,
  type SubagentSpawnArgs
} from '../session/subagent-contract.js';
import type { SqliteStateStore } from '../storage.js';
import type { WorkspaceManager } from '../workspaces.js';
import type {
  BackgroundJobRecord,
  RunContext,
  SessionRecord,
  TaskRecord
} from '../types.js';
import { forkOpeningMessage, inheritForkRetrievalMetadata, latestUserTriggerParts } from '../bots/fork-inheritance.js';
import { inheritWorkspaceBinding, resolveEffectiveWorkspace, workspaceBindingFromMetadata } from '../workspace/index.js';
import type { OrchestrationRun } from '../orchestrator/types.js';
import {
  botTeammatePermission,
  childPermissionMode,
  inheritBotAllowlists,
  inheritModelOverride,
  copyScratchOnSpawn
} from './spawn-policy.js';
import {
  createTeammateSession,
  ensureAgent,
  getLatestAssistantText,
  textPart,
  type SessionFacadeHost
} from './session-facade.js';

export interface SpawnHost extends SessionFacadeHost {
  store: SqliteStateStore;
  repoRoot: string;
  stateDir: string;
  workspaceManager: WorkspaceManager;
  sandbox: AgentSandbox | undefined;
  setSandbox(sandbox: AgentSandbox): void;
  backgroundJobAborts: Map<string, AbortController>;
  runSession(sessionId: string): Promise<SessionRecord>;
  cancelSession?(sessionId: string): void;
}

export async function ensureWorkspaceRoot(
  host: SpawnHost,
  session: SessionRecord,
  task?: TaskRecord
): Promise<string | undefined> {
  const binding = workspaceBindingFromMetadata(session.metadata);
  if (binding.kind === 'project' || binding.kind === 'cloud_folder') {
    const effective = await resolveEffectiveWorkspace({
      store: host.store,
      session,
      repoRoot: host.repoRoot,
      stateDir: host.stateDir
    });
    return effective.workspaceRoot;
  }

  if (!task) {
    return undefined;
  }

  if (task.workspaceId) {
    return host.store.getWorkspace(task.workspaceId)?.rootPath;
  }

  const workspace = await host.workspaceManager.createForTask(task.id, task.title);
  host.store.createWorkspace(workspace);
  host.store.updateTask(task.id, { workspaceId: workspace.id });
  host.store.updateSession(session.id, { workspaceId: workspace.id });
  host.store.appendEvent({
    taskId: task.id,
    kind: 'workspace.bound',
    actor: 'system',
    payload: {
      workspaceId: workspace.id,
      rootPath: workspace.rootPath
    }
  });
  return workspace.rootPath;
}

export async function runOrchestrationResearch(
  host: SpawnHost,
  run: OrchestrationRun
): Promise<string> {
  const researchStore = host.store.research();
  const task = researchStore.createTask({
    query: run.title,
    scope: run.sourceRef,
    capabilityTags: [...run.capabilityTags]
  });
  await new ResearchPipeline({
    store: researchStore,
    stateDir: host.stateDir,
    env: process.env
  }).runTask(task.id);
  return `research:${task.id}`;
}

export async function runOrchestrationSubagentStage(
  host: SpawnHost,
  run: OrchestrationRun,
  stage: 'review' | 'test'
): Promise<string> {
  const agentId = stage === 'test' ? 'evaluator' : 'reviewer';
  const spec =
    builtinAgents.find((a) => a.id === agentId) ??
    builtinAgents.find((a) => a.id === 'general') ??
    builtinAgents[0]!;
  ensureAgent(host.store, spec);
  const subagent = host.store.createSession({
    title: `Orchestration ${stage}: ${run.title.slice(0, 60)}`,
    mode: 'subagent',
    agentId,
    background: false,
    metadata: { orchestrationRunId: run.id, orchestrationStage: stage }
  });
  const prompt =
    stage === 'review'
      ? `Review this orchestration item.\nTitle: ${run.title}\nSource: ${run.sourceRef}\nTags: ${run.capabilityTags.join(', ')}\nGive a brief pass/fail review.`
      : `Run a lightweight harness check for:\nTitle: ${run.title}\nSource: ${run.sourceRef}\nReport pass/fail in one short paragraph.`;
  host.store.appendMessage(subagent.id, 'user', [textPart(prompt)]);
  await host.runSession(subagent.id);
  const summary = (getLatestAssistantText(host.store, subagent.id) ?? 'no-output').slice(0, 200);
  return `${stage}:${subagent.id}:${summary}`;
}

export interface SubagentOutcome {
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

function withChildSession(
  outcome: SubagentOutcome,
  childSessionId: string,
  key: 'childSessionId' | 'teammateSessionId' = 'childSessionId'
): SubagentOutcome {
  return { ...outcome, metadata: { ...outcome.metadata, [key]: childSessionId } };
}

/** Goal scope stays on this bot's own children. A delegated task id is the only link back. */
function inheritedExecutionMetadata(metadata: Record<string, unknown> | undefined, sessionId: string): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  const goalId = metadata?.botGoalId;
  if (typeof goalId === 'string' && goalId) {
    inherited.botGoalId = goalId;
    const scope = metadata?.botGoalScopeSessionId;
    inherited.botGoalScopeSessionId = typeof scope === 'string' && scope ? scope : metadata?.canonicalBotChat === true ? sessionId : undefined;
  }
  const taskId = metadata?.botWorkTaskId;
  if (typeof taskId === 'string' && taskId) inherited.botWorkTaskId = taskId;
  return inherited;
}

/** Text form for callers that only need a string (PTC cells, dyn tools). */
export async function spawnSubagent(
  host: SpawnHost,
  context: RunContext,
  prompt: string,
  role?: string,
  opts?: Omit<SubagentSpawnArgs, 'prompt' | 'role'>
): Promise<string> {
  return (await spawnSubagentOutcome(host, context, prompt, role, opts)).content;
}

/**
 * The child ended parked on approval (or failed) while the parent waited for it.
 * Reporting that as a normal result hides the stall, so it is `ok: false` with a
 * structured body the parent model can act on. The pending approval stays open.
 */
function pendingApprovalsOf(host: SpawnHost, child: SessionRecord) {
  const pending = host.store
    .listApprovals({ status: 'pending' })
    .filter((approval) => approval.sessionId === child.id);
  return {
    blockedTools: [...new Set(pending.map((approval) => approval.toolName))],
    approvalIds: pending.map((approval) => approval.id),
    approvals: pending.map((approval) => ({
      id: approval.id,
      tool: approval.toolName,
      reason: approval.reason
    }))
  };
}

function unfinishedSubagentOutcome(
  host: SpawnHost,
  child: SessionRecord | undefined
): SubagentOutcome | undefined {
  if (!child) return undefined;
  if (child.status === 'waiting_approval') {
    return withChildSession({
      ok: false,
      content: JSON.stringify({
        blocked: true,
        status: 'waiting_approval',
        childSessionId: child.id,
        ...pendingApprovalsOf(host, child),
        remediation:
          'The subagent is waiting for human approval and did not finish. Ask the user to approve it on the approvals page (POST /api/approvals/:id/approve), or continue without this subagent using steps that need no approval.'
      })
    }, child.id);
  }
  if (child.status === 'failed') {
    return withChildSession({
      ok: false,
      content: JSON.stringify({
        blocked: false,
        status: 'failed',
        childSessionId: child.id,
        remediation:
          'The subagent run failed or was aborted and produced no final answer. Retry with a narrower task, or continue without it.'
      })
    }, child.id);
  }
  return undefined;
}

export async function spawnSubagentOutcome(
  host: SpawnHost,
  context: RunContext,
  prompt: string,
  role?: string,
  opts?: Omit<SubagentSpawnArgs, 'prompt' | 'role'>
): Promise<SubagentOutcome> {
  const parentAgent = context.agent;
  const agentId = resolveSubagentAgentId(role, parentAgent.id);
  const childMeta: Record<string, unknown> = {
    parentSessionId: context.session.id,
    subagentRole: role ?? parentAgent.role
  };
  if (opts?.allowedTools?.length) {
    childMeta.allowedTools = opts.allowedTools;
  }
  Object.assign(
    childMeta,
    inheritBotAllowlists(context.session.metadata, {
      agentAllowedTools: host.store.getAgent(agentId)?.allowedTools,
      requestedTools: opts?.allowedTools
    })
  );
  Object.assign(childMeta, inheritModelOverride(context.session.metadata));
  if (opts?.model) {
    childMeta.modelOverride = opts.model;
  }
  if (opts?.minConfidence != null) {
    childMeta.minConfidence = opts.minConfidence;
  }

  const inheritedMode = childPermissionMode(context.session.metadata);
  if (inheritedMode) {
    childMeta.permissionMode = inheritedMode;
  }
  Object.assign(childMeta, inheritForkRetrievalMetadata(context.session.metadata));
  Object.assign(childMeta, inheritBotIdentityMetadata(context.session, host.store));
  const liveParent = host.store.getSession(context.session.id) ?? context.session;
  Object.assign(childMeta, inheritedExecutionMetadata(liveParent.metadata, liveParent.id));

  const subagent = host.store.createSession({
    title: `Subagent: ${role ?? parentAgent.role}`,
    mode: 'subagent',
    agentId,
    taskId: context.task?.id,
    parentSessionId: context.session.id,
    background: false,
    metadata: childMeta
  });

  const scratchCopy = copyScratchOnSpawn(context.session.metadata, opts?.scratchKeyFilter);
  if (scratchCopy === 'all') {
    host.store.copySessionMemory(context.session.id, subagent.id, 'scratch');
  } else if (scratchCopy === 'filter') {
    host.store.copySessionMemory(
      context.session.id,
      subagent.id,
      'scratch',
      opts?.scratchKeyFilter
    );
  }
  const reviewHint =
    role === 'review' || role === 'evaluator' || role === 'reviewer'
      ? `\n\nWhen finished, include a line: confidence: <0-100>`
      : '';
  const taskText = `${prompt}${reviewHint}`;
  host.store.appendMessage(
    subagent.id,
    'user',
    forkOpeningMessage({
      store: host.store,
      parentSessionId: context.session.id,
      childSessionId: subagent.id,
      taskText,
      triggerParts: latestUserTriggerParts(host.store.foldMessages(context.session.id))
    })
  );
  const cancelChild = () => host.cancelSession?.(subagent.id);
  if (opts?.signal?.aborted) throw new Error('Subagent spawn aborted');
  opts?.signal?.addEventListener('abort', cancelChild, { once: true });
  try {
    await host.runSession(subagent.id);
  } finally {
    opts?.signal?.removeEventListener('abort', cancelChild);
  }
  if (opts?.signal?.aborted) throw new Error('Subagent run aborted');
  const unfinished = unfinishedSubagentOutcome(host, host.store.getSession(subagent.id));
  if (unfinished) return unfinished;
  const raw = getLatestAssistantText(host.store, subagent.id) ?? '(subagent returned no text)';
  const summary = formatSubagentSummary({
    text: raw,
    sessionId: subagent.id,
    role,
    minConfidence: opts?.minConfidence ?? (role === 'review' || role === 'evaluator' ? 80 : undefined),
    summaryMaxChars: opts?.summaryMaxChars
  });
  return withChildSession({ ok: true, content: summary.text }, subagent.id);
}

export async function spawnTeammate(
  host: SpawnHost,
  context: RunContext,
  input: { name: string; role: string; prompt: string }
): Promise<string> {
  return (await spawnTeammateOutcome(host, context, input)).content;
}

/**
 * The teammate is a persistent background session, so a run that parks on approval is not a
 * failed spawn: the outcome stays `ok: true` (re-spawning would only duplicate it) but the body
 * names the blocked tool, approval ids and session so the parent can surface it to the user.
 */
export async function spawnTeammateOutcome(
  host: SpawnHost,
  context: RunContext,
  input: { name: string; role: string; prompt: string }
): Promise<SubagentOutcome> {
  const session = createTeammateSession(host, {
    name: input.name,
    role: input.role,
    prompt: input.prompt,
    taskId: context.task?.id,
    parentSessionId: context.session.id,
    background: true,
    metadata: {
      ...inheritWorkspaceBinding(context.session.metadata),
      ...inheritModelOverride(context.session.metadata),
      ...botTeammatePermission(context.session.metadata),
      ...inheritBotAllowlists(context.session.metadata, {
        agentAllowedTools: host.store.getAgent(input.name)?.allowedTools
      }),
      ...inheritBotIdentityMetadata(context.session, host.store),
      ...inheritedExecutionMetadata(context.session.metadata, context.session.id)
    }
  });
  if (copyScratchOnSpawn(context.session.metadata, undefined) === 'all') {
    host.store.copySessionMemory(context.session.id, session.id, 'scratch');
  }
  await host.runSession(session.id);
  const spawned = `Spawned teammate ${input.name} in session ${session.id}`;
  const after = host.store.getSession(session.id);
  if (after?.status === 'waiting_approval') {
    const pending = pendingApprovalsOf(host, after);
    return withChildSession({
      ok: true,
      content: JSON.stringify({
        spawned: true,
        blocked: true,
        status: 'waiting_approval',
        message: spawned,
        teammateName: input.name,
        teammateSessionId: after.id,
        ...pending,
        remediation:
          'The teammate exists but is waiting for human approval and is not making progress. Ask the user to approve it on the approvals page (POST /api/approvals/:id/approve). Do not spawn a duplicate teammate; continue with steps that need no approval in the meantime.'
      })
    }, after.id, 'teammateSessionId');
  }
  return withChildSession({ ok: true, content: spawned }, session.id, 'teammateSessionId');
}

export async function startBackgroundJob(
  host: SpawnHost,
  sessionId: string,
  command: string,
  options?: { isolation?: unknown }
): Promise<BackgroundJobRecord> {
  const denied = matchCommandHardline(command);
  if (denied) throw new CommandHardlineDeniedError(denied);

  const session = host.store.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session', sessionId);
  }

  const workspaceRoot = session.workspaceId ? host.store.getWorkspace(session.workspaceId)?.rootPath : undefined;
  let cwd = workspaceRoot ?? host.repoRoot;
  let workspace: string | string[] = cwd;
  try {
    const effective = await resolveEffectiveWorkspace({
      store: host.store,
      session,
      repoRoot: host.repoRoot,
      stateDir: host.stateDir,
      isolatedWorkspaceRoot: workspaceRoot
    });
    cwd = effective.workspaceRoot;
    workspace = effective.workspaceRoots.map((r) => r.path);
  } catch {
    workspace = cwd;
  }
  let sandbox = host.sandbox;
  if (!sandbox) {
    sandbox = createAgentSandboxFromEnv();
    host.setSandbox(sandbox);
  }
  const decision = decideShellIsolation(options?.isolation, shellIsolationAvailability(sandbox.kind));
  if (!decision.ok) throw new Error(decision.message);
  if (
    decision.explicitDirect &&
    resolvePermissionMode(session.metadata, process.env) !== 'bypass' &&
    !bgRunDirectApproved(host, sessionId, command, options?.isolation)
  ) {
    throw new Error(DIRECT_ISOLATION_REFUSAL);
  }
  const job = host.store.createBackgroundJob({
    sessionId,
    command,
    status: 'running'
  });
  const ac = new AbortController();
  host.backgroundJobAborts.set(job.id, ac);
  sandbox
    .execute({
      command,
      cwd,
      workspace,
      signal: ac.signal,
      sessionId,
      allowNetwork: true,
      ...(decision.localMode === 'inherit' ? {} : { isolation: decision.localMode })
    })
    .then((result) => {
      host.backgroundJobAborts.delete(job.id);
      if (!host.store.db.isOpen) return;
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') || '(no output)';
      host.store.updateBackgroundJob(job.id, 'completed', output);
      host.store.runWithoutWriterScope(() => host.store.enqueueSteer(sessionId, `Background job ${job.id} completed.\n${output.slice(0, 4000)}`, {role:'user',key:`background-job:${job.id}`}));
    }).catch((error) => {
      host.backgroundJobAborts.delete(job.id);
      if (!host.store.db.isOpen) return;
      host.store.updateBackgroundJob(job.id, 'error', String(error));
      host.store.runWithoutWriterScope(() => host.store.enqueueSteer(sessionId, `Background job ${job.id} failed: ${String(error)}`, {role:'user',key:`background-job:${job.id}`}));
    });

  return job;
}

function bgRunDirectApproved(host: SpawnHost, sessionId: string, command: string, isolation: unknown): boolean {
  return approvalGrantsDirectIsolation(host.store.listApprovals(), sessionId, 'bg_run', { command, isolation });
}
