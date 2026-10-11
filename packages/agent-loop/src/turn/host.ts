/**
 * L3: Turn Kernel Host interface — the port boundary between kernel and product.
 *
 * The kernel (turn/kernel.ts) depends on this interface only.
 * Products implement this interface to integrate their storage, model, prompt,
 * and tool infrastructure.
 */

import type {
  AgentSpec,
  ApprovalMode,
  MessagePart,
  MessageRole,
  ModelAdapter,
  ModelStreamChunk,
  ModelTurnInput,
  ModelTurnResult,
  RunContext,
  SessionMessage,
  SessionRecord,
  TaskRecord,
  ToolContract,
  ToolExecutionResult,
  TraceEvent,
} from '../types.js';
import type { RunProfile } from '../runtime/run-profile.js';
import type { FileApprovalPolicy } from '../runtime/tool-loop.js';
import type { LoopConfig } from './config.js';

// ============================================================================
// Minimum store interface the kernel requires
// ============================================================================

export interface TurnKernelStore {
  // Session CRUD
  getSession(id: string): SessionRecord | undefined;
  updateSession(id: string, patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>): SessionRecord;

  // Message WAL
  foldMessages(sessionId: string): SessionMessage[];
  appendMessage(
    sessionId: string,
    role: MessageRole,
    parts: MessagePart[],
    opts?: { key?: string }
  ): SessionMessage;
  appendReplacement(
    sessionId: string,
    input: {
      startSeq: number;
      endSeq: number;
      role: MessageRole;
      parts: MessagePart[];
      key?: string;
    }
  ): SessionMessage;

  // Agent lookup
  getAgent(id: string): AgentSpec | undefined;

  // Concurrent writer control (no-op stubs are valid for single-writer setups)
  claimWriter(sessionId: string, runId: string): void;
  releaseWriter(sessionId: string, runId: string): void;

  // Approval records
  listApprovals(filter?: { status?: 'pending' | 'approved' | 'rejected' }): Array<{
    id: string;
    sessionId: string;
    toolName: string;
    status: 'pending' | 'approved' | 'rejected';
    args: Record<string, unknown>;
    createdAt: string;
  }>;

  /**
   * Optional Lab/daemon KV. Kernel reads `loop_settings` for steer-drain
   * when the embedder persists it; omit for in-memory hosts.
   */
  getDaemonControl?(key: string): unknown;

  /**
   * Optional step-inbox. Required for steer-drain / next-run claim.
   * Omit and the kernel skips inbox claim (compatible with today's hosts).
   */
  claimInbox?(
    sessionId: string,
    target: 'next-step' | 'next-run'
  ): Array<{
    id: string;
    key?: string;
    role: 'user' | 'system';
    text: string;
  }>;
  hideByKey?(sessionId: string, key: string): number;
  /**
   * Hide a closed-checkpoint tail (`decideRewindTail`). Omit = skip WAL rewind.
   */
  hideRange?(
    sessionId: string,
    startSeq: number,
    endSeq: number,
    opts?: { expectedWriterRunId?: string }
  ): unknown;

  /** Optional task lookup so ensureWorkspaceRoot can bind an isolated root. */
  getTask?(id: string): TaskRecord | undefined;
}

// ============================================================================
// Prompt surface the kernel calls
// ============================================================================

export interface PromptContext {
  sessionId: string;
  agent: AgentSpec;
  session: SessionRecord;
  workspaceRoot?: string;
  repoRoot: string;
}

export interface TurnKernelPrompt {
  /** Build the complete system prompt for this turn. */
  buildSystemPrompt(ctx: PromptContext, messages: SessionMessage[]): Promise<string>;

  /**
   * Optional memory appendix injected at the end of the last user message.
   * Return empty string when memory is not available. May be async (host I/O).
   */
  buildMemoryAppendix(
    ctx: PromptContext,
    opts?: { query?: string; stateDir?: string }
  ): string | Promise<string>;
}

// ============================================================================
// Tool execution result (as returned from the kernel's executeToolCalls)
// ============================================================================

export interface ToolExecResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Agent Loop Step Events (L4 public API)
// ============================================================================

export type AgentStepEvent =
  | { type: 'turn_prepared'; messageCount?: number; messages?: SessionMessage[]; foldSeqs?: number[] }
  | {
      type: 'model_done';
      stopReason: string;
      finishReason?: string;
      truncated?: boolean;
      assistant?: { parts: MessagePart[] };
    }
  | { type: 'tools_done'; results: Array<{ ok: boolean; content: string; name?: string }> }
  | { type: 'waiting_approval'; approvalIds?: string[]; interrupt?: unknown }
  | { type: 'compacted'; replaced: { startSeq: number; endSeq: number } }
  | { type: 'ended'; reason: string; outcome?: unknown }
  | { type: 'abort' };

// ============================================================================
// Optional ports — omit and the kernel stays compatible with today's hosts
// ============================================================================

export type KernelStepKind = 'tools_done' | 'model_done';

export interface KernelStepInfo {
  turn: number;
  step: number;
  kind: KernelStepKind;
  sessionId?: string;
}

export interface KernelRunInfo {
  sessionId: string;
  runId: string;
  reason?: string;
}

/** Optional per-step transaction. Host implements persistence; kernel only calls. */
export interface KernelStepTx {
  beginRun?(info: KernelRunInfo): void | Promise<void>;
  endRun?(info: KernelRunInfo): void | Promise<void>;
  beginStep?(info: KernelStepInfo): void | Promise<void>;
  commitStep?(info: KernelStepInfo): void | Promise<void>;
  rollbackUncommitted?(reason: string): void | Promise<void>;
}

export type AutoForkTrigger = 'repetition-aborted' | 'deadloop-exhausted';

export interface AutoForkHostInput {
  session: SessionRecord;
  trigger: AutoForkTrigger;
  checkpointSeq?: number;
  guidance: string;
}

export type HitlLatchDecision = 'proceed' | 'waiting' | 'steer';

export interface CheckToolApprovalsExtras {
  filePolicy?: FileApprovalPolicy;
  turnTools?: ToolContract<any>[];
}

export interface ResolveTurnToolsResult {
  tools: ToolContract<any>[];
  allowExternalAiTools: boolean;
  promptCacheKey?: string;
  metadataPatch?: Record<string, unknown>;
  /** Extra tools hydrated for this turn only (dyn-tools / skills). */
  trace?: { kind: string; payload: Record<string, unknown> };
}

// ============================================================================
// Main host interface — implement this to integrate agent-loop into your product
// ============================================================================

export interface TurnKernelHost {
  // ── Storage & State ─────────────────────────────────────────────────────
  store: TurnKernelStore;
  repoRoot: string;
  stateDir: string;

  // ── Model ────────────────────────────────────────────────────────────────
  modelAdapter: ModelAdapter;
  /** Optional per-session adapter override (e.g. for user-configured models). */
  resolveModelAdapter?(session: SessionRecord): ModelAdapter;

  // ── Prompt ───────────────────────────────────────────────────────────────
  promptBuilder: TurnKernelPrompt;

  // ── Tools ────────────────────────────────────────────────────────────────
  tools: ToolContract<any>[];

  // ── Configuration ────────────────────────────────────────────────────────
  maxTurnsPerRun: number;
  /** Approximate token budget for the model context window. */
  maxContextTokens?: number;
  /** Loop knobs. Kernel prefers this over reading process.env. */
  loopConfig?: LoopConfig;
  /**
   * Environment bag for `RAW_AGENT_*` recovery / risk-engine thresholds
   * (SessionLoopGuard, AdvisoryGrace, RiskEngine). Kernel never reads
   * `process.env` directly; hosts pass it in (browser hosts omit it).
   */
  env?: Record<string, string | undefined>;
  /**
   * Epoch mixed into `promptCacheKey` (host-side cache bust, e.g. after compact).
   */
  promptCacheEpoch?: number | string;

  // ── Observability ────────────────────────────────────────────────────────
  emitTrace(sessionId: string, event: Omit<TraceEvent, 'timestamp'>): void;

  // ── Session Lifecycle ────────────────────────────────────────────────────
  mergeSessionMetadata(sessionId: string, patch: Record<string, unknown>): SessionRecord;

  /**
   * Run the model turn (with retries and optional stream).
   * Implement to add watchdogs, retry logic, or logging.
   */
  runTurnWithRetries(
    input: ModelTurnInput & { signal?: AbortSignal },
    onStream?: (chunk: ModelStreamChunk) => void
  ): Promise<ModelTurnResult>;

  /**
   * Execute tool calls in parallel with optional approval gating.
   * Return results in the same order as validToolCalls.
   */
  executeToolCalls(
    toolCalls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>,
    context: RunContext,
    allowExternalAiTools: boolean,
    sessionId: string,
    turnTools?: ToolContract<any>[]
  ): Promise<ToolExecResult[]>;

  /**
   * Prepare and compress messages before handing them to the model.
   * Omit and the kernel uses refusal + micro-compact.
   */
  prepareMessagesForModel?(
    session: SessionRecord,
    messages: SessionMessage[]
  ): Promise<SessionMessage[]>;

  /**
   * Auto-compact: summarize old history when token budget is exceeded.
   * Return { replaced } when compaction happened, {} otherwise.
   */
  autoCompact(
    context: RunContext,
    opts?: { force?: boolean }
  ): Promise<{ replaced?: { startSeq: number; endSeq: number } }>;

  /** Called after a session turn completes cleanly. */
  handleTurnCompletion(
    session: SessionRecord,
    agent: AgentSpec
  ): Promise<SessionRecord>;

  /**
   * Persist tool results into the session message store.
   * Must be called after executeToolCalls to make results visible to the model.
   */
  processToolResults(
    results: ToolExecResult[],
    validToolCalls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>,
    session: SessionRecord,
    task: unknown,
    sessionId: string,
    onModelStreamChunk?: (chunk: ModelStreamChunk) => void
  ): void;

  // ── Optional extensions (no-op stubs are valid) ──────────────────────────

  /**
   * Check tool approval policy. Return 'proceed' | 'skip' | 'waiting'.
   * May be async. The kernel awaits it. Jev is not part of this contract;
   * a host calls it only when its own optional chain is on.
   */
  checkToolApprovals?(
    toolCalls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>,
    context: RunContext,
    session: SessionRecord,
    extras?: CheckToolApprovalsExtras
  ): 'proceed' | 'skip' | 'waiting' | Promise<'proceed' | 'skip' | 'waiting'>;

  /** Resolve an image asset id to a data URL for vision turns. */
  resolveImageDataUrl?(assetId: string, sessionId: string): Promise<string | undefined>;

  /** Inbox / steer injection before each turn. */
  ingestMailbox?(session: SessionRecord): Promise<void>;

  /** Workspace root path resolution (for tool context). Pass task when known. */
  ensureWorkspaceRoot?(session: SessionRecord, task?: TaskRecord): Promise<string | undefined>;

  /** Look up the session task so isolated workspace roots are not empty. */
  resolveTask?(session: SessionRecord): TaskRecord | undefined;

  /** Claim the next scheduler task for this session. */
  autoClaimTask?(session: SessionRecord): Promise<void>;

  /**
   * Post-fold history budget. Omit and the kernel keeps the fold while it is
   * under the token budget; over budget it pins the system prompt and latest
   * user message and cuts on a closed tool wave.
   */
  applyFoldBudget?(session: SessionRecord, folded: SessionMessage[]): SessionMessage[];

  /** Dyn-tool / product usage accounting after a tool result. */
  recordToolUse?(input: {
    name: string;
    sessionId: string;
    turn: number;
    ok: boolean;
  }): void;

  /** Soft-goal waiting_user when the run parks for ask_user / approval. */
  noteGoalWaitingUser?(
    sessionId: string,
    toolCalls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>
  ): void;

  /**
   * Optional cumulative prompt-token state (long-lived daemons).
   * Omit and the kernel keeps a per-run map.
   */
  cumulativeInputTokensBySession?: Map<string, { cumulative: number; sticky: boolean }>;

  /** Per-session abort controllers map (for programmatic abort). */
  sessionAbortControllers?: Map<string, AbortController>;

  // ── Execution mode (RunProfile) — optional, defaults to 'auto' ───────────

  /**
   * Resolve the execution mode for this session. Products that expose a mode
   * picker (fast / planner / teams / deep_research / dynamic_workflow / ...)
   * implement this; embedders that want a single behaviour omit it and get
   * `resolveRunProfile()` defaults ('auto').
   *
   * The kernel uses this to shape the turn: fast mode skips plan protocol and
   * persistent memory, planner mode forces the plan tools, teams mode forces
   * TEAMS_TOOLS, dynamic_workflow enables PTC orchestration.
   */
  resolveRunProfile?(session: SessionRecord): RunProfile;

  /**
   * Per-turn tool resolution. The host owns agent allowlists, optional tool
   * groups, run-profile filtering and dynamic-tool hydration; the kernel calls
   * this once per turn with the already-built system prompt length.
   *
   * Omit it and the kernel uses `host.tools` verbatim.
   */
  resolveTurnTools?(input: {
    session: SessionRecord;
    agent: AgentSpec;
    messages: SessionMessage[];
    systemPromptChars: number;
  }): ResolveTurnToolsResult | Promise<ResolveTurnToolsResult>;

  /**
   * Optional pre-model gate. Return `skip_goal_done` to finish the turn as
   * goal-achieved without calling the deep model (no forged assistant text).
   * Mini hosts omit this.
   */
  beforeModelTurn?(input: {
    session: SessionRecord;
    messages: SessionMessage[];
    hasPendingToolCalls: boolean;
  }): Promise<'proceed' | 'skip_goal_done' | null | undefined>;

  /**
   * Optional discrete recovery picker. `options` are actions the kernel already
   * considers; return one of their ids or null to keep the hardcoded choice.
   * Mini hosts omit this.
   */
  chooseRecovery?(input: {
    situation: string;
    options: ReadonlyArray<{ id: string; label: string }>;
    defaultId: string;
  }): Promise<string | null | undefined>;

  // ── Optional lifecycle hooks ─────────────────────────────────────────────

  /**
   * Called once before turn 0 and before every turn. Products registered
   * extensions invoke them here; return `block: true` to abort the run.
   */
  runLifecycleHook?(input: {
    phase: 'session_start' | 'before_turn' | 'stop' | 'subagent_stop';
    sessionId: string;
    agentId: string;
    turn?: number;
    meta?: Record<string, unknown>;
  }): Promise<{ block?: boolean; systemMessage?: string; message?: string }>;

  /**
   * Soft goal-completion gate, evaluated when the model stops without tool
   * calls. Return `{ met: false }` to keep the loop running another turn.
   * Fail-open: rejections are treated as met.
   */
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

  /**
   * Injected before a recovery abort, so a product can add diagnostic context
   * (e.g. a self-evolving coach) instead of letting the turn die silently.
   */
  injectRecoveryCoach?(input: {
    session: SessionRecord;
    agent: AgentSpec;
    trigger: 'repetition' | 'tools' | 'turn_recovery';
    reason: string;
  }): Promise<void>;

  /**
   * Fire-and-forget session outcome notification (case logging, self-evolving
   * review queue). Never awaited by the kernel — must not throw.
   */
  onSessionOutcome?(input: {
    sessionId: string;
    agentId: string;
    outcome: 'success' | 'failure' | 'partial';
    signals?: Record<string, unknown>;
  }): void;

  /**
   * Block until steered child sessions finish before a soft completion.
   * Products without steering omit it.
   */
  waitSteeringChildrenIdle?(sessionId: string): Promise<void>;

  /**
   * Load MCP / remote tool catalogs before resolveTurnTools.
   * Omit when the embedder has no MCP client.
   */
  ensureMcpLoaded?(sessionId: string): Promise<void>;

  /**
   * File / path approval policy for this run. Kernel reads once and passes
   * the result into `checkToolApprovals` extras. Omit = no file policy.
   */
  resolveFilePolicy?(): Promise<FileApprovalPolicy | undefined> | FileApprovalPolicy | undefined;

  /**
   * Multi-root workspace resolution. Kernel copies the result onto
   * `RunContext.workspaceRoots` when present. Omit = single `ensureWorkspaceRoot`.
   */
  resolveWorkspaceRoots?(
    session: SessionRecord
  ): Promise<NonNullable<RunContext['workspaceRoots']> | undefined>;

  /**
   * Drop unknown / gated tool calls before approval + execute.
   * Omit and the kernel keeps the raw tool_call list.
   */
  filterValidToolCalls?(
    toolCalls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>,
    allowExternalAiTools: boolean,
    sessionId: string,
    turnTools?: ToolContract<any>[]
  ): Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>;

  /**
   * C-style pre-wave latch after `model_done`. Return `waiting` to park the
   * run, `steer` to close the open wave and skip execute. Omit = proceed.
   */
  shouldLatchBeforeTools?(input: {
    session: SessionRecord;
    toolCalls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>;
  }): HitlLatchDecision | Promise<HitlLatchDecision>;

  /**
   * Optional step transaction. Kernel calls begin/commit around model/tools
   * and rollbackUncommitted on abort / uncommitted failure. Host owns EventLog.
   */
  stepTx?: KernelStepTx;

  /**
   * Optional working-log tail (full+). Kernel injects it into the view copy
   * when `buildMemoryAppendix` is empty. Omit on mini — no `node:fs`.
   */
  readWorkingLogAppendix?(sessionId: string): string;

  /**
   * Latest closed checkpoint seq for auto-fork decisions. Decision stays in
   * the kernel; this only supplies the number.
   */
  latestClosedCheckpoint?(sessionId: string): { seq: number } | undefined;

  /**
   * Apply an auto-fork decision (rewind-in-place or spawn a sibling session).
   * Kernel never forks itself. Omit = skip auto-fork (compatible).
   */
  applyAutoFork?(
    input: AutoForkHostInput
  ): Promise<{ applied: boolean } | void> | { applied: boolean } | void;
}

// ============================================================================
// Embed entry point — minimal host for embedders (no daemon, no SQLite)
// ============================================================================

export interface RunTurnKernelInput {
  store: TurnKernelStore;
  sessionId: string;
  model: ModelAdapter;
  tools?: ToolContract<any>[];
  agent?: AgentSpec;
  maxTurns?: number;
  systemPrompt?: string;
  repoRoot?: string;
  stateDir?: string;
  onModelStreamChunk?: (chunk: ModelStreamChunk) => void;
  signal?: AbortSignal;
}
