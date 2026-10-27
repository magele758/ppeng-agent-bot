import type {
  MessagePart,
  ModelAdapter,
  ModelStreamChunk,
  ModelTurnInput,
  ModelTurnResult,
  SessionMessage,
  SummaryInput,
  ToolContract
} from '../types.js';
import { parseModelToolArguments } from './parse-tool-arguments.js';
import { resolveModelStopReason } from './stop-reason.js';
import {
  isTruncatedFinish,
  normalizeAnthropicUsage,
  normalizeOpenAiUsage
} from './usage.js';
import {
  pickUpstreamRequestIdFromHeaders,
  pickUpstreamRequestIdFromRecord,
  resolveUpstreamRequestId,
  wrapResponseToCaptureUpstreamRequestId
} from './upstream-request-id.js';
import { llmPromptDebugEnabled, maybeLogLlmRequest } from './llm-prompt-debug.js';
import { formatToolResultForLlm } from './tool-result-problem.js';
import { normalizeRemoteSecret } from './remote-env.js';
import {
  UpstreamStreamError,
  midStreamError,
  prematureStreamEnd,
  upstreamHttpError
} from './upstream-error.js';
import { createLogger } from '../logger.js';

const responsesStreamLog = createLogger('openai-responses-stream');

// ---------------------------------------------------------------------------
// Inlined from list-models.ts (pure URL normalization, no external deps)
// ---------------------------------------------------------------------------

/** OpenAI-compat chat/models live under /v1; host-only URLs 404 on /chat/completions. */
function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/v\d+(?:beta)?(?:\/|$)/i.test(base)) return base;
  return `${base}/v1`;
}

// ---------------------------------------------------------------------------
// Pure helpers — unchanged from source
// ---------------------------------------------------------------------------

/**
 * Many OpenAI-compatible reasoning models expose chain-of-thought on alternate keys
 * (`reasoning_content`, `reasoning`, `thinking`) on both stream deltas and non-stream
 * `message` objects. Centralize so non-stream turns persist the same ReasoningPart shape
 * as streaming turns.
 */
function coalesceOpenAiReasoningText(source: Record<string, unknown> | null | undefined): string {
  if (!source) return '';
  const rc = source.reasoning_content;
  const r = source.reasoning;
  const t = source.thinking;
  const rs = source.reasoning_summary;
  const thought = source.thought;
  if (typeof rc === 'string' && rc) return rc;
  if (typeof r === 'string' && r) return r;
  if (typeof t === 'string' && t) return t;
  if (typeof rs === 'string' && rs) return rs;
  if (typeof thought === 'string' && thought) return thought;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const o = r as Record<string, unknown>;
    const sum = o.summary;
    if (typeof sum === 'string' && sum.trim()) return sum.trim();
    if (Array.isArray(sum)) {
      const joined = sum
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const it = item as Record<string, unknown>;
            if (typeof it.text === 'string') return it.text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (joined.trim()) return joined.trim();
    }
    const txt = o.text;
    if (typeof txt === 'string' && txt) return txt;
  }
  return '';
}

function textFromParts(parts: MessagePart[]): string {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** OpenAI `assistant.content`: concatenate persisted reasoning + visible text (tool_call parts excluded). */
function assistantOpenAiTextFromParts(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === 'reasoning') chunks.push(part.text ?? '');
    if (part.type === 'text') chunks.push(part.text ?? '');
  }
  return chunks.join('\n\n').trim();
}

/** Text + image placeholders for skill matching and summarization. */
export function textSummaryFromParts(parts: MessagePart[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === 'reasoning') lines.push(part.text);
    else if (part.type === 'text') lines.push(part.text);
    else if (part.type === 'image') {
      lines.push(`[image ${part.assetId}${part.retentionTier ? ` tier=${part.retentionTier}` : ''}]`);
    } else if (part.type === 'tool_call') lines.push(`[tool ${part.name}]`);
    else if (part.type === 'tool_result') lines.push(`[result ${part.name}] ${part.content}`);
  }
  return lines.join('\n').trim();
}

/**
 * Must stay equal to `ABSOLUTE_DATE_SUMMARY_RULE` in
 * packages/core/src/session/conversation-clock.ts.
 * agent-loop must not import @ppeng/agent-core.
 */
export const ABSOLUTE_DATE_SUMMARY_RULE =
  'Write every date as an absolute YYYY-MM-DD. Never write today, tomorrow, yesterday, or this week, and never write 今天, 明天, 昨天, 后天, 本周, or 下周. If a source message uses those words, resolve them against that message\'s writtenAt timestamp, not against the moment you are summarizing.';

export function summaryMessagePayload(message: {
  role: string;
  parts: MessagePart[];
  createdAt?: string;
}): { role: string; text: string; writtenAt?: string } {
  const row: { role: string; text: string; writtenAt?: string } = {
    role: message.role,
    text: textSummaryFromParts(message.parts)
  };
  if (typeof message.createdAt === 'string' && message.createdAt.length > 0) {
    row.writtenAt = message.createdAt;
  }
  return row;
}

export function summarizeContinuationInstruction(json: boolean): string {
  const base = json
    ? 'Summarize the conversation state for continuation. Return JSON with a single "summary" string field. Preserve tasks, decisions, risks, and pending work.'
    : 'Summarize the conversation state for continuation. Preserve tasks, decisions, risks, and pending work.';
  return `${base} ${ABSOLUTE_DATE_SUMMARY_RULE}`;
}

/** Last user-authored text part (appendix / working-log is prepended as an earlier part). */
function lastUserUtterance(messages: SessionMessage[]): string {
  const reversed = [...messages].reverse();
  const message = reversed.find((candidate) => candidate.role === 'user');
  if (!message) return '';
  const texts = message.parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text.trim())
    .filter((text) => text && !text.includes('[conversation-clock]'));
  return texts.at(-1) ?? '';
}

function lastUserSummaryText(messages: SessionMessage[]): string {
  const reversed = [...messages].reverse();
  const message = reversed.find((candidate) => candidate.role === 'user');
  return message ? textSummaryFromParts(message.parts) : '';
}

let toolCallSeq = 0;
function createToolCallId(): string {
  toolCallSeq += 1;
  return `call_${toolCallSeq}_${Date.now()}`;
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-clone plain objects with sorted keys at every nesting level; arrays preserve order
 * but elements are canonicalized. Used so JSON.stringify yields stable bytes for nested args.
 */
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (!isPlainObject(value)) return value;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalize(obj[key]);
      return acc;
    }, {});
}

/** Returns a canonical JSON string with object keys sorted at every depth for stable serialization. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Builds the tool definitions array for the model, sorted by name for stable order.
 * Consistent ordering ensures the tools payload doesn't change between turns when
 * the same tool set is in use, enabling prompt-cache reuse.
 */
function toolDefinitions(tools: ToolContract[]): Array<Record<string, unknown>> {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

/** Chat Completions vs OpenAI Responses (`/v1/responses`) — reasoning + tool interleaving per OpenAI guidance. */
export type OpenAiHttpKind = 'chat_completions' | 'responses';

export function normalizeOpenAiHttpKind(raw: string | undefined): OpenAiHttpKind {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'responses' || v === 'response') return 'responses';
  return 'chat_completions';
}

function mapToolDefinitionsToResponsesFormat(
  tools: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const fn = t.function as Record<string, unknown> | undefined;
    if (t.type === 'function' && fn && typeof fn === 'object') {
      return {
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
        strict: false
      };
    }
    return t;
  });
}

function openAiCompatEndpoint(baseUrl: string, kind: OpenAiHttpKind): string {
  const base = normalizeOpenAiCompatibleBaseUrl(baseUrl);
  return kind === 'responses' ? `${base}/responses` : `${base}/chat/completions`;
}

function extractReasoningSummaryFromResponsesItem(it: Record<string, unknown>): string {
  const summary = it.summary;
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  if (!Array.isArray(summary)) return '';
  const parts: string[] = [];
  for (const entry of summary) {
    if (typeof entry === 'string') parts.push(entry);
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      if (typeof e.text === 'string') parts.push(e.text);
    }
  }
  return parts.join('\n').trim();
}

function extractAssistantTextFromResponsesMessage(it: Record<string, unknown>): string {
  const content = it.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'output_text' && typeof b.text === 'string') chunks.push(b.text);
  }
  return chunks.join('').trim();
}

function parseResponsesOutputToTurnResult(body: Record<string, unknown>): ModelTurnResult {
  const assistantParts: MessagePart[] = [];
  const output = body.output;
  let sawTool = false;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const it = item as Record<string, unknown>;
      if (it.type === 'reasoning') {
        const r = extractReasoningSummaryFromResponsesItem(it);
        if (r) assistantParts.push({ type: 'reasoning', text: r });
      } else if (it.type === 'message' && it.role === 'assistant') {
        const text = extractAssistantTextFromResponsesMessage(it);
        if (text) assistantParts.push({ type: 'text', text });
      } else if (it.type === 'function_call') {
        sawTool = true;
        const callId = String(it.call_id ?? it.id ?? createToolCallId());
        const name = String(it.name ?? 'unknown_tool');
        const rawArgs = it.arguments;
        const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
        assistantParts.push({
          type: 'tool_call',
          toolCallId: callId,
          name,
          input: parseModelToolArguments(argsStr)
        });
      }
    }
  }
  if (assistantParts.length === 0 && typeof body.output_text === 'string' && body.output_text.trim()) {
    assistantParts.push({ type: 'text', text: body.output_text.trim() });
  }
  if (assistantParts.length === 0) {
    assistantParts.push({ type: 'text', text: '' });
  }
  // Responses API reports truncation via `status: 'incomplete'` +
  // `incomplete_details.reason: 'max_output_tokens'`.
  const incompleteReason =
    body.status === 'incomplete'
      ? String(
          (body.incomplete_details as Record<string, unknown> | undefined)?.reason ?? 'incomplete'
        )
      : undefined;
  const usage = normalizeOpenAiUsage(body.usage);
  const result: ModelTurnResult = {
    stopReason: resolveModelStopReason(incompleteReason, sawTool ? 1 : 0),
    assistantParts,
    finishReason: incompleteReason
  };
  if (usage) result.usage = usage;
  if (isTruncatedFinish(incompleteReason)) result.truncated = true;
  const requestId = pickUpstreamRequestIdFromRecord(body);
  if (requestId) result.requestId = requestId;
  return result;
}

type ResponsesFuncSlot = { callId: string; name: string; args: string; announced: boolean };

type ResponsesStreamAgg = {
  textAcc: string;
  reasoningAcc: string;
  /** function_call item `id` (and `call_id`) → partial call */
  funcByItemId: Map<string, ResponsesFuncSlot>;
  /** `response` object from the terminal event (`response.completed` / `.done` / `.incomplete`). */
  terminalResponse: Record<string, unknown> | null;
  /** A terminal event (or `[DONE]`) arrived; without one the connection dropped mid-answer. */
  terminated: boolean;
};

interface ResponsesEventContext {
  parsed: Record<string, unknown>;
  agg: ResponsesStreamAgg;
  onChunk: (chunk: ModelStreamChunk) => void;
}

/** Returns `false` when the event shape was not understood (debug-logged). */
type ResponsesEventHandler = (ctx: ResponsesEventContext) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deltaTextFromUnknown(delta: unknown): string {
  if (typeof delta === 'string') return delta;
  if (isRecord(delta)) {
    if (typeof delta.text === 'string') return delta.text;
    if (typeof delta.output_text === 'string') return delta.output_text;
  }
  return '';
}

function emitResponsesText(ctx: ResponsesEventContext, piece: string): void {
  if (!piece) return;
  ctx.agg.textAcc += piece;
  ctx.onChunk({ type: 'text_delta', text: piece });
}

function emitResponsesReasoning(ctx: ResponsesEventContext, piece: string): void {
  if (!piece) return;
  ctx.agg.reasoningAcc += piece;
  ctx.onChunk({ type: 'reasoning_delta', text: piece });
}

function announceSlot(slot: ResponsesFuncSlot, onChunk: (chunk: ModelStreamChunk) => void): void {
  if (slot.announced || !slot.name) return;
  onChunk({ type: 'tool_call_start', toolCallId: slot.callId, name: slot.name });
  slot.announced = true;
}

function appendSlotArgs(
  slot: ResponsesFuncSlot,
  fragment: string,
  onChunk: (chunk: ModelStreamChunk) => void
): void {
  slot.args += fragment;
  onChunk({ type: 'tool_call_delta', toolCallId: slot.callId, argumentsFragment: fragment });
}

function registerSlot(agg: ResponsesStreamAgg, itemId: string, slot: ResponsesFuncSlot): void {
  if (itemId) agg.funcByItemId.set(itemId, slot);
  if (slot.callId) agg.funcByItemId.set(slot.callId, slot);
}

interface FunctionCallFields {
  itemId: string;
  callId: string;
  name: string;
  rawArgs: unknown;
}

function functionCallFields(rec: Record<string, unknown>): FunctionCallFields {
  return {
    itemId: String(rec.id ?? ''),
    callId: String(rec.call_id ?? rec.id ?? ''),
    name: String(rec.name ?? ''),
    rawArgs: rec.arguments
  };
}

/** `output_item.done` / `function_call_arguments.done`: final name + full arguments for a call. */
function finalizeFunctionCall(ctx: ResponsesEventContext, f: FunctionCallFields): void {
  const { agg } = ctx;
  const argsStr = typeof f.rawArgs === 'string' ? f.rawArgs : JSON.stringify(f.rawArgs ?? {});
  let slot = (f.itemId && agg.funcByItemId.get(f.itemId)) || (f.callId && agg.funcByItemId.get(f.callId));
  if (!slot) {
    slot = { callId: f.callId || createToolCallId(), name: f.name, args: argsStr, announced: false };
    registerSlot(agg, f.itemId, slot);
  }
  if (f.rawArgs !== undefined) slot.args = argsStr;
  slot.name = f.name || slot.name;
  announceSlot(slot, ctx.onChunk);
}

const onResponsesTextDelta: ResponsesEventHandler = (ctx) => {
  emitResponsesText(ctx, deltaTextFromUnknown(ctx.parsed.delta));
  return true;
};

const onResponsesTextDone: ResponsesEventHandler = (ctx) => {
  const { parsed } = ctx;
  const text =
    typeof parsed.text === 'string'
      ? parsed.text
      : deltaTextFromUnknown(parsed.delta) ||
        (typeof parsed.output_text === 'string' ? parsed.output_text : '');
  if (!ctx.agg.textAcc) emitResponsesText(ctx, text);
  return true;
};

const onResponsesReasoningDelta: ResponsesEventHandler = (ctx) => {
  emitResponsesReasoning(ctx, deltaTextFromUnknown(ctx.parsed.delta));
  return true;
};

function outputItemDeltaArguments(
  ctx: ResponsesEventContext,
  itemId: string,
  delta: Record<string, unknown>
): boolean {
  const fragment = typeof delta.arguments === 'string' ? delta.arguments : '';
  if (!itemId || !fragment) return false;
  let slot = ctx.agg.funcByItemId.get(itemId);
  if (!slot) {
    slot = {
      callId: String(delta.call_id ?? itemId),
      name: typeof delta.name === 'string' ? delta.name : '',
      args: '',
      announced: false
    };
    registerSlot(ctx.agg, itemId, slot);
  }
  announceSlot(slot, ctx.onChunk);
  appendSlotArgs(slot, fragment, ctx.onChunk);
  return true;
}

/**
 * Some gateways emit `response.output_item.delta` instead of (or in addition to)
 * `response.output_text.delta` / `response.function_call_arguments.delta`.
 */
const onResponsesOutputItemDelta: ResponsesEventHandler = (ctx) => {
  const { parsed } = ctx;
  const item = isRecord(parsed.item) ? parsed.item : undefined;
  const itemId = String(parsed.item_id ?? item?.id ?? '');
  const delta = parsed.delta;
  if (typeof delta === 'string') {
    if (!delta) return false;
    const slot = itemId ? ctx.agg.funcByItemId.get(itemId) : undefined;
    if (slot) appendSlotArgs(slot, delta, ctx.onChunk);
    else emitResponsesText(ctx, delta);
    return true;
  }
  if (!isRecord(delta)) return false;
  const textPiece = deltaTextFromUnknown(delta);
  if (textPiece) {
    emitResponsesText(ctx, textPiece);
    return true;
  }
  const reasoningPiece = coalesceOpenAiReasoningText(delta).trim();
  if (reasoningPiece) {
    emitResponsesReasoning(ctx, reasoningPiece);
    return true;
  }
  return outputItemDeltaArguments(ctx, itemId, delta);
};

const onResponsesOutputItemAdded: ResponsesEventHandler = (ctx) => {
  const item = ctx.parsed.item;
  if (!isRecord(item) || item.type !== 'function_call') return true;
  const slot: ResponsesFuncSlot = {
    callId: String(item.call_id ?? item.id ?? createToolCallId()),
    name: String(item.name ?? 'unknown_tool'),
    args: typeof item.arguments === 'string' ? item.arguments : '',
    announced: false
  };
  registerSlot(ctx.agg, String(item.id ?? ''), slot);
  announceSlot(slot, ctx.onChunk);
  return true;
};

const onResponsesOutputItemDone: ResponsesEventHandler = (ctx) => {
  const item = ctx.parsed.item;
  if (isRecord(item) && item.type === 'function_call') finalizeFunctionCall(ctx, functionCallFields(item));
  return true;
};

const onResponsesArgumentsDelta: ResponsesEventHandler = (ctx) => {
  const itemId = String(ctx.parsed.item_id ?? '');
  const fragment = typeof ctx.parsed.delta === 'string' ? ctx.parsed.delta : '';
  if (!itemId || !fragment) return true;
  let slot = ctx.agg.funcByItemId.get(itemId);
  if (!slot) {
    slot = { callId: itemId, name: '', args: '', announced: false };
    ctx.agg.funcByItemId.set(itemId, slot);
  }
  announceSlot(slot, ctx.onChunk);
  appendSlotArgs(slot, fragment, ctx.onChunk);
  return true;
};

const onResponsesArgumentsDone: ResponsesEventHandler = (ctx) => {
  const { parsed } = ctx;
  if (isRecord(parsed.item) && parsed.item.type === 'function_call') {
    finalizeFunctionCall(ctx, functionCallFields(parsed.item));
  } else if (typeof parsed.call_id === 'string' || typeof parsed.item_id === 'string') {
    finalizeFunctionCall(ctx, {
      itemId: String(parsed.item_id ?? ''),
      callId: String(parsed.call_id ?? ''),
      name: String(parsed.name ?? ''),
      rawArgs: parsed.arguments
    });
  }
  return true;
};

function responsesFailure(response: Record<string, unknown>, status: string): UpstreamStreamError {
  return response.error
    ? midStreamError('OpenAI Responses', response.error)
    : new UpstreamStreamError(`Responses stream ended with status=${status}`, status);
}

const onResponsesTerminal: ResponsesEventHandler = (ctx) => {
  const response = isRecord(ctx.parsed.response) ? ctx.parsed.response : null;
  const status = typeof response?.status === 'string' ? response.status : '';
  if (response && (status === 'failed' || status === 'cancelled')) throw responsesFailure(response, status);
  ctx.agg.terminated = true;
  ctx.agg.terminalResponse = response;
  return true;
};

const onResponsesFailed: ResponsesEventHandler = (ctx) => {
  throw responsesFailure(isRecord(ctx.parsed.response) ? ctx.parsed.response : {}, 'failed');
};

const onResponsesCancelled: ResponsesEventHandler = (ctx) => {
  throw responsesFailure(isRecord(ctx.parsed.response) ? ctx.parsed.response : {}, 'cancelled');
};

const onResponsesErrorEvent: ResponsesEventHandler = (ctx) => {
  const { parsed } = ctx;
  throw midStreamError(
    'OpenAI Responses',
    isRecord(parsed.error) ? parsed.error : { message: parsed.message ?? parsed.error, code: parsed.code }
  );
};

const RESPONSES_STREAM_HANDLERS: Readonly<Record<string, ResponsesEventHandler>> = {
  'response.output_text.delta': onResponsesTextDelta,
  'response.output_text.done': onResponsesTextDone,
  'response.output_item.delta': onResponsesOutputItemDelta,
  'response.reasoning_summary_text.delta': onResponsesReasoningDelta,
  'response.reasoning_summary_part.delta': onResponsesReasoningDelta,
  'response.reasoning_text.delta': onResponsesReasoningDelta,
  'response.output_item.added': onResponsesOutputItemAdded,
  'response.output_item.done': onResponsesOutputItemDone,
  'response.function_call_arguments.delta': onResponsesArgumentsDelta,
  'response.function_call_arguments.done': onResponsesArgumentsDone,
  'response.completed': onResponsesTerminal,
  'response.done': onResponsesTerminal,
  'response.incomplete': onResponsesTerminal,
  'response.failed': onResponsesFailed,
  'response.cancelled': onResponsesCancelled,
  error: onResponsesErrorEvent
};

function handleResponsesStreamEvent(
  parsed: Record<string, unknown>,
  agg: ResponsesStreamAgg,
  onChunk: (chunk: ModelStreamChunk) => void,
  env: NodeJS.ProcessEnv
): void {
  const typ = typeof parsed.type === 'string' ? parsed.type : '';
  const handler = Object.hasOwn(RESPONSES_STREAM_HANDLERS, typ) ? RESPONSES_STREAM_HANDLERS[typ] : undefined;
  const handled = handler ? handler({ parsed, agg, onChunk }) : false;
  if (!handled && typ.startsWith('response.') && llmPromptDebugEnabled(env)) {
    responsesStreamLog.debug('unhandled responses stream event type', { type: typ });
  }
}

/** Gateways that omit `output` on the terminal event: rebuild the turn from deltas. */
function responsesResultFromDeltas(agg: ResponsesStreamAgg): ModelTurnResult {
  const assistantParts: MessagePart[] = [];
  if (agg.reasoningAcc.trim()) assistantParts.push({ type: 'reasoning', text: agg.reasoningAcc.trim() });
  if (agg.textAcc) assistantParts.push({ type: 'text', text: agg.textAcc });
  const seenCall = new Set<string>();
  for (const slot of agg.funcByItemId.values()) {
    if (!slot.name || !slot.callId || seenCall.has(slot.callId)) continue;
    seenCall.add(slot.callId);
    assistantParts.push({
      type: 'tool_call',
      toolCallId: slot.callId,
      name: slot.name,
      input: parseModelToolArguments(slot.args)
    });
  }
  if (assistantParts.length === 0) return { assistantParts: [{ type: 'text', text: '' }], stopReason: 'end' };
  const result: ModelTurnResult = {
    assistantParts,
    stopReason: resolveModelStopReason(undefined, seenCall.size)
  };
  const usage = normalizeOpenAiUsage(agg.terminalResponse?.usage);
  if (usage) result.usage = usage;
  return result;
}

function finishResponsesStream(agg: ResponsesStreamAgg): ModelTurnResult {
  if (!agg.terminated) throw prematureStreamEnd('OpenAI Responses', 'response.completed');
  const response = agg.terminalResponse;
  const terminal = response ? parseResponsesOutputToTurnResult(response) : undefined;
  // Prefer actual terminal content (including gateway output_text), otherwise
  // retain streamed deltas while still carrying terminal usage/truncation.
  if (terminal?.assistantParts.some(part => part.type !== 'text' || part.text !== '')) return terminal;
  const result = responsesResultFromDeltas(agg);
  if (terminal?.usage) result.usage = terminal.usage;
  if (terminal?.finishReason) result.finishReason = terminal.finishReason;
  if (terminal?.truncated) result.truncated = true;
  return result;
}

async function readResponsesStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: ModelStreamChunk) => void,
  env: NodeJS.ProcessEnv
): Promise<ModelTurnResult> {
  const agg: ResponsesStreamAgg = {
    textAcc: '',
    reasoningAcc: '',
    funcByItemId: new Map(),
    terminalResponse: null,
    terminated: false
  };
  await readSseData(body, (data) => {
    if (data === '[DONE]') {
      agg.terminated = true;
      return;
    }
    const parsed = parseSseJson(data);
    if (parsed) handleResponsesStreamEvent(parsed, agg, onChunk, env);
  });
  return finishResponsesStream(agg);
}

type ChatToolSlot = { id: string; name: string; args: string };

type ChatStreamAgg = {
  textAcc: string;
  reasoningAcc: string;
  toolAcc: Map<number, ChatToolSlot>;
  finishReason?: string;
  rawUsage?: Record<string, unknown>;
  /** `finish_reason` or `[DONE]` arrived; without either the connection dropped mid-answer. */
  completed: boolean;
};

function applyChatToolCallDelta(
  agg: ChatStreamAgg,
  tc: Record<string, unknown>,
  onChunk: (chunk: ModelStreamChunk) => void
): void {
  const idx = typeof tc.index === 'number' ? tc.index : 0;
  const id = typeof tc.id === 'string' ? tc.id : '';
  const fn = isRecord(tc.function) ? tc.function : {};
  const name = typeof fn.name === 'string' ? fn.name : '';
  const fragment = typeof fn.arguments === 'string' ? fn.arguments : '';
  let slot = agg.toolAcc.get(idx);
  if (!slot) {
    slot = { id, name: '', args: '' };
    agg.toolAcc.set(idx, slot);
    if (id) onChunk({ type: 'tool_call_start', toolCallId: id, name });
  }
  if (id) slot.id = id;
  if (name) slot.name = name;
  if (fragment) {
    slot.args += fragment;
    onChunk({ type: 'tool_call_delta', toolCallId: slot.id || String(idx), argumentsFragment: fragment });
  }
}

function handleChatStreamChunk(
  parsed: Record<string, unknown>,
  agg: ChatStreamAgg,
  onChunk: (chunk: ModelStreamChunk) => void
): void {
  if (parsed.error) throw midStreamError('OpenAI', parsed.error);
  // The include_usage final chunk carries top-level `usage` and empty `choices`.
  if (isRecord(parsed.usage)) agg.rawUsage = parsed.usage;
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  if (!isRecord(choice)) return;
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    agg.finishReason = choice.finish_reason;
    agg.completed = true;
  }
  const delta = isRecord(choice.delta) ? choice.delta : undefined;
  if (!delta) return;
  const reasoningPiece = coalesceOpenAiReasoningText(delta);
  if (reasoningPiece) {
    agg.reasoningAcc += reasoningPiece;
    onChunk({ type: 'reasoning_delta', text: reasoningPiece });
  }
  if (typeof delta.content === 'string' && delta.content) {
    agg.textAcc += delta.content;
    onChunk({ type: 'text_delta', text: delta.content });
  }
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const tc of toolCalls) {
    if (isRecord(tc)) applyChatToolCallDelta(agg, tc, onChunk);
  }
}

function finishChatStream(agg: ChatStreamAgg): ModelTurnResult {
  if (!agg.completed) throw prematureStreamEnd('OpenAI', 'finish_reason or [DONE]');
  const assistantParts: MessagePart[] = [];
  if (agg.reasoningAcc.trim()) assistantParts.push({ type: 'reasoning', text: agg.reasoningAcc.trim() });
  if (agg.textAcc.trim()) assistantParts.push({ type: 'text', text: agg.textAcc });
  const sortedTools = [...agg.toolAcc.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, slot] of sortedTools) {
    if (!slot.name) continue;
    assistantParts.push({
      type: 'tool_call',
      toolCallId: slot.id || createToolCallId(),
      name: slot.name,
      input: parseModelToolArguments(slot.args)
    });
  }
  const { finishReason } = agg;
  const result: ModelTurnResult = {
    assistantParts,
    stopReason: resolveModelStopReason(finishReason, assistantParts.filter((p) => p.type === 'tool_call').length),
    finishReason
  };
  const usage = normalizeOpenAiUsage(agg.rawUsage);
  if (usage) result.usage = usage;
  if (isTruncatedFinish(finishReason)) result.truncated = true;
  return result;
}

async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: ModelStreamChunk) => void
): Promise<ModelTurnResult> {
  const agg: ChatStreamAgg = { textAcc: '', reasoningAcc: '', toolAcc: new Map(), completed: false };
  await readSseData(body, (data) => {
    if (data === '[DONE]') {
      agg.completed = true;
      return;
    }
    const parsed = parseSseJson(data);
    if (parsed) handleChatStreamChunk(parsed, agg, onChunk);
  });
  return finishChatStream(agg);
}

/**
 * Feeds each SSE `data:` payload to `onData`. If `onData` throws (a mid-stream
 * error event), the body is cancelled so the upstream connection is released.
 */
async function readSseData(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data) onData(data);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) flush(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) flush(buffer);
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
}

function parseSseJson(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

interface OpenedSseStream {
  body: ReadableStream<Uint8Array>;
  /** Header request id, else the first id seen in the stream body. */
  requestId(): string | undefined;
}

async function openSseStream(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  errorPrefix: string
): Promise<OpenedSseStream> {
  const raw = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal
  });
  if (!raw.ok || !raw.body) {
    const text = await raw.text();
    throw upstreamHttpError(errorPrefix, raw, text, resolveUpstreamRequestId({ headers: raw.headers, bodyText: text }));
  }
  let requestId = pickUpstreamRequestIdFromHeaders(raw.headers);
  const response = wrapResponseToCaptureUpstreamRequestId(raw, (id) => {
    if (!requestId) requestId = id;
  });
  return { body: response.body!, requestId: () => requestId };
}

interface PostJsonResult<T> {
  data: T;
  /** Upstream request id from response headers or body (observability). */
  requestId?: string;
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  init?: { signal?: AbortSignal }
): Promise<PostJsonResult<T>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body),
    signal: init?.signal
  });

  const text = await response.text();
  const requestId = resolveUpstreamRequestId({ headers: response.headers, bodyText: text });
  if (!response.ok) {
    throw upstreamHttpError('Remote adapter request failed with', response, text, requestId);
  }

  return { data: JSON.parse(text) as T, requestId };
}

function attachRequestId(result: ModelTurnResult, requestId?: string): ModelTurnResult {
  if (requestId) result.requestId = requestId;
  return result;
}

async function buildOpenAiMessages(
  systemPrompt: string,
  messages: SessionMessage[],
  resolveImage?: (assetId: string, signal?: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal
): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = [
    {
      role: 'system',
      // Some OpenAI-compatible chat templates accept exactly one leading
      // system message. Preserve runtime notices at system authority without
      // sending mid-conversation system roles or mutating the stored history.
      content: [systemPrompt, ...messages.filter(message => message.role === 'system').map(message => textFromParts(message.parts))].join('\n\n')
    }
  ];

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type !== 'tool_result') continue;
        output.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: formatToolResultForLlm(part)
        });
      }
      continue;
    }

    const toolCalls = message.parts
      .filter((part): part is Extract<MessagePart, { type: 'tool_call' }> => part.type === 'tool_call')
      .map((part) => ({
        id: part.toolCallId,
        type: 'function',
        function: {
          name: part.name,
          arguments: canonicalJson(part.input)
        }
      }));

    if (message.role === 'assistant') {
      const text = assistantOpenAiTextFromParts(message.parts);
      output.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'user') {
      const contentBlocks: Array<Record<string, unknown>> = [];
      let textAcc = '';
      for (const part of message.parts) {
        if (part.type === 'text') {
          textAcc += (textAcc ? '\n' : '') + part.text;
        } else if (part.type === 'image') {
          if (textAcc.trim()) {
            contentBlocks.push({ type: 'text', text: textAcc.trim() });
            textAcc = '';
          }
          if (resolveImage) {
            const url = await resolveImage(part.assetId, signal);
            if (url) {
              contentBlocks.push({
                type: 'image_url',
                image_url: { url }
              });
            } else {
              textAcc += `[missing image ${part.assetId}]`;
            }
          } else {
            textAcc += `[image ${part.assetId}]`;
          }
        }
      }
      if (textAcc.trim()) {
        contentBlocks.push({ type: 'text', text: textAcc.trim() });
      }
      let content: string | Array<Record<string, unknown>>;
      if (contentBlocks.length === 0) {
        content = '';
      } else if (contentBlocks.length === 1 && contentBlocks[0]!.type === 'text') {
        content = String((contentBlocks[0] as { text: string }).text);
      } else {
        content = contentBlocks;
      }
      output.push({
        role: 'user',
        content
      });
      continue;
    }

    output.push({
      role: message.role,
      content: textFromParts(message.parts)
    });
  }

  return output;
}

/**
 * Maps persisted session messages to OpenAI `/v1/responses` `input` items.
 * Do not pass Chat Completions `messages` here — Responses uses `function_call` /
 * `function_call_output` items and `message` content blocks (`input_text` / `input_image`),
 * not `role: tool` or `tool_calls` on assistant messages.
 *
 * Persisted assistant `reasoning` parts are **not** replayed as `type: 'reasoning'` input items
 * (many gateways reject that shape); they are folded into assistant `message` items as
 * `output_text` with a short prefix so multi-turn transcripts stay valid.
 */
async function buildResponsesApiInput(
  messages: SessionMessage[],
  resolveImage?: (assetId: string, signal?: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type !== 'tool_result') continue;
        out.push({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: formatToolResultForLlm(part)
        });
      }
      continue;
    }

    if (message.role === 'system') {
      const text = textFromParts(message.parts).trim();
      if (text) {
        out.push({
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text }]
        });
      }
      continue;
    }

    if (message.role === 'user') {
      const content: Array<Record<string, unknown>> = [];
      let textAcc = '';
      for (const part of message.parts) {
        if (part.type === 'text') {
          textAcc += (textAcc ? '\n' : '') + part.text;
        } else if (part.type === 'image') {
          if (textAcc.trim()) {
            content.push({ type: 'input_text', text: textAcc.trim() });
            textAcc = '';
          }
          if (resolveImage) {
            const url = await resolveImage(part.assetId, signal);
            if (url) {
              content.push({
                type: 'input_image',
                image_url: url,
                detail: 'auto' as const
              });
            } else {
              textAcc += `[missing image ${part.assetId}]`;
            }
          } else {
            textAcc += `[image ${part.assetId}]`;
          }
        }
      }
      if (textAcc.trim()) {
        content.push({ type: 'input_text', text: textAcc.trim() });
      }
      if (content.length > 0) {
        out.push({
          type: 'message',
          role: 'user',
          content
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      /**
       * `/v1/responses` `input` is not documented to accept replaying model `reasoning` items
       * (`{ type: 'reasoning', summary }` is output-shaped). Fold persisted reasoning into
       * assistant `message` `output_text` so strict gateways avoid 400 on multi-turn transcripts.
       */
      let reasoningBuf = '';
      const takeReasoningPrefix = (): string => {
        const r = reasoningBuf.trim();
        reasoningBuf = '';
        if (!r) return '';
        return `[Earlier reasoning]\n${r}\n\n`;
      };
      for (const part of message.parts) {
        if (part.type === 'reasoning') {
          const r = (part.text ?? '').trim();
          if (r) reasoningBuf += (reasoningBuf ? '\n\n' : '') + r;
        } else if (part.type === 'text') {
          const t = (part.text ?? '').trim();
          const combined = `${takeReasoningPrefix()}${t}`.trim();
          if (combined) {
            out.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: combined }]
            });
          }
        } else if (part.type === 'tool_call') {
          const prefix = takeReasoningPrefix().trim();
          if (prefix) {
            out.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: prefix }]
            });
          }
          out.push({
            type: 'function_call',
            call_id: part.toolCallId,
            name: part.name,
            arguments: canonicalJson(part.input),
            status: 'completed' as const
          });
        }
      }
      const tail = takeReasoningPrefix().trim();
      if (tail) {
        out.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: tail }]
        });
      }
      continue;
    }

    const fallback = textFromParts(message.parts).trim();
    if (fallback) {
      out.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: fallback }]
      });
    }
  }

  return out;
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | undefined {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/is);
  if (!m?.[1] || !m[2]) return undefined;
  return { mediaType: m[1], base64: m[2] };
}

async function buildAnthropicMessages(
  messages: SessionMessage[],
  resolveImage?: (assetId: string, signal?: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal
): Promise<{
  messages: Array<Record<string, unknown>>;
  refusalReminder: string | null;
}> {
  const output: Array<Record<string, unknown>> = [];
  let refusalReminder: string | null = null;

  for (const message of messages) {
    if (message.role === 'system') {
      // Extract refusal preservation reminder to fold into Anthropic system payload
      if (message.id === '__refusal_preservation__') {
        refusalReminder = textFromParts(message.parts);
      }
      continue;
    }

    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type !== 'tool_result') continue;
        output.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: part.toolCallId,
              content: formatToolResultForLlm(part),
              is_error: !part.ok
            }
          ]
        });
      }
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      if (part.type === 'reasoning') {
        content.push({ type: 'text', text: part.text });
      }
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      }
      if (part.type === 'image' && resolveImage) {
        const dataUrl = await resolveImage(part.assetId, signal);
        const parsed = dataUrl ? parseDataUrl(dataUrl) : undefined;
        if (parsed) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mediaType,
              data: parsed.base64
            }
          });
        } else {
          content.push({ type: 'text', text: `[missing image ${part.assetId}]` });
        }
      } else if (part.type === 'image' && !resolveImage) {
        content.push({ type: 'text', text: `[image ${part.assetId}]` });
      }
      if (part.type === 'tool_call') {
        content.push({
          type: 'tool_use',
          id: part.toolCallId,
          name: part.name,
          input: part.input
        });
      }
    }

    output.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content
    });
  }

  return { messages: output, refusalReminder };
}

// ---------------------------------------------------------------------------
// Heuristic adapter
// ---------------------------------------------------------------------------

/** Marker in heuristic long-bash stdout so Lab e2e can assert stored vs stub. */
export const HEURISTIC_LONG_BASH_MARKER = 'MODEL_VIEW_BASH_MARKER-';

/** Safe, approval-free command that prints >100 chars (default minChars). */
export const HEURISTIC_LONG_BASH_COMMAND = `node -e "console.log('${HEURISTIC_LONG_BASH_MARKER}' + 'x'.repeat(180))"`;

function wantsHeuristicLongBash(text: string): boolean {
  return (
    text.includes('long bash') ||
    text.includes('长 bash') ||
    text.includes('跑一段长 bash') ||
    text.includes('长bash')
  );
}

function hasNamedToolResult(messages: SessionMessage[], name: string): boolean {
  return messages.some((message) =>
    message.parts.some((part) => part.type === 'tool_result' && part.name === name)
  );
}

export class HeuristicModelAdapter implements ModelAdapter {
  readonly name = 'heuristic';

  async completeText(input: {
    system: string;
    user: string;
    signal?: AbortSignal;
    jsonMode?: boolean;
  }): Promise<string> {
    void input;
    // Fail-open friendly default for goal judge in heuristic mode.
    return JSON.stringify({ met: true, reason: 'heuristic adapter: no real judge' });
  }

  async runTurn(input: ModelTurnInput): Promise<ModelTurnResult> {
    const lastSummary = lastUserSummaryText(input.messages).toLowerCase();
    const lastUtterance = lastUserUtterance(input.messages).toLowerCase();

    if (!lastSummary) {
      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'No input.' }]
      };
    }

    if (lastSummary.includes('[image') && !lastUtterance) {
      return {
        stopReason: 'end',
        assistantParts: [
          {
            type: 'text',
            text: '收到图片。当前为 heuristic 模式，请配置 RAW_AGENT_MODEL_PROVIDER=openai-compatible 与 VL 环境变量以进行视觉理解；或使用 vision_analyze 工具（配置 VL 后）。'
          }
        ]
      };
    }

    // Tool intents before greetings: working-log appendix often repeats a prior「你好」.
    if (lastUtterance.includes('list files') || lastUtterance.includes('列出文件')) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'heuristic_read_dir',
            name: 'read_file',
            input: {}
          }
        ]
      };
    }

    if (
      lastUtterance.includes('hello') ||
      lastUtterance.includes('你好') ||
      lastUtterance.includes('hi')
    ) {
      return {
        stopReason: 'end',
        assistantParts: [
          {
            type: 'text',
            text: '你好，我现在已经是一个基于工具循环的裸 agent runtime 了。你可以直接聊天，也可以让我读文件、跑命令、建任务。'
          }
        ]
      };
    }

    // Lab「送模视图」e2e / 本地 heuristic：打出一条足够长的 bash 结果，
    // 供 after_text_assistant 在后续轮次换成占位。已有 bash 结果则不再连打。
    if (wantsHeuristicLongBash(lastUtterance) && !hasNamedToolResult(input.messages, 'bash')) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'heuristic_bash_long',
            name: 'bash',
            input: { command: HEURISTIC_LONG_BASH_COMMAND }
          }
        ]
      };
    }

    return {
      stopReason: 'end',
      assistantParts: [
        {
          type: 'text',
          text: `Heuristic adapter reply: ${lastUserSummaryText(input.messages)}`
        }
      ]
    };
  }

  async summarizeMessages(input: SummaryInput): Promise<string> {
    const recent = input.messages
      .slice(-8)
      .map((message) => {
        const row = summaryMessagePayload(message);
        const stamp = row.writtenAt ? ` writtenAt=${row.writtenAt}` : '';
        return `${row.role}${stamp}: ${row.text}`;
      });
    return `Summary for ${input.reason}: ${recent.join(' | ')}`.slice(0, 4000);
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter (base of OpenAiChatAdapter / OpenAiResponsesAdapter;
// use it directly when the wire format is chosen at runtime)
// ---------------------------------------------------------------------------

export interface OpenAICompatibleAdapterOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  useJsonMode: boolean;
  /** When `responses`, POST `/v1/responses` with `input` (OpenAI reasoning / interleaved tools). */
  httpKind?: OpenAiHttpKind;
  /** Process environment for debug-logging checks; defaults to `{}`. */
  env?: NodeJS.ProcessEnv;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly name: string = 'openai-compatible';
  get modelName(): string { return this.options.model; }

  protected readonly options: Required<OpenAICompatibleAdapterOptions>;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.options = {
      httpKind: 'chat_completions',
      env: {},
      ...options,
      apiKey: normalizeRemoteSecret(options.apiKey),
      baseUrl: normalizeRemoteSecret(options.baseUrl),
      model: normalizeRemoteSecret(options.model)
    };
  }

  private get httpKind(): OpenAiHttpKind {
    return this.options.httpKind;
  }

  async completeText(input: {
    system: string;
    user: string;
    signal?: AbortSignal;
    jsonMode?: boolean;
  }): Promise<string> {
    const endpoint = openAiCompatEndpoint(this.options.baseUrl, this.httpKind);
    if (this.httpKind === 'responses') {
      const { data: result } = await postJson<Record<string, unknown>>(
        endpoint,
        {
          model: this.options.model,
          instructions: input.system,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: input.user }]
            }
          ]
        },
        { authorization: `Bearer ${this.options.apiKey}` },
        { signal: input.signal }
      );
      const turn = parseResponsesOutputToTurnResult(result);
      return turn.assistantParts
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
    }
    const useJson = input.jsonMode !== false && this.options.useJsonMode;
    const { data: result } = await postJson<{
      choices?: Array<{ message?: { content?: string | null } }>;
    }>(
      endpoint,
      {
        model: this.options.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user }
        ],
        ...(useJson ? { response_format: { type: 'json_object' } } : {})
      },
      { authorization: `Bearer ${this.options.apiKey}` },
      { signal: input.signal }
    );
    return result.choices?.[0]?.message?.content?.trim() ?? '';
  }

  async runTurn(input: ModelTurnInput): Promise<ModelTurnResult> {
    type ChatResponse = {
      usage?: Record<string, unknown>;
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          thinking?: string | null;
          tool_calls?: Array<{
            id: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
      }>;
    };

    const tools = toolDefinitions(input.tools);
    const endpoint = openAiCompatEndpoint(this.options.baseUrl, this.httpKind);

    if (this.httpKind === 'responses') {
      const responsesInput = await buildResponsesApiInput(
        input.messages,
        input.resolveImageDataUrl,
        input.signal
      );
      const payload = {
        model: this.options.model,
        instructions: input.systemPrompt,
        input: responsesInput,
        tools: mapToolDefinitionsToResponsesFormat(tools),
        tool_choice: 'auto' as const,
        ...(input.promptCacheKey ? { prompt_cache_key: input.promptCacheKey } : {})
      };
      await maybeLogLlmRequest(this.options.env, input.debugLlmContext, this.name, {
        kind: 'responses',
        ...payload
      });
      const { data: result, requestId } = await postJson<Record<string, unknown>>(
        endpoint,
        payload,
        {
          authorization: `Bearer ${this.options.apiKey}`
        },
        { signal: input.signal }
      );
      return attachRequestId(parseResponsesOutputToTurnResult(result), requestId);
    }

    const msgs = await buildOpenAiMessages(
      input.systemPrompt,
      input.messages,
      input.resolveImageDataUrl,
      input.signal
    );
    const payload = {
      model: this.options.model,
      messages: msgs,
      tools,
      tool_choice: 'auto',
      ...(input.promptCacheKey ? { prompt_cache_key: input.promptCacheKey } : {})
    };

    await maybeLogLlmRequest(this.options.env, input.debugLlmContext, this.name, {
      kind: 'chat.completions',
      ...payload
    });

    const { data: result, requestId } = await postJson<ChatResponse>(
      endpoint,
      payload,
      {
        authorization: `Bearer ${this.options.apiKey}`
      },
      { signal: input.signal }
    );

    const choice = result.choices?.[0];
    const assistantParts: MessagePart[] = [];
    const msg = choice?.message;
    const reasoning = coalesceOpenAiReasoningText(
      msg as Record<string, unknown> | null | undefined
    ).trim();
    if (reasoning) {
      assistantParts.push({ type: 'reasoning', text: reasoning });
    }
    const content = msg?.content;
    if (typeof content === 'string' && content.trim()) {
      assistantParts.push({
        type: 'text',
        text: content
      });
    }

    for (const toolCall of choice?.message?.tool_calls ?? []) {
      assistantParts.push({
        type: 'tool_call',
        toolCallId: toolCall.id,
        name: toolCall.function?.name ?? 'unknown_tool',
        input: parseModelToolArguments(toolCall.function?.arguments)
      });
    }

    const finishReason = choice?.finish_reason ?? undefined;
    const usage = normalizeOpenAiUsage(result.usage);
    const turnResult: ModelTurnResult = {
      stopReason: resolveModelStopReason(finishReason, choice?.message?.tool_calls?.length ?? 0),
      assistantParts,
      finishReason
    };
    if (usage) turnResult.usage = usage;
    if (isTruncatedFinish(finishReason)) turnResult.truncated = true;
    return attachRequestId(turnResult, requestId ?? pickUpstreamRequestIdFromRecord(result));
  }

  async runTurnStream(
    input: ModelTurnInput,
    onChunk: (chunk: ModelStreamChunk) => void
  ): Promise<ModelTurnResult> {
    const tools = toolDefinitions(input.tools);
    const endpoint = openAiCompatEndpoint(this.options.baseUrl, this.httpKind);
    const payload =
      this.httpKind === 'responses'
        ? {
            model: this.options.model,
            instructions: input.systemPrompt,
            input: await buildResponsesApiInput(
              input.messages,
              input.resolveImageDataUrl,
              input.signal
            ),
            tools: mapToolDefinitionsToResponsesFormat(tools),
            tool_choice: 'auto' as const,
            stream: true,
            ...(input.promptCacheKey ? { prompt_cache_key: input.promptCacheKey } : {})
          }
        : {
            model: this.options.model,
            messages: await buildOpenAiMessages(
              input.systemPrompt,
              input.messages,
              input.resolveImageDataUrl,
              input.signal
            ),
            tools,
            tool_choice: 'auto',
            stream: true,
            // Ask the provider to emit a final usage-only chunk (empty choices + usage).
            stream_options: { include_usage: true },
            ...(input.promptCacheKey ? { prompt_cache_key: input.promptCacheKey } : {})
          };

    await maybeLogLlmRequest(this.options.env, input.debugLlmContext, this.name, {
      kind: this.httpKind === 'responses' ? 'responses.stream' : 'chat.completions.stream',
      ...payload
    });

    const stream = await openSseStream(
      endpoint,
      payload,
      { authorization: `Bearer ${this.options.apiKey}` },
      input.signal,
      'OpenAI stream failed'
    );
    const result =
      this.httpKind === 'responses'
        ? await readResponsesStream(stream.body, onChunk, this.options.env)
        : await readChatStream(stream.body, onChunk);
    onChunk({ type: 'done', stopReason: result.stopReason });
    return attachRequestId(result, stream.requestId());
  }

  async summarizeMessages(input: SummaryInput): Promise<string> {
    type ChatResponse = {
      choices?: Array<{
        message?: { content?: string | null };
      }>;
    };

    // Under `/v1/responses` we take plain `output_text` (no `response_format`); summaries are
    // free-form prose, not guaranteed `{"summary":...}` JSON.
    const useJsonFormat = this.options.useJsonMode && this.httpKind !== 'responses';
    const summMessages = [
      {
        role: 'system',
        content: summarizeContinuationInstruction(useJsonFormat)
      },
      {
        role: 'user',
        content: JSON.stringify(input.messages.map((message) => summaryMessagePayload(message)))
      }
    ];

    const endpoint = openAiCompatEndpoint(this.options.baseUrl, this.httpKind);

    if (this.httpKind === 'responses') {
      const payload = {
        model: this.options.model,
        instructions: summMessages[0]!.content as string,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: String(summMessages[1]!.content) }]
          }
        ]
      };
      const { data: result } = await postJson<Record<string, unknown>>(
        endpoint,
        payload,
        {
          authorization: `Bearer ${this.options.apiKey}`
        }
      );
      const turn = parseResponsesOutputToTurnResult(result);
      const text = turn.assistantParts
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
      return text || 'Conversation compacted.';
    }

    const payload = {
      model: this.options.model,
      messages: summMessages,
      ...(useJsonFormat
        ? {
            response_format: {
              type: 'json_object'
            }
          }
        : {})
    };

    const { data: result } = await postJson<ChatResponse>(endpoint, payload, {
      authorization: `Bearer ${this.options.apiKey}`
    });

    const content = result.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return 'Conversation compacted.';
    }

    if (!useJsonFormat) {
      return content;
    }

    try {
      const parsed = JSON.parse(content) as { summary?: string };
      return parsed.summary?.trim() || content;
    } catch {
      return content;
    }
  }
}

// ---------------------------------------------------------------------------
// Named public adapters
// ---------------------------------------------------------------------------

export interface OpenAiChatAdapterOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  useJsonMode: boolean;
  /** Process environment for debug-logging checks; defaults to `{}`. */
  env?: NodeJS.ProcessEnv;
}

/** OpenAI Chat Completions adapter (`/v1/chat/completions`). */
export class OpenAiChatAdapter extends OpenAICompatibleAdapter {
  override readonly name = 'openai-chat';

  constructor(options: OpenAiChatAdapterOptions) {
    super({ ...options, httpKind: 'chat_completions' });
  }
}

export interface OpenAiResponsesAdapterOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  useJsonMode: boolean;
  /** Process environment for debug-logging checks; defaults to `{}`. */
  env?: NodeJS.ProcessEnv;
}

/** OpenAI Responses API adapter (`/v1/responses`) — reasoning + tool interleaving. */
export class OpenAiResponsesAdapter extends OpenAICompatibleAdapter {
  override readonly name = 'openai-responses';

  constructor(options: OpenAiResponsesAdapterOptions) {
    super({ ...options, httpKind: 'responses' });
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages adapter
// ---------------------------------------------------------------------------

type AnthropicBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; args: string };

type AnthropicStreamAgg = {
  blocks: Map<number, AnthropicBlock>;
  finishReason?: string;
  rawUsage: Record<string, unknown>;
  sawUsage: boolean;
  messageId?: string;
  /** `message_stop` arrived; without it (or a `stop_reason`) the connection dropped mid-answer. */
  stopped: boolean;
};

function mergeAnthropicUsage(agg: AnthropicStreamAgg, usage: unknown): void {
  if (!isRecord(usage)) return;
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v !== 'number') continue;
    agg.rawUsage[k] = v;
    agg.sawUsage = true;
  }
}

function onAnthropicBlockStart(
  agg: AnthropicStreamAgg,
  ev: Record<string, unknown>,
  onChunk: (chunk: ModelStreamChunk) => void
): void {
  const index = typeof ev.index === 'number' ? ev.index : agg.blocks.size;
  const cb = isRecord(ev.content_block) ? ev.content_block : {};
  const cbType = typeof cb.type === 'string' ? cb.type : 'text';
  if (cbType === 'tool_use') {
    const id = typeof cb.id === 'string' && cb.id ? cb.id : createToolCallId();
    const name = typeof cb.name === 'string' ? cb.name : '';
    agg.blocks.set(index, { kind: 'tool_use', id, name, args: '' });
    onChunk({ type: 'tool_call_start', toolCallId: id, name });
  } else if (cbType === 'thinking' || cbType === 'redacted_thinking') {
    agg.blocks.set(index, { kind: 'thinking', text: '' });
  } else {
    const initial = typeof cb.text === 'string' ? cb.text : '';
    agg.blocks.set(index, { kind: 'text', text: initial });
    if (initial) onChunk({ type: 'text_delta', text: initial });
  }
}

function blockForDelta(dType: string): AnthropicBlock {
  if (dType === 'input_json_delta') return { kind: 'tool_use', id: createToolCallId(), name: '', args: '' };
  if (dType === 'thinking_delta') return { kind: 'thinking', text: '' };
  return { kind: 'text', text: '' };
}

function onAnthropicBlockDelta(
  agg: AnthropicStreamAgg,
  ev: Record<string, unknown>,
  onChunk: (chunk: ModelStreamChunk) => void
): void {
  const index = typeof ev.index === 'number' ? ev.index : 0;
  const delta = isRecord(ev.delta) ? ev.delta : {};
  const dType = typeof delta.type === 'string' ? delta.type : '';
  let block = agg.blocks.get(index);
  if (!block) {
    block = blockForDelta(dType);
    agg.blocks.set(index, block);
  }
  if (dType === 'text_delta' && typeof delta.text === 'string' && block.kind === 'text') {
    block.text += delta.text;
    if (delta.text) onChunk({ type: 'text_delta', text: delta.text });
  } else if (dType === 'thinking_delta' && typeof delta.thinking === 'string' && block.kind === 'thinking') {
    block.text += delta.thinking;
    if (delta.thinking) onChunk({ type: 'reasoning_delta', text: delta.thinking });
  } else if (dType === 'input_json_delta' && typeof delta.partial_json === 'string' && block.kind === 'tool_use') {
    block.args += delta.partial_json;
    if (delta.partial_json) {
      onChunk({ type: 'tool_call_delta', toolCallId: block.id, argumentsFragment: delta.partial_json });
    }
  }
}

function handleAnthropicStreamEvent(
  agg: AnthropicStreamAgg,
  ev: Record<string, unknown>,
  onChunk: (chunk: ModelStreamChunk) => void
): void {
  switch (ev.type) {
    case 'message_start': {
      const message = isRecord(ev.message) ? ev.message : {};
      mergeAnthropicUsage(agg, message.usage);
      if (typeof message.id === 'string' && message.id) agg.messageId = message.id;
      return;
    }
    case 'content_block_start':
      onAnthropicBlockStart(agg, ev, onChunk);
      return;
    case 'content_block_delta':
      onAnthropicBlockDelta(agg, ev, onChunk);
      return;
    case 'message_delta': {
      const delta = isRecord(ev.delta) ? ev.delta : {};
      if (typeof delta.stop_reason === 'string') agg.finishReason = delta.stop_reason;
      mergeAnthropicUsage(agg, ev.usage);
      return;
    }
    case 'message_stop':
      agg.stopped = true;
      return;
    case 'error':
      throw midStreamError('Anthropic', ev.error ?? ev);
    default:
      // content_block_stop / ping carry no payload we need.
      return;
  }
}

function anthropicBlocksToParts(blocks: Map<number, AnthropicBlock>): MessagePart[] {
  const assistantParts: MessagePart[] = [];
  for (const [, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    switch (block.kind) {
      case 'thinking':
        if (block.text.trim()) assistantParts.push({ type: 'reasoning', text: block.text.trim() });
        break;
      case 'text':
        if (block.text) assistantParts.push({ type: 'text', text: block.text });
        break;
      case 'tool_use':
        if (!block.name) break;
        assistantParts.push({
          type: 'tool_call',
          toolCallId: block.id,
          name: block.name,
          input: block.args.trim() ? parseModelToolArguments(block.args) : {}
        });
        break;
      default: {
        const _exhaustive: never = block;
        return _exhaustive;
      }
    }
  }
  return assistantParts;
}

function finishAnthropicStream(agg: AnthropicStreamAgg): ModelTurnResult {
  if (!agg.stopped && !agg.finishReason) throw prematureStreamEnd('Anthropic', 'message_stop');
  const assistantParts = anthropicBlocksToParts(agg.blocks);
  const { finishReason } = agg;
  const result: ModelTurnResult = {
    assistantParts,
    stopReason: resolveModelStopReason(finishReason, assistantParts.filter((p) => p.type === 'tool_call').length),
    finishReason
  };
  const usage = agg.sawUsage ? normalizeAnthropicUsage(agg.rawUsage) : undefined;
  if (usage) result.usage = usage;
  if (isTruncatedFinish(finishReason)) result.truncated = true;
  if (agg.messageId) result.requestId = agg.messageId;
  return result;
}

async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: ModelStreamChunk) => void
): Promise<ModelTurnResult> {
  const agg: AnthropicStreamAgg = { blocks: new Map(), rawUsage: {}, sawUsage: false, stopped: false };
  await readSseData(body, (data) => {
    const parsed = data === '[DONE]' ? undefined : parseSseJson(data);
    if (parsed) handleAnthropicStreamEvent(agg, parsed, onChunk);
  });
  return finishAnthropicStream(agg);
}

/** Non-stream `content[]`: thinking → reasoning, redacted_thinking dropped, tool_use → tool_call. */
function anthropicContentToParts(content: unknown): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      parts.push({ type: 'reasoning', text: block.thinking.trim() });
    } else if (block.type === 'tool_use') {
      parts.push({
        type: 'tool_call',
        toolCallId: typeof block.id === 'string' && block.id ? block.id : createToolCallId(),
        name: typeof block.name === 'string' ? block.name : 'unknown_tool',
        input: isRecord(block.input) ? block.input : {}
      });
    }
  }
  return parts;
}

export interface AnthropicMessagesAdapterOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Process environment for debug-logging checks; defaults to `{}`. */
  env?: NodeJS.ProcessEnv;
}

export class AnthropicMessagesAdapter implements ModelAdapter {
  readonly name = 'anthropic-compatible';
  get modelName(): string { return this.options.model; }

  private readonly options: Required<AnthropicMessagesAdapterOptions>;

  constructor(options: AnthropicMessagesAdapterOptions) {
    this.options = {
      env: {},
      ...options,
      apiKey: normalizeRemoteSecret(options.apiKey),
      baseUrl: normalizeRemoteSecret(options.baseUrl),
      model: normalizeRemoteSecret(options.model)
    };
  }

  async completeText(input: {
    system: string;
    user: string;
    signal?: AbortSignal;
    jsonMode?: boolean;
  }): Promise<string> {
    void input.jsonMode;
    const { data: result } = await postJson<{
      content: Array<{ type: 'text'; text: string }>;
    }>(
      `${this.options.baseUrl.replace(/\/$/, '')}/messages`,
      {
        model: this.options.model,
        max_tokens: 1024,
        system: input.system,
        messages: [{ role: 'user', content: input.user }]
      },
      {
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01'
      },
      { signal: input.signal }
    );
    return result.content.find((p) => p.type === 'text')?.text?.trim() ?? '';
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.options.apiKey,
      'anthropic-version': '2023-06-01'
    };
  }

  private messagesEndpoint(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/messages`;
  }

  private async buildTurnPayload(input: ModelTurnInput): Promise<Record<string, unknown>> {
    const { messages: anthropicMsgs, refusalReminder } = await buildAnthropicMessages(
      input.messages,
      input.resolveImageDataUrl,
      input.signal
    );

    // Build system prompt array, merging refusal preservation reminder if present
    const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];
    systemBlocks.push({
      type: 'text',
      text: input.systemPrompt
    });
    if (refusalReminder) {
      systemBlocks.push({
        type: 'text',
        text: refusalReminder
      });
    }
    // Only the last block gets cache_control so we can cache the base system prompt
    systemBlocks[systemBlocks.length - 1]!.cache_control = { type: 'ephemeral' };

    return {
      model: this.options.model,
      // Use structured content blocks on system to enable Anthropic prompt caching.
      // The last block carries cache_control so the provider can cache everything
      // up to and including the system prompt prefix across turns.
      system: systemBlocks,
      max_tokens: 4000,
      messages: anthropicMsgs,
      tools: [...input.tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }))
    };
  }

  async runTurn(input: ModelTurnInput): Promise<ModelTurnResult> {
    type MessagesResponse = {
      stop_reason?: string;
      usage?: Record<string, unknown>;
      content?: unknown;
    };

    const payload = await this.buildTurnPayload(input);

    await maybeLogLlmRequest(this.options.env, input.debugLlmContext, this.name, {
      kind: 'anthropic.messages',
      ...payload
    });

    const { data: result, requestId } = await postJson<MessagesResponse>(
      this.messagesEndpoint(),
      payload,
      this.headers(),
      { signal: input.signal }
    );

    const assistantParts = anthropicContentToParts(result.content);

    const finishReason = result.stop_reason ?? undefined;
    const usage = normalizeAnthropicUsage(result.usage);
    const turnResult: ModelTurnResult = {
      stopReason: resolveModelStopReason(
        finishReason,
        assistantParts.filter((p) => p.type === 'tool_call').length
      ),
      assistantParts,
      finishReason
    };
    if (usage) turnResult.usage = usage;
    if (isTruncatedFinish(finishReason)) turnResult.truncated = true;
    return attachRequestId(turnResult, requestId ?? pickUpstreamRequestIdFromRecord(result));
  }

  /**
   * Anthropic Messages SSE: `message_start` → `content_block_start/delta/stop`*
   * → `message_delta` → `message_stop`. Text / thinking / tool_use blocks are
   * indexed; `input_json_delta` fragments are accumulated per tool block and
   * parsed once the stream ends.
   */
  async runTurnStream(
    input: ModelTurnInput,
    onChunk: (chunk: ModelStreamChunk) => void
  ): Promise<ModelTurnResult> {
    const payload = { ...(await this.buildTurnPayload(input)), stream: true };

    await maybeLogLlmRequest(this.options.env, input.debugLlmContext, this.name, {
      kind: 'anthropic.messages.stream',
      ...payload
    });

    const stream = await openSseStream(
      this.messagesEndpoint(),
      payload,
      this.headers(),
      input.signal,
      'Anthropic stream failed'
    );
    const result = await readAnthropicStream(stream.body, onChunk);
    onChunk({ type: 'done', stopReason: result.stopReason });
    return attachRequestId(result, stream.requestId());
  }

  async summarizeMessages(input: SummaryInput): Promise<string> {
    type MessagesResponse = {
      content: Array<{ type: 'text'; text: string }>;
    };

    const { data: result } = await postJson<MessagesResponse>(
      this.messagesEndpoint(),
      {
        model: this.options.model,
        max_tokens: 1000,
        system: summarizeContinuationInstruction(false),
        messages: [
          {
            role: 'user',
            content: JSON.stringify(input.messages.map((message) => summaryMessagePayload(message)))
          }
        ]
      },
      {
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01'
      }
    );

    return result.content.find((part) => part.type === 'text')?.text?.trim() || 'Conversation compacted.';
  }
}

// ---------------------------------------------------------------------------
// Hybrid router
// ---------------------------------------------------------------------------

export class HybridModelRouterAdapter implements ModelAdapter {
  readonly name = 'hybrid-router';

  constructor(
    private readonly textAdapter: ModelAdapter,
    private readonly vlAdapter: ModelAdapter,
    private readonly routeScope: 'last_user' | 'any' = 'any'
  ) {}

  private needsVl(input: ModelTurnInput): boolean {
    if (this.routeScope === 'last_user') {
      const last = [...input.messages].reverse().find((m) => m.role === 'user');
      return last?.parts.some((p) => p.type === 'image') ?? false;
    }
    return input.messages.some((m) => m.parts.some((p) => p.type === 'image'));
  }

  async runTurn(input: ModelTurnInput): Promise<ModelTurnResult> {
    return this.needsVl(input) ? this.vlAdapter.runTurn(input) : this.textAdapter.runTurn(input);
  }

  async runTurnStream(
    input: ModelTurnInput,
    onChunk: (chunk: ModelStreamChunk) => void
  ): Promise<ModelTurnResult> {
    const vl = this.needsVl(input);
    if (vl && typeof this.vlAdapter.runTurnStream === 'function') {
      return this.vlAdapter.runTurnStream(input, onChunk);
    }
    if (!vl && typeof this.textAdapter.runTurnStream === 'function') {
      return this.textAdapter.runTurnStream(input, onChunk);
    }
    const result = vl ? await this.vlAdapter.runTurn(input) : await this.textAdapter.runTurn(input);
    if (result.assistantParts[0]?.type === 'text') {
      onChunk({ type: 'text_delta', text: result.assistantParts[0].text });
    }
    onChunk({ type: 'done', stopReason: result.stopReason });
    return result;
  }

  async summarizeMessages(input: SummaryInput): Promise<string> {
    return this.textAdapter.summarizeMessages(input);
  }

  async completeText(input: {
    system: string;
    user: string;
    signal?: AbortSignal;
    jsonMode?: boolean;
  }): Promise<string> {
    if (typeof this.textAdapter.completeText === 'function') {
      return this.textAdapter.completeText(input);
    }
    return JSON.stringify({ met: true, reason: 'completeText unavailable; fail-open' });
  }
}

// ---------------------------------------------------------------------------
// Single-turn VL helper
// ---------------------------------------------------------------------------

/** Single-turn VL call (OpenAI-style chat.completions) for tools / batch analysis. */
export async function runOpenAiVisionTurn(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  userPrompt: string;
  imageDataUrls: string[];
  signal?: AbortSignal;
}): Promise<string> {
  const content: Array<Record<string, unknown>> = [];
  if (options.userPrompt.trim()) {
    content.push({ type: 'text', text: options.userPrompt.trim() });
  }
  for (const url of options.imageDataUrls) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  type ChatResponse = { choices?: Array<{ message?: { content?: string | null } }> };
  const { data: result } = await postJson<ChatResponse>(
    `${options.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model: options.model,
      messages: [
        {
          role: 'system',
          content: 'You are a vision assistant. Answer concisely in the same language as the user prompt.'
        },
        { role: 'user', content }
      ],
      max_tokens: 2048
    },
    { authorization: `Bearer ${options.apiKey}` },
    { signal: options.signal }
  );
  return result.choices?.[0]?.message?.content?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Factory (env-based DI — env is passed in, never read from process.env here)
// ---------------------------------------------------------------------------

export function createModelAdapterFromEnv(env: NodeJS.ProcessEnv): ModelAdapter {
  const provider = env.RAW_AGENT_MODEL_PROVIDER ?? 'heuristic';
  const useJsonMode = !['0', 'false', 'off'].includes(String(env.RAW_AGENT_USE_JSON_MODE ?? '1').toLowerCase());

  if (provider === 'openai-compatible') {
    const apiKey = normalizeRemoteSecret(env.RAW_AGENT_API_KEY);
    const baseUrl = normalizeRemoteSecret(env.RAW_AGENT_BASE_URL);
    const model = normalizeRemoteSecret(env.RAW_AGENT_MODEL_NAME);
    if (!apiKey || !baseUrl || !model) {
      throw new Error('Missing RAW_AGENT_API_KEY, RAW_AGENT_BASE_URL, or RAW_AGENT_MODEL_NAME');
    }
    const httpKind = normalizeOpenAiHttpKind(env.RAW_AGENT_OPENAI_HTTP_KIND);
    // The shared base adapter keeps httpKind fully dynamic here.
    const textAdapter = new OpenAICompatibleAdapter({ apiKey, baseUrl, model, useJsonMode, httpKind, env });
    const vlModel = env.RAW_AGENT_VL_MODEL_NAME?.trim();
    if (vlModel) {
      const vlBase = (env.RAW_AGENT_VL_BASE_URL ?? baseUrl).trim();
      const vlKey = (env.RAW_AGENT_VL_API_KEY ?? apiKey).trim();
      const vlUseJson =
        !['0', 'false', 'off'].includes(String(env.RAW_AGENT_VL_USE_JSON_MODE ?? '0').toLowerCase());
      const vlHttpRaw = env.RAW_AGENT_VL_OPENAI_HTTP_KIND?.trim();
      const vlHttpKind = vlHttpRaw ? normalizeOpenAiHttpKind(vlHttpRaw) : httpKind;
      const vlAdapter = new OpenAICompatibleAdapter({
        apiKey: vlKey,
        baseUrl: vlBase,
        model: vlModel,
        useJsonMode: vlUseJson,
        httpKind: vlHttpKind,
        env
      });
      const scope: 'last_user' | 'any' =
        env.RAW_AGENT_VL_ROUTE_SCOPE === 'last_user' ? 'last_user' : 'any';
      return new HybridModelRouterAdapter(textAdapter, vlAdapter, scope);
    }
    return textAdapter;
  }

  if (provider === 'anthropic-compatible') {
    const apiKey = normalizeRemoteSecret(env.RAW_AGENT_API_KEY);
    const baseUrl = normalizeRemoteSecret(env.RAW_AGENT_ANTHROPIC_URL ?? env.RAW_AGENT_BASE_URL);
    const model = normalizeRemoteSecret(env.RAW_AGENT_MODEL_NAME);
    if (!apiKey || !baseUrl || !model) {
      throw new Error('Missing RAW_AGENT_API_KEY, RAW_AGENT_ANTHROPIC_URL/RAW_AGENT_BASE_URL, or RAW_AGENT_MODEL_NAME');
    }
    return new AnthropicMessagesAdapter({ apiKey, baseUrl, model, env });
  }

  return new HeuristicModelAdapter();
}
