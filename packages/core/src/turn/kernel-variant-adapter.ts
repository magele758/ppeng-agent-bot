/**
 * Adapter: core `TurnKernelHost` → `@ppeng/agent-loop` `TurnKernelHost`.
 *
 * Optional ports must be forwarded — otherwise dyn-tools / goal / lifecycle
 * / MCP / filePolicy silently disappear when switching kernels.
 */

import type { TurnKernelHost as CoreHost } from '../turn/host.js';
import type { FileApprovalPolicy as LoopFilePolicy, TurnKernelHost as LoopHost } from '@ppeng/agent-loop';

export function adaptCoreHostToAgentLoop(core: CoreHost): LoopHost {
  const adapted: LoopHost = {
    store: core.store,
    repoRoot: core.repoRoot,
    stateDir: core.stateDir,
    tools: core.tools,
    modelAdapter: core.modelAdapter,
    promptBuilder: {
      buildSystemPrompt: (ctx, messages) => core.promptBuilder.buildSystemPrompt(ctx, messages),
      buildMemoryAppendix: (ctx, opts) => {
        const bound = opts as { query?: string; stateDir?: string } | undefined;
        return core.promptBuilder.buildMemoryAppendix(ctx, {
          query: bound?.query,
          stateDir: bound?.stateDir ?? core.stateDir
        });
      }
    },
    maxTurnsPerRun: core.maxTurnsPerRun,
    loopConfig: core.loopConfig,
    env: core.env ?? process.env,
    cumulativeInputTokensBySession: core.cumulativeInputTokensBySession,

    emitTrace(sessionId, event) {
      core.emitTrace(sessionId, event as Parameters<CoreHost['emitTrace']>[1]);
    },

    mergeSessionMetadata: (sessionId, patch) => core.mergeSessionMetadata(sessionId, patch),

    runTurnWithRetries: (input, onStream) => core.runTurnWithRetries(input, onStream),

    executeToolCalls: (toolCalls, context, allowExternalAiTools, sessionId, turnTools) =>
      core.executeToolCalls(
        toolCalls as Parameters<CoreHost['executeToolCalls']>[0],
        context,
        allowExternalAiTools,
        sessionId,
        turnTools
      ),

    prepareMessagesForModel: (session, messages) =>
      core.prepareMessagesForModel(session, messages),

    autoCompact: (context, opts) => core.autoCompact(context, opts),

    handleTurnCompletion: (session, agent) => {
      const task =
        core.resolveTask?.(session) ??
        (session.taskId && typeof core.store.getTask === 'function'
          ? core.store.getTask(session.taskId)
          : undefined);
      return core.handleTurnCompletion(session, { id: agent.id }, task);
    },

    processToolResults: (results, validToolCalls, session, task, sessionId, onModelStreamChunk) =>
      core.processToolResults(
        results,
        validToolCalls as Parameters<CoreHost['processToolResults']>[1],
        session,
        task as Parameters<CoreHost['processToolResults']>[3],
        sessionId,
        onModelStreamChunk
      ),

    resolveModelAdapter: core.resolveModelAdapter
      ? (session) => core.resolveModelAdapter!(session)
      : undefined,

    checkToolApprovals: (toolCalls, context, session, extras) =>
      core.checkToolApprovals(
        toolCalls as Parameters<CoreHost['checkToolApprovals']>[0],
        context,
        extras?.filePolicy as Parameters<CoreHost['checkToolApprovals']>[2],
        session,
        extras?.turnTools,
        extras?.closedByGate,
        extras?.settledApprovalIds
      ),

    resolveImageDataUrl: core.resolveImageDataUrl
      ? (assetId, sessionId) => core.resolveImageDataUrl!(assetId, sessionId)
      : undefined,

    ingestMailbox: core.ingestMailbox ? (session) => core.ingestMailbox!(session) : undefined,

    // Isolated roots need the task; look it up when the kernel only has the session.
    ensureWorkspaceRoot: async (session, task) => {
      const resolved =
        task ??
        core.resolveTask?.(session) ??
        (session.taskId && typeof core.store.getTask === 'function'
          ? core.store.getTask(session.taskId)
          : undefined);
      return core.ensureWorkspaceRoot(session, resolved);
    },

    autoClaimTask: (session) => core.autoClaimTask(session),

    applyFoldBudget: (session, folded) =>
      core.applyFoldBudget
        ? core.applyFoldBudget(session, folded)
        : core.applyOptionalFoldBudget(session, folded),

    recordToolUse: core.recordToolUse
      ? (input) => core.recordToolUse!(input)
      : undefined,

    noteGoalWaitingUser: core.noteGoalWaitingUser
      ? (sessionId, toolCalls) => core.noteGoalWaitingUser!(sessionId, toolCalls)
      : undefined,

    resolveTask: core.resolveTask
      ? (session) => core.resolveTask!(session)
      : (session) =>
          session.taskId && typeof core.store.getTask === 'function'
            ? core.store.getTask(session.taskId)
            : undefined,

    sessionAbortControllers: core.sessionAbortControllers,

    waitSteeringChildrenIdle: core.waitSteeringChildrenIdle
      ? (sessionId: string) => core.waitSteeringChildrenIdle!(sessionId)
      : undefined,

    injectRecoveryCoach: core.injectEvolvingCoachBeforeRecovery
      ? async ({ session, agent, trigger, reason }) => {
          await core.injectEvolvingCoachBeforeRecovery!(session, agent, trigger, reason);
        }
      : undefined,

    onSessionOutcome: core.scheduleBackgroundCaseReview
      ? ({ sessionId, agentId, outcome, signals }) => {
          core.scheduleBackgroundCaseReview!({ sessionId, agentId, outcome, signals });
        }
      : undefined,

    resolveRunProfile: core.resolveRunProfile
      ? (session) => core.resolveRunProfile!(session)
      : undefined,

    resolveTurnTools: core.resolveTurnTools
      ? (input) => core.resolveTurnTools!(input)
      : undefined,

    beforeModelTurn: core.beforeModelTurn
      ? (input) => core.beforeModelTurn!(input)
      : undefined,

    chooseRecovery: core.chooseRecovery
      ? (input) => core.chooseRecovery!(input)
      : undefined,

    evaluateGoalGate: core.evaluateGoalGate
      ? (input) => core.evaluateGoalGate!(input)
      : undefined,

    runLifecycleHook: core.runLifecycleHook
      ? (input) => core.runLifecycleHook!(input)
      : undefined,

    ensureMcpLoaded: core.ensureMcpLoaded
      ? (sessionId) => core.ensureMcpLoaded!(sessionId)
      : (sessionId) => core.mcpManager.ensureLoaded(sessionId),

    resolveFilePolicy: async () => {
      const policy = core.resolveFilePolicy
        ? await core.resolveFilePolicy()
        : await core.mergedFilePolicy();
      return policy as LoopFilePolicy | undefined;
    },

    resolveWorkspaceRoots: core.resolveWorkspaceRoots
      ? (session) => core.resolveWorkspaceRoots!(session)
      : undefined,

    filterValidToolCalls: (toolCalls, allowExternalAiTools, sessionId, turnTools) =>
      core.filterValidToolCalls(
        toolCalls as Parameters<CoreHost['filterValidToolCalls']>[0],
        allowExternalAiTools,
        sessionId,
        turnTools
      ),

    shouldLatchBeforeTools: core.shouldLatchBeforeTools
      ? (input) => core.shouldLatchBeforeTools!(input)
      : undefined,

    stepTx: core.stepTx,

    latestClosedCheckpoint: core.latestClosedCheckpoint
      ? (sessionId) => core.latestClosedCheckpoint!(sessionId)
      : undefined,

    applyAutoFork: core.applyAutoFork
      ? (input) => core.applyAutoFork!(input)
      : undefined,
  };

  if (core.hooks) {
    Object.assign(adapted, { hooks: core.hooks });
  }

  return adapted;
}
