/**
 * L3 kernel host: L5 RawAgentRuntime is one implementation.
 * Kernel must not import daemon or web-console.
 */

import type { FileApprovalPolicy } from '../approval/policy-loader.js';
import type { ExtensionRegistry } from '../extensions/extension-registry.js';
import type { PromptContext } from '../model/prompt-builder.js';
import type { AgentLoopLatch, AgentStepEvent } from '../runtime/agent-loop.js';
import type { ToolExecResult } from '../runtime/tool-loop.js';
import type { SessionSurfaceStore } from '../session/surface-store.js';
import type { CloudFolderStore } from '../workspace/cloud-store.js';
import type { ProjectStore } from '../workspace/project-store.js';
import type { KernelHookRegistry, LoopConfig, RunProfile } from '@ppeng/agent-loop';
import type { SteerDrainPolicy } from '../session/steer-drain.js';
import type { TraceEvent } from '../stores/trace.js';
import type {
  AgentSpec,
  ApprovalRecord,
  ImageAssetRecord,
  MessagePart,
  ModelAdapter,
  ModelStreamChunk,
  ModelTurnInput,
  ModelTurnResult,
  RunContext,
  SessionMessage,
  SessionRecord,
  TaskRecord,
  ToolContract
} from '../types.js';

export type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

export interface TurnKernelStore extends SessionSurfaceStore {
  getAgent(id: string): AgentSpec | undefined;
  getTask(id: string): TaskRecord | undefined;
  updateSession(
    id: string,
    patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>
  ): SessionRecord;
  getImageAsset(id: string): ImageAssetRecord | undefined;
  claimWriter(sessionId: string, runId: string): void;
  releaseWriter(sessionId: string, runId: string): void;
  /** Scope all async persistence to this execution generation (Node hosts may use ALS). */
  runWithWriter?<T>(sessionId: string, runId: string, fn: () => Promise<T>): Promise<T>;
  isWriterCurrent?(sessionId: string, runId: string): boolean;
  listApprovals(filter?: { status?: ApprovalRecord['status'] }): ApprovalRecord[];
  getDaemonControl?(key: string): unknown;
  projects?(): ProjectStore;
  cloudFolders?(): CloudFolderStore;
}

/**
 * Prompt surface the kernel actually calls. {@link PromptBuilder} satisfies
 * this; the L3 embed host supplies a sqlite-free stub (no evolving/goal).
 */
export interface TurnKernelPrompt {
  lastCognitivePhaseBySession: Map<string, { phase: string; confidence: number }>;
  getRouting(sessionId: string): {
    mode: string;
    confidence: { level: string };
    shortlistNames: string[];
    routed: Array<{ skill: { name: string } }>;
  } | undefined;
  buildMemoryAppendix(
    ctx: PromptContext,
    opts?: { query?: string; stateDir?: string }
  ): string | Promise<string>;
  buildStablePrefix(ctx: PromptContext): string;
  buildSystemPrompt(ctx: PromptContext, messages: SessionMessage[]): Promise<string>;
}

/**
 * Embed-only L3 entry: custom {@link SessionSurfaceStore} + model + tools.
 * Matches `doc/AGENT_LOOP_LAYERING_PLAN.md` §3.1 «只用 L3».
 */
export interface RunTurnKernelInput {
  store: SessionSurfaceStore;
  sessionId: string;
  model: ModelAdapter;
  tools?: ToolContract<any>[];
  latch?: AgentLoopLatch;
  agent?: AgentSpec;
  agents?: AgentSpec[];
  maxTurns?: number;
  systemPrompt?: string;
  repoRoot?: string;
  stateDir?: string;
  onModelStreamChunk?: (chunk: ModelStreamChunk) => void;
  steerDrainPolicy?: SteerDrainPolicy;
}

export interface TurnKernelHost {
  store: TurnKernelStore;
  repoRoot: string;
  stateDir: string;
  tools: ToolContract<any>[];
  /** Drop or add granted plugin connector tools before this turn's tool list is sealed. */
  syncConnectorTools?(): void;
  modelAdapter: ModelAdapter;
  /** Per-session adapter (Lab provider catalog). Falls back to `modelAdapter`. */
  resolveModelAdapter?(session: SessionRecord): ModelAdapter;
  promptBuilder: TurnKernelPrompt;
  mcpManager: { ensureLoaded(sessionId: string): Promise<void> };
  extensionRegistry: ExtensionRegistry;
  maxTurnsPerRun: number;
  turnShapeBySession: Map<string, { systemPromptChars: number; toolCount: number }>;
  cumulativeInputTokensBySession: Map<string, { cumulative: number; sticky: boolean }>;
  sessionAbortControllers: Map<string, AbortController>;

  emitTrace(sessionId: string, event: Omit<TraceEvent, 'ts' | 'sessionId'>): void;
  mergeSessionMetadata(sessionId: string, patch: Record<string, unknown>): SessionRecord;
  ensureWorkspaceRoot(session: SessionRecord, task?: TaskRecord): Promise<string | undefined>;
  ingestMailbox(session: SessionRecord): Promise<void>;
  autoClaimTask(session: SessionRecord): Promise<void>;
  mergedFilePolicy(): Promise<FileApprovalPolicy | undefined>;
  autoCompact(
    context: RunContext,
    opts?: { force?: boolean }
  ): Promise<{ replaced?: { startSeq: number; endSeq: number } }>;
  prepareMessagesForModel(session: SessionRecord, messages: SessionMessage[]): Promise<SessionMessage[]>;
  applyOptionalFoldBudget(session: SessionRecord, folded: SessionMessage[]): SessionMessage[];
  resolveImageDataUrl(assetId: string, sessionId: string): Promise<string | undefined>;
  runTurnWithRetries(
    input: ModelTurnInput & { signal?: AbortSignal },
    onStream?: (chunk: ModelStreamChunk) => void
  ): Promise<ModelTurnResult>;
  filterValidToolCalls(
    toolCalls: ToolCallPart[],
    allowExternalAiTools: boolean,
    sessionId: string,
    turnTools?: ToolContract<any>[]
  ): ToolCallPart[];
  checkToolApprovals(
    validToolCalls: ToolCallPart[],
    context: RunContext,
    filePolicy: FileApprovalPolicy | undefined,
    session: SessionRecord,
    turnTools?: ToolContract<any>[],
    closedByGate?: { reported: boolean; ids: string[] },
    settledApprovalIds?: readonly string[]
  ): 'waiting' | 'skip' | 'proceed' | Promise<'waiting' | 'skip' | 'proceed'>;
  executeToolCalls(
    validToolCalls: ToolCallPart[],
    context: RunContext,
    allowExternalAiTools: boolean,
    sessionId: string,
    turnTools?: ToolContract<any>[]
  ): Promise<ToolExecResult[]>;
  processToolResults(
    results: ToolExecResult[],
    validToolCalls: ToolCallPart[],
    session: SessionRecord,
    task: TaskRecord | undefined,
    sessionId: string,
    onModelStreamChunk?: (chunk: ModelStreamChunk) => void
  ): void;
  handleTurnCompletion(
    session: SessionRecord,
    agent: { id: string },
    task?: TaskRecord
  ): Promise<SessionRecord>;
  waitSteeringChildrenIdle?(sessionId: string): Promise<void>;

  /** Optional ports forwarded to `@ppeng/agent-loop` when kernelVariant=agent-loop. */
  resolveTurnTools?(input: {
    session: SessionRecord;
    agent: AgentSpec;
    messages: SessionMessage[];
    systemPromptChars: number;
  }):
    | {
        tools: ToolContract<any>[];
        allowExternalAiTools: boolean;
        promptCacheKey?: string;
        metadataPatch?: Record<string, unknown>;
        trace?: { kind: string; payload: Record<string, unknown> };
      }
    | Promise<{
        tools: ToolContract<any>[];
        allowExternalAiTools: boolean;
        promptCacheKey?: string;
        metadataPatch?: Record<string, unknown>;
        trace?: { kind: string; payload: Record<string, unknown> };
      }>;
  beforeModelTurn?(input: {
    session: SessionRecord;
    messages: SessionMessage[];
    hasPendingToolCalls: boolean;
  }): Promise<'proceed' | 'skip_goal_done' | null | undefined>;
  chooseRecovery?(input: {
    situation: string;
    options: ReadonlyArray<{ id: string; label: string }>;
    defaultId: string;
  }): Promise<string | null | undefined>;
  evaluateGoalGate?(input: {
    session: SessionRecord;
    agent: AgentSpec;
    signal?: AbortSignal;
    workspaceRoot?: string;
  }): Promise<{
    met: boolean;
    reason?: string;
    action?: 'continue' | 'close' | 'achieved';
    systemMessage?: string;
  }>;
  runLifecycleHook?(input: {
    phase: 'session_start' | 'before_turn' | 'stop' | 'subagent_stop';
    sessionId: string;
    agentId: string;
    turn?: number;
    meta?: Record<string, unknown>;
  }): Promise<{ block?: boolean; systemMessage?: string; message?: string }>;
  ensureMcpLoaded?(sessionId: string): Promise<void>;
  resolveFilePolicy?(): Promise<FileApprovalPolicy | undefined>;
  resolveWorkspaceRoots?(
    session: SessionRecord
  ): Promise<Array<{ alias: string; path: string; primary?: boolean }> | undefined>;
  shouldLatchBeforeTools?(input: {
    session: SessionRecord;
    toolCalls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>;
  }): 'proceed' | 'waiting' | 'steer' | Promise<'proceed' | 'waiting' | 'steer'>;
  recordToolUse?(input: {
    name: string;
    sessionId: string;
    turn: number;
    ok: boolean;
  }): void;
  noteGoalWaitingUser?(
    sessionId: string,
    toolCalls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>
  ): void;
  resolveTask?(session: SessionRecord): TaskRecord | undefined;
  applyFoldBudget?(session: SessionRecord, folded: SessionMessage[]): SessionMessage[];
  loopConfig?: LoopConfig;
  /** Env bag for RAW_AGENT_* recovery / risk thresholds (mirrors @ppeng/agent-loop host.env). */
  env?: Record<string, string | undefined>;
  /** Product hook registry; Runtime always supplies one so callers can listen. */
  hooks?: KernelHookRegistry;
  /** Session → RunProfile. A kernel calls this when present. */
  resolveRunProfile?(session: SessionRecord): RunProfile;
  stepTx?: {
    beginRun?(info: { sessionId: string; runId: string; reason?: string }): void | Promise<void>;
    endRun?(info: { sessionId: string; runId: string; reason?: string }): void | Promise<void>;
    beginStep?(info: {
      turn: number;
      step: number;
      kind: 'tools_done' | 'model_done';
      sessionId?: string;
    }): void | Promise<void>;
    commitStep?(info: {
      turn: number;
      step: number;
      kind: 'tools_done' | 'model_done';
      sessionId?: string;
    }): void | Promise<void>;
    rollbackUncommitted?(reason: string): void | Promise<void>;
  };
  latestClosedCheckpoint?(sessionId: string): { seq: number } | undefined;
  applyAutoFork?(input: {
    session: SessionRecord;
    trigger: 'repetition-aborted' | 'deadloop-exhausted';
    checkpointSeq?: number;
    guidance: string;
  }): Promise<{ applied: boolean } | void> | { applied: boolean } | void;

  injectEvolvingCoachBeforeRecovery(
    session: SessionRecord,
    agent: { id: string },
    trigger: string,
    reason: string
  ): Promise<void>;
  runCaseGovernance(): void;
  scheduleBackgroundCaseReview(input: {
    sessionId: string;
    agentId: string;
    outcome: 'success' | 'failure' | 'partial';
    signals?: Record<string, unknown>;
  }): void;
}

export type { AgentLoopLatch, AgentStepEvent };
