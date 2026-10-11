/**
 * L0: Type algebra for the agent loop.
 *
 * This module is the single source of truth for loop-layer types. Consumer
 * packages (`@ppeng/agent-core`, the Lab, domain agents) re-export from here so
 * a value produced inside the loop is structurally identical to the one the
 * frontend renders — no adapter layer, no duplicated declarations drifting
 * apart.
 *
 * Wire-format message parts come from `@ppeng/api-types`, which is also what
 * the daemon and Lab consume.
 */

import type {
  HttpProblemDetails,
  ImagePart,
  ImageRetentionTier,
  MessagePart,
  MessageRole,
  ReasoningPart,
  SurfaceUpdatePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from '@ppeng/api-types';

export type {
  HttpProblemDetails,
  ImagePart,
  ImageRetentionTier,
  MessagePart,
  MessageRole,
  ReasoningPart,
  SurfaceUpdatePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
};

// ============================================================================
// Session & message records
// ============================================================================

export type SessionMode = 'chat' | 'task' | 'subagent' | 'teammate';
export type SessionStatus = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'unknown';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type WorkspaceMode = 'git-worktree' | 'directory-copy';
export type SideEffectLevel = 'none' | 'workspace' | 'system';
export type ApprovalMode = 'never' | 'always' | 'auto';
export type MailStatus = 'pending' | 'delivered' | 'read';
export type BackgroundJobStatus = 'running' | 'completed' | 'error';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: string;
  /** Monotonic WAL sequence for this session. Present on fold() / listMessages after surface migration. */
  seq?: number;
  /** Optional stable key (steer / fact / summary). Same-key overwrite hides the previous visible node. */
  key?: string;
  /** When present, this message replaces the seq range [startSeq, endSeq]. */
  replaces?: { startSeq: number; endSeq: number };
  /** Hidden from the model view (retracted but retained for audit). */
  hidden?: boolean;
}

export interface SessionRecord {
  id: string;
  title: string;
  mode: SessionMode;
  status: SessionStatus;
  agentId: string;
  taskId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  background: boolean;
  summary?: string;
  todo: TodoItem[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** L1 WAL writer claim. Empty/undefined = legacy unrestricted append. */
  activeWriterRunId?: string;
}

// ============================================================================
// Task & workspace records
// ============================================================================

export interface TaskArtifact {
  kind: string;
  label: string;
  value: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  ownerAgentId?: string;
  sessionId?: string;
  parentTaskId?: string;
  workspaceId?: string;
  blockedBy: string[];
  artifacts: TaskArtifact[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: string;
  taskId: string;
  name: string;
  mode: WorkspaceMode;
  sourcePath: string;
  rootPath: string;
  status: 'active' | 'archived';
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  toolName: string;
  status: ApprovalStatus;
  reason: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Set only when this approval was raised by an unattended wake (cron, bot
   * routine, scheduler). Absent for a human sitting in Lab chat. Product code
   * denies the approval at this instant if nobody has answered; the loop does
   * not interpret it.
   */
  expiresAt?: string;
  /** Present after an unattended approval was denied because nobody answered. */
  expireReason?: string;
  /** Wake that raised this approval (`cron`, `routine`, `mailbox`, …). */
  wakeSource?: string;
}

export interface SessionMemoryEntry {
  id: string;
  sessionId: string;
  scope: 'scratch' | 'long';
  key: string;
  value: string;
  metadata: Record<string, unknown>;
  /** Importance score (0-1) for retrieval prioritization. Higher = more relevant. */
  importance?: number;
  /** Number of times this memory has been accessed/referenced. */
  accessCount?: number;
  /** Last access timestamp for LRU-style eviction. */
  lastAccessAt?: string;
  /** Source of this memory entry (extracted, user_provided, inferred, consolidated). */
  source?: 'extracted' | 'user_provided' | 'inferred' | 'consolidated' | 'ptc';
  /** IDs of memory entries that were merged into this one (for consolidated entries). */
  mergedFrom?: string[];
  updatedAt: string;
}

export interface MailRecord {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  type: string;
  content: string;
  correlationId?: string;
  sessionId?: string;
  taskId?: string;
  status: MailStatus;
  createdAt: string;
  readAt?: string;
}

export interface BackgroundJobRecord {
  id: string;
  sessionId: string;
  command: string;
  status: BackgroundJobStatus;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Agent spec
// ============================================================================

export interface AgentSpec {
  id: string;
  name: string;
  role: string;
  instructions: string;
  capabilities: string[];
  /** When set, built-in harness workflow hints apply (planner / generator / evaluator). */
  harnessRole?: 'planner' | 'generator' | 'evaluator';
  autonomous?: boolean;
  model?: string;
  /**
   * When set, the runtime only exposes tools whose `name` is in this list to
   * this agent (in addition to the global isExternal gate). Use this to scope
   * a domain agent (e.g. SRE persona) so it cannot accidentally call unrelated
   * tools.
   */
  allowedTools?: string[];
  /**
   * Domain bundle the agent belongs to (e.g. "sre" / "stock"). Used by the Web
   * Console to group personas in the agent selector. Defaults to "core"
   * when undefined.
   */
  domainId?: string;
}

// ============================================================================
// Tool contract & execution context
// ============================================================================

export interface RunContext {
  repoRoot: string;
  stateDir: string;
  session: SessionRecord;
  agent: AgentSpec;
  workspaceRoot?: string;
  workspaceRoots?: Array<{ alias: string; path: string; primary?: boolean }>;
  task?: TaskRecord;
  /** When aborted, long-running tools should stop. */
  abortSignal?: AbortSignal;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  artifacts?: TaskArtifact[];
  metadata?: Record<string, unknown>;
}

export interface ToolContract<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  approvalMode: ApprovalMode;
  sideEffectLevel: SideEffectLevel;
  execute: (context: RunContext, args: Args) => Promise<ToolExecutionResult>;
  needsApproval?: (context: RunContext, args: Args) => boolean;
  /** Marks the tool as coming from an external AI CLI (e.g. claude_code, codex_exec). */
  isExternal?: boolean;
  /** Pre-execute snapshot for wave-level LIFO compensation (fail-soft). */
  captureSnapshot?: (context: RunContext, args: Args) => Promise<unknown>;
  /** Undo this call's side effects. Missing hook is skipped. */
  compensate?: (context: RunContext, args: Args, snapshot: unknown) => Promise<void>;
  /** Side effect cannot be undone; wave failure records carryover instead. */
  irreversible?: boolean;
  /**
   * Explicit PTC namespace classification. Unmarked tools are never injected
   * into a generated workflow cell, even when their generic side-effect level
   * happens to be `none`.
   */
  ptc?: {
    kind: 'read' | 'write';
    requiresConfirm?: boolean;
  };
}

// ============================================================================
// Model adapter
// ============================================================================

/** Normalized per-turn token accounting. All counts are whole tokens. */
export interface TokenUsage {
  /** Prompt / input tokens billed for this turn. */
  inputTokens: number;
  /** Completion / output tokens produced this turn. */
  outputTokens: number;
  /** input + output (providers sometimes omit their own total). */
  totalTokens: number;
  /** Subset of inputTokens served from the provider prompt cache, when reported. */
  cachedInputTokens?: number;
  /** Number of model requests represented by this usage (1 per turn; merged sums). */
  requests: number;
}

export interface ModelTurnInput {
  agent: AgentSpec;
  systemPrompt: string;
  messages: SessionMessage[];
  tools: ToolContract<any>[];
  signal?: AbortSignal;
  /** Session that owns this turn (used to pick Lab-configured provider/model). */
  sessionId?: string;
  /** Resolve image asset id to data URL for VL requests (optional). */
  resolveImageDataUrl?: (assetId: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** When `RAW_AGENT_DEBUG_LLM_PROMPT` is set, adapters may log sanitized request bodies here. */
  debugLlmContext?: { stateDir: string; sessionId: string };
  /**
   * Provider prompt-cache affinity key (OpenAI `prompt_cache_key` / session binding).
   * Stable for the life of a session toolset lock.
   */
  promptCacheKey?: string;
}

export interface ModelTurnResult {
  assistantParts: MessagePart[];
  stopReason: 'end' | 'tool_use';
  /** Normalized token accounting for this turn, when the provider reported it. */
  usage?: TokenUsage;
  /** Raw provider finish/stop reason (e.g. 'stop', 'length', 'tool_calls', 'max_tokens'). */
  finishReason?: string;
  /**
   * True when the output was cut off by a token cap rather than a natural stop.
   * A truncated turn still has `stopReason: 'end'` (no more tool calls), so this
   * flag is the only signal that the assistant content is incomplete.
   */
  truncated?: boolean;
  /**
   * Upstream provider / gateway request id (`x-request-id`, body `request_id`, or
   * chatcmpl `id`). Observability only — for correlating with gateway / model logs.
   */
  requestId?: string;
}

export type ModelStreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; toolCallId: string; name: string }
  | { type: 'tool_call_delta'; toolCallId: string; argumentsFragment: string }
  /**
   * Incremental A2UI surface update emitted by the runtime after a tool call
   * (e.g. `a2ui_render`) returns envelopes in `metadata.a2uiMessages`. The
   * `envelope` payload validates against the v0.9 schema; web clients fold
   * it into per-surface state and re-render in place.
   */
  | { type: 'a2ui_message'; surfaceId: string; envelope: unknown }
  /**
   * The model attempt that produced the deltas since the last `done` failed and
   * is being re-run (`retry`) or handed to the next provider (`fallback`).
   * Clients drop everything streamed since the last `done`; the replacement
   * attempt streams the turn again from scratch.
   */
  | { type: 'stream_reset'; reason: StreamResetReason }
  | { type: 'done'; stopReason: 'end' | 'tool_use' };

export type StreamResetReason = 'retry' | 'fallback';

export interface SummaryInput {
  agent: AgentSpec;
  messages: SessionMessage[];
  reason: string;
}

export interface TextCompletionInput {
  system: string;
  user: string;
  signal?: AbortSignal;
  /** Prefer JSON object response when the provider supports it. */
  jsonMode?: boolean;
}

export interface ModelAdapter {
  name: string;
  runTurn(input: ModelTurnInput): Promise<ModelTurnResult>;
  summarizeMessages(input: SummaryInput): Promise<string>;
  /** Optional streaming turn; default falls back to runTurn without chunks. */
  runTurnStream?(
    input: ModelTurnInput,
    onChunk: (chunk: ModelStreamChunk) => void
  ): Promise<ModelTurnResult>;
  /**
   * Optional single-shot text completion (goal judge / small helpers).
   * When absent, callers should fail-open or use summarizeMessages.
   */
  completeText?(input: TextCompletionInput): Promise<string>;
}

// ============================================================================
// Trace events
// ============================================================================

export type TraceEventKind =
  | 'turn_start'
  | 'model_call'
  | 'tool_call'
  | 'tool_result'
  | 'turn_end'
  | 'turn_truncated'
  | 'error'
  | 'repetition_abort'
  | 'model_error'
  | 'recovery_advisory'
  | 'recovery_abort'
  | 'reasoning_spin_abort'
  | 'risk_advisory'
  | 'usage_cumulative_split'
  | 'prompt_cache_bust'
  | 'goal_eval'
  | 'dyn_tool_hydrate'
  | string;

export interface TraceEvent {
  kind: TraceEventKind;
  /** Free-form payload; consumers narrow by `kind`. */
  payload?: Record<string, unknown>;
  /** Alias used by some emitters — prefer `payload` in new code. */
  data?: Record<string, unknown>;
  timestamp?: string;
}
