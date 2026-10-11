/**
 * Product adapter: ToolLoopDeps → A's ToolLoopHost.
 * Agent semantics (filter / approve / execute / persist / retry) live in A.
 */

import {
  filePolicyRequiresBashApproval,
  filePolicyRequiresPathApproval,
  type FileApprovalPolicy
} from '../approval/policy-loader.js';
import { lifecycleBlocks, runLifecycleHook } from '../hooks/lifecycle-hooks.js';
import { maybeExportOtelSpan } from '../otel.js';
import {
  HARDLINE_ERROR_CODE,
  HARDLINE_SIBLING_SKIPPED_CODE,
  formatCommandHardlineContent,
  hardlineCommandOfToolCall,
  matchCommandHardline,
  type CommandHardlineMatch
} from '../sandbox/command-hardline.js';
import { redactToolContent } from '../sandbox/result-redaction.js';
import { toolInfraProblem } from '../model/tool-result-problem.js';
import { maybeArchiveToolResult } from '../artifact/archive-tool-result.js';
import type { IngestionSettingsStore } from '../ingestion/settings.js';
import type { PagedArtifactManifest } from '../artifact/paged-artifact.js';
import type {
  ApprovalRecord,
  ApprovalStatus,
  HttpProblemDetails,
  MessagePart,
  ModelAdapter,
  ModelStreamChunk,
  ModelTurnInput,
  ModelTurnResult,
  RunContext,
  SessionRecord,
  TaskArtifact,
  TaskRecord,
  ToolContract
} from '../types.js';
import {
  compensateCompletedLifo,
  createCompensationTx,
  runWithCompensation,
  type CompletedWaveItem,
  checkToolApprovals as checkToolApprovalsA,
  executeSingleTool as executeSingleToolA,
  executeToolCalls as executeToolCallsA,
  filterValidToolCalls as filterValidToolCallsA,
  processToolResults as processToolResultsA,
  runTurnWithRetries as runTurnWithRetriesA,
  type FileApprovalPolicy as LoopFilePolicy,
  type ToolLoopHost,
  type ToolLoopResult
} from '@ppeng/agent-loop';
import {
  getBoundSecretVault,
  parseSecretRefs,
  runWithSecretRefs
} from '../secrets/secret-vault.js';
import { stripSubagentDeniedTools } from './subagent-policy.js';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

export type ToolExecResult = {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
  isExternal?: boolean;
  artifacts?: TaskArtifact[];
  metadata?: Record<string, unknown>;
  problem?: HttpProblemDetails;
};

export type { FileApprovalPolicy };

export interface ToolLoopStore {
  appendMessage: (sessionId: string, role: 'tool' | 'user' | 'assistant' | 'system', parts: MessagePart[]) => unknown;
  listApprovals: (filter?: { status?: ApprovalStatus }) => ApprovalRecord[];
  createApproval: (input: {
    sessionId: string;
    toolName: string;
    reason: string;
    args: Record<string, unknown>;
    idempotencyKey?: string;
  }) => ApprovalRecord;
  deleteApproval: (id: string) => void;
  getTask: (taskId: string) => TaskRecord | undefined;
  updateTask: (taskId: string, patch: { artifacts: TaskArtifact[] }) => unknown;
}

export interface ToolLoopDeps {
  tools: ToolContract<any>[];
  store: ToolLoopStore;
  envApprovalPolicy: import('../approval/approval-policy.js').ApprovalPolicy | undefined;
  maxParallelToolCalls: number;
  modelAdapter: ModelAdapter;
  stateDir: string;
  emitTrace: (sessionId: string, event: { kind: string; payload?: Record<string, unknown> }) => void;
  runAfterToolExtension?: (ctx: {
    sessionId: string;
    tool: string;
    input?: unknown;
    ok: boolean;
    content: string;
  }) => Promise<{ systemMessage?: string } | void>;
  checkCapabilityPin?: (toolName: string, inputSchema: unknown) => {
    ok: boolean;
    reason?: string;
    expected?: string;
    actual?: string;
  };
  settingsStore?: IngestionSettingsStore;
  onArtifactCreated?: (manifest: PagedArtifactManifest) => void;
  /** Arm the unattended-wake deny timer when a deadline was stored. */
  armUnattendedApproval?: (approval: ApprovalRecord) => void;
}

function toolsForTurn(deps: ToolLoopDeps, turnTools?: ToolContract<any>[]): ToolContract<Record<string, unknown>>[] {
  return (turnTools ?? deps.tools) as ToolContract<Record<string, unknown>>[];
}

function adaptFilePolicy(policy: FileApprovalPolicy | undefined): LoopFilePolicy | undefined {
  if (!policy) return undefined;
  return {
    requireApprovalForBash: Boolean(policy.bashCommandPatterns?.length),
    requiresBashApproval: (cmd) => filePolicyRequiresBashApproval(policy, cmd),
    requiresPathApproval: (toolName, path) => filePolicyRequiresPathApproval(policy, toolName, path)
  };
}

function hostFromDeps(deps: ToolLoopDeps): ToolLoopHost {
  return {
    env: process.env,
    gateDirtyInput: true,
    appendMessage: (sessionId, role, parts) => {
      deps.store.appendMessage(sessionId, role, parts);
    },
    listApprovals: (filter) => deps.store.listApprovals(filter),
    createApproval: (input) => {
      const approval = deps.store.createApproval(input);
      deps.armUnattendedApproval?.(approval);
      return approval;
    },
    deleteApproval: (id) => deps.store.deleteApproval(id),
    getTask: (taskId) => deps.store.getTask(taskId),
    updateTask: (taskId, patch) => {
      deps.store.updateTask(taskId, patch);
    },
    emitTrace: deps.emitTrace,
    exportToolSpan: ({ sessionId, toolName, ok }) => {
      void maybeExportOtelSpan(process.env, deps.stateDir, sessionId, `tool.${toolName}`, {
        ok: String(ok)
      });
    },
    runLifecycleHook: async (input) => {
      const r = await runLifecycleHook(process.env, {
        phase: input.phase,
        sessionId: input.sessionId,
        tool: input.tool,
        input: input.input,
        ok: input.ok,
        content: input.content
      });
      return {
        permissionDecision: lifecycleBlocks(r)
          ? 'block'
          : r.permissionDecision === 'ask'
            ? 'ask'
            : r.permissionDecision === 'allow'
              ? 'proceed'
              : undefined,
        message: r.message,
        systemMessage: r.systemMessage,
        input: r.input ?? r.updatedInput
      };
    },
    runAfterToolExtension: deps.runAfterToolExtension,
    checkCapabilityPin: deps.checkCapabilityPin,
    archiveToolResult: ({ sessionId, toolName, content }) =>
      maybeArchiveToolResult({
        stateDir: deps.stateDir,
        sessionId,
        toolName,
        content,
        settingsStore: deps.settingsStore,
        onCreated: deps.onArtifactCreated
      }),
    redactSecrets: (content) => redactToolContent(content, process.env),
    compensate: async (items) => {
      await compensateCompletedLifo(items);
    }
  };
}

function envHost(): ToolLoopHost {
  return {
    env: process.env,
    appendMessage() {},
    listApprovals() {
      return [];
    },
    createApproval() {
      throw new Error('runTurnWithRetries host does not persist approvals');
    },
    deleteApproval() {},
    getTask() {
      return undefined;
    },
    updateTask() {},
    emitTrace() {}
  };
}

export function filterValidToolCalls(
  deps: ToolLoopDeps,
  toolCalls: ToolCallPart[],
  allowExternalAiTools: boolean,
  sessionId: string,
  turnTools?: ToolContract<any>[]
): ToolCallPart[] {
  return filterValidToolCallsA(
    hostFromDeps(deps),
    toolsForTurn(deps, turnTools),
    toolCalls,
    allowExternalAiTools,
    sessionId
  );
}

/**
 * Hardline commands are refused before any approval is considered, in every
 * permission mode. Sibling calls in the same wave get a paired "not executed"
 * result so tool_call/tool_result stay balanced. The gate inside execute stays
 * as the second line for approvals created before this check existed.
 */
function refuseHardlineToolCalls(
  deps: ToolLoopDeps,
  validToolCalls: ToolCallPart[],
  session: SessionRecord
): boolean {
  const hits = new Map<string, CommandHardlineMatch>();
  for (const call of validToolCalls) {
    const command = hardlineCommandOfToolCall(call.name, call.input);
    if (command === undefined) continue;
    const match = matchCommandHardline(command);
    if (match) hits.set(call.toolCallId, match);
  }
  if (hits.size === 0) return false;

  deps.store.appendMessage(
    session.id,
    'tool',
    validToolCalls.map((call): MessagePart => {
      const match = hits.get(call.toolCallId);
      if (match) {
        const content = formatCommandHardlineContent(match);
        return {
          type: 'tool_result',
          toolCallId: call.toolCallId,
          name: call.name,
          ok: false,
          content,
          problem: toolInfraProblem(call.name, call.toolCallId, HARDLINE_ERROR_CODE, match.reason, {
            title: 'Blocked by command hardline',
            status: 403
          })
        };
      }
      return {
        type: 'tool_result',
        toolCallId: call.toolCallId,
        name: call.name,
        ok: false,
        content: JSON.stringify({
          error: 'not executed: another tool call in this wave was refused by the command hardline',
          error_code: HARDLINE_SIBLING_SKIPPED_CODE
        })
      };
    })
  );
  for (const [toolCallId, match] of hits) {
    const call = validToolCalls.find((c) => c.toolCallId === toolCallId);
    deps.emitTrace(session.id, {
      kind: 'command_hardline_denied',
      payload: { tool: call?.name, ruleId: match.ruleId, toolCallId }
    });
  }
  return true;
}

export function checkToolApprovals(
  deps: ToolLoopDeps,
  validToolCalls: ToolCallPart[],
  context: RunContext,
  filePolicy: FileApprovalPolicy | undefined,
  session: SessionRecord,
  turnTools?: ToolContract<any>[]
): 'waiting' | 'skip' | 'proceed' {
  if (refuseHardlineToolCalls(deps, validToolCalls, session)) return 'skip';
  return checkToolApprovalsA(
    hostFromDeps(deps),
    toolsForTurn(deps, turnTools),
    validToolCalls,
    context,
    adaptFilePolicy(filePolicy),
    session,
    deps.envApprovalPolicy
  );
}

/** Assembled-loop path: file policy is already the loop shape. */
export function checkToolApprovalsForLoop(
  deps: ToolLoopDeps,
  validToolCalls: ToolCallPart[],
  context: RunContext,
  filePolicy: LoopFilePolicy | undefined,
  session: SessionRecord,
  turnTools: ToolContract<any>[] | undefined,
  envApprovalPolicy: ToolLoopDeps['envApprovalPolicy']
): 'waiting' | 'skip' | 'proceed' {
  if (refuseHardlineToolCalls(deps, validToolCalls, session)) return 'skip';
  return checkToolApprovalsA(
    hostFromDeps(deps),
    toolsForTurn(deps, turnTools),
    validToolCalls,
    context,
    filePolicy,
    session,
    envApprovalPolicy
  );
}

export async function executeSingleTool(
  deps: ToolLoopDeps,
  toolCall: ToolCallPart,
  context: RunContext,
  allowExternalAiTools: boolean,
  sessionId: string,
  completed?: CompletedWaveItem[]
): Promise<ToolExecResult> {
  return executeSingleToolA(
    hostFromDeps(deps),
    toolsForTurn(deps),
    toolCall,
    context,
    allowExternalAiTools,
    sessionId,
    completed
  );
}

export async function executeToolCalls(
  deps: ToolLoopDeps,
  validToolCalls: ToolCallPart[],
  context: RunContext,
  allowExternalAiTools: boolean,
  sessionId: string,
  turnTools?: ToolContract<any>[]
): Promise<ToolExecResult[]> {
  const visible = stripSubagentDeniedTools(context.session, turnTools ?? deps.tools);
  const execDeps = { ...deps, tools: visible };
  const vault = getBoundSecretVault();
  const secretValues = vault ? vault.resolveNamed(parseSecretRefs(context.session.metadata)) : {};
  const tx = createCompensationTx();
  const run = () =>
    executeToolCallsA(
      hostFromDeps(execDeps),
      toolsForTurn(execDeps),
      validToolCalls,
      context,
      allowExternalAiTools,
      sessionId,
      deps.maxParallelToolCalls
    );
  return runWithSecretRefs(secretValues, () => runWithCompensation(tx, run));
}

export function processToolResults(
  deps: ToolLoopDeps,
  results: ToolExecResult[],
  validToolCalls: ToolCallPart[],
  session: SessionRecord,
  task: TaskRecord | undefined,
  sessionId: string,
  onModelStreamChunk?: (chunk: ModelStreamChunk) => void
): void {
  processToolResultsA(
    hostFromDeps(deps),
    results as ToolLoopResult[],
    validToolCalls,
    session,
    task,
    sessionId,
    onModelStreamChunk
  );
}

export async function runTurnWithRetries(
  modelAdapter: ModelAdapter,
  input: ModelTurnInput & { signal?: AbortSignal },
  onStream?: (chunk: ModelStreamChunk) => void,
  opts?: { maxRetries?: number }
): Promise<ModelTurnResult> {
  return runTurnWithRetriesA(envHost(), modelAdapter, input, onStream, opts);
}
