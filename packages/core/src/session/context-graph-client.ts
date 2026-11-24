/**
 * Ultra-thin, strictly opt-in, fail-open HTTP client for Context Graph v0.2.4
 * artifact compaction (`POST /v1/graphs/:id/ingest-artifacts`).
 *
 * Zero external runtime dependencies (`node:http`, `node:https`, `node:crypto` only).
 * Performs zero work on module import, adds 0 bytes of model tool schema,
 * and contains zero duplicated excerption/slicing/versioning logic.
 */

import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { currentSecretOverrides, getBoundSecretVault } from '../secrets/secret-vault.js';
import type { MessagePart, SessionMessage, ToolCallPart, ToolResultPart } from '../types.js';

export const CONTEXT_GRAPH_ARTIFACT_HEADING = '## Active Artifact State (Context Graph)';
export const DEFAULT_CONTEXT_GRAPH_TIMEOUT_MS = 3_000;
export const MIN_CONTEXT_GRAPH_TIMEOUT_MS = 200;
export const MAX_CONTEXT_GRAPH_TIMEOUT_MS = 15_000;
export const MAX_CONTEXT_GRAPH_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_EVENTS_PER_BATCH = 2_000;
export const DEFAULT_CG_MAX_OUTPUT_CHARS = 720;
export const MIN_CG_BODY_ROOM_CHARS = 320;
export const MIN_CG_PROSE_RESERVE_CHARS = 120;

/** Rejects CR, LF, NUL, and non-tab ASCII control characters. */
const FORBIDDEN_CTRL_RE = /[\r\n\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;
/** Printable ASCII non-whitespace token bytes (`0x21..0x7e`). */
const PRINTABLE_ASCII_TOKEN_RE = /^[\x21-\x7e]+$/;
const SAFE_ERRNO_CODE_RE = /^[A-Z0-9_]{2,32}$/;
const BOT_SECTION_BULLET_RE = /^- (?:Goal|Constraints|Progress|Decisions|Files|Next steps)(?:\s*:|\s*$)/;
const HISTORY_SOURCE_PREFIX = 'History source:';
const ARCHIVE_FOOTER_PREFIX = 'Compacted original transcript:';

export interface ResolvedContextGraphConfig {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface ContextGraphBodyBudget {
  bodyRoom: number;
  maxOutputChars: number | undefined;
}

export interface ContextGraphToolEvent {
  callId: string;
  tool: string;
  args?: Record<string, unknown>;
  ok: boolean;
  output: string;
  seq?: number;
}

export interface ContextGraphPrunedEvent {
  callId: string;
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  seq?: number;
}

export interface ContextGraphCompactionApplied {
  applied: true;
  graphId: string;
  artifactBlock: string;
  prunedEvents: ContextGraphPrunedEvent[];
  prunedCount: number;
  charsSaved: number;
  durationMs: number;
  fallbackReason?: undefined;
}

export interface ContextGraphCompactionFallback {
  applied: false;
  fallbackReason: string;
  durationMs: number;
  graphId?: undefined;
  artifactBlock?: undefined;
  prunedEvents?: undefined;
  prunedCount?: undefined;
  charsSaved?: undefined;
}

export type ContextGraphCompactionOutcome =
  | ContextGraphCompactionApplied
  | ContextGraphCompactionFallback;

export interface IngestAndCompileSessionArtifactsInput {
  sessionId: string;
  messages: readonly SessionMessage[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  signal?: AbortSignal;
  maxOutputChars?: number;
  timeoutMs?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function clampTimeoutMs(value: number): number {
  return Math.min(
    MAX_CONTEXT_GRAPH_TIMEOUT_MS,
    Math.max(MIN_CONTEXT_GRAPH_TIMEOUT_MS, Math.floor(value))
  );
}

function resolveTimeoutMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  explicitTimeoutMs?: number
): number {
  if (typeof explicitTimeoutMs === 'number' && Number.isFinite(explicitTimeoutMs)) {
    return clampTimeoutMs(explicitTimeoutMs);
  }
  for (const candidate of [env.RAW_AGENT_CONTEXT_GRAPH_TIMEOUT_MS, env.CONTEXT_GRAPH_TIMEOUT_MS]) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0
      ? clampTimeoutMs(parsed)
      : DEFAULT_CONTEXT_GRAPH_TIMEOUT_MS;
  }
  return DEFAULT_CONTEXT_GRAPH_TIMEOUT_MS;
}

function validateTokenCandidate(
  candidate: string
): { status: 'empty' } | { status: 'invalid' } | { status: 'ok'; token: string } {
  if (FORBIDDEN_CTRL_RE.test(candidate)) {
    return { status: 'invalid' };
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return { status: 'empty' };
  }
  if (!PRINTABLE_ASCII_TOKEN_RE.test(trimmed)) {
    return { status: 'invalid' };
  }
  return { status: 'ok', token: trimmed };
}

function resolveAuthToken(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): { valid: true; token?: string } | { valid: false } {
  const als = currentSecretOverrides();
  const vault = getBoundSecretVault();
  const keys = [
    'RAW_AGENT_CONTEXT_GRAPH_TOKEN',
    'CONTEXT_GRAPH_TOKEN',
    'CG_AUTH_TOKEN'
  ] as const;

  for (const key of keys) {
    for (const candidate of [als[key], vault?.get(key), env[key]]) {
      if (candidate === undefined) continue;
      const checked = validateTokenCandidate(candidate);
      if (checked.status === 'invalid') return { valid: false };
      if (checked.status === 'ok') return { valid: true, token: checked.token };
    }
  }
  return { valid: true, token: undefined };
}

function extractRawBaseUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string | null {
  for (const candidate of [env.RAW_AGENT_CONTEXT_GRAPH_URL, env.CONTEXT_GRAPH_URL]) {
    if (candidate === undefined) continue;
    if (FORBIDDEN_CTRL_RE.test(candidate)) return null;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function parseValidatedBaseUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Resolves opt-in Context Graph configuration from env, ALS overrides, and bound SecretVault.
 * Returns `null` immediately when unset or invalid (`http:`/`https:` only, no control chars,
 * no embedded credentials, no query/hash, printable ASCII tokens only).
 */
export function resolveContextGraphConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  explicitTimeoutMs?: number
): ResolvedContextGraphConfig | null {
  const rawUrl = extractRawBaseUrl(env);
  if (!rawUrl) return null;

  const baseUrl = parseValidatedBaseUrl(rawUrl);
  if (!baseUrl) return null;

  const auth = resolveAuthToken(env);
  if (!auth.valid) return null;

  return {
    baseUrl,
    token: auth.token,
    timeoutMs: resolveTimeoutMs(env, explicitTimeoutMs),
    maxResponseBytes: MAX_CONTEXT_GRAPH_RESPONSE_BYTES
  };
}

/**
 * Deterministic URL-safe graph ID for a session (`sess_<24 hex chars>`).
 */
export function sessionContextGraphId(sessionId: string): string {
  return `sess_${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
}

/**
 * Computes the exact post-suffix body room matching `boundedSourceSummary`, plus a bounded
 * `maxOutputChars` (`<= 720`, scaling down under tight caps; `undefined` when `< 320c`).
 */
export function computeContextGraphBodyBudget(
  maxChars: number,
  sourceNavigation: string
): ContextGraphBodyBudget {
  const limit = Math.max(0, Math.floor(maxChars));
  const suffixLen =
    sourceNavigation && limit >= sourceNavigation.length + 66 ? sourceNavigation.length + 2 : 0;
  const bodyRoom = Math.max(0, limit - suffixLen);
  if (bodyRoom < MIN_CG_BODY_ROOM_CHARS) {
    return { bodyRoom, maxOutputChars: undefined };
  }
  return {
    bodyRoom,
    maxOutputChars: Math.min(DEFAULT_CG_MAX_OUTPUT_CHARS, Math.floor(bodyRoom * 0.4))
  };
}

function isStripStopLine(trimmed: string): boolean {
  return (
    trimmed.startsWith('## ') ||
    trimmed.startsWith(HISTORY_SOURCE_PREFIX) ||
    trimmed.startsWith(ARCHIVE_FOOTER_PREFIX) ||
    BOT_SECTION_BULLET_RE.test(trimmed)
  );
}

function normalizeKeptBeforeResume(kept: string[], hasNonBlank: boolean): void {
  if (!hasNonBlank) {
    kept.length = 0;
    return;
  }
  while (
    kept.length >= 2 &&
    kept[kept.length - 1]!.trim() === '' &&
    kept[kept.length - 2]!.trim() === ''
  ) {
    kept.pop();
  }
}

/**
 * Strictly linear O(N) line-scan that removes any `## Active Artifact State (Context Graph)`
 * section up to the next non-CG `## ` heading, trailing summary footer (`History source:` /
 * `Compacted original transcript:`), canonical bot section bullet, or end-of-string.
 */
export function stripContextGraphArtifactBlock(text: string): string {
  if (!text || !text.includes(CONTEXT_GRAPH_ARTIFACT_HEADING)) {
    return text;
  }
  const lines = text.split('\n');
  const kept: string[] = [];
  let skipping = false;
  let strippedAny = false;
  let hasNonBlank = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === CONTEXT_GRAPH_ARTIFACT_HEADING) {
      skipping = true;
      strippedAny = true;
      continue;
    }
    if (skipping) {
      if (!isStripStopLine(trimmed)) continue;
      skipping = false;
      normalizeKeptBeforeResume(kept, hasNonBlank);
    }
    kept.push(line);
    if (trimmed.length > 0) hasNonBlank = true;
  }

  if (!strippedAny) return text;
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') {
    kept.pop();
  }
  return kept.join('\n');
}

function demoteArtifactLevel2Headings(block: string): string {
  if (!block.includes('## ')) return block;
  return block
    .split('\n')
    .map((line) => {
      const trimmedStart = line.trimStart();
      if (!trimmedStart.startsWith('## ')) return line;
      const indent = line.slice(0, line.length - trimmedStart.length);
      return `${indent}### ${trimmedStart.slice(3)}`;
    })
    .join('\n');
}

function sanitizeArtifactBlock(artifactBlock: string): string {
  let trimmed = artifactBlock.trim();
  if (trimmed === CONTEXT_GRAPH_ARTIFACT_HEADING) return '';
  if (
    trimmed.startsWith(`${CONTEXT_GRAPH_ARTIFACT_HEADING}\n`) ||
    trimmed.startsWith(`${CONTEXT_GRAPH_ARTIFACT_HEADING}\r\n`)
  ) {
    trimmed = trimmed.slice(CONTEXT_GRAPH_ARTIFACT_HEADING.length).trim();
  }
  if (!trimmed) return '';
  return demoteArtifactLevel2Headings(trimmed);
}

function trimProseHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
  const budget = maxChars - 1;
  const slice = text.slice(0, budget);
  const minBoundary = Math.floor(budget * 0.5);
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline >= minBoundary) {
    return `${slice.slice(0, lastNewline).trimEnd()}…`;
  }
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= minBoundary) {
    return `${slice.slice(0, lastSpace).trimEnd()}…`;
  }
  return `${slice.trimEnd()}…`;
}

/**
 * Strips any echoed Context Graph artifact heading from `summary`, demotes internal `## `
 * headings inside `artifactBlock` to `### `, and appends the artifact section cleanly.
 * When `maxBodyRoom` is finite, omits attachment if `< section.length + 120`, otherwise trims
 * the prose head at a line/word boundary so `trimmedBase + "\n\n" + section <= maxBodyRoom`
 * always holds (preventing `boundedSourceSummary` from slicing prose or the CG heading).
 */
export function attachContextGraphArtifactBlock(
  summary: string,
  artifactBlock: string,
  maxBodyRoom?: number
): string {
  const cleanedSummary = stripContextGraphArtifactBlock(summary);
  const sanitized = sanitizeArtifactBlock(artifactBlock);
  if (!sanitized) return cleanedSummary;

  const section = `${CONTEXT_GRAPH_ARTIFACT_HEADING}\n${sanitized}`;
  const hasCap = typeof maxBodyRoom === 'number' && Number.isFinite(maxBodyRoom);
  if (hasCap && maxBodyRoom < section.length + MIN_CG_PROSE_RESERVE_CHARS) {
    return cleanedSummary;
  }

  const base = cleanedSummary.trimEnd();
  if (!base) return section;

  const fittedBase = hasCap ? trimProseHead(base, maxBodyRoom - section.length - 2) : base;
  return `${fittedBase}\n\n${section}`;
}

function isCarriedSummaryMessage(message: SessionMessage): boolean {
  return message.key === 'compact-summary' || message.id === 'compact-prior-summary';
}

function indexToolCalls(
  messages: readonly SessionMessage[]
): Map<string, { name: string; input?: Record<string, unknown> }> {
  const callsById = new Map<string, { name: string; input?: Record<string, unknown> }>();
  for (const message of messages) {
    if (isCarriedSummaryMessage(message)) continue;
    for (const part of message.parts) {
      if (part.type === 'tool_call' && part.toolCallId) {
        callsById.set(part.toolCallId, {
          name: part.name,
          input: plainObjectOrUndefined(part.input)
        });
      }
    }
  }
  return callsById;
}

function buildToolTrajectoryEvent(
  part: ToolResultPart,
  call: { name: string; input?: Record<string, unknown> } | undefined,
  seq: number | undefined
): ContextGraphToolEvent {
  const event: ContextGraphToolEvent = {
    callId: part.toolCallId,
    tool: part.name || call?.name || 'unknown',
    ok: part.ok !== false,
    output: part.content ?? ''
  };
  if (call?.input !== undefined) event.args = call.input;
  if (seq !== undefined) event.seq = seq;
  return event;
}

/**
 * Pure extraction of tool call/result events from session messages.
 * Skips replacement/summary messages and returns `[]` for pure chat histories.
 */
export function extractToolTrajectoryEvents(
  messages: readonly SessionMessage[]
): ContextGraphToolEvent[] {
  const callsById = indexToolCalls(messages);
  const events: ContextGraphToolEvent[] = [];

  for (const message of messages) {
    if (isCarriedSummaryMessage(message)) continue;
    const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? message.seq : undefined;
    for (const part of message.parts) {
      if (part.type !== 'tool_result' || !part.toolCallId) continue;
      events.push(buildToolTrajectoryEvent(part, callsById.get(part.toolCallId), seq));
    }
  }
  return events;
}

function indexPrunedEvents(
  prunedEvents: readonly ContextGraphPrunedEvent[]
): Map<string, ContextGraphPrunedEvent> {
  const byId = new Map<string, ContextGraphPrunedEvent>();
  for (const ev of prunedEvents) {
    if (ev && typeof ev.callId === 'string' && ev.callId.length > 0) {
      byId.set(ev.callId, ev);
    }
  }
  return byId;
}

function applyPrunedToolCallPart(
  part: ToolCallPart,
  prunedByCallId: Map<string, ContextGraphPrunedEvent>
): ToolCallPart {
  const prunedEv = prunedByCallId.get(part.toolCallId);
  const nextInput = prunedEv?.args !== undefined ? plainObjectOrUndefined(prunedEv.args) : undefined;
  if (nextInput === undefined) return part;
  const prevJson = safeJsonStringify(part.input);
  const nextJson = safeJsonStringify(nextInput);
  if (prevJson !== undefined && nextJson !== undefined && prevJson === nextJson) {
    return part;
  }
  return { ...part, input: { ...nextInput } };
}

function applyPrunedToolResultPart(
  part: ToolResultPart,
  prunedByCallId: Map<string, ContextGraphPrunedEvent>
): ToolResultPart {
  const prunedEv = prunedByCallId.get(part.toolCallId);
  if (!prunedEv || typeof prunedEv.output !== 'string' || prunedEv.output === part.content) {
    return part;
  }
  return { ...part, content: prunedEv.output };
}

function applyPrunedPart(
  part: MessagePart,
  carriedSummary: boolean,
  prunedByCallId: Map<string, ContextGraphPrunedEvent>
): MessagePart {
  if (carriedSummary && part.type === 'text') {
    const stripped = stripContextGraphArtifactBlock(part.text);
    return stripped === part.text ? part : { ...part, text: stripped };
  }
  if (part.type === 'tool_call') {
    return applyPrunedToolCallPart(part, prunedByCallId);
  }
  if (part.type === 'tool_result') {
    return applyPrunedToolResultPart(part, prunedByCallId);
  }
  return part;
}

/**
 * Pure, non-mutating application of server-pruned tool events onto `SessionMessage[]`.
 * Updates matching `tool_call.input` and `tool_result.content`, and strips any carried-over
 * `## Active Artifact State (Context Graph)` section from `compact-summary` messages.
 */
export function applyPrunedEventsToMessages(
  messages: readonly SessionMessage[],
  prunedEvents: readonly ContextGraphPrunedEvent[]
): SessionMessage[] {
  const prunedByCallId = indexPrunedEvents(prunedEvents);
  return messages.map((message) => {
    const carriedSummary = isCarriedSummaryMessage(message);
    let changed = false;
    const nextParts = message.parts.map((part) => {
      const next = applyPrunedPart(part, carriedSummary, prunedByCallId);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? { ...message, parts: nextParts } : message;
  });
}

type HttpJsonResult =
  | { ok: true; statusCode: number; body: Record<string, unknown> }
  | { ok: false; statusCode?: number; reason: string };

function safeNetworkReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && SAFE_ERRNO_CODE_RE.test(code)) {
    return `network_${code.toLowerCase()}`;
  }
  return 'network_error';
}

function parseJsonObjectResponse(chunks: Buffer[], statusCode: number): HttpJsonResult {
  const rawText = Buffer.concat(chunks).toString('utf8').trim();
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    return { ok: false, statusCode, reason: 'invalid_json' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, statusCode, reason: 'invalid_response' };
  }
  return { ok: true, statusCode, body: parsed };
}

function exceedsDeclaredContentLength(
  res: IncomingMessage,
  maxBytes: number
): boolean {
  const declaredLen = res.headers['content-length'];
  if (typeof declaredLen !== 'string') return false;
  const parsedLen = Number(declaredLen);
  return Number.isFinite(parsedLen) && parsedLen > maxBytes;
}

function buildPostHeaders(bodyLength: number, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bodyLength)
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function postJson(
  config: ResolvedContextGraphConfig,
  path: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<HttpJsonResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({ ok: false, reason: 'timeout' });
  }
  const serialized = safeJsonStringify(payload);
  if (serialized === undefined) {
    return Promise.resolve({ ok: false, reason: 'serialize_error' });
  }

  const bodyBuffer = Buffer.from(serialized, 'utf8');
  const targetUrl = new URL(path.replace(/^\/+/, ''), `${config.baseUrl.replace(/\/+$/, '')}/`);
  const reqOptions: RequestOptions = {
    method: 'POST',
    headers: buildPostHeaders(bodyBuffer.length, config.token)
  };
  const transport = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<HttpJsonResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeRes: IncomingMessage | undefined;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const finish = (result: HttpJsonResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const req = transport(targetUrl, reqOptions, (res) => {
      activeRes = res;
      const statusCode = res.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        finish({ ok: false, statusCode, reason: `http_${statusCode}` });
        return;
      }
      if (exceedsDeclaredContentLength(res, config.maxResponseBytes)) {
        res.destroy();
        req.destroy();
        finish({ ok: false, statusCode, reason: 'response_too_large' });
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        totalBytes += buf.length;
        if (totalBytes > config.maxResponseBytes) {
          res.destroy();
          req.destroy();
          finish({ ok: false, statusCode, reason: 'response_too_large' });
          return;
        }
        chunks.push(buf);
      });

      res.on('end', () => {
        if (!settled) finish(parseJsonObjectResponse(chunks, statusCode));
      });
      res.on('close', () => {
        if (!settled && !res.complete) finish({ ok: false, statusCode, reason: 'network_aborted' });
      });
      res.on('error', (err) => finish({ ok: false, statusCode, reason: safeNetworkReason(err) }));
    });

    const onAbort = (): void => {
      activeRes?.destroy();
      req.destroy();
      finish({ ok: false, reason: 'aborted' });
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      activeRes?.destroy();
      req.destroy();
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    req.on('error', (err) => finish({ ok: false, reason: safeNetworkReason(err) }));

    try {
      req.write(bodyBuffer);
      req.end();
    } catch (err) {
      req.destroy();
      finish({ ok: false, reason: safeNetworkReason(err) });
    }
  });
}

function readFiniteNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractServerPruneStats(
  prunedObj: Record<string, unknown>
): { prunedCount?: number; charsSaved?: number } {
  const statsObj = isPlainObject(prunedObj.stats) ? prunedObj.stats : undefined;
  return {
    prunedCount: readFiniteNumber(prunedObj, 'prunedCount') ?? readFiniteNumber(statsObj, 'prunedCount'),
    charsSaved: readFiniteNumber(prunedObj, 'charsSaved') ?? readFiniteNumber(statsObj, 'charsSaved')
  };
}

function diffEventPruning(
  orig: ContextGraphToolEvent,
  next: ContextGraphPrunedEvent
): { changed: boolean; savedChars: number } {
  let changed = false;
  let savedChars = 0;

  if (typeof next.output === 'string' && next.output !== orig.output) {
    changed = true;
    savedChars += Math.max(0, orig.output.length - next.output.length);
  }
  if (next.args !== undefined && orig.args !== undefined) {
    const origJson = safeJsonStringify(orig.args);
    const nextJson = safeJsonStringify(next.args);
    if (origJson !== undefined && nextJson !== undefined && origJson !== nextJson) {
      changed = true;
      savedChars += Math.max(0, origJson.length - nextJson.length);
    }
  }
  return { changed, savedChars };
}

function estimateClientPruneStats(
  originalEvents: readonly ContextGraphToolEvent[],
  prunedEvents: readonly ContextGraphPrunedEvent[]
): { prunedCount: number; charsSaved: number } {
  const prunedById = indexPrunedEvents(prunedEvents);
  let prunedCount = 0;
  let charsSaved = 0;

  for (const orig of originalEvents) {
    const next = prunedById.get(orig.callId);
    if (!next) continue;
    const diff = diffEventPruning(orig, next);
    if (diff.changed) {
      prunedCount += 1;
      charsSaved += diff.savedChars;
    }
  }
  return { prunedCount, charsSaved };
}

function computePruneStats(
  originalEvents: readonly ContextGraphToolEvent[],
  prunedEvents: readonly ContextGraphPrunedEvent[],
  prunedObj: Record<string, unknown>
): { prunedCount: number; charsSaved: number } {
  const server = extractServerPruneStats(prunedObj);
  if (server.prunedCount !== undefined && server.charsSaved !== undefined) {
    return { prunedCount: server.prunedCount, charsSaved: server.charsSaved };
  }
  const estimated = estimateClientPruneStats(originalEvents, prunedEvents);
  return {
    prunedCount: server.prunedCount ?? estimated.prunedCount,
    charsSaved: server.charsSaved ?? estimated.charsSaved
  };
}

function parsePrunedEventItem(rawEv: unknown): ContextGraphPrunedEvent | null {
  if (!isPlainObject(rawEv) || typeof rawEv.callId !== 'string') return null;
  const ev: ContextGraphPrunedEvent = { callId: rawEv.callId };
  if (typeof rawEv.tool === 'string') ev.tool = rawEv.tool;
  if (isPlainObject(rawEv.args)) ev.args = rawEv.args;
  if (typeof rawEv.ok === 'boolean') ev.ok = rawEv.ok;
  if (typeof rawEv.output === 'string') ev.output = rawEv.output;
  if (typeof rawEv.seq === 'number' && Number.isFinite(rawEv.seq)) ev.seq = rawEv.seq;
  return ev;
}

function parsePrunedEvents(rawEvents: unknown[]): ContextGraphPrunedEvent[] | null {
  const prunedEvents: ContextGraphPrunedEvent[] = [];
  for (const rawEv of rawEvents) {
    const parsed = parsePrunedEventItem(rawEv);
    if (!parsed) return null;
    prunedEvents.push(parsed);
  }
  return prunedEvents;
}

function unwrapIngestPayload(body: Record<string, unknown>): Record<string, unknown> {
  if (body.compiled !== undefined || body.pruned !== undefined) return body;
  return isPlainObject(body.data) ? body.data : body;
}

function parseIngestResponse(
  body: Record<string, unknown>,
  originalEvents: readonly ContextGraphToolEvent[]
):
  | { ok: true; artifactBlock: string; prunedEvents: ContextGraphPrunedEvent[]; prunedCount: number; charsSaved: number }
  | { ok: false; reason: string } {
  if (body.ok === false) return { ok: false, reason: 'server_rejected' };

  const payload = unwrapIngestPayload(body);
  const compiledObj = isPlainObject(payload.compiled) ? payload.compiled : undefined;
  const prunedObj = isPlainObject(payload.pruned) ? payload.pruned : undefined;
  if (!compiledObj || typeof compiledObj.promptText !== 'string' || !prunedObj || !Array.isArray(prunedObj.events)) {
    return { ok: false, reason: 'invalid_response' };
  }

  const prunedEvents = parsePrunedEvents(prunedObj.events);
  if (!prunedEvents) return { ok: false, reason: 'invalid_response' };

  const stats = computePruneStats(originalEvents, prunedEvents, prunedObj);
  return {
    ok: true,
    artifactBlock: compiledObj.promptText,
    prunedEvents,
    prunedCount: stats.prunedCount,
    charsSaved: stats.charsSaved
  };
}

function buildIngestRequestBody(
  events: readonly ContextGraphToolEvent[],
  maxOutputChars?: number
): Record<string, unknown> {
  const compileOptions: Record<string, unknown> = { format: 'compact_markdown' };
  if (typeof maxOutputChars === 'number' && Number.isFinite(maxOutputChars) && maxOutputChars > 0) {
    compileOptions.maxOutputChars = Math.floor(maxOutputChars);
  }
  return { events, prune: true, compile: true, compileOptions };
}

function createGraphFallbackReason(reason: string): string {
  return reason === 'timeout' || reason === 'aborted' ? reason : `create_graph_${reason}`;
}

async function postIngestWithAutoCreate(
  config: ResolvedContextGraphConfig,
  graphId: string,
  requestBody: Record<string, unknown>,
  deadlineMs: number,
  signal?: AbortSignal
): Promise<HttpJsonResult> {
  const ingestPath = `/v1/graphs/${encodeURIComponent(graphId)}/ingest-artifacts`;
  const first = await postJson(config, ingestPath, requestBody, deadlineMs - Date.now(), signal);
  if (first.ok || first.statusCode !== 404) return first;

  const createRes = await postJson(
    config,
    '/v1/graphs',
    { id: graphId, name: 'ppeng-session' },
    deadlineMs - Date.now(),
    signal
  );
  if (!createRes.ok && createRes.statusCode !== 409) {
    return { ok: false, statusCode: createRes.statusCode, reason: createGraphFallbackReason(createRes.reason) };
  }
  return postJson(config, ingestPath, requestBody, deadlineMs - Date.now(), signal);
}

/**
 * Ingests tool trajectory events for a session into Context Graph v0.2.4,
 * requests server-side trajectory pruning + `compact_markdown` compilation,
 * and returns a fail-open outcome.
 *
 * Returns `null` immediately (0 HTTP calls) when Context Graph is not configured
 * or when `messages` contain zero tool events (pure chat).
 */
export async function ingestAndCompileSessionArtifacts(
  input: IngestAndCompileSessionArtifactsInput
): Promise<ContextGraphCompactionOutcome | null> {
  const config = resolveContextGraphConfig(input.env ?? process.env, input.timeoutMs);
  if (!config) return null;

  const allEvents = extractToolTrajectoryEvents(input.messages);
  if (allEvents.length === 0) return null;

  const events =
    allEvents.length > MAX_TOOL_EVENTS_PER_BATCH
      ? allEvents.slice(-MAX_TOOL_EVENTS_PER_BATCH)
      : allEvents;

  const startedAt = Date.now();
  const deadlineMs = startedAt + config.timeoutMs;
  const elapsed = (): number => Math.max(0, Date.now() - startedAt);

  try {
    const graphId = sessionContextGraphId(input.sessionId);
    const requestBody = buildIngestRequestBody(events, input.maxOutputChars);
    const res = await postIngestWithAutoCreate(config, graphId, requestBody, deadlineMs, input.signal);
    if (!res.ok) {
      return { applied: false, fallbackReason: res.reason, durationMs: elapsed() };
    }
    const parsed = parseIngestResponse(res.body, events);
    if (!parsed.ok) {
      return { applied: false, fallbackReason: parsed.reason, durationMs: elapsed() };
    }
    return {
      applied: true,
      graphId,
      artifactBlock: parsed.artifactBlock,
      prunedEvents: parsed.prunedEvents,
      prunedCount: parsed.prunedCount,
      charsSaved: parsed.charsSaved,
      durationMs: elapsed()
    };
  } catch {
    return { applied: false, fallbackReason: 'unexpected_error', durationMs: elapsed() };
  }
}
