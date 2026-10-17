import { BotRoomService } from './rooms/index.js';
import { recoverBotWork, tickBotWork, createBotManagementTools, expireOverdueBotWork, isBotWorkSessionBlocked, type BotWorkHost } from './bots/bot-work.js';
import { applyConcurrentBotForks, clearActiveWorkPiece } from './bots/concurrent-fork.js';
import { createSubagentHelpTool } from './runtime/subagent-help.js';
import { createHistoryTools } from './session/history/tools.js';
/**
 * L5 runtime host façade: MCP / mailbox / approvals / scheduler / public API.
 * The session turn loop lives in `turn/kernel.ts` (`runSessionKernel`).
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LcuComputerUseProvider, type LcuDeps } from './computer-use/lcu-provider.js';
import { createLcuApprovalHandler } from './computer-use/approval.js';
import { readLcuSettings } from './computer-use/settings.js';
import { createAppControlTools } from './app-control/tools.js';
import { readAppControlSettings } from './app-control/settings.js';
import { createLogger } from './logger.js';
import { NotFoundError, ValidationError } from './errors.js';
import type { AgentSandbox } from './sandbox/agent-sandbox-types.js';
import { SelfHealScheduler } from './self-heal/self-heal-scheduler.js';
import { attachServedByToTrace } from './model/fallback-chain.js';
import { PromptBuilder } from './model/prompt-builder.js';
import { previewSessionContextStack } from './session/context-stack.js';
import type { ContextSnapshot } from './session/context-snapshots.js';
import type { ApprovalPolicy } from './approval/approval-policy.js';
import { expireDueUnattendedApprovals } from './approval/unattended-approval.js';
import {
  loadPolicyFromRepo,
  mergeApprovalPolicies,
  type FileApprovalPolicy
} from './approval/policy-loader.js';
import {
  createExtensionRegistry,
  type ExtensionRegistry,
  type ExtensionSpec
} from './extensions/extension-registry.js';
import type { PermissionMode } from './approval/permission-mode.js';
import { runDoctor, formatDoctorReport, type DoctorReport } from './doctor/doctor.js';
import { CronJobStore } from './cron/cron-store.js';
import { builtinAgents } from './builtin-agents.js';
import {
  createModelAdapterFromEnvOrHeuristic,
  pickerOptions,
  readModelCatalog
} from './model/provider-catalog.js';
import { SqliteStateStore } from './storage.js';
import { readSessionTraceEvents } from './stores/read-traces.js';
import { appendTraceEvent } from './stores/trace.js';
import type { TraceEvent } from './stores/trace.js';
import { createBuiltinTools } from './tools/builtin-tools.js';
import { createMessageAgentTool } from './tools/message-agent.js';
import type {
  AgentSpec,
  ApprovalRecord,
  DaemonRestartRequest,
  MailRecord,
  ModelAdapter,
  ModelStreamChunk,
  SelfHealEventRecord,
  SelfHealPolicy,
  SelfHealRunRecord,
  SessionMessage,
  SessionRecord,
  ImageAssetRecord,
  SkillSpec,
  TaskRecord,
  ToolContract
} from './types.js';
import type { ApiSocialPostScheduleItem } from './api-types.js';
import { type SocialPostDeliverFn } from './social-schedule.js';
import { SocialScheduleService, type SocialScheduleAction } from './services/social-schedule-service.js';
import { AutonomousScheduler } from './services/autonomous-scheduler.js';
import { SwarmExecutor } from './swarm/executor.js';
import { TeamDagExecutor } from './teams/executor.js';
import type { TeamGateName, TeamPlan } from './teams/types.js';
import { loadRuntimeEnvConfig } from './runtime-env.js';
import { OrchestrationEngine } from './orchestrator/engine.js';
import { createPtcExecTool } from './ptc/ptc-exec-tool.js';
import { createPtcJevHooks } from './jev/points/ptc-decide.js';
import { runWithJevTrace } from './jev/client.js';
import { chainHas, resolveJevChain } from './jev/settings.js';
import { mirrorTraceToLangfuse } from './langfuse/export.js';
import { createDynMetaTools, tryCreateDynToolStore } from './dyn-tools/index.js';
import { createSkillProposeTool } from './skill-proposals/index.js';
import { createStoreScratchPersist } from './ptc/scratchpad.js';
import { inheritBotIdentityMetadata } from './memory/bot-memory-scope.js';
import { inheritBotAllowlists, inheritModelOverride } from './runtime/spawn-policy.js';
import { scratchKeyFilterFromInherit } from './memory/ptc-meta.js';
import { runGoalVerify } from './goal/run-verify.js';
import { filterToolsForSession } from './turn/resolve-turn-tools.js';
import { markInterruptedSubagentsUnknown } from './runtime/subagent-policy.js';
import { ResearchPipeline } from './deepresearch/pipeline.js';
import { ImageIngestService } from './services/image-ingest-service.js';
import { AttachmentIngestService } from './ingestion/attachment-ingest-service.js';
import type { AttachmentRecord } from './ingestion/attachment-ingest-service.js';
import type { AttachmentStatus } from './ingestion/status.js';
import type { ArtifactIndexRecord } from './stores/artifact-store.js';
import { WorkspaceManager } from './workspaces.js';
import { McpManager } from './mcp/mcp-manager.js';
import { discoverPlugins, mergePlugins, pluginDirsFromEnv } from './plugins/plugin-loader.js';
import type { LoadedPlugin } from './plugins/plugin-loader.js';
import { ConnectorRegistry, mergeGrantedConnectorTools } from './connectors/registry.js';
import type { AssetStorage, EventBufferRepository } from './storage/interfaces.js';
import { defaultTenantIdFromEnv, defaultUserIdFromEnv } from './storage/provider-config.js';
import { AgentLoopHandle, type AgentLoopLatch } from './runtime/agent-loop.js';
import type { EnqueueSteerOptions } from './session/step-inbox.js';
import { decideSteerAdmission, type SteerAck } from './session/steer-ack.js';
import { resolveSteerInterruptPolicy } from './session/steer-interrupt.js';
import { requestHumanRun, requestSteerContinuation, dropHumanSteerContinuation, withHumanContinuationAdmission, createHumanContinuationObserver, drainHumanContinuations, blockHumanContinuations, releaseHumanModelInput } from './session/human-continuation.js';
import { type SteerDrainPolicy } from './session/steer-drain.js';
import { runSessionKernel as runSessionKernelPpeng } from './turn/kernel.js';
import {
  createAssembledLoop,
  createKernelHookRegistry,
  parseLoopPreset,
  registerKernelHooks as subscribeKernelHooks
} from '@ppeng/agent-loop';
import type { KernelHookListener, KernelHookRegistry, LoopPreset } from '@ppeng/agent-loop';
import { assembleOptionalTools } from './runtime/tool-assembly.js';
import { attachFileCompensation } from './session/file-compensation.js';
import { forkSession } from './session/session-fork.js';
import {
  mergeSteeringChild,
  startSteeringSubagent,
  resolveSubagentAgentId
} from './session/steering-subagent.js';
import { bindSecretVault, SecretVault } from './secrets/secret-vault.js';
import {
  bindSandboxSettingsStore,
  resolveCloudflareComputer,
  resolveCloudflareComputerToken
} from './sandbox/sandbox-settings.js';
import { probeCloudflareComputerHealth } from './sandbox/cloudflare-computer-client.js';
import { createId } from './id.js';
import { textPart } from './runtime/session-facade.js';
import {
  approve as approveDecision,
  createChatSession as createChatSessionFn,
  createTaskSession as createTaskSessionFn,
  createTeammateSession as createTeammateSessionFn,
  enqueueSteer as enqueueSteerFn,
  getLatestAssistantText as latestAssistantText,
  getPermissionMode as getPermissionModeFn,
  mergeSessionMetadata as mergeSessionMetadataFn,
  sendMailboxMessage as sendMailboxMessageFn,
  sendUserMessage as sendUserMessageFn,
  setPermissionMode as setPermissionModeFn
} from './runtime/session-facade.js';
import {
  createBot as createBotFn,
  getBot as getBotFn,
  listBots as listBotsFn,
  openBot as openBotFn,
  updateBot as updateBotFn
} from './bots/bot-facade.js';
import { applyBotChatCommand, type BotChatCommandResult } from './bots/bot-chat-commands.js';
import { botPolicyWarnings as botPolicyWarningsFn, type BotPolicyWarning } from './bots/bot-policy.js';
import { resolveSessionMaxTurns } from './runtime/session-max-turns.js';
import type { BotRecord, CreateBotInput, ListBotsOptions, OpenBotResult, UpdateBotInput } from './bots/types.js';
import {
  runScheduler as runSchedulerFn,
  tickCronJobs as tickCronJobsFn
} from './runtime/scheduler-host.js';
import { cancelAllSessions as cancelAllSessionsFn, cancelSession as cancelSessionFn, destroyRuntime } from './runtime/session-control.js';
import { ensureWorkspaceRoot as ensureWorkspaceRootFn } from './runtime/spawn-host.js';
import { createRuntimeCollaborators } from './runtime/collaborators.js';
import { flushPreparedContextSnapshots,
  bindTurnKernelHost,
  compactFrom,
  createRuntimeToolServices,
  cronFacadeFrom,
  fanoutKernelLatch,
  l5ToAssembledIo,
  mergeKernelHookRegistries,
  schedulerFrom,
  sessionFacadeFrom,
  spawnFrom,
  type L5Bindable
} from './runtime/l5-bindings.js';
import { autoCompactSession } from './runtime/compact-host.js';
import {
  createCronJob as createCronJobFn,
  deleteCronJob as deleteCronJobFn,
  getCronJob as getCronJobFn,
  listCronJobs as listCronJobsFn,
  updateCronJob as updateCronJobFn,
  type CreateCronJobInput,
  type ListCronJobsFilter,
  type UpdateCronJobInput
} from './cron/cron-facade.js';
import type { CronJobRecord } from './cron/cron-store.js';

export interface RuntimeOptions {
  /** Optional native transport seam for embedders and isolated protocol tests. */
  computerUseClientFactory?: LcuDeps['clientFactory'];
  repoRoot: string;
  stateDir: string;
  modelAdapter?: ModelAdapter;
  agents?: AgentSpec[];
  tools?: ToolContract<any>[];
  /**
   * Append on top of `builtinAgents` (or the explicit `agents` list) without
   * replacing them. Use this to mount domain personas alongside the core.
   */
  extraAgents?: AgentSpec[];
  /**
   * Append on top of the builtin tool set (or the explicit `tools` list)
   * without replacing it. Used to mount domain-specific tools.
   */
  extraTools?: ToolContract<any>[];
  /**
   * Append on top of the discovered SkillSpecs (workspace + ~/.agents).
   * Used by domain bundles to ship runbooks alongside the core agent.
   */
  extraSkills?: SkillSpec[];
  /** Optional PG-backed trace/event buffer (multi-replica daemon). */
  eventBufferRepository?: EventBufferRepository;
  /** Optional cloud catalog skills merged after workspace/~.agents discovery. */
  cloudSkillsLoader?: () => Promise<SkillSpec[]>;
  /** Optional tiered asset store (emptyDir hot + MinIO cold). */
  tieredAssetStorage?: AssetStorage;
  /** Max tool calls executed in parallel when none need approval (default 8). */
  maxParallelToolCalls?: number;
  /** In-process extension handlers (pi-style phases). */
  extensions?: ExtensionSpec[];
}

export class RawAgentRuntime {
  private readonly log = createLogger('runtime');
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly store: SqliteStateStore;
  /** Optional L2/L3 asset facade when `ASSET_STORAGE_PROVIDER=tiered`. */
  readonly tieredAssetStorage?: AssetStorage;
  readonly workspaceManager: WorkspaceManager;
  readonly modelAdapter: ModelAdapter;
  readonly selfHeal: SelfHealScheduler;
  readonly promptBuilder: PromptBuilder;
  tools: ToolContract<any>[];
  readonly connectors: ConnectorRegistry;
  readonly rooms: BotRoomService;
  private loadedPlugins: LoadedPlugin[] = [];
  private connectorToolNames = new Set<string>();
  readonly secretVault: SecretVault;
  /** Product-facing kernel event registry. `runSession` always fans out here. */
  readonly hooks: KernelHookRegistry;

  private readonly maxParallelToolCalls: number;
  private readonly maxTurnsPerRun: number;
  /** AbortControllers for sandbox-managed background jobs (only path actually used; legacy spawn-tracker removed). */
  private readonly backgroundJobAborts = new Map<string, AbortController>();
  private sandbox: AgentSandbox | undefined;
  private readonly sessionAbortControllers = new Map<string, AbortController>();
  /** Tracks sessions currently in runSession() to prevent concurrent runs on the same session. */
  private readonly runningSessions = new Map<string, Promise<SessionRecord>>();
  /** Late subscribers (Lab follow after ask_user) receive chunks from the in-flight run. */
  private readonly modelStreamListeners = new Map<string, Set<(chunk: ModelStreamChunk) => void>>();
  private readonly sessionRunWaiters = new Map<string, Set<(run: Promise<SessionRecord>) => void>>();
  /**
   * Last turn's system-prompt size and tool count per session, used to derive the
   * history token budget. Populated after the first turn assembles its prompt;
   * before that the budget falls back to the input-free defaults.
   */
  private readonly turnShapeBySession = new Map<
    string,
    { systemPromptChars: number; toolCount: number }
  >();
  /**
   * Sticky cumulative-input-token detector: some gateways report prompt_tokens as a
   * running total. We remember the last cumulative value so we can split it.
   */
  private readonly cumulativeInputTokensBySession = new Map<
    string,
    { cumulative: number; sticky: boolean }
  >();
  private readonly envApprovalPolicy: ApprovalPolicy | undefined;
  private readonly mcpManager: McpManager;
  readonly computerUse: LcuComputerUseProvider;
  private filePolicyCache: FileApprovalPolicy | undefined | null = null;
  private readonly socialSchedule: SocialScheduleService;
  private readonly autonomousScheduler: AutonomousScheduler;
  private readonly swarmExecutor: SwarmExecutor;
  private readonly teamDagExecutor: TeamDagExecutor;
  private readonly orchestrationEngine: OrchestrationEngine;
  private readonly imageIngest: ImageIngestService;
  private readonly attachmentIngest: AttachmentIngestService;
  private cronStore: CronJobStore | undefined;
  private readonly extensionRegistry: ExtensionRegistry;
  private readonly traceCloudOptions: {
    eventBuffer: EventBufferRepository;
    tenantId: string;
    userId: string;
  } | undefined;

  constructor(options: RuntimeOptions) {
    this.repoRoot = options.repoRoot;
    this.stateDir = options.stateDir;
    this.hooks = createKernelHookRegistry();
    this.tieredAssetStorage = options.tieredAssetStorage;
    this.traceCloudOptions = options.eventBufferRepository
      ? {
          eventBuffer: options.eventBufferRepository,
          tenantId: defaultTenantIdFromEnv(process.env),
          userId: defaultUserIdFromEnv(process.env),
        }
      : undefined;
    this.store = new SqliteStateStore(join(this.stateDir, 'runtime.sqlite'));
    recoverBotWork(this.store);
    const interruptedSubagents = markInterruptedSubagentsUnknown(this.store);
    if (interruptedSubagents.length > 0) {
      this.log.warn('in-flight subagents marked unknown after restart', {
        count: interruptedSubagents.length,
        sessionIds: interruptedSubagents.map((session) => session.id)
      });
    }
    this.workspaceManager = new WorkspaceManager(join(this.stateDir, 'workspaces'), this.repoRoot);
    this.modelAdapter = options.modelAdapter ?? createModelAdapterFromEnvOrHeuristic(process.env);
    const runtimeEnv = loadRuntimeEnvConfig(process.env);
    this.maxParallelToolCalls = options.maxParallelToolCalls ?? runtimeEnv.maxParallelToolCalls;
    this.maxTurnsPerRun = runtimeEnv.maxTurnsPerRun;
    this.envApprovalPolicy = runtimeEnv.approvalPolicy;
    this.extensionRegistry = createExtensionRegistry(options.extensions);

    this.loadedPlugins = discoverPlugins(pluginDirsFromEnv(process.env));
    const mergedPlugins = mergePlugins(this.loadedPlugins);
    for (const [k, v] of Object.entries(mergedPlugins.hookEnv)) {
      if (!process.env[k]?.trim()) process.env[k] = v;
    }
    this.connectors = new ConnectorRegistry({
      store: this.store,
      getPlugins: () => this.loadedPlugins,
      getCapabilities: () => this.store.capabilities().list({ limit: 500 })
    });

    this.promptBuilder = new PromptBuilder({
      store: this.store,
      repoRoot: this.repoRoot,
      stateDir: this.stateDir,
      extraSkills: [...(options.extraSkills ?? []), ...mergedPlugins.skills],
      cloudSkillsLoader: options.cloudSkillsLoader,
      runtimeInstructions: (sessionId) =>
        [this.computerUse?.instructionsForSession(sessionId) ?? '', this.connectors.instructionsForGranted(process.env)]
          .filter(Boolean)
          .join('\n\n'),
    });

    const collab = createRuntimeCollaborators({
      store: this.store,
      repoRoot: this.repoRoot,
      stateDir: this.stateDir,
      log: this.log,
      createTaskSession: (input) => this.createTaskSession(input),
      createTeammateSession: (input) => this.createTeammateSession(input),
      runSession: (sid) => this.runSession(sid).then(() => {}),
      bindWorkspaceForTask: (tid) => this.bindWorkspaceForTask(tid),
      workspaceManager: this.workspaceManager,
      completeText: (input) =>
        typeof this.modelAdapter.completeText === 'function'
          ? this.modelAdapter.completeText(input)
          : Promise.resolve(''),
      spawnHost: () => spawnFrom(this.l5())
    });
    this.selfHeal = collab.selfHeal;
    this.socialSchedule = collab.socialSchedule;
    this.autonomousScheduler = collab.autonomousScheduler;
    this.swarmExecutor = collab.swarmExecutor;
    this.teamDagExecutor = collab.teamDagExecutor;
    this.orchestrationEngine = collab.orchestrationEngine;
    this.imageIngest = collab.imageIngest;
    this.attachmentIngest = collab.attachmentIngest;

    for (const agent of options.agents ?? builtinAgents) {
      this.store.upsertAgent(agent);
    }
    for (const agent of options.extraAgents ?? []) {
      this.store.upsertAgent(agent);
    }
    for (const agent of mergedPlugins.agents) {
      this.store.upsertAgent(agent);
    }

    this.secretVault = new SecretVault(this.store);
    bindSecretVault(this.secretVault);
    bindSandboxSettingsStore(this.store);
    const toolServices = createRuntimeToolServices(this.l5());
    const baseTools = attachFileCompensation(
      options.tools ?? createBuiltinTools(toolServices)
    );
    const optionalExtras = assembleOptionalTools({
      routineHost: {
        store:this.store, stateDir:this.stateDir, log:this.log,
        runSession:(id)=>this.runSession(id),
        isSessionRunning:(id)=>this.isSessionRunning(id),
        hasUnconfirmedEffects:(id,startedAt)=>this.connectors.software.unconfirmedForSession(id,startedAt).length>0,
        cancelSession:(id)=>this.cancelSession(id),
      },
      env: process.env,
      store: this.store,
      stateDir: this.stateDir,
      getCronStore: () => {
        if (!this.cronStore) this.cronStore = new CronJobStore(this.stateDir);
        return this.cronStore;
      }
    });
    const messageAgentTool = createMessageAgentTool({
      store: this.store,
      runSession: (sessionId) => this.runSession(sessionId),
      isSessionRunning: (sessionId) => this.runningSessions.has(sessionId),
      log: this.log
    });
    const toolsWithoutPtc = [
      ...baseTools.filter(tool => tool.name !== 'history_search' && tool.name !== 'history_read'),
      ...optionalExtras,
      messageAgentTool,
      ...createHistoryTools(this.store),
      createSubagentHelpTool(this.store),
      ...createBotManagementTools({ store: this.store, runSession: (id) => this.runSession(id),
        isSessionRunning: (id) => this.runningSessions.has(id), cancelSession: (id) => this.cancelSession(id),
        hasUnconfirmedEffects: (id, since) => this.hasUnconfirmedEffects(id, since), log: this.log }),
      ...(options.extraTools ?? [])
    ];
    const ptcExec = createPtcExecTool({
      getAuthorizedTools: (context) =>
        filterToolsForSession({
          env: process.env,
          tools: toolsWithoutPtc,
          agent: context.agent,
          session: context.session,
          settingsStore: this.store
        }).tools,
      spawnSubagent: (context, spec, signal) =>
        toolServices.spawnSubagent(
          context,
          spec.task,
          spec.role ?? spec.agent,
          {
            allowedTools: spec.allowed_tools,
            model: spec.model,
            signal,
            summaryMaxChars: spec.summaryMaxChars,
            scratchKeyFilter: scratchKeyFilterFromInherit(spec.inheritScratch)
          }
        ),
      createScratchPersist: (context) => createStoreScratchPersist(this.store, context.session.id),
      goalSettingsStore: this.store,
      runGoalVerify,
      resolveJevHooks: ({ signal }) => {
        const chain = resolveJevChain(this.store);
        if (!chainHas(chain, 'ptcDecide') || !chain) return undefined;
        return createPtcJevHooks(chain, signal);
      },
      emitTrace: (sessionId, event) => {
        void this.emitTrace(sessionId, event);
      },
      saveProgram: (sessionId, patch) => {
        this.mergeSessionMetadata(sessionId, patch);
      }
    });
    this.tools = [...toolsWithoutPtc, ptcExec];
    this.tools.push(
      ...createDynMetaTools({
        getStore: (context) => tryCreateDynToolStore(this.store) ?? undefined,
        settingsStore: this.store,
        getProcessTools: () => this.tools,
        getAuthorizedTools: (context) =>
          filterToolsForSession({
            env: process.env,
            tools: toolsWithoutPtc,
            agent: context.agent,
            session: context.session,
            settingsStore: this.store
          }).tools,
        spawnSubagent: (context, spec, signal) =>
          toolServices.spawnSubagent(context, spec.task, spec.role ?? spec.agent, {
            allowedTools: spec.allowed_tools,
            model: spec.model,
            signal,
            summaryMaxChars: spec.summaryMaxChars
          }),
        createScratchPersist: (context) => createStoreScratchPersist(this.store, context.session.id),
        goalSettingsStore: this.store,
        emitTrace: (sessionId, event) => {
          void this.emitTrace(sessionId, event as Omit<TraceEvent, 'ts' | 'sessionId'>);
        }
      })
    );
    this.tools.push(
      createSkillProposeTool({
        settingsStore: this.store,
        getStateDir: () => this.stateDir,
        listSkills: () => this.promptBuilder.allSkills(),
        emitTrace: (sessionId, event) => {
          void this.emitTrace(sessionId, event as Omit<TraceEvent, 'ts' | 'sessionId'>);
        }
      })
    );
    this.mcpManager = new McpManager({ stateDir: this.stateDir, tools: this.tools, env: process.env, log: this.log });
    this.connectors.setMcpInvoker(async (name, args, ctx) => {
      await this.mcpManager.ensureLoaded(ctx.session.id);
      const tool = this.tools.find((candidate) => candidate.name === name && (name === 'mcp_invoke' || name.startsWith('mcp_')));
      if (!tool) return { ok: false, content: 'MCP tool is unavailable: ' + name };
      return tool.execute(ctx, args);
    });
    this.rooms = new BotRoomService({ store: this.store,
      createChatSession: (input) => this.createChatSession(input),
      runSession: (id, options) => this.runSession(id, options), cancelSession: (id) => this.cancelSession(id),
      isSessionRunning: (id) => this.runningSessions.has(id),
      hasUnconfirmedEffects: (id, since) => this.hasUnconfirmedEffects(id, since) });
    this.computerUse = new LcuComputerUseProvider({
      clientFactory: options.computerUseClientFactory,
      enabled: () => readLcuSettings(this.store).enabled,
      command: () => readLcuSettings(this.store).command,
      saveImage: async (sessionId, image) => {
        if (!image.data || !image.mimeType) throw new Error('LCU returned an incomplete image');
        const asset = await this.ingestImageBase64(sessionId, { dataBase64: image.data, mimeType: image.mimeType });
        return { type: 'image', assetId: asset.id, mimeType: asset.mimeType, alt: 'LCU desktop observation' };
      },
      requestApproval: createLcuApprovalHandler(this.store),
    });
    this.tools.push(...createAppControlTools({
      enabled: () => readAppControlSettings(this.store).enabled,
      approvals: this.store
    }));
  }

  /** Tick due cron jobs: append prompt to owning session and enqueue a run. */
  async tickCronJobs(): Promise<number> {
    return tickCronJobsFn(schedulerFrom(this.l5()));
  }

  private sessionControlHost() {
    return {
      store: this.store,
      sessionAbortControllers: this.sessionAbortControllers,
      backgroundJobAborts: this.backgroundJobAborts,
      emitTrace: (id: string, event: Omit<TraceEvent, 'ts' | 'sessionId'>) => this.emitTrace(id, event)
    };
  }

  /** Abort in-flight model/tool work for a session (best-effort). Closes any open tool wave. */
  isSessionRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId);
  }

  hasUnconfirmedEffects(sessionId: string, startedAt: string): boolean {
    return this.connectors.software.unconfirmedForSession(sessionId, startedAt).length > 0;
  }

  cancelSession(sessionId: string): void {
    blockHumanContinuations(this.store, sessionId);
    cancelSessionFn(this.sessionControlHost(), sessionId);
  }

  /**
   * Abort every live session and every background job.
   * When `allowedSessionIds` is set, only those sessions (and their jobs) stop.
   * Does not close the database or tear down MCP.
   */
  cancelAllSessions(allowedSessionIds?: ReadonlySet<string>): { sessionIds: string[] } {
    return cancelAllSessionsFn(this.sessionControlHost(), allowedSessionIds);
  }

  listAgents(): AgentSpec[] {
    return this.store.listAgents();
  }

  /**
   * Upsert 当前包内的内置 Agent 列表（幂等）。升级后若 SQLite 里缺新 id，调一次即可补齐；
   * daemon 在 GET /api/agents 前会调用，避免只编了 apps/daemon、未重编 core 时长期缺条目。
   */
  ensureBuiltinAgentsSynced(): void {
    for (const agent of builtinAgents) {
      this.store.upsertAgent(agent);
    }
  }

  /** Re-scan repo skills/ 与 ~/.agents 下的 SKILL.md（合并；同名时 ~/.agents 覆盖）。 */
  reloadWorkspaceSkills(): Promise<SkillSpec[]> {
    this.promptBuilder.invalidateSkillsCache();
    this.filePolicyCache = null;
    return this.promptBuilder.allSkills();
  }

  /** 列出当前加载的所有技能（用于 HTTP /api/skills 展示）。 */
  listSkills(): Promise<SkillSpec[]> {
    return this.promptBuilder.allSkills();
  }

  /**
   * Process-local monotonic version of mutable state. Daemon emits this as
   * `ETag: W/"<n>"` on poll-friendly list endpoints so the web-console can
   * short-circuit unchanged refreshes with HTTP 304.
   */
  getStateVersion(): number {
    return this.store.stateVersion;
  }

  listSessions(): SessionRecord[] {
    return this.store.listSessions();
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.store.getSession(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    try {
      this.cancelSession(sessionId);
    } catch {
      /* idle / already gone */
    }
    return this.store.deleteSession(sessionId);
  }

  deleteSessions(sessionIds: string[]): { deleted: string[]; missing: string[] } {
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const id of sessionIds) {
      if (this.deleteSession(id)) deleted.push(id);
      else missing.push(id);
    }
    return { deleted, missing };
  }

  getSessionMessages(sessionId: string): SessionMessage[] {
    return this.store.listMessages(sessionId);
  }

  /** Stored prepared views, oldest first. Read-only. */
  listContextSnapshots(sessionId: string): ContextSnapshot[] {
    const session = this.store.getSession(sessionId);
    if (!session) throw new NotFoundError('Session', sessionId);
    flushPreparedContextSnapshots(this.store, sessionId);
    return this.store.listContextSnapshots(sessionId);
  }

  /** Read-only prepared model context. Does not compact, claim inbox, or persist a summary. */
  previewContextStack(sessionId: string) {
    return previewSessionContextStack(
      {
        store: this.store,
        repoRoot: this.repoRoot,
        stateDir: this.stateDir,
        tools: this.tools,
        promptBuilder: this.promptBuilder,
        modelAdapter: this.modelAdapter,
        turnShapeBySession: this.turnShapeBySession,
        syncConnectorTools: () => this.syncConnectorTools(),
        env: process.env
      },
      sessionId
    );
  }

  /** Shallow-merge keys into session.metadata (daemon PATCH / UI toggles). */
  mergeSessionMetadata(sessionId: string, patch: Record<string, unknown>): SessionRecord {
    return mergeSessionMetadataFn(this.store, sessionId, patch);
  }

  /** Current effective permission mode for a session. */
  getPermissionMode(sessionId: string): PermissionMode {
    return getPermissionModeFn(this.store, sessionId);
  }

  /**
   * Set or shift session permissionMode (Lab temporary elevate/demote).
   * Returns previous + next mode with human-readable descriptions.
   */
  setPermissionMode(
    sessionId: string,
    input: { mode?: PermissionMode | string; shift?: 'elevate' | 'demote' }
  ): {
    sessionId: string;
    previous: PermissionMode;
    mode: PermissionMode;
    description: string;
  } {
    return setPermissionModeFn(this.store, sessionId, input);
  }

  registerKernelHooks(listener: KernelHookListener): () => void {
    return subscribeKernelHooks(this.hooks, listener);
  }

  registerExtension(ext: ExtensionSpec): void {
    this.extensionRegistry.register(ext);
  }

  listExtensions(): Array<{ id: string; name?: string; phases: string[] }> {
    return this.extensionRegistry.list();
  }

  runDoctorCheck(): DoctorReport {
    return runDoctor({
      repoRoot: this.repoRoot,
      stateDir: this.stateDir,
      store: this.store,
      secretVault: this.secretVault
    });
  }

  /** GET /health only — never POST /exec. */
  async runDoctorCheckAsync(): Promise<DoctorReport> {
    const cf = resolveCloudflareComputer(this.store, process.env, this.secretVault);
    const tok = resolveCloudflareComputerToken(cf, this.secretVault, process.env);
    const cloudflareProbe = cf.endpoint
      ? await probeCloudflareComputerHealth({
          endpoint: cf.endpoint,
          token: tok.token,
          timeoutMs: 800
        })
      : undefined;
    return runDoctor({
      repoRoot: this.repoRoot,
      stateDir: this.stateDir,
      store: this.store,
      secretVault: this.secretVault,
      cloudflareProbe
    });
  }

  formatDoctorCheck(): string {
    return formatDoctorReport(this.runDoctorCheck());
  }

  listTasks(status?: TaskRecord['status']): TaskRecord[] {
    return this.store.listTasks(status ? { status } : undefined);
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.store.getTask(taskId);
  }

  listSocialPostScheduleSummaries(): ApiSocialPostScheduleItem[] {
    return this.socialSchedule.list();
  }

  applySocialPostScheduleAction(taskId: string, action: SocialScheduleAction): TaskRecord {
    return this.socialSchedule.applyAction(taskId, action);
  }

  async dispatchSocialPostScheduleNow(taskId: string, deliver: SocialPostDeliverFn): Promise<TaskRecord> {
    return this.socialSchedule.dispatchNow(taskId, deliver);
  }

  getTaskEvents(taskId: string) {
    return this.store.listEvents(taskId);
  }

  listApprovals(status?: ApprovalRecord['status']): ApprovalRecord[] {
    return this.store.listApprovals(status ? { status } : undefined);
  }

  listWorkspaces() {
    return this.store.listWorkspaces();
  }

  listBackgroundJobs(sessionId?: string) {
    return this.store.listBackgroundJobs(sessionId);
  }

  listMailbox(agentId: string, onlyPending = false): MailRecord[] {
    return this.store.listMailbox(agentId, onlyPending);
  }

  listAllMailbox(limit?: number): MailRecord[] {
    return this.store.listAllMailbox({ limit });
  }

  /** Pending inter-agent mail grouped by recipient agent id (dashboards / team-overview). */
  countPendingMailboxByRecipient(): { total: number; byRecipientAgentId: Record<string, number> } {
    return this.store.countPendingMailboxByRecipient();
  }

  async listTraceEvents(sessionId: string, limit?: number): Promise<TraceEvent[]> {
    return readSessionTraceEvents(this.stateDir, sessionId, limit ?? 500);
  }

  createChatSession(input: {
    title?: string;
    message?: string;
    imageAssetIds?: string[];
    attachmentIds?: string[];
    agentId?: string;
    background?: boolean;
    metadata?: Record<string, unknown>;
  }): SessionRecord {
    const session = createChatSessionFn(sessionFacadeFrom(this.l5()), {
      ...input,
      message: undefined,
      imageAssetIds: undefined
    });
    const extra = this.attachmentIngest.expandForMessage(session.id, input.attachmentIds);
    const imageAssetIds = [...(input.imageAssetIds ?? []), ...extra.imageAssetIds];
    const text = [input.message, ...extra.textParts].filter((s) => String(s ?? '').trim()).join('\n\n');
    if (text || imageAssetIds.length > 0) {
      return sendUserMessageFn(sessionFacadeFrom(this.l5()), session.id, text || '(attachment)', {
        imageAssetIds
      });
    }
    return session;
  }

  createTaskSession(input: {
    title: string;
    description?: string;
    message?: string;
    imageAssetIds?: string[];
    attachmentIds?: string[];
    agentId?: string;
    blockedBy?: string[];
    background?: boolean;
    metadata?: Record<string, unknown>;
  }): { task: TaskRecord; session: SessionRecord } {
    const hasAtt = Boolean(input.attachmentIds?.length);
    const result = createTaskSessionFn(sessionFacadeFrom(this.l5()), {
      ...input,
      message: hasAtt ? undefined : input.message,
      imageAssetIds: hasAtt ? undefined : input.imageAssetIds
    });
    if (!hasAtt) return result;
    const extra = this.attachmentIngest.expandForMessage(result.session.id, input.attachmentIds);
    const imageAssetIds = [...(input.imageAssetIds ?? []), ...extra.imageAssetIds];
    const text = [input.message, ...extra.textParts].filter((s) => String(s ?? '').trim()).join('\n\n');
    if (text || imageAssetIds.length > 0) {
      sendUserMessageFn(sessionFacadeFrom(this.l5()), result.session.id, text || '(attachment)', {
        imageAssetIds
      });
    }
    return { task: result.task, session: this.store.getSession(result.session.id) ?? result.session };
  }

  createTeammateSession(input: {
    name: string;
    role: string;
    prompt: string;
    taskId?: string;
    parentSessionId?: string;
    background?: boolean;
    metadata?: Record<string, unknown>;
  }): SessionRecord {
    return createTeammateSessionFn(sessionFacadeFrom(this.l5()), input);
  }

  listBots(opts?: ListBotsOptions): BotRecord[] {
    return listBotsFn(this.store, opts);
  }

  getBot(id: string): BotRecord {
    return getBotFn(this.store, id);
  }

  createBot(input: CreateBotInput): BotRecord {
    return createBotFn(sessionFacadeFrom(this.l5()), input);
  }

  updateBot(
    id: string,
    patch: UpdateBotInput,
    opts?: { skillCatalog?: readonly { name: string }[] }
  ): BotRecord {
    return updateBotFn(sessionFacadeFrom(this.l5()), id, patch, {
      toolCatalog: this.tools,
      dynToolNames: patch.allowedTools !== undefined ? this.listBotDynToolNames(id) : undefined,
      skillCatalog: opts?.skillCatalog,
      modelOptions: pickerOptions(readModelCatalog(this.store), process.env)
    });
  }

  /** Stored policy warnings for a bot, checked against the live tool catalog and saved dynamic tools. */
  getBotPolicyWarnings(id: string): BotPolicyWarning[] {
    const bot = this.store.getBot(id);
    if (!bot) return [];
    const dyn = tryCreateDynToolStore(this.store);
    return botPolicyWarningsFn(this.store.getSession(bot.canonicalSessionId)?.metadata, {
      registeredToolNames: this.tools.map((tool) => tool.name),
      dynToolNames: dyn
        ? dyn
            .list({ sessionId: bot.canonicalSessionId })
            .filter((record) => record.status !== 'retired')
            .map((record) => record.name)
        : undefined
    });
  }

  private listBotDynToolNames(id: string): string[] {
    const bot = this.store.getBot(id);
    const dyn = tryCreateDynToolStore(this.store);
    if (!bot || !dyn) return [];
    return dyn.list({ sessionId: bot.canonicalSessionId }).map((record) => record.name);
  }

  openBot(id: string, opts?: { userId?: string; tenantId?: string }): OpenBotResult {
    return openBotFn(sessionFacadeFrom(this.l5()), id, opts);
  }

  /**
   * Forever-chat command on a Bot's canonical session.
   * Returns null when the text is not `/new`, `/stop`, or `/model`, or the session is not that chat.
   */
  handleBotChatCommand(sessionId: string, text: string): Promise<BotChatCommandResult | null> {
    return applyBotChatCommand(
      {
        getSession: (id) => this.getSession(id),
        appendSystemNote: (id, note) => {
          this.store.appendMessage(id, 'system', [{ type: 'text', text: note }]);
        },
        cancelSession: (id) => this.cancelSession(id),
        updateBot: (id, patch) => {
          this.updateBot(id, patch);
        },
        modelOptions: () =>
          pickerOptions(readModelCatalog(this.store), process.env).map((option) => ({
            providerId: option.providerId,
            modelId: option.modelId,
            source: option.source
          })),
        compactSession: (id) => this.compactCanonicalSession(id)
      },
      sessionId,
      text
    );
  }

  private async compactCanonicalSession(
    sessionId: string
  ): Promise<{ replaced?: { startSeq: number; endSeq: number } }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new NotFoundError('Session', sessionId);
    const agent = this.store.getAgent(session.agentId);
    if (!agent) throw new NotFoundError('Agent', session.agentId);
    return autoCompactSession(
      compactFrom(this.l5()),
      { repoRoot: this.repoRoot, stateDir: this.stateDir, session, agent },
      { force: true }
    );
  }

  findBotBySessionId(sessionId: string): BotRecord | undefined {
    return this.store.getBotByCanonicalSessionId(sessionId);
  }

  listCronJobs(filter?: ListCronJobsFilter): CronJobRecord[] {
    return listCronJobsFn(cronFacadeFrom(this.l5()), filter);
  }

  getCronJob(id: string): CronJobRecord {
    return getCronJobFn(cronFacadeFrom(this.l5()), id);
  }

  createCronJob(input: CreateCronJobInput): CronJobRecord {
    return createCronJobFn(cronFacadeFrom(this.l5()), input);
  }

  updateCronJob(id: string, patch: UpdateCronJobInput): CronJobRecord {
    return updateCronJobFn(cronFacadeFrom(this.l5()), id, patch);
  }

  deleteCronJob(id: string): void {
    deleteCronJobFn(cronFacadeFrom(this.l5()), id);
  }

  sendUserMessage(
    sessionId: string,
    message: string,
    options?: { imageAssetIds?: string[]; attachmentIds?: string[]; autoRun?: boolean; replyTo?: string }
  ): SessionRecord {
    const extra = this.attachmentIngest.expandForMessage(sessionId, options?.attachmentIds);
    const imageAssetIds = [...(options?.imageAssetIds ?? []), ...extra.imageAssetIds];
    const text = [message, ...extra.textParts].filter((s) => String(s).trim()).join('\n\n');
    const body = text || (imageAssetIds.length > 0 ? '(attachment)' : message);
    const append = () => {
      const session = sendUserMessageFn(sessionFacadeFrom(this.l5()), sessionId, body, { imageAssetIds, replyTo: options?.replyTo });
      if (options?.autoRun) requestHumanRun(this.store, sessionId);
      return session;
    };
    return options?.autoRun ? withHumanContinuationAdmission(this.store, sessionId, append) : append();
  }

  enqueueSteer(sessionId: string, text: string, opts?: EnqueueSteerOptions): SteerAck {
    const admit = () => {
      const ack = enqueueSteerFn(this.store, sessionId, text, opts);
      if (ack.status !== 'not_submitted' && opts?.steerMode !== 'subagent') requestSteerContinuation(this.store, sessionId, ack.item);
      return ack;
    };
    const session = this.store.getSession(sessionId);
    const policy = resolveSteerInterruptPolicy({ option: opts?.interruptPolicy, sessionMetadata: session?.metadata, store: this.store });
    const decision = decideSteerAdmission({ session, text, interruptPolicy: policy });
    const ack = opts?.steerMode === 'subagent' || !decision.admit
      ? admit()
      : withHumanContinuationAdmission(this.store, sessionId, admit);
    if (ack.status !== 'not_submitted' && opts?.steerMode === 'subagent') {
      this.startSteeringSubagent(sessionId, text, opts.subagentRole, ack.item.id);
      // SubAgent is a parallel child — do not also drain the same text as a parent steer.
      this.store.removeUnclaimedInbox(sessionId, ack.item.id);
    }
    if (ack.status !== 'not_submitted' && opts?.steerMode !== 'subagent') this.scheduleHumanContinuations();
    return ack;
  }

  updateSteerItem(sessionId: string, itemId: string, text: string) {
    const next = text.trim();
    if (!next) throw new ValidationError('Missing steer text');
    const item = this.store.updateUnclaimedInbox(sessionId, itemId, next);
    if (!item) throw new NotFoundError('Steer', itemId);
    requestSteerContinuation(this.store, sessionId, item);
    return item;
  }

  dropSteerItem(sessionId: string, itemId: string): boolean {
    const removed = this.store.removeUnclaimedInbox(sessionId, itemId);
    if (removed) dropHumanSteerContinuation(this.store, sessionId, itemId);
    return removed;
  }

  /** Spawn a queued inbox item as a steering subagent and drop it from the parent inbox. */
  promoteSteerToSubagent(sessionId: string, itemId: string, role?: string) {
    const item = this.store.getUnclaimedInbox(sessionId, itemId);
    if (!item) throw new NotFoundError('Steer', itemId);
    const spawned = this.startSteeringSubagent(sessionId, item.text, role, item.id);
    this.store.removeUnclaimedInbox(sessionId, itemId);
    dropHumanSteerContinuation(this.store, sessionId, itemId);
    return { spawned: true as const, childSessionId: spawned?.sessionId, item };
  }

  startSteeringSubagent(
    parentSessionId: string,
    prompt: string,
    role?: string,
    steerId?: string
  ): { sessionId: string } | undefined {
    const parent = this.store.getSession(parentSessionId);
    if (!parent) return undefined;
    const agentId = resolveSubagentAgentId(role, parent.agentId);
    const { child } = startSteeringSubagent({
      parent,
      prompt,
      steerId: steerId ?? createId('steer'),
      role,
      spawn: ({ parentSessionId: pid, prompt: childPrompt, role: childRole }) => {
        const childSession = this.store.createSession({
          title: `Steer: ${(childRole ?? role ?? 'subagent').slice(0, 40)}`,
          mode: 'subagent',
          agentId,
          taskId: parent.taskId,
          parentSessionId: pid,
          background: true,
          metadata: {
            parentSessionId: pid,
            subagentRole: childRole ?? role ?? parent.agentId,
            spawnSource: 'steering',
            ...inheritBotAllowlists(parent.metadata, {
              agentAllowedTools: this.store.getAgent(agentId)?.allowedTools
            }),
            ...inheritModelOverride(parent.metadata),
            ...inheritBotIdentityMetadata(parent, this.store)
          }
        });
        this.store.appendMessage(childSession.id, 'user', [textPart(childPrompt)]);
        const done = this.runSession(childSession.id).then(() => undefined);
        return { sessionId: childSession.id, done };
      }
    });
    this.mergeSessionMetadata(parentSessionId, mergeSteeringChild(parent.metadata ?? {}, child));
    return { sessionId: child.sessionId };
  }

  forkSession(sourceSessionId: string, opts?: { boundarySeq?: number; title?: string }) {
    return forkSession(this.store, {
      sourceSessionId,
      boundarySeq: opts?.boundarySeq,
      title: opts?.title
    });
  }

  createAgentLoop(
    sessionId: string,
    options?: { steerDrainPolicy?: SteerDrainPolicy }
  ): AgentLoopHandle {
    if (!this.store.getSession(sessionId)) {
      throw new NotFoundError('Session', sessionId);
    }
    return new AgentLoopHandle(
      {
        getSession: (id) => this.getSession(id),
        foldMessages: (id) => this.store.foldMessages(id),
        enqueueSteer: (id, text, opts) => this.enqueueSteer(id, text, opts),
        abortSession: (id) => this.cancelSession(id),
        startRun: (id, latch, opts) =>
          this.runSession(id, {
            onModelStreamChunk: opts?.onModelStreamChunk as ((chunk: ModelStreamChunk) => void) | undefined,
            latch,
            steerDrainPolicy: opts?.steerDrainPolicy
          })
      },
      sessionId,
      options
    );
  }

  /** Ingest base64 image bytes into session image store. */
  async ingestImageBase64(
    sessionId: string,
    input: { dataBase64: string; mimeType: string; sourceUrl?: string }
  ): Promise<ImageAssetRecord> {
    return this.imageIngest.ingestBase64(sessionId, input);
  }

  /** Download image from URL into session store (server-side fetch). */
  async ingestImageFromUrl(sessionId: string, imageUrl: string, signal?: AbortSignal): Promise<ImageAssetRecord> {
    return this.imageIngest.ingestFromUrl(sessionId, imageUrl, signal);
  }

  async ingestAttachmentBase64(
    sessionId: string,
    input: { dataBase64: string; mimeType?: string; fileName?: string }
  ): Promise<{ attachment: AttachmentRecord; imageAsset?: ImageAssetRecord; statuses: AttachmentStatus[] }> {
    return this.attachmentIngest.ingestBase64(sessionId, input);
  }

  async ingestAttachmentFromUrl(
    sessionId: string,
    input: { url: string; fileName?: string; mimeType?: string }
  ): Promise<{ attachment: AttachmentRecord; imageAsset?: ImageAssetRecord; statuses: AttachmentStatus[] }> {
    return this.attachmentIngest.ingestFromUrl(sessionId, input);
  }

  listSessionAttachments(sessionId: string): AttachmentRecord[] {
    return this.store.listAttachmentsForSession(sessionId);
  }

  listSessionArtifacts(sessionId: string): ArtifactIndexRecord[] {
    return this.store.listArtifactsForSession(sessionId);
  }

  getArtifactIndex(id: string): ArtifactIndexRecord | undefined {
    return this.store.getArtifactIndex(id);
  }

  sendMailboxMessage(input: {
    fromAgentId: string;
    toAgentId: string;
    content: string;
    type?: string;
    correlationId?: string;
    sessionId?: string;
    taskId?: string;
  }): MailRecord {
    return sendMailboxMessageFn(sessionFacadeFrom(this.l5()), input);
  }

  getLatestAssistantText(sessionId: string): string | undefined {
    return latestAssistantText(this.store, sessionId);
  }

  async approve(approvalId: string, decision: 'approved' | 'rejected'): Promise<ApprovalRecord> {
    const approval = this.store.getApproval(approvalId);
    if (decision === 'approved' && approval) {
      const expired = expireOverdueBotWork(this.botWorkRuntimeHost(), approval.sessionId);
      if (expired || isBotWorkSessionBlocked(this.store, approval.sessionId)) {
        throw new ValidationError('Delegated task stopped; verify its effects before retrying');
      }
    }
    return approveDecision(this.store, approvalId, decision, {
      emitTrace: (sessionId, event) => {
        this.emitTrace(sessionId, event as Omit<TraceEvent, 'ts' | 'sessionId'>);
      }
    });
  }

  /** Lab / daemon lifecycle traces (dyn-tool retire/promote, etc.). */
  emitTraceEvent(sessionId: string, event: Omit<TraceEvent, 'ts' | 'sessionId'>): void {
    this.emitTrace(sessionId, event);
  }

  async runScheduler(): Promise<void> {
    await tickBotWork(this.botWorkRuntimeHost());
    void this.rooms.tick().catch((error) => this.log.warn('Room scheduler failed', { error: String(error) }));
    await runSchedulerFn(schedulerFrom(this.l5()));
    await this.drainHumanContinuations();
  }

  private botWorkRuntimeHost(): BotWorkHost {
    return { store: this.store, runSession: (id: string) => this.runSession(id),
      isSessionRunning: (id) => this.runningSessions.has(id), cancelSession: (id) => this.cancelSession(id),
      hasUnconfirmedEffects: (id, since) => this.hasUnconfirmedEffects(id, since), log: this.log };
  }

  runResearchTask(taskId: string) {
    return new ResearchPipeline({
      store: this.store.research(),
      stateDir: this.stateDir,
      env: process.env
    }).runTask(taskId);
  }

  startSwarmRun(
    runId: string,
    seedTasks?: Array<{ title: string; description?: string; requiredRole?: string; blockedBy?: string[] }>
  ) {
    return this.swarmExecutor.startRun(
      runId,
      seedTasks?.map((t) => ({
        ...t,
        requiredRole: t.requiredRole as import('./swarm/types.js').SwarmRole | undefined
      }))
    );
  }

  createTeamPlan(input: { objective: string; sessionId?: string; tasks?: unknown }): Promise<{
    plan?: TeamPlan;
    error?: string;
  }> {
    return this.teamDagExecutor.createPlan(input);
  }

  decideTeamGate(
    planId: string,
    gateName: TeamGateName,
    passed: boolean,
    feedback?: string
  ): TeamPlan | null {
    return this.teamDagExecutor.decideGate(planId, gateName, passed, feedback);
  }

  listTeamMailbox(planId: string, limit?: number) {
    return this.teamDagExecutor.listMailbox(planId, limit);
  }

  startTeamPlan(planId: string): TeamPlan | null {
    return this.teamDagExecutor.start(planId);
  }

  resumeTeamPlan(planId: string): TeamPlan | null {
    return this.teamDagExecutor.resume(planId);
  }

  startSelfHealRun(policy?: Partial<SelfHealPolicy>): SelfHealRunRecord {
    return this.selfHeal.startRun(policy);
  }

  stopSelfHealRun(id: string): SelfHealRunRecord {
    return this.selfHeal.stopRun(id);
  }

  resumeSelfHealRun(id: string): SelfHealRunRecord {
    return this.selfHeal.resumeRun(id);
  }

  getSelfHealRun(id: string): SelfHealRunRecord | undefined {
    return this.selfHeal.getRun(id);
  }

  listSelfHealRuns(limit?: number): SelfHealRunRecord[] {
    return this.selfHeal.listRuns(limit);
  }

  listActiveSelfHealRuns(): SelfHealRunRecord[] {
    return this.selfHeal.listActiveRuns();
  }

  listSelfHealEvents(runId: string, limit?: number): SelfHealEventRecord[] {
    return this.selfHeal.listEvents(runId, limit);
  }

  getDaemonRestartRequest(): DaemonRestartRequest | undefined {
    return this.selfHeal.getDaemonRestartRequest();
  }

  acknowledgeDaemonRestart(): void {
    this.selfHeal.acknowledgeDaemonRestart();
  }

  /** Ensure task workspace exists; returns workspace root. */
  async bindWorkspaceForTask(taskId: string): Promise<string | undefined> {
    const task = this.store.getTask(taskId);
    if (!task?.sessionId) {
      return undefined;
    }
    const session = this.store.getSession(task.sessionId);
    if (!session) {
      return undefined;
    }
    return ensureWorkspaceRootFn(spawnFrom(this.l5()), session, task);
  }

  /** Subscribe to model chunks for a session. Safe to call before the run starts. */
  subscribeModelStream(sessionId: string, listener: (chunk: ModelStreamChunk) => void): () => void {
    const set = this.modelStreamListeners.get(sessionId) ?? new Set<(chunk: ModelStreamChunk) => void>();
    set.add(listener);
    this.modelStreamListeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.modelStreamListeners.delete(sessionId);
    };
  }

  /**
   * Settle when the in-flight run ends, or when the next run starts and then ends.
   * Does not start a run. Aborting `signal` stops waiting and leaves the run going.
   */
  waitForSessionRun(
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<SessionRecord | undefined> {
    const watch = (run: Promise<SessionRecord>) => this.observeSessionRun(run, opts?.signal);
    const existing = this.runningSessions.get(sessionId);
    if (existing) return watch(existing);
    const timeoutMs = opts?.timeoutMs ?? 20_000;
    return new Promise((resolve) => {
      let settled = false;
      const set = this.sessionRunWaiters.get(sessionId) ?? new Set<(run: Promise<SessionRecord>) => void>();
      this.sessionRunWaiters.set(sessionId, set);
      const stopWaiting = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        set.delete(onStart);
        if (set.size === 0) this.sessionRunWaiters.delete(sessionId);
      };
      const onStart = (run: Promise<SessionRecord>) => {
        stopWaiting();
        void watch(run).then(resolve);
      };
      const onAbort = () => {
        stopWaiting();
        resolve(undefined);
      };
      const timer = setTimeout(() => {
        stopWaiting();
        resolve(undefined);
      }, timeoutMs);
      set.add(onStart);
      if (opts?.signal?.aborted) {
        onAbort();
        return;
      }
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      const again = this.runningSessions.get(sessionId);
      if (again) onStart(again);
    });
  }

  private observeSessionRun(
    run: Promise<SessionRecord>,
    signal?: AbortSignal
  ): Promise<SessionRecord | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onAbort = () => resolve(undefined);
      signal?.addEventListener('abort', onAbort, { once: true });
      run.then(
        (record) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(signal?.aborted ? undefined : record);
        },
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(undefined);
        }
      );
    });
  }

  private notifySessionRunStarted(sessionId: string, run: Promise<SessionRecord>): void {
    const waiters = this.sessionRunWaiters.get(sessionId);
    if (!waiters || waiters.size === 0) return;
    for (const waiter of [...waiters]) waiter(run);
  }

  private deliverModelStreamChunk(
    sessionId: string,
    chunk: ModelStreamChunk,
    direct?: (chunk: ModelStreamChunk) => void
  ): void {
    direct?.(chunk);
    const listeners = this.modelStreamListeners.get(sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(chunk);
      } catch (error) {
        this.log.warn('model stream listener failed', { sessionId, error: String(error) });
      }
    }
  }

  private forkConcurrentBotWork(session: SessionRecord | undefined, inFlight: boolean): void {
    if (!session || session.mode !== 'chat' || session.metadata?.canonicalBotChat !== true) return;
    try {
      applyConcurrentBotForks(
        {
          store: this.store,
          runSession: (id) => this.runSession(id),
          log: this.log
        },
        session.id,
        inFlight
      );
    } catch (error) {
      this.log.warn('Concurrent bot fork failed', { sessionId: session.id, error: String(error) });
    }
  }

  /** Explicit human run request; subsystem runs keep their own original result promise. */
  runHumanSession(sessionId: string, options?: Parameters<RawAgentRuntime['runSession']>[1]): Promise<SessionRecord> {
    requestHumanRun(this.store, sessionId);
    return this.runSession(sessionId, options);
  }

  private drainHumanContinuations(): Promise<void> {
    return drainHumanContinuations({ store: this.store, runSession: (id) => this.runSession(id),
      isSessionRunning: (id) => this.runningSessions.has(id),
      hasUnconfirmedEffects: (id) => this.hasUnconfirmedEffects(id, '1970-01-01T00:00:00.000Z'), log: this.log });
  }

  private scheduleHumanContinuations(): void {
    setImmediate(() => { if (!this.store.db.isOpen) return; void this.drainHumanContinuations().catch(error => this.log.warn('Human continuation scheduler failed', { error: String(error) })); });
  }

  async runSession(
    sessionId: string,
    options?: {
      onModelStreamChunk?: (chunk: ModelStreamChunk) => void;
      latch?: AgentLoopLatch;
      steerDrainPolicy?: SteerDrainPolicy;
      hooks?: KernelHookRegistry;
      onEvent?: KernelHookListener;
      /**
       * Cancels the run (same as `cancelSession`) when aborted, e.g. the SSE client
       * went away. Ignored when the call joins a run that is already in flight.
       */
      signal?: AbortSignal;
    }
  ): Promise<SessionRecord> {
    expireOverdueBotWork(this.botWorkRuntimeHost(), sessionId);
    if (isBotWorkSessionBlocked(this.store, sessionId)) {
      const stopped = this.store.getSession(sessionId);
      if (!stopped) throw new NotFoundError('Session', sessionId);
      return stopped;
    }
    const parked = this.store.getSession(sessionId);
    if (typeof parked?.metadata?.roomId === 'string') {
      this.rooms.prepareSession(sessionId);
    }
    if (typeof parked?.metadata?.roomId === 'string' && !options?.onEvent) {
      const budgetHook = this.rooms.budgetHookForSession(sessionId);
      if (budgetHook) options = { ...options, onEvent: budgetHook };
    }
    if (parked?.mode === 'subagent' && parked.status === 'unknown') {
      return parked;
    }
    const existing = this.runningSessions.get(sessionId);
    if (existing && !options?.latch) {
      this.forkConcurrentBotWork(parked, true);
      const late = options?.onModelStreamChunk;
      if (late) {
        const detach = this.subscribeModelStream(sessionId, late);
        void existing.finally(() => detach());
      }
      return existing;
    }
    if (existing && options?.latch) {
      await existing.catch(() => undefined);
    }
    this.forkConcurrentBotWork(parked, false);
    const observeHuman = createHumanContinuationObserver(this.store, sessionId);
    const callerEvent = options?.onEvent;
    options = { ...options, onEvent: async event => { await observeHuman(event); await callerEvent?.(event); } };
    const directChunk = options?.onModelStreamChunk;
    if (directChunk || (this.modelStreamListeners.get(sessionId)?.size ?? 0) > 0) {
      options = {
        ...options,
        onModelStreamChunk: (chunk) => this.deliverModelStreamChunk(sessionId, chunk, directChunk)
      };
    }
    const { signal: callerSignal, ...runOptions } = options ?? {};
    expireDueUnattendedApprovals(this.store);

    // Kernel selection: `loop_settings.kernelVariant` (Lab UI). Default is
    // `@ppeng/agent-loop` (`agent-loop`). Explicit `ppeng` keeps the local
    // packages/core kernel as a reference path.
    const loopKv = this.store.getDaemonControl<{
      kernelVariant?: string;
      assemblyPreset?: string;
    }>('loop_settings');
    const kernelVariant = loopKv?.kernelVariant ?? 'agent-loop';
    const assemblyPreset: LoopPreset = parseLoopPreset(loopKv?.assemblyPreset) ?? 'max';
    this.log.info(`runSession kernel=${kernelVariant} assembly=${assemblyPreset}`);
    this.sessionAbortControllers.set(sessionId, new AbortController());
    const unlinkCallerSignal = this.cancelOnAbort(sessionId, callerSignal);
    const coreHost = bindTurnKernelHost(this.l5());
    const sessionMaxTurns = resolveSessionMaxTurns(
      this.store.getSession(sessionId)?.metadata,
      this.maxTurnsPerRun
    );
    const hooks = mergeKernelHookRegistries(this.hooks, options?.hooks);
    const agentLoopOptions = {
      ...runOptions,
      hooks,
      onEvent: options?.onEvent,
      config: {
        ...coreHost.loopConfig,
        maxTurns: sessionMaxTurns
      }
    };
    const ppengOptions = {
      ...runOptions,
      latch: fanoutKernelLatch(options?.latch, hooks, options?.onEvent) as AgentLoopLatch
    };
    const promise = runWithJevTrace(
      {
        sessionId,
        emit: (event) => this.emitTrace(sessionId, event)
      },
      () =>
        (async () => {
          try {
            await this.computerUse.beginTurn(sessionId, randomUUID());
            for (const tool of this.computerUse.tools()) {
              const index = this.tools.findIndex(item => item.name === tool.name);
              if (index >= 0) this.tools[index] = tool; else this.tools.push(tool);
            }
            return await (kernelVariant === 'ppeng'
          ? runSessionKernelPpeng(coreHost, sessionId, ppengOptions)
          : createAssembledLoop({
              preset: assemblyPreset,
              io: l5ToAssembledIo(this.l5(), sessionId),
              hooks,
              config: coreHost.loopConfig
            }).then((assembled) => assembled.run(sessionId, agentLoopOptions)));
          } finally {
            await this.computerUse.endTurn(sessionId, this.sessionAbortControllers.get(sessionId)?.signal.aborted ? 'Interrupt' : 'Stop');
          }
        })()
    )
      .catch((err: unknown) => {
        if (err instanceof NotFoundError) throw err;
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'NotFoundError') {
          const msg = err instanceof Error ? err.message : String(err);
          if (/Agent not found/i.test(msg)) {
            throw new NotFoundError('Agent', sessionId);
          }
          throw new NotFoundError('Session', sessionId);
        }
        throw err;
      })
      .finally(() => {
      unlinkCallerSignal();
      this.runningSessions.delete(sessionId);
      clearActiveWorkPiece(sessionId);
      releaseHumanModelInput(this.store, sessionId);
      this.scheduleHumanContinuations();
    });
    this.runningSessions.set(sessionId, promise);
    this.notifySessionRunStarted(sessionId, promise);
    return promise;
  }

  /** Cancel `sessionId` when `signal` aborts; returns the unlink function. */
  private cancelOnAbort(sessionId: string, signal: AbortSignal | undefined): () => void {
    if (!signal) return () => undefined;
    const cancel = () => this.cancelSession(sessionId);
    if (signal.aborted) {
      cancel();
      return () => undefined;
    }
    signal.addEventListener('abort', cancel, { once: true });
    return () => signal.removeEventListener('abort', cancel);
  }

  /** Open configured HTTP MCP sessions. Safe to call before the first turn; does not throw. */
  warmMcp(): Promise<void> {
    return this.mcpManager.warmHttp();
  }

  mcpHttpConnectedCount(): number {
    return this.mcpManager.httpConnectedCount();
  }

  /** Gracefully shut down all in-flight work, MCP sessions, and release SQLite. */
  async destroy(): Promise<void> {
    await this.computerUse.close();
    // Writes still queued must land before the store closes, or replay loses them.
    flushPreparedContextSnapshots(this.store);
    await destroyRuntime({
      sessionAbortControllers: this.sessionAbortControllers,
      backgroundJobAborts: this.backgroundJobAborts,
      mcpManager: this.mcpManager,
      store: this.store
    });
  }

  /** Trace JSONL on disk; optional PG fan-out when `EVENT_BUFFER_PROVIDER=redis_postgres`. */
  private emitTrace(sessionId: string, rawEvent: Omit<TraceEvent, 'ts' | 'sessionId'>): void {
    const event = attachServedByToTrace(sessionId, rawEvent);
    void appendTraceEvent(this.stateDir, sessionId, event, this.traceCloudOptions);
    void mirrorTraceToLangfuse(this.store, sessionId, event);
  }

  private async mergedFilePolicy(): Promise<FileApprovalPolicy | undefined> {
    if (this.filePolicyCache === null) {
      const file = await loadPolicyFromRepo(this.repoRoot);
      this.filePolicyCache = mergeApprovalPolicies(file, this.envApprovalPolicy) ?? undefined;
    }
    return this.filePolicyCache;
  }

  /** Put granted plugin tools on the shared catalog. Domain tools stay mounted. */
  syncConnectorTools(): void {
    this.connectorToolNames = mergeGrantedConnectorTools(
      this.tools,
      this.connectors.toolsForGranted(process.env),
      this.connectorToolNames
    );
  }

  private l5(): L5Bindable {
    return {
      store: this.store,
      repoRoot: this.repoRoot,
      stateDir: this.stateDir,
      tools: this.tools,
      syncConnectorTools: () => this.syncConnectorTools(),
      filterSoftwareTools: (tools, session) => this.connectors.software.filterForSession(tools, session),
      hasUnconfirmedEffects: (id, since) => this.hasUnconfirmedEffects(id, since),
      isSessionRunning: (id) => this.runningSessions.has(id),
      modelAdapter: this.modelAdapter,
      promptBuilder: this.promptBuilder,
      mcpManager: this.mcpManager,
      extensionRegistry: this.extensionRegistry,
      maxTurnsPerRun: this.maxTurnsPerRun,
      maxParallelToolCalls: this.maxParallelToolCalls,
      envApprovalPolicy: this.envApprovalPolicy,
      turnShapeBySession: this.turnShapeBySession,
      cumulativeInputTokensBySession: this.cumulativeInputTokensBySession,
      sessionAbortControllers: this.sessionAbortControllers,
      workspaceManager: this.workspaceManager,
      sandbox: this.sandbox,
      setSandbox: (sandbox) => {
        this.sandbox = sandbox;
      },
      backgroundJobAborts: this.backgroundJobAborts,
      cronStore: this.cronStore,
      setCronStore: (store) => {
        this.cronStore = store;
      },
      selfHeal: this.selfHeal,
      swarmExecutor: this.swarmExecutor,
      teamDagExecutor: this.teamDagExecutor,
      orchestrationEngine: this.orchestrationEngine,
      autonomousScheduler: this.autonomousScheduler,
      imageIngest: this.imageIngest,
      log: this.log,
      emitTrace: (sessionId, event) => this.emitTrace(sessionId, event),
      mergeSessionMetadata: (sessionId, patch) => this.mergeSessionMetadata(sessionId, patch),
      mergedFilePolicy: () => this.mergedFilePolicy(),
      runSession: (sessionId) => this.runSession(sessionId),
      cancelSession: (sessionId) => this.cancelSession(sessionId),
      hooks: this.hooks
    };
  }
}
