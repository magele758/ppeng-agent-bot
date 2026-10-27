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
  ModelRetryProgress,
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
import { classifyModelError } from '../model/error-class.js';
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
  /** Set when a hook asked for approval. The kernel parks instead of persisting this row. */
  hold?: 'approval';
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
  /** Optional per-call cancellation scope. It must never abort the session. */
  toolExecutionScope?(call: ToolCallPart, context: RunContext): { context: RunContext; release(): void };
  /** Reject a revoked execution before dispatching another tool. */
  assertSessionWritable?(sessionId: string): void;
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

  /** Scrub secrets from every tool result before archiving or truncating. */
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

  /** Tool-call ids that already have a persisted tool_result. Skip writing them again. */
  pairedToolCallIds?(sessionId: string): ReadonlySet<string>;
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

function scrubToolContent(host: ToolLoopHost, content: string): string {
  return host.redactSecrets ? host.redactSecrets(content) : content;
}

function clipTraceBody(host: ToolLoopHost, text: string): string {
  const redacted = scrubToolContent(host, text);
  return truncateToolContent(redacted, envToolResultMaxChars(host.env));
}

/** Child session id carried on a tool result, so a parent trace can open the other trajectory. */
export function childSessionIdFromToolResult(result: {
  content: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const meta = result.metadata ?? {};
  for (const key of ['childSessionId', 'teammateSessionId'] as const) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const trimmed = result.content.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['childSessionId', 'teammateSessionId'] as const) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const reference = parsed.reference;
    if (typeof reference === 'string') {
      const match = /^session:(\S+)$/.exec(reference.trim());
      if (match?.[1]) return match[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function traceToolEndPayload(
  host: ToolLoopHost,
  result: ToolLoopResult,
  call: ToolCallPart | undefined
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: result.name,
    ok: result.ok,
    input: clipTraceBody(host, stableJson(call?.input ?? {})),
    content: clipTraceBody(host, result.content)
  };
  const childSessionId = childSessionIdFromToolResult(result);
  if (childSessionId) payload.childSessionId = childSessionId;
  return payload;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

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

/** Filled by the gate so a later turn can skip closed calls without folding. */
export interface ApprovalClosureReport {
  reported: boolean;
  ids: string[];
}

export function checkToolApprovals(
  host: ToolLoopHost,
  tools: ToolContract<Record<string, unknown>>[],
  validToolCalls: ToolCallPart[],
  context: RunContext,
  filePolicy: FileApprovalPolicy | undefined,
  session: SessionRecord,
  envApprovalPolicy: ApprovalPolicy | undefined,
  closure?: ApprovalClosureReport
): 'waiting' | 'skip' | 'proceed' {
  if (closure) closure.reported = true;
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
  let sessionApprovals: Map<string, ApprovalRecord> | undefined;
  const approvalFor = (idemKey: string): ApprovalRecord | undefined => {
    sessionApprovals ??= approvalIndexForSession(host, sid);
    return sessionApprovals.get(idemKey);
  };
  for (const tc of validToolCalls) {
    const tool = findToolByName(tools, tc.name);
    if (!tool || !needsApproval(tool, tc)) continue;
    const idemKey = stableJsonHash(tool.name, tc.input);
    const existing = approvalFor(idemKey);
    if (existing?.status === 'approved') continue;
    if (existing?.status === 'rejected') {
      closure?.ids.push(tc.toolCallId);
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

/** One scan per wave. The newest record for each key wins. */
function approvalIndexForSession(
  host: ToolLoopHost,
  sessionId: string
): Map<string, ApprovalRecord> {
  const index = new Map<string, ApprovalRecord>();
  for (const row of host.listApprovals()) {
    if (row.sessionId !== sessionId || !row.idempotencyKey) continue;
    const prev = index.get(row.idempotencyKey);
    // ISO 8601 timestamps in the same UTC format sort chronologically via lexicographic >=.
    // On equal timestamps, the last listed record wins, matching the hook-ask path.
    if (!prev || row.createdAt >= prev.createdAt) index.set(row.idempotencyKey, row);
  }
  return index;
}

/** Per call and per tool+input. A reused id with different args must not inherit an earlier approval. */
function hookAskKey(toolCall: ToolCallPart): string {
  return `${toolCall.toolCallId}:${stableJsonHash(toolCall.name, toolCall.input)}`;
}

/** Lazy, wave-local lookup shared by all hook asks, including sequential chunks. */
function createApprovalLookup(host: ToolLoopHost, sessionId: string): (key: string) => ApprovalRecord | undefined {
  let sessionApprovals: Map<string, ApprovalRecord> | undefined;
  return (key) => {
    sessionApprovals ??= approvalIndexForSession(host, sessionId);
    return sessionApprovals.get(key);
  };
}

function userRejectedToolResult(toolCall: ToolCallPart, toolName: string): ToolLoopResult {
  const content = '用户拒绝';
  return {
    toolCallId: toolCall.toolCallId,
    name: toolName,
    ok: false,
    content,
    problem: toolInfraProblem(toolName, toolCall.toolCallId, 'APPROVAL_REJECTED', content, {
      title: 'Approval rejected',
      status: 403,
    }),
  };
}

function holdForHookAsk(
  host: ToolLoopHost,
  tool: ToolContract<Record<string, unknown>>,
  toolCall: ToolCallPart,
  sessionId: string,
  message: string | undefined
): ToolLoopResult {
  const idemKey = hookAskKey(toolCall);
  host.createApproval({
    sessionId,
    toolName: tool.name,
    reason: message ?? `Hook asked for approval on ${tool.name}`,
    args: toolCall.input,
    idempotencyKey: idemKey,
  });
  return {
    toolCallId: toolCall.toolCallId,
    name: tool.name,
    ok: false,
    content: '',
    hold: 'approval',
  };
}

/** A rejected ask must settle as one tool_result. Creating another approval parks the wave again. */
function resolvePreToolAsk(
  host: ToolLoopHost,
  tool: ToolContract<Record<string, unknown>>,
  toolCall: ToolCallPart,
  sessionId: string,
  message: string | undefined,
  approvalFor: (key: string) => ApprovalRecord | undefined
): ToolLoopResult | undefined {
  const idemKey = hookAskKey(toolCall);
  const latest = approvalFor(idemKey);
  if (latest && latest.status === 'rejected') return userRejectedToolResult(toolCall, tool.name);
  if (latest && latest.status === 'approved') return undefined;
  return holdForHookAsk(host, tool, toolCall, sessionId, message);
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
  return executeSingleToolWithApprovals(host, tools, toolCall, context, allowExternalAiTools, sessionId,
    completed, createApprovalLookup(host, sessionId));
}

function checkToolCapabilityPin(
  host: ToolLoopHost,
  tool: ToolContract<Record<string, unknown>>,
  toolCall: ToolCallPart,
  sessionId: string
): ToolLoopResult | undefined {
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

  return undefined;
}

function prepareToolResultContent(host: ToolLoopHost, sessionId: string, toolName: string, content: string): string {
  const maxChars = envToolResultMaxChars(host.env);
  const scrubbed = scrubToolContent(host, content);
  const archived = host.archiveToolResult
    ? host.archiveToolResult({ sessionId, toolName, content: scrubbed })
    : scrubbed;
  return archived === scrubbed ? truncateToolContent(scrubbed, maxChars) : archived;
}

async function captureToolSnapshot(
  tool: ToolContract<Record<string, unknown>>,
  context: RunContext,
  input: unknown
): Promise<unknown> {
  if (!tool.captureSnapshot) return undefined;
  try {
    return await tool.captureSnapshot(context, input as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

async function executeSingleToolWithApprovals(
  host: ToolLoopHost, tools: ToolContract<Record<string, unknown>>[], toolCall: ToolCallPart,
  context: RunContext, allowExternalAiTools: boolean, sessionId: string,
  completed: CompletedWaveItem[] | undefined, approvalFor: (key: string) => ApprovalRecord | undefined
): Promise<ToolLoopResult> {
  const scope = host.toolExecutionScope?.(toolCall, context);
  try { return await executeScopedTool(host, tools, toolCall, scope?.context ?? context, allowExternalAiTools, sessionId, completed, approvalFor); }
  finally { scope?.release(); }
}

function cancelledBySteer(context: RunContext): boolean {
  return context.abortSignal?.aborted === true && context.abortSignal.reason?.code === 'TOOL_CANCELLED_BY_STEER';
}

function refuseBeforeDispatch(
  host: ToolLoopHost,
  tools: ToolContract<Record<string, unknown>>[],
  toolCall: ToolCallPart,
  allowExternalAiTools: boolean,
  sessionId: string
): { tool: ToolContract<Record<string, unknown>> } | { refused: ToolLoopResult } {
  const tool = findToolByName(tools, toolCall.name);
  if (!tool) {
    const available = tools.map((t) => t.name);
    const content = buildUnknownToolResultContent(toolCall.name, available);
    return { refused: {
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
    } };
  }

  if (host.gateDirtyInput !== false) {
    const gated = gateDirtyToolInput(toolCall.input);
    if (!gated.ok) {
      return { refused: {
        toolCallId: toolCall.toolCallId,
        name: tool.name,
        ok: false,
        content: gated.reason,
        problem: toolInfraProblem(tool.name, toolCall.toolCallId, gated.code, gated.reason, {
          title: 'Invalid tool arguments',
          status: 400,
        }),
      } };
    }
  }

  if (tool.isExternal && !allowExternalAiTools) {
    return { refused: {
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
    } };
  }

  const pinFailure = checkToolCapabilityPin(host, tool, toolCall, sessionId);
  if (pinFailure) return { refused: pinFailure };
  return { tool };
}

async function executeScopedTool(
  host: ToolLoopHost,
  tools: ToolContract<Record<string, unknown>>[],
  toolCall: ToolCallPart,
  context: RunContext,
  allowExternalAiTools: boolean,
  sessionId: string,
  completed: CompletedWaveItem[] | undefined,
  approvalFor: (key: string) => ApprovalRecord | undefined
): Promise<ToolLoopResult> {
  const admitted = refuseBeforeDispatch(host, tools, toolCall, allowExternalAiTools, sessionId);
  if ('refused' in admitted) return admitted.refused;
  const { tool } = admitted;

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
    const asked = resolvePreToolAsk(host, tool, toolCall, sessionId, pre.message, approvalFor);
    if (asked) return asked;
  }

  const execInput = pre.input !== undefined ? pre.input : toolCall.input;
  const snapshot = await captureToolSnapshot(tool, context, execInput);

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
    if (context.abortSignal?.aborted) throw new Error(cancelledBySteer(context) ? 'Tool cancelled by user interjection before dispatch' : 'Session aborted before tool dispatch');
    host.assertSessionWritable?.(sessionId);
    let result = await tool.execute(context, execInput as Record<string, unknown>);
    if (completed) {
      completed.push({ tool, toolCallId: toolCall.toolCallId, args: (execInput ?? {}) as Record<string, unknown>, snapshot, context });
    }

    if (cancelledBySteer(context)) result = {
      ...result, ok: false,
      content: result.content + '\nTool cancelled by user interjection. Partial effects may remain; do not retry unless the user requests it.',
      metadata: { ...result.metadata, cancelledBySteer: true }
    };
    result = { ...result, content: prepareToolResultContent(host, sessionId, tool.name, result.content) };
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
    return toolExceptionResult(host, tool, toolCall, context, sessionId, execInput, snapshot, completed, exportSpan, error);
  }
}

async function toolExceptionResult(
  host: ToolLoopHost,
  tool: ToolContract<Record<string, unknown>>,
  toolCall: ToolCallPart,
  context: RunContext,
  sessionId: string,
  execInput: unknown,
  snapshot: unknown,
  completed: CompletedWaveItem[] | undefined,
  exportSpan: (ok: boolean) => void,
  error: unknown
): Promise<ToolLoopResult> {
  if (completed) {
    completed.push({ tool, toolCallId: toolCall.toolCallId, args: (execInput ?? {}) as Record<string, unknown>, snapshot, context });
  }
  const detail = error instanceof Error ? error.message : String(error);
  const content = scrubToolContent(host, cancelledBySteer(context) ? `Tool cancelled by user interjection. Partial effects may remain; do not retry unless requested. ${detail}` : detail);
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
    metadata: cancelledBySteer(context) ? { cancelledBySteer: true } : undefined,
    problem: toolInfraProblem(tool.name, toolCall.toolCallId, cancelledBySteer(context) ? 'TOOL_CANCELLED_BY_STEER' : 'TOOL_UNHANDLED_EXCEPTION', content, {
      title: 'Tool raised an exception',
      status: 500,
    }),
  };
}

function resultCountsAsWaveFailure(result: ToolLoopResult): boolean {
  return !result.ok && result.hold !== 'approval' && result.metadata?.cancelledBySteer !== true;
}

/** A hook hold is not a failed write, so it must not roll the rest of the wave back. */
export function waveNeedsCompensation(results: readonly ToolLoopResult[], aborted: boolean): boolean {
  if (aborted) return true;
  return results.some(resultCountsAsWaveFailure);
}

export function toolWaveHeldForApproval(results: readonly { hold?: string }[]): boolean {
  return results.some((result) => result.hold === 'approval');
}

export function resultsToPersist(results: readonly ToolLoopResult[]): ToolLoopResult[] {
  return results.filter((result) => result.hold !== 'approval');
}

export function skipPersistedToolResult(
  result: { toolCallId: string },
  paired: ReadonlySet<string> | undefined
): boolean {
  if (!paired) return false;
  return paired.has(result.toolCallId);
}

function reopenToolCallId(open: Set<string>, paired: Set<string>, id: string): void {
  open.add(id);
  paired.delete(id);
}

function closeToolCallId(open: Set<string>, paired: Set<string>, id: string): void {
  if (!open.has(id)) return;
  open.delete(id);
  paired.add(id);
}

function applyToolPairEvent(
  open: Set<string>,
  paired: Set<string>,
  part: { type?: string; toolCallId?: string }
): void {
  const id = part.toolCallId;
  if (!id) return;
  if (part.type === 'tool_call') {
    reopenToolCallId(open, paired, id);
    return;
  }
  if (part.type !== 'tool_result') return;
  closeToolCallId(open, paired, id);
}

/**
 * Ids whose latest tool_call already has a later tool_result.
 * A reused id (heuristic_read_dir) is open again until a result follows that latest call.
 */
export function pairedToolCallIdsFromMessages(
  messages: readonly { parts: readonly { type?: string; toolCallId?: string }[] }[]
): Set<string> {
  const open = new Set<string>();
  const paired = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) applyToolPairEvent(open, paired, part);
  }
  return paired;
}

function toolResultIdsAlreadyPaired(host: ToolLoopHost, sessionId: string): ReadonlySet<string> | undefined {
  if (!host.pairedToolCallIds) return undefined;
  return host.pairedToolCallIds(sessionId);
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
  const approvalFor = createApprovalLookup(host, sessionId);

  for (const chunk of partitionForParallel(validToolCalls, maxParallelToolCalls)) {
    if (context.abortSignal?.aborted) break;
    host.assertSessionWritable?.(sessionId);
    const chunkResults = await Promise.all(
      chunk.map((tc) => executeSingleToolWithApprovals(host, tools, tc, context, allowExternalAiTools, sessionId, completed, approvalFor))
    );
    results.push(...chunkResults);
  }

  if (waveNeedsCompensation(results, context.abortSignal?.aborted === true) && host.compensate) {
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
  // Own the batch snapshot: hosts may return a shared/read-only set, or omit it.
  // Recreate it on each call so a later occurrence of a reused id can reopen.
  const paired = new Set(toolResultIdsAlreadyPaired(host, sessionId));
  for (const r of results) {
    if (skipPersistedToolResult(r, paired)) continue;
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
    paired.add(r.toolCallId);

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

    const call = validToolCalls.find((tc) => tc.toolCallId === r.toolCallId);
    host.emitTrace(sessionId, { kind: 'tool_end', payload: traceToolEndPayload(host, r, call) });
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
  const rawRetries = host.env.RAW_AGENT_MODEL_MAX_RETRIES?.trim();
  const configuredRetries = Number(rawRetries);
  const envRetries = rawRetries && Number.isFinite(configuredRetries) && configuredRetries >= 0 ? Math.floor(configuredRetries) : 5;
  const maxRetries =
    opts?.maxRetries !== undefined && Number.isFinite(opts.maxRetries)
      ? Math.max(0, Math.min(envRetries, Math.floor(opts.maxRetries)))
      : envRetries;
  const { signal, ...turnInput } = input;
  const useStream = Boolean(onStream) && typeof modelAdapter.runTurnStream === 'function' && envBool(host.env, 'RAW_AGENT_STREAM', true);
  const stream = useStream && onStream ? createStreamResetTracker(onStream) : undefined;
  let lastError: unknown;
  let requests = 0;
  const progress = (phase: ModelRetryProgress['phase'], retry: number, reason: ModelRetryProgress['reason'] = 'temporary', delayMs?: number) => {
    onStream?.({ type: 'model_retry', phase, model: modelAdapter.modelName ?? modelAdapter.name, retry, maxRetries, requests,
      message: lastError instanceof Error ? lastError.message.slice(0, 300) : String(lastError ?? ''), reason,
      ...(delayMs === undefined ? {} : { delayMs }) });
  };
  const checkAbort = (attempt: number) => {
    if (!signal?.aborted) return;
    progress('cancelled', attempt);
    throw new Error('Session aborted');
  };
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    checkAbort(attempt);
    if (attempt > 0) progress('requesting', attempt);
    requests++;
    try {
      const result = stream
        ? await runStreamTurnWithRepetitionGuard(host, modelAdapter, turnInput, signal, stream.onChunk)
        : await modelAdapter.runTurn({ ...turnInput, signal });
      if (attempt > 0) progress('recovered', attempt);
      return result;
    } catch (error) {
      lastError = error;
      checkAbort(attempt);
      const delayMs = retryDelayMs(error, attempt);
      const category = classifyModelError(error).category;
      const permanent = ['auth', 'bad_request', 'content_filter', 'aborted', 'watchdog'].includes(category);
      if (error instanceof RepetitionLoopAbortError || permanent || delayMs === undefined || attempt === maxRetries) {
        const reason = permanent ? 'permanent' : delayMs === undefined ? 'wait_limit' : 'exhausted';
        progress('failed', attempt, reason);
        break;
      }
      stream?.resetIfDirty('retry');
      progress('waiting', attempt + 1, 'temporary', delayMs);
      await abortableSleep(delayMs, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Longest server-requested wait we sit out in-process; longer asks fail fast (fallback can take over). */
export const MAX_RETRY_AFTER_MS = 120_000;

/** Backoff before the next attempt, honoring `Retry-After`; `undefined` = do not retry. */
export function retryDelayMs(error: unknown, attempt: number): number | undefined {
  const category = classifyModelError(error).category;
  if (['auth', 'bad_request', 'content_filter', 'aborted', 'watchdog'].includes(category)) return undefined;
  const backoff = Math.min(30_000, 2_000 * 2 ** attempt);
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
    if (signal?.aborted) done();
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
      const sample = chunk.type === 'text_delta' ? textGuard.text : reasoningGuard.text;
      abortError = new RepetitionLoopAbortError(reason, sample);
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
