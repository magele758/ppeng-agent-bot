/**
 * Core type algebra.
 *
 * Loop-layer types (session records, message parts, tool contracts, model
 * adapter shapes) live in `@ppeng/agent-loop` and are re-exported here so every
 * consumer inside this package keeps importing from `./types.js` unchanged.
 *
 * The point of the re-export is identity: a `SessionMessage` produced by the
 * loop and one declared in core are the same declaration, not two structurally
 * similar ones that drift. Only genuinely core-owned shapes are defined below.
 */

import type { ImageRetentionTier } from '@ppeng/api-types';

// Wire-format message parts and loop-layer records — single source of truth.
export type {
  AgentSpec,
  ApprovalMode,
  ApprovalRecord,
  ApprovalStatus,
  BackgroundJobRecord,
  BackgroundJobStatus,
  HttpProblemDetails,
  ImagePart,
  ImageRetentionTier,
  MailRecord,
  MailStatus,
  MessagePart,
  MessageReplyTo,
  MessageRole,
  ModelAdapter,
  ModelStreamChunk,
  ModelTurnInput,
  ModelTurnResult,
  ReasoningPart,
  RunContext,
  SessionMemoryEntry,
  SessionMessage,
  SessionMode,
  SessionRecord,
  SessionStatus,
  SideEffectLevel,
  SummaryInput,
  SurfaceUpdatePart,
  TaskArtifact,
  TaskRecord,
  TaskStatus,
  TextCompletionInput,
  TextPart,
  TodoItem,
  TokenUsage,
  ToolCallPart,
  ToolContract,
  ToolExecutionResult,
  ToolResultPart,
  WorkspaceMode,
  WorkspaceRecord,
} from '@ppeng/agent-loop';

// ============================================================================
// Core-owned types (not part of the portable loop layer)
// ============================================================================

export interface SkillSpec {
  id: string;
  name: string;
  description: string;
  promptFragment?: string;
  content?: string;
  source?: 'builtin' | 'workspace' | 'agents' | 'user';
  /** 仓库内 SKILL.md 的相对路径（workspace），agents 目录扫描时可为空 */
  skillPath?: string;
  /** Alternate names accepted by load_skill and considered during routing. */
  aliases?: string[];
  triggerWords?: string[];
}

export interface ImageAssetRecord {
  id: string;
  sessionId: string;
  sha256: string;
  mimeType: string;
  sourceType: 'upload' | 'url' | 'derived';
  sourceUrl?: string;
  /** Relative to stateDir (e.g. images/<session>/<id>.png). */
  localRelPath: string;
  sizeBytes: number;
  derivedFromIds: string[];
  retentionTier: ImageRetentionTier;
  kind: 'original' | 'contact_sheet';
  lastAccessAt: string;
  createdAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Relative paths for structured harness handoffs (see Anthropic long-running harness pattern). */
export const HARNESS_ARTIFACT_DIR = '.raw-agent-harness';
export const HARNESS_ARTIFACT_FILES = {
  productSpec: 'product_spec.md',
  sprintContract: 'sprint_contract.md',
  evaluatorFeedback: 'evaluator_feedback.md',
  /** Numbered, testable requirements (functional + non-functional) before implementation sprints. */
  requirementsBacklog: 'requirements_backlog.md'
} as const;

export type HarnessWriteSpecKind =
  | 'product_spec'
  | 'sprint_contract'
  | 'evaluator_feedback'
  | 'requirements_backlog';

/** File basename under `${HARNESS_ARTIFACT_DIR}/` for each harness_write_spec kind. */
export function harnessWriteSpecBasename(kind: HarnessWriteSpecKind): string {
  switch (kind) {
    case 'product_spec':
      return HARNESS_ARTIFACT_FILES.productSpec;
    case 'sprint_contract':
      return HARNESS_ARTIFACT_FILES.sprintContract;
    case 'evaluator_feedback':
      return HARNESS_ARTIFACT_FILES.evaluatorFeedback;
    case 'requirements_backlog':
      return HARNESS_ARTIFACT_FILES.requirementsBacklog;
  }
}

// ============================================================================
// Self-heal (core-owned)
// ============================================================================

/** Preset npm script for self-heal test runs (whitelist). */
export type SelfHealTestPreset = 'unit' | 'regression' | 'e2e' | 'remote' | 'ci' | 'build';

export interface SelfHealPolicy {
  /** npm script preset or custom (see customNpmScript). */
  testPreset: SelfHealTestPreset | 'custom';
  /** When testPreset is custom: must be `pnpm run <script>` with allowed script name. */
  customNpmScript?: string;
  maxFixIterations: number;
  autoMerge: boolean;
  autoRestartDaemon: boolean;
  /** Branch to merge into from worktree branch (default: current branch at merge time). */
  targetBranch?: string;
  agentId?: string;
  /**
   * When true, the self-heal session's approval policy is set to auto-skip approval for
   * external AI tool calls (claude_code, codex_exec, cursor_agent).
   * Requires RAW_AGENT_EXTERNAL_AI_TOOLS=1 to expose those tools.
   */
  allowExternalAiTools?: boolean;
}

export type SelfHealStatus =
  | 'pending'
  | 'running_tests'
  | 'fixing'
  | 'tests_passed'
  | 'merging'
  | 'restart_pending'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'stopped';

export interface SelfHealRunRecord {
  id: string;
  status: SelfHealStatus;
  policy: SelfHealPolicy;
  taskId?: string;
  sessionId?: string;
  workspaceId?: string;
  worktreeBranch?: string;
  fixIteration: number;
  lastErrorSummary?: string;
  lastTestOutput?: string;
  mergeCommitSha?: string;
  blockReason?: string;
  stopped: boolean;
  restartRequestedAt?: string;
  restartAckAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SelfHealEventRecord {
  id: string;
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DaemonRestartRequest {
  requestedAt: string;
  reason: string;
  runId?: string;
}
