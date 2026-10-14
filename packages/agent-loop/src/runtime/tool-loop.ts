/**
 * L7: Tool execution loop with dependency injection.
 *
 * Ported from ppeng-agent-core/packages/core/src/runtime/tool-loop.ts.
 * Hard I/O (process.env, SqliteStateStore) replaced with ToolLoopHost.
 */

import type {
  HttpProblemDetails,
  MessagePart,
  ModelAdapter,
  ModelStreamChunk,
  ModelTurnInput,
  ModelTurnResult,
  RunContext,
  SessionRecord,
  TaskArtifact,
  ApprovalRecord,
  ToolCallPart,
  ToolContract,
} from '../types.js';
import { envBool, envInt } from '../helpers.js';
import { toolInfraProblem } from '../model/tool-result-problem.js';
import { retryAfterMsOf } from '../model/upstream-error.js';
import { gateDirtyToolInput } from './dirty-input-gate.js';
import { buildUnknownToolResultContent } from '../recovery/unknown-tool-result.js';
import {
  loadRepetitionWatchdogConfig,
  RepetitionLoopAbortError,
  RepetitionStreamGuard,
  createStreamResetTracker,
} from '../streaming/index.js';
import {
  contextHasApprovalPolicy,
  policyRequiresApproval,
  policySkipsAutoApproval,
  type ApprovalPolicy,
} from '../approval/approval-policy.js';
import {
  applyPermissionModeGate,
  resolvePermissionMode,
} from '../approval/permission-mode.js';

// ============================================================================
// Public types
// ============================================================================

export interface ToolLoopResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
  images?: import('../types.js').ImagePart[];
  isExternal?: boolean;
  artifacts?: TaskArtifact[];
  metadata?: Record<string, unknown>;
  problem?: HttpProblemDetails;
}


export interface FileApprovalPolicy {
  allowedPaths?: string[];
  blockedPaths?: string[];
  requireApprovalForBash?: boolean;
  requiresBashApproval?(cmd: string): boolean;
  requiresPathApproval?(toolName: string, path: string): boolean;
}

export interface ToolTaskRecord {
  id: string;
  artifacts: TaskArtifact[];
}

export interface CompletedWaveItem {
  tool: ToolContract<Record<string, unknown>>;
  toolCallId: string;
  args: Record<string, unknown>;
  snapshot: unknown;
  context: RunContext;
}

// ============================================================================
// Host interface (I/O boundary)
// ============================================================================

export interface ToolLoopHost {
  /** Injected env; replaces direct process.env reads. */
  env: Record<string, string | undefined>;

  appendMessage(sessionId: string, role: 'tool' | 'user' | 'assistant' | 'system', parts: MessagePart[]): void;
  listApprovals(filter?: { status?: 'pending' | 'approved' | 'rejected' }): ApprovalRecord[];
  createApproval(input: {
    sessionId: string;
    toolName: string;
    reason: string;
    args: Record<string, unknown>;
    idempotencyKey?: string;
  }): ApprovalRecord;
  deleteApproval(id: string): void;
  getTask(taskId: string): ToolTaskRecord | undefined;
  updateTask(taskId: string, patch: { artifacts: TaskArtifact[] }): void;
  emitTrace(sessionId: string, event: { kind: string; payload?: Record<string, unknown> }): void;

  /** Optional lifecycle hooks; omit for environments with no hook runner. */
  runLifecycleHook?(input: {
    phase: 'pre_tool_use' | 'post_tool_use';
    tool: string;
    sessionId: string;
    input: unknown;
    ok?: boolean;
    content?: string;
  }): Promise<{
    permissionDecision?: 'proceed' | 'block' | 'ask';
    message?: string;
    systemMessage?: string;
    input?: unknown;
  }>;

  runAfterToolExtension?(ctx: {
    sessionId: string;
    tool: string;
    input?: unknown;
    ok: boolean;
    content: string;
  }): Promise<{ systemMessage?: string } | void>;

  /** CBOM schema-pin check; return ok:false to block before execute. */
  checkCapabilityPin?(toolName: string, inputSchema: unknown): {
    ok: boolean;
    reason?: string;
    expected?: string;
    actual?: string;
  };

  /**
   * Archive oversized tool output and return a URI or the original string
   * when below the archive threshold.
   */
  archiveToolResult?(input: {
    sessionId: string;
    toolName: string;
    content: string;
  }): string;

  /** Scrub secrets from shell-like tool output before archiving/truncating. */
  redactSecrets?(content: string): string;

  /**
   * Wave-level LIFO compensation: called when any result in the wave is !ok.
   * Return the tool-call ids whose side effects were undone so the wave
   * results can stop claiming those calls succeeded.
   */
  compensate?(items: CompletedWaveItem[]): Promise<{ compensated: string[] } | void>;

  /**
   * Per-tool span/metric export, invoked inside `executeSingleTool` right after
   * the result is finalized (so direct callers of `executeSingleTool` get spans
   * too, not only `executeToolCalls` waves). Fire-and-forget; must not throw.
   */
  exportToolSpan?(input: {
    sessionId: string;
    toolName: string;
    toolCallId: string;
    ok: boolean;
    durationMs: number;
  }): void;

  /** Reject `{ raw }` / `{ _nonObject }` tool args. Default true. */
  gateDirtyInput?: boolean;
}

// ============================================================================
// Private helpers
// ============================================================================

function findToolByName(
  tools: ToolContract<Record<string, unknown>>[],
  name: string
): ToolContract<Record<string, unknown>> | undefined {
  return tools.find((t) => t.name === name);
}

function extractInputString(input: unknown, key: string): string {
  if (input !== null && typeof input === 'object' && key in input) {
    const val = (input as Record<string, unknown>)[key];
    return typeof val === 'string' ? val : '';
  }
  return '';
}

function stableJsonHash(toolName: string, input: unknown): string {
  const payload = JSON.stringify({ tool: toolName, input });
  let h = 0;
  for (let i = 0; i < payload.length; i++) {
    h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 120_000;

/**
 * Max chars kept from a tool result before head/tail truncation.
 * `RAW_AGENT_TOOL_RESULT_MAX_CHARS` is the long-standing daemon knob;
 * `TOOL_RESULT_MAX_CHARS` is accepted as an embed-friendly alias.
 */
export function envToolResultMaxChars(env: Record<string, string | undefined>): number {
  for (const key of ['RAW_AGENT_TOOL_RESULT_MAX_CHARS', 'TOOL_RESULT_MAX_CHARS'] as const) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_TOOL_RESULT_MAX_CHARS;
}

export function truncateToolContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const half = Math.floor(maxChars / 2);
  return content.slice(0, half) + `\n\n[… ${content.length - maxChars} chars truncated …]\n\n` + content.slice(-half);
}

function partitionForParallel<T>(items: T[], maxParallel: number): T[][] {
  if (maxParallel <= 0 || items.length === 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += maxParallel) chunks.push(items.slice(i, i + maxParallel));
  return chunks;
}

const SHELL_LIKE_TOOLS: Record<string, true> = {
  bash: true,
  bg_run: true,
  bg_check: true,
  work_evidence: true,
};

// ============================================================================
// Filter
// ============================================================================

export function filterValidToolCalls(
  host: ToolLoopHost,
  tools: ToolContract<Record<string, unknown>>[],
  toolCalls: ToolCallPart[],
  allowExternalAiTools: boolean,
  sessionId: string
): ToolCallPart[] {
  const valid: ToolCallPart[] = [];
  for (const tc of toolCalls) {
    const t = findToolByName(tools, tc.name);
    if (t?.isExternal && !allowExternalAiTools) {
      host.appendMessage(sessionId, 'tool', [
        {
          type: 'tool_result',
          toolCallId: tc.toolCallId,
          name: tc.name,
          ok: false,
          content: `Tool ${tc.name} is not available in this session`,
          problem: toolInfraProblem(
            tc.name,
            tc.toolCallId,
            'TOOL_DISABLED_IN_SESSION',
            `Tool ${tc.name} is not enabled for this session (external AI tools gate).`,
            { title: 'Tool not available in session', status: 403 }
          ),
        },
      ]);
    } else {
      valid.push(tc);
    }
  }
  return valid;
}

// ============================================================================
// Approval check
// ============================================================================

export function checkToolApprovals(
  host: ToolLoopHost,
  tools: ToolContract<Record<string, unknown>>[],
  validToolCalls: ToolCallPart[],
  context: RunContext,
  filePolicy: FileApprovalPolicy | undefined,
  session: SessionRecord,
  envApprovalPolicy: ApprovalPolicy | undefined
): 'waiting' | 'skip' | 'proceed' {
  const policy = envApprovalPolicy ?? contextHasApprovalPolicy(context);
  const sid = session.id;
  const permissionMode = resolvePermissionMode(session.metadata, host.env);

  const needsApproval = (tool: ToolContract<Record<string, unknown>>, toolCall: ToolCallPart): boolean => {
    const modeGate = applyPermissionModeGate(permissionMode, tool.name, tool.approvalMode);
    if (modeGate?.action === 'deny') return false;
    if (modeGate?.action === 'require_approval') return true;
    if (modeGate?.action === 'proceed' && (permissionMode === 'bypass' || permissionMode === 'acceptEdits')) return false;

    if (policyRequiresApproval(policy, tool.name)) return true;
    if (filePolicy) {
      if (tool.name === 'bash') {
        const cmd = extractInputString(toolCall.input, 'command');
        if (filePolicy.requiresBashApproval?.(cmd)) return true;
        if (filePolicy.requireApprovalForBash && cmd.length > 0) return true;
      }
      if (tool.name === 'write_file' || tool.name === 'edit_file') {
        const p = extractInputString(toolCall.input, 'path');
        if (filePolicy.requiresPathApproval?.(tool.name, p)) return true;
        if (filePolicy.blockedPaths?.some((bp) => p.startsWith(bp))) return true;
        if (filePolicy.allowedPaths?.length && !filePolicy.allowedPaths.some((ap) => p.startsWith(ap))) return true;
      }
    }
    if (policy?.defaultRisky && tool.approvalMode === 'auto') return true;
    if (tool.approvalMode === 'always') return true;
    if (policySkipsAutoApproval(policy, tool.name)) return false;
    return tool.approvalMode === 'auto' && tool.needsApproval?.(context, toolCall.input) === true;
  };

  const denied: Array<{ tc: ToolCallPart; detail: string; code: string }> = [];
  for (const tc of validToolCalls) {
    const tool = findToolByName(tools, tc.name);
    if (!tool) continue;
    const modeGate = applyPermissionModeGate(permissionMode, tool.name, tool.approvalMode);
    if (modeGate?.action === 'deny') {
      denied.push({
        tc,
        detail: `${modeGate.reason}\nremediation: ${modeGate.remediation}`,
        code: modeGate.code,
      });
    }
  }
  if (denied.length > 0) {
    const deniedIds = new Set(denied.map((item) => item.tc.toolCallId));
    for (const item of denied) {
      appendApprovalToolResult(host, sid, item.tc, item.detail, {
        title: 'Blocked by permission mode',
        code: item.code,
        status: 403,
      });
    }
    for (const tc of validToolCalls) {
      if (deniedIds.has(tc.toolCallId)) continue;
      appendApprovalToolResult(
        host,
        sid,
        tc,
        'Not executed: another tool in the same wave was blocked by permission mode.',
        { title: 'Not executed', code: 'WAVE_BLOCKED', status: 403 }
      );
    }
    return 'skip';
  }

  let waiting = false;
  for (const tc of validToolCalls) {
    const tool = findToolByName(tools, tc.name);
    if (!tool || !needsApproval(tool, tc)) continue;
    const idemKey = stableJsonHash(tool.name, tc.input);
    const existing = findApprovalForCall(host, sid, idemKey);
    if (existing?.status === 'approved') continue;
    if (existing?.status === 'rejected') {
      appendApprovalToolResult(
        host,
        sid,
        tc,
        `Approval for ${tool.name} was rejected.`,
        { title: 'Approval rejected', code: 'APPROVAL_REJECTED', status: 403 }
      );
      continue;
    }
    if (existing?.status === 'pending') {
      waiting = true;
      continue;
    }
    host.createApproval({
      sessionId: sid,
      toolName: tool.name,
      reason: `Approval required for ${tool.name} (permissionMode=${permissionMode})`,
      args: tc.input,
      idempotencyKey: idemKey,
    });
    waiting = true;
  }
  return waiting ? 'waiting' : 'proceed';
}

function appendApprovalToolResult(
  host: ToolLoopHost,
  sessionId: string,
  tc: ToolCallPart,
  content: string,
  problem: { title: string; code: string; status: number }
): void {
  host.appendMessage(sessionId, 'tool', [
    {
      type: 'tool_result',
      toolCallId: tc.toolCallId,
      name: tc.name,
      ok: false,
      content,
      problem: toolInfraProblem(tc.name, tc.toolCallId, problem.code, content, {
        title: problem.title,
        status: problem.status,
      }),
    },
  ]);
}

/** Rejected wins over a stale pending or approved row with the same idempotency key. */
function findApprovalForCall(
  host: ToolLoopHost,
  sessionId: string,
  idemKey: string | undefined
): ApprovalRecord | undefined {
  if (!idemKey) return undefined;
  const statuses = ['rejected', 'pending', 'approved'] as const;
  for (const status of statuses) {
    const hit = host
      .listApprovals({ status })
      .find((approval) => approval.sessionId === sessionId && approval.idempotencyKey === idemKey);
    if (hit) return hit;
  }
  return undefined;
}

// ============================================================================
// Single-tool execution
// ============================================================================

export async function executeSingleTool(
  host: ToolLoopHost,
  tools: ToolContract<Record<string, unknown>>[],
  toolCall: ToolCallPart,
  context: RunContext,
  allowExternalAiTools: boolean,
  sessionId: string,
  completed?: CompletedWaveItem[]
): Promise<ToolLoopResult> {
  const tool = findToolByName(tools, toolCall.name);
  if (!tool) {
    const available = tools.map((t) => t.name);
    const content = buildUnknownToolResultContent(toolCall.name, available);
    return {
      toolCallId: toolCall.toolCallId,
      name: toolCall.name,
      ok: false,
      content,
      problem: toolInfraProblem(
        toolCall.name,
        toolCall.toolCallId,
        'UNKNOWN_TOOL',
        `No tool definition matches name ${toolCall.name}.`,
        { title: 'Unknown tool', status: 404 }
      ),
    };
  }

  if (host.gateDirtyInput !== false) {
    const gated = gateDirtyToolInput(toolCall.input);
    if (!gated.ok) {
      return {
        toolCallId: toolCall.toolCallId,
        name: tool.name,
        ok: false,
        content: gated.reason,
        problem: toolInfraProblem(tool.name, toolCall.toolCallId, gated.code, gated.reason, {
          title: 'Invalid tool arguments',
          status: 400,
        }),
      };
    }
  }

  if (tool.isExternal && !allowExternalAiTools) {
    return {
      toolCallId: toolCall.toolCallId,
      name: tool.name,
      ok: false,
      content: `Tool ${tool.name} is not available in this session`,
      isExternal: true,
      problem: toolInfraProblem(
        tool.name,
        toolCall.toolCallId,
        'TOOL_DISABLED_IN_SESSION',
        `Tool ${tool.name} is not enabled for this session.`,
        { title: 'Tool not available in session', status: 403 }
      ),
    };
  }

  if (host.checkCapabilityPin) {
    const pin = host.checkCapabilityPin(tool.name, tool.inputSchema ?? {});
    if (!pin.ok) {
      host.emitTrace(sessionId, {
        kind: 'capability_pin_fail',
        payload: { tool: tool.name, reason: pin.reason, expected: pin.expected, actual: pin.actual },
      });
      return {
        toolCallId: toolCall.toolCallId,
        name: tool.name,
        ok: false,
        content: JSON.stringify({
          error: 'schema_pin_mismatch',
          reason: pin.reason ?? 'CBOM schema pin failed',
          expected: pin.expected,
          actual: pin.actual,
        }),
        problem: toolInfraProblem(
          tool.name,
          toolCall.toolCallId,
          'SCHEMA_PIN_MISMATCH',
          pin.reason ?? 'CBOM schema pin failed',
          { title: 'Schema pin mismatch', status: 409 }
        ),
      };
    }
  }

  host.emitTrace(sessionId, { kind: 'tool_start', payload: { name: tool.name } });

  let pre: {
    permissionDecision?: string;
    message?: string;
    systemMessage?: string;
    input?: unknown;
  } = {};
  if (host.runLifecycleHook) {
    pre = await host.runLifecycleHook({ phase: 'pre_tool_use', tool: tool.name, sessionId, input: toolCall.input });
  }

  if (pre.permissionDecision === 'block') {
    return {
      toolCallId: toolCall.toolCallId,
      name: tool.name,
      ok: false,
      content: pre.message ?? pre.systemMessage ?? 'blocked by pre_tool_use hook',
      problem: toolInfraProblem(
        tool.name,
        toolCall.toolCallId,
        'PRE_TOOL_USE_BLOCKED',
        pre.message ?? 'blocked by pre_tool_use hook',
        { title: 'Tool blocked by hook', status: 403 }
      ),
    };
  }

  if (pre.permissionDecision === 'ask') {
    const idemKey = stableJsonHash(tool.name, toolCall.input);
    const existingApproved = host
      .listApprovals({ status: 'approved' })
      .find((a) => a.sessionId === sessionId && a.idempotencyKey === idemKey);
    if (!existingApproved) {
      host.createApproval({
        sessionId,
        toolName: tool.name,
        reason: pre.message ?? `Hook asked for approval on ${tool.name}`,
        args: toolCall.input,
        idempotencyKey: idemKey,
      });
      return {
        toolCallId: toolCall.toolCallId,
        name: tool.name,
        ok: false,
        content: 'waiting for approval (hook permissionDecision=ask)',
        problem: toolInfraProblem(
          tool.name,
          toolCall.toolCallId,
          'HOOK_ASK_APPROVAL',
          'Hook requested human approval',
          { title: 'Approval required by hook', status: 403 }
        ),
      };
    }
  }

  const execInput = pre.input !== undefined ? pre.input : toolCall.input;
  let snapshot: unknown;
  if (tool.captureSnapshot) {
    try {
      snapshot = await tool.captureSnapshot(context, execInput as Record<string, unknown>);
    } catch {
      snapshot = undefined;
    }
  }

  const startedAt = Date.now();
  const exportSpan = (ok: boolean) => {
    if (!host.exportToolSpan) return;
    try {
      host.exportToolSpan({
        sessionId,
        toolName: tool.name,
        toolCallId: toolCall.toolCallId,
        ok,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      /* observability must never fail the tool */
    }
  };

  try {
    let result = await tool.execute(context, execInput as Record<string, unknown>);
    if (completed) {
      completed.push({ tool, toolCallId: toolCall.toolCallId, args: (execInput ?? {}) as Record<string, unknown>, snapshot, context });
    }

    const maxChars = envToolResultMaxChars(host.env);
    const scrubbed = SHELL_LIKE_TOOLS[tool.name] && host.redactSecrets
      ? host.redactSecrets(result.content)
      : result.content;
    const archived = host.archiveToolResult
      ? host.archiveToolResult({ sessionId, toolName: tool.name, content: scrubbed })
      : scrubbed;

    result = { ...result, content: archived === scrubbed ? truncateToolContent(scrubbed, maxChars) : archived };
    exportSpan(result.ok);

    if (host.runLifecycleHook) {
      await host.runLifecycleHook({
        phase: 'post_tool_use',
        tool: tool.name,
        sessionId,
        input: execInput,
        ok: result.ok,
        content: result.content,
      });
    }

    if (host.runAfterToolExtension) {
      const ext = await host.runAfterToolExtension({
        sessionId,
        tool: tool.name,
        input: execInput,
        ok: result.ok,
        content: result.content,
      });
      if (ext && ext.systemMessage) {
        host.appendMessage(sessionId, 'system', [{ type: 'text', text: ext.systemMessage }]);
      }
    }

    return {
      toolCallId: toolCall.toolCallId,
      name: tool.name,
      ok: result.ok,
      content: result.content,
      isExternal: tool.isExternal,
      images: result.images,
      artifacts: result.artifacts,
      metadata: result.metadata,
    };
  } catch (error) {
    if (completed) {
      completed.push({ tool, toolCallId: toolCall.toolCallId, args: (execInput ?? {}) as Record<string, unknown>, snapshot, context });
    }
    const content = error instanceof Error ? error.message : String(error);
    exportSpan(false);
    if (host.runLifecycleHook) {
      await host.runLifecycleHook({ phase: 'post_tool_use', tool: tool.name, sessionId, input: execInput, ok: false, content });
    }
    return {
      toolCallId: toolCall.toolCallId,
      name: tool.name,
      ok: false,
      content,
      isExternal: tool.isExternal,
      problem: toolInfraProblem(tool.name, toolCall.toolCallId, 'TOOL_UNHANDLED_EXCEPTION', content, {
        title: 'Tool raised an exception',
        status: 500,
      }),
    };
  }
}

// ============================================================================
// Wave execution with compensation
// ============================================================================

export async function executeToolCalls(
  host: ToolLoopHost,
  tools: ToolContract<Record<string, unknown>>[],
  validToolCalls: ToolCallPart[],
  context: RunContext,
  allowExternalAiTools: boolean,
  sessionId: string,
  maxParallelToolCalls: number
): Promise<ToolLoopResult[]> {
  const completed: CompletedWaveItem[] = [];
  const results: ToolLoopResult[] = [];

  for (const chunk of partitionForParallel(validToolCalls, maxParallelToolCalls)) {
    const chunkResults = await Promise.all(
      chunk.map((tc) => executeSingleTool(host, tools, tc, context, allowExternalAiTools, sessionId, completed))
    );
    results.push(...chunkResults);
  }

  if ((results.some((r) => !r.ok) || context.abortSignal?.aborted) && host.compensate) {
    const report = await host.compensate(completed);
    const rolledBack = new Set(report?.compensated ?? []);
    for (const result of results) {
      if (!result.ok || !rolledBack.has(result.toolCallId)) continue;
      result.ok = false;
      result.content = `${result.content}\n\nRolled back: a later tool in this wave failed, so this change was undone.`;
    }
  }

  return results;
}

// ============================================================================
// Tool result processing
// ============================================================================

export function processToolResults(
  host: ToolLoopHost,
  results: ToolLoopResult[],
  validToolCalls: ToolCallPart[],
  session: SessionRecord,
  task: ToolTaskRecord | undefined,
  sessionId: string,
  onModelStreamChunk?: (chunk: ModelStreamChunk) => void
): void {
  const images: import('../types.js').ImagePart[] = [];
  for (const r of results) {
    images.push(...(r.images ?? []));
    const parts: MessagePart[] = [
      {
        type: 'tool_result',
        toolCallId: r.toolCallId,
        name: r.name,
        ok: r.ok,
        content: r.content,
        isExternal: r.isExternal,
        ...(r.problem ? { problem: r.problem } : {}),
      },
    ];

    const a2uiMessages = Array.isArray(r.metadata?.a2uiMessages)
      ? (r.metadata!.a2uiMessages as unknown[])
      : undefined;
    if (a2uiMessages && a2uiMessages.length > 0) {
      const surfaceId =
        typeof r.metadata?.a2uiSurfaceId === 'string' ? r.metadata!.a2uiSurfaceId : '';
      if (surfaceId) {
        const catalogId =
          typeof r.metadata?.a2uiCatalogId === 'string' ? r.metadata!.a2uiCatalogId : '';
        parts.push({ type: 'surface_update', surfaceId, catalogId, messages: a2uiMessages } as unknown as MessagePart);
        if (onModelStreamChunk) {
          for (const envelope of a2uiMessages) {
            try {
              onModelStreamChunk({ type: 'a2ui_message', surfaceId, envelope } as unknown as ModelStreamChunk);
            } catch {
              // best-effort
            }
          }
        }
      }
    }

    host.appendMessage(session.id, 'tool', parts);

    if (r.isExternal) {
      const idemKey = stableJsonHash(
        r.name,
        validToolCalls.find((tc) => tc.toolCallId === r.toolCallId)?.input ?? {}
      );
      const matchingApproval = host
        .listApprovals({ status: 'approved' })
        .find((a) => a.sessionId === sessionId && a.idempotencyKey === idemKey);
      if (matchingApproval) host.deleteApproval(matchingApproval.id);
    }

    if (task && r.artifacts?.length) {
      const latestTask = host.getTask(task.id);
      if (latestTask) {
        host.updateTask(task.id, { artifacts: [...latestTask.artifacts, ...r.artifacts] });
      }
    }

    host.emitTrace(sessionId, { kind: 'tool_end', payload: { name: r.name, ok: r.ok } });
  }
  if (images.length > 0) host.appendMessage(session.id, 'user', [
    { type: 'text', text: '[Tool observations: screenshots returned by tools, not a new user instruction.]' },
    ...images,
  ]);
}

// ============================================================================
// Model turn execution with retries and repetition guard
// ============================================================================

export async function runTurnWithRetries(
  host: ToolLoopHost,
  modelAdapter: ModelAdapter,
  input: ModelTurnInput & { signal?: AbortSignal },
  onStream?: (chunk: ModelStreamChunk) => void,
  opts?: { maxRetries?: number }
): Promise<ModelTurnResult> {
  const envRetries = envInt(host.env, 'RAW_AGENT_MODEL_MAX_RETRIES', 2);
  const maxRetries =
    opts?.maxRetries !== undefined && Number.isFinite(opts.maxRetries)
      ? Math.max(0, Math.min(envRetries, Math.floor(opts.maxRetries)))
      : envRetries;
  const { signal, ...turnInput } = input;
  const useStream =
    Boolean(onStream) &&
    typeof modelAdapter.runTurnStream === 'function' &&
    envBool(host.env, 'RAW_AGENT_STREAM', true);

  const stream = useStream && onStream ? createStreamResetTracker(onStream) : undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw new Error('Session aborted');
    try {
      if (stream) {
        return await runStreamTurnWithRepetitionGuard(host, modelAdapter, turnInput, signal, stream.onChunk);
      }
      return await modelAdapter.runTurn({ ...turnInput, signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw new Error('Session aborted');
      if (error instanceof RepetitionLoopAbortError || attempt === maxRetries) break;
      const delayMs = retryDelayMs(error, attempt);
      if (delayMs === undefined) break;
      stream?.resetIfDirty('retry');
      await abortableSleep(delayMs, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Longest server-requested wait we sit out in-process; longer asks fail fast (fallback can take over). */
export const MAX_RETRY_AFTER_MS = 20_000;

/** Backoff before the next attempt, honoring `Retry-After`; `undefined` = do not retry. */
export function retryDelayMs(error: unknown, attempt: number): number | undefined {
  const backoff = 400 * (attempt + 1);
  const retryAfter = retryAfterMsOf(error);
  if (retryAfter === undefined) return backoff;
  return retryAfter > MAX_RETRY_AFTER_MS ? undefined : Math.max(backoff, retryAfter);
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function runStreamTurnWithRepetitionGuard(
  host: ToolLoopHost,
  modelAdapter: ModelAdapter,
  turnInput: ModelTurnInput,
  signal: AbortSignal | undefined,
  onStream: (chunk: ModelStreamChunk) => void
): Promise<ModelTurnResult> {
  const enabled = envBool(host.env, 'REPETITION_WATCHDOG_ENABLED', true);
  if (!enabled) {
    return modelAdapter.runTurnStream!({ ...turnInput, signal }, onStream);
  }

  const config = loadRepetitionWatchdogConfig(host.env);
  const textGuard = new RepetitionStreamGuard(config);
  const reasoningGuard = new RepetitionStreamGuard(config);
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onOuterAbort, { once: true });

  let abortError: RepetitionLoopAbortError | undefined;

  const guardedStream = (chunk: ModelStreamChunk) => {
    if (abortError) return;
    const reason =
      chunk.type === 'text_delta' ? textGuard.push(chunk.text) :
      chunk.type === 'reasoning_delta' ? reasoningGuard.push(chunk.text) :
      null;
    if (reason != null) {
      abortError = new RepetitionLoopAbortError(reason);
      controller.abort();
      return;
    }
    onStream(chunk);
  };

  try {
    return await modelAdapter.runTurnStream!({ ...turnInput, signal: controller.signal }, guardedStream);
  } catch (error) {
    if (abortError) throw abortError;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
