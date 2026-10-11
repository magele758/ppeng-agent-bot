/**
 * L5 runtime host façade: MCP / mailbox / approvals / scheduler / public API.
 * The session turn loop lives in `turn/kernel.ts` (`runSessionKernel`).
 */

import { join } from 'node:path';
import { createLogger } from './logger.js';
import { NotFoundError, ValidationError } from './errors.js';
import type { AgentSandbox } from './sandbox/agent-sandbox-types.js';
import { SelfHealScheduler } from './self-heal/self-heal-scheduler.js';
import { attachServedByToTrace } from './model/fallback-chain.js';
import { PromptBuilder } from './model/prompt-builder.js';
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
import type { AssetStorage, EventBufferRepository } from './storage/interfaces.js';
import { defaultTenantIdFromEnv, defaultUserIdFromEnv } from './storage/provider-config.js';
import { AgentLoopHandle, type AgentLoopLatch } from './runtime/agent-loop.js';
import type { EnqueueSteerOptions } from './session/step-inbox.js';
import type { SteerAck } from './session/steer-ack.js';
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
import { cancelSession as cancelSessionFn, destroyRuntime } from './runtime/session-control.js';
import { ensureWorkspaceRoot as ensureWorkspaceRootFn } from './runtime/spawn-host.js';
import { createRuntimeCollaborators } from './runtime/collaborators.js';
import {
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

    const discoveredPlugins = discoverPlugins(pluginDirsFromEnv(process.env));
    const mergedPlugins = mergePlugins(discoveredPlugins);
    for (const [k, v] of Object.entries(mergedPlugins.hookEnv)) {
      if (!process.env[k]?.trim()) process.env[k] = v;
    }

    this.promptBuilder = new PromptBuilder({
      store: this.store,
      repoRoot: this.repoRoot,
      stateDir: this.stateDir,
      extraSkills: [...(options.extraSkills ?? []), ...mergedPlugins.skills],
      cloudSkillsLoader: options.cloudSkillsLoader,
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
      ...baseTools,
      ...optionalExtras,
      messageAgentTool,
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
  }

  /** Tick due cron jobs: append prompt to owning session and enqueue a run. */
  async tickCronJobs(): Promise<number> {
    return tickCronJobsFn(schedulerFrom(this.l5()));
  }

  /** Abort in-flight model/tool work for a session (best-effort). Closes any open tool wave. */
  cancelSession(sessionId: string): void {
    cancelSessionFn({
      store: this.store,
      sessionAbortControllers: this.sessionAbortControllers,
      backgroundJobAborts: this.backgroundJobAborts,
      emitTrace: (id, event) => this.emitTrace(id, event)
    }, sessionId);
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
    options?: { imageAssetIds?: string[]; attachmentIds?: string[] }
  ): SessionRecord {
    const extra = this.attachmentIngest.expandForMessage(sessionId, options?.attachmentIds);
    const imageAssetIds = [...(options?.imageAssetIds ?? []), ...extra.imageAssetIds];
    const text = [message, ...extra.textParts].filter((s) => String(s).trim()).join('\n\n');
    const body = text || (imageAssetIds.length > 0 ? '(attachment)' : message);
    return sendUserMessageFn(sessionFacadeFrom(this.l5()), sessionId, body, {
      imageAssetIds
    });
  }

  enqueueSteer(sessionId: string, text: string, opts?: EnqueueSteerOptions): SteerAck {
    const ack = enqueueSteerFn(this.store, sessionId, text, opts);
    if (ack.status !== 'not_submitted' && opts?.steerMode === 'subagent') {
      this.startSteeringSubagent(sessionId, text, opts.subagentRole, ack.item.id);
      // SubAgent is a parallel child — do not also drain the same text as a parent steer.
      this.store.removeUnclaimedInbox(sessionId, ack.item.id);
    }
    return ack;
  }

  updateSteerItem(sessionId: string, itemId: string, text: string) {
    const next = text.trim();
    if (!next) throw new ValidationError('Missing steer text');
    const item = this.store.updateUnclaimedInbox(sessionId, itemId, next);
    if (!item) throw new NotFoundError('Steer', itemId);
    return item;
  }

  dropSteerItem(sessionId: string, itemId: string): boolean {
    return this.store.removeUnclaimedInbox(sessionId, itemId);
  }

  /** Spawn a queued inbox item as a steering subagent and drop it from the parent inbox. */
  promoteSteerToSubagent(sessionId: string, itemId: string, role?: string) {
    const item = this.store.getUnclaimedInbox(sessionId, itemId);
    if (!item) throw new NotFoundError('Steer', itemId);
    const spawned = this.startSteeringSubagent(sessionId, item.text, role, item.id);
    this.store.removeUnclaimedInbox(sessionId, itemId);
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
    await runSchedulerFn(schedulerFrom(this.l5()));
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
    const parked = this.store.getSession(sessionId);
    if (parked?.mode === 'subagent' && parked.status === 'unknown') {
      return parked;
    }
    const existing = this.runningSessions.get(sessionId);
    if (existing && !options?.latch) return existing;
    if (existing && options?.latch) {
      await existing.catch(() => undefined);
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
        (kernelVariant === 'ppeng'
          ? runSessionKernelPpeng(coreHost, sessionId, ppengOptions)
          : createAssembledLoop({
              preset: assemblyPreset,
              io: l5ToAssembledIo(this.l5()),
              hooks,
              config: coreHost.loopConfig
            }).then((assembled) => assembled.run(sessionId, agentLoopOptions)))
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
    });
    this.runningSessions.set(sessionId, promise);
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

  /** Gracefully shut down all in-flight work, MCP sessions, and release SQLite. */
  async destroy(): Promise<void> {
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

  private l5(): L5Bindable {
    return {
      store: this.store,
      repoRoot: this.repoRoot,
      stateDir: this.stateDir,
      tools: this.tools,
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
