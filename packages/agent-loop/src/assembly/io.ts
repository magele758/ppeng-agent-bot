/**
 * Product I/O ports for `createAssembledLoop`.
 * A owns agent behavior; B only injects workspace / sqlite / MCP / secrets / exporters.
 */

import type { ApprovalPolicy } from '../approval/approval-policy.js';
import type { FileApprovalPolicy, ToolLoopHost } from '../runtime/tool-loop.js';
import type { KernelHookRegistry } from '../turn/hooks.js';
import type { LoopConfig } from '../turn/config.js';
import type {
  KernelStepTx,
  TurnKernelHost,
  TurnKernelPrompt,
  TurnKernelStore,
} from '../turn/host.js';
import type { TurnKernelOptions } from '../turn/kernel.js';
import type { AgentLoopHandle } from '../runtime/agent-loop.js';
import type {
  AgentSpec,
  ModelAdapter,
  RunContext,
  SessionMessage,
  SessionRecord,
  ToolContract,
} from '../types.js';
import type { LoopPreset } from './presets.js';
import type { RecallSources } from '../session/context-compiler.js';
import type { OpenSqliteEventLogInput } from '../session/event-log-sqlite.js';

export interface AssembledLoopIo {
  model?: ModelAdapter;
  tools?: ToolContract<Record<string, unknown>>[];
  store?: TurnKernelStore;
  agent?: AgentSpec;
  agents?: AgentSpec[];
  repoRoot?: string;
  stateDir?: string;
  env?: Record<string, string | undefined>;
  loopConfig?: LoopConfig;
  promptCacheEpoch?: number | string;
  maxTurns?: number;
  maxParallelToolCalls?: number;
  emitTrace?: TurnKernelHost['emitTrace'];
  promptBuilder?: TurnKernelPrompt;
  mergeSessionMetadata?: TurnKernelHost['mergeSessionMetadata'];
  sessionAbortControllers?: Map<string, AbortController>;
  runToolLifecycleHook?: ToolLoopHost['runLifecycleHook'];
  runAfterToolExtension?: ToolLoopHost['runAfterToolExtension'];

  ensureMcpLoaded?: TurnKernelHost['ensureMcpLoaded'];
  ensureWorkspaceRoot?: TurnKernelHost['ensureWorkspaceRoot'];
  resolveWorkspaceRoots?: TurnKernelHost['resolveWorkspaceRoots'];
  resolveFilePolicy?: TurnKernelHost['resolveFilePolicy'];
  resolveImageDataUrl?: TurnKernelHost['resolveImageDataUrl'];
  resolveModelAdapter?: TurnKernelHost['resolveModelAdapter'];
  resolveTurnTools?: TurnKernelHost['resolveTurnTools'];
  resolveRunProfile?: TurnKernelHost['resolveRunProfile'];
  evaluateGoalGate?: TurnKernelHost['evaluateGoalGate'];
  beforeModelTurn?: TurnKernelHost['beforeModelTurn'];
  chooseRecovery?: TurnKernelHost['chooseRecovery'];
  runLifecycleHook?: TurnKernelHost['runLifecycleHook'];
  handleTurnCompletion?: TurnKernelHost['handleTurnCompletion'];
  injectRecoveryCoach?: TurnKernelHost['injectRecoveryCoach'];
  onSessionOutcome?: TurnKernelHost['onSessionOutcome'];
  waitSteeringChildrenIdle?: TurnKernelHost['waitSteeringChildrenIdle'];
  ingestMailbox?: TurnKernelHost['ingestMailbox'];
  autoClaimTask?: TurnKernelHost['autoClaimTask'];
  applyFoldBudget?: TurnKernelHost['applyFoldBudget'];
  recordToolUse?: TurnKernelHost['recordToolUse'];
  noteGoalWaitingUser?: TurnKernelHost['noteGoalWaitingUser'];
  shouldLatchBeforeTools?: TurnKernelHost['shouldLatchBeforeTools'];
  applyAutoFork?: TurnKernelHost['applyAutoFork'];
  latestClosedCheckpoint?: TurnKernelHost['latestClosedCheckpoint'];
  filterValidToolCalls?: TurnKernelHost['filterValidToolCalls'];
  checkToolApprovals?: TurnKernelHost['checkToolApprovals'];
  executeToolCalls?: TurnKernelHost['executeToolCalls'];
  processToolResults?: TurnKernelHost['processToolResults'];
  runTurnWithRetries?: TurnKernelHost['runTurnWithRetries'];
  fitModelRequest?: TurnKernelHost['fitModelRequest'];
  autoCompact?: TurnKernelHost['autoCompact'];
  prepareMessagesForModel?: TurnKernelHost['prepareMessagesForModel'];
  readWorkingLogAppendix?: TurnKernelHost['readWorkingLogAppendix'];
  stepTx?: KernelStepTx;

  sqlite?: OpenSqliteEventLogInput;
  envApprovalPolicy?: ApprovalPolicy;
  filePolicy?: FileApprovalPolicy;
  vault?: {
    resolveNamed(refs: unknown): Record<string, string>;
    runWithSecretRefs?<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T>;
  };
  parseSecretRefs?: (metadata: Record<string, unknown> | undefined) => unknown;
  withSecretRefs?: <T>(fn: () => Promise<T>) => Promise<T>;
  otel?: { exportSpan?(sessionId: string, name: string, attrs?: Record<string, string>): void };
  cbom?: {
    checkPin(
      toolName: string,
      schema: unknown
    ): { ok: boolean; reason?: string; expected?: string; actual?: string };
  };
  redactSecrets?: (content: string) => string;
  archiveToolResult?: (input: { sessionId: string; toolName: string; content: string }) => string;
  resolveWorkspacePath?: (context: RunContext, rel: string) => string;
  recallContextSources?: (input: {
    session: SessionRecord;
    query: string;
    stateDir?: string;
  }) => RecallSources;
  selectEpisodic?: (folded: SessionMessage[], session: SessionRecord) => SessionMessage[];
  getImageAsset?: (id: string) => {
    mimeType: string;
    sourceUrl?: string;
    retentionTier?: string;
  } | undefined;
  annotateRetired?: (messages: SessionMessage[], session: SessionRecord) => SessionMessage[];
  onCaseGovernance?: () => void;
  createPtcExecTool?: (
    tools: ToolContract<Record<string, unknown>>[]
  ) => ToolContract<Record<string, unknown>> | Promise<ToolContract<Record<string, unknown>>>;
}

export interface CreateAssembledLoopInput {
  preset?: LoopPreset;
  io?: AssembledLoopIo;
  config?: LoopConfig;
  hooks?: KernelHookRegistry;
}

export interface AssembledLoop {
  preset: LoopPreset;
  host: TurnKernelHost;
  store: TurnKernelStore;
  loadedModules: string[];
  run(sessionId: string, options?: TurnKernelOptions): Promise<SessionRecord>;
  createHandle?(sessionId: string): AgentLoopHandle;
  /** Release host-owned resources (e.g. the sqlite EventLog mirror). */
  close?(): Promise<void>;
}
