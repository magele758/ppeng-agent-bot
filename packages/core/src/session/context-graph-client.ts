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
import type { MessagePart, SessionMessage } from '../types.js';

export const CONTEXT_GRAPH_ARTIFACT_HEADING = '## Active Artifact State (Context Graph)';
export const DEFAULT_CONTEXT_GRAPH_TIMEOUT_MS = 3_000;
export const MIN_CONTEXT_GRAPH_TIMEOUT_MS = 200;
export const MAX_CONTEXT_GRAPH_TIMEOUT_MS = 15_000;
export const MAX_CONTEXT_GRAPH_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_EVENTS_PER_BATCH = 2_000;

/** Rejects CR, LF, NUL, and non-tab ASCII control characters. */
const FORBIDDEN_CTRL_RE = /[\r\n\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const SAFE_ERRNO_CODE_RE = /^[A-Z0-9_]{2,32}$/;

export interface ResolvedContextGraphConfig {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  maxResponseBytes: number;
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
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return clampTimeoutMs(parsed);
    }
    break;
  }
  return DEFAULT_CONTEXT_GRAPH_TIMEOUT_MS;
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
    const candidates = [als[key], vault?.get(key), env[key]];
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      if (FORBIDDEN_CTRL_RE.test(candidate)) {
        return { valid: false };
      }
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return { valid: true, token: trimmed };
      }
    }
  }
  return { valid: true, token: undefined };
}

/**
 * Resolves opt-in Context Graph configuration from env, ALS overrides, and bound SecretVault.
 * Returns `null` immediately when unset or invalid (`http:`/`https:` only, no control chars).
 */
export function resolveContextGraphConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  explicitTimeoutMs?: number
): ResolvedContextGraphConfig | null {
  let rawUrl: string | undefined;
  for (const candidate of [env.RAW_AGENT_CONTEXT_GRAPH_URL, env.CONTEXT_GRAPH_URL]) {
    if (candidate === undefined) continue;
    if (FORBIDDEN_CTRL_RE.test(candidate)) {
      return null;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      rawUrl = trimmed;
      break;
    }
  }
  if (!rawUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }

  const auth = resolveAuthToken(env);
  if (!auth.valid) {
    return null;
  }

  return {
    baseUrl: parsed.toString().replace(/\/+$/, ''),
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
 * Strictly linear O(N) line-scan that removes any `## Active Artifact State (Context Graph)`
 * section (from that heading line up to the next `## ` heading or end-of-string),
 * trimming redundant trailing blank lines.
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

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === CONTEXT_GRAPH_ARTIFACT_HEADING) {
      skipping = true;
      strippedAny = true;
      continue;
    }
    if (skipping) {
      if (trimmed.startsWith('## ')) {
        skipping = false;
        if (!hasNonBlank) {
          kept.length = 0;
        } else {
          while (
            kept.length >= 2 &&
            kept[kept.length - 1]!.trim() === '' &&
            kept[kept.length - 2]!.trim() === ''
          ) {
            kept.pop();
          }
        }
        kept.push(line);
        hasNonBlank = true;
      }
      continue;
    }
    kept.push(line);
    if (trimmed.length > 0) {
      hasNonBlank = true;
    }
  }

  if (!strippedAny) {
    return text;
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') {
    kept.pop();
  }
  return kept.join('\n');
}

/**
 * Strips any echoed Context Graph artifact heading from `summary` and cleanly appends
 * `## Active Artifact State (Context Graph)\n<artifactBlock>` at the end (unless
 * `artifactBlock` is empty or `maxTotalChars` is too tiny to keep prose + artifacts).
 */
export function attachContextGraphArtifactBlock(
  summary: string,
  artifactBlock: string,
  maxTotalChars?: number
): string {
  const cleanedSummary = stripContextGraphArtifactBlock(summary);
  let trimmedBlock = artifactBlock.trim();
  if (trimmedBlock === CONTEXT_GRAPH_ARTIFACT_HEADING) {
    return cleanedSummary;
  }
  if (
    trimmedBlock.startsWith(`${CONTEXT_GRAPH_ARTIFACT_HEADING}\n`) ||
    trimmedBlock.startsWith(`${CONTEXT_GRAPH_ARTIFACT_HEADING}\r\n`)
  ) {
    trimmedBlock = trimmedBlock.slice(CONTEXT_GRAPH_ARTIFACT_HEADING.length).trim();
  }
  if (!trimmedBlock) {
    return cleanedSummary;
  }

  const section = `${CONTEXT_GRAPH_ARTIFACT_HEADING}\n${trimmedBlock}`;
  if (
    typeof maxTotalChars === 'number' &&
    Number.isFinite(maxTotalChars) &&
    maxTotalChars < section.length + 120
  ) {
    return cleanedSummary;
  }

  const base = cleanedSummary.trimEnd();
  if (!base) {
    return section;
  }
  return `${base}\n\n${section}`;
}

function isCarriedSummaryMessage(message: SessionMessage): boolean {
  return message.key === 'compact-summary' || message.id === 'compact-prior-summary';
}

/**
 * Pure extraction of tool call/result events from session messages.
 * Skips replacement/summary messages and returns `[]` for pure chat histories.
 */
export function extractToolTrajectoryEvents(
  messages: readonly SessionMessage[]
): ContextGraphToolEvent[] {
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

  const events: ContextGraphToolEvent[] = [];
  for (const message of messages) {
    if (isCarriedSummaryMessage(message)) continue;
    const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? message.seq : undefined;
    for (const part of message.parts) {
      if (part.type !== 'tool_result') continue;
      const call = part.toolCallId ? callsById.get(part.toolCallId) : undefined;
      const event: ContextGraphToolEvent = {
        callId: part.toolCallId,
        tool: part.name || call?.name || 'unknown',
        ok: part.ok !== false,
        output: part.content ?? ''
      };
      if (call?.input !== undefined) {
        event.args = call.input;
      }
      if (seq !== undefined) {
        event.seq = seq;
      }
      events.push(event);
    }
  }

  return events;
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
  const prunedByCallId = new Map<string, ContextGraphPrunedEvent>();
  for (const ev of prunedEvents) {
    if (ev && typeof ev.callId === 'string' && ev.callId.length > 0) {
      prunedByCallId.set(ev.callId, ev);
    }
  }

  return messages.map((message) => {
    let changed = false;
    const carriedSummary = isCarriedSummaryMessage(message);

    const nextParts: MessagePart[] = message.parts.map((part) => {
      if (carriedSummary && part.type === 'text') {
        const stripped = stripContextGraphArtifactBlock(part.text);
        if (stripped !== part.text) {
          changed = true;
          return { ...part, text: stripped };
        }
        return part;
      }

      if (part.type === 'tool_call') {
        const prunedEv = prunedByCallId.get(part.toolCallId);
        const nextInput = prunedEv?.args !== undefined ? plainObjectOrUndefined(prunedEv.args) : undefined;
        if (nextInput !== undefined) {
          const prevJson = safeJsonStringify(part.input);
          const nextJson = safeJsonStringify(nextInput);
          if (prevJson === undefined || nextJson === undefined || prevJson !== nextJson) {
            changed = true;
            return { ...part, input: { ...nextInput } };
          }
        }
        return part;
      }

      if (part.type === 'tool_result') {
        const prunedEv = prunedByCallId.get(part.toolCallId);
        if (prunedEv && typeof prunedEv.output === 'string' && prunedEv.output !== part.content) {
          changed = true;
          return { ...part, content: prunedEv.output };
        }
        return part;
      }

      return part;
    });

    return changed ? { ...message, parts: nextParts } : message;
  });
}

type HttpJsonResult =
  | { ok: true; statusCode: number; body: Record<string, unknown> }
  | { ok: false; statusCode?: number; reason: string };

function postJson(
  config: ResolvedContextGraphConfig,
  path: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<HttpJsonResult> {
  return new Promise<HttpJsonResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: 'aborted' });
      return;
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      resolve({ ok: false, reason: 'timeout' });
      return;
    }

    let bodyBuffer: Buffer;
    try {
      bodyBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
    } catch {
      resolve({ ok: false, reason: 'serialize_error' });
      return;
    }

    const targetUrl = new URL(path.replace(/^\/+/, ''), `${config.baseUrl.replace(/\/+$/, '')}/`);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bodyBuffer.length)
    };
    if (config.token) {
      headers.authorization = `Bearer ${config.token}`;
    }

    const reqOptions: RequestOptions = {
      method: 'POST',
      headers
    };

    const transport = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeRes: IncomingMessage | undefined;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
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
      const declaredLen = res.headers['content-length'];
      if (typeof declaredLen === 'string') {
        const parsedLen = Number(declaredLen);
        if (Number.isFinite(parsedLen) && parsedLen > config.maxResponseBytes) {
          res.destroy();
          req.destroy();
          finish({ ok: false, statusCode, reason: 'response_too_large' });
          return;
        }
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
        if (settled) return;
        if (statusCode >= 400) {
          finish({ ok: false, statusCode, reason: `http_${statusCode}` });
          return;
        }

        const rawText = Buffer.concat(chunks).toString('utf8').trim();
        let parsed: unknown;
        try {
          parsed = rawText ? JSON.parse(rawText) : {};
        } catch {
          finish({ ok: false, statusCode, reason: 'invalid_json' });
          return;
        }

        if (!isPlainObject(parsed)) {
          finish({ ok: false, statusCode, reason: 'invalid_response' });
          return;
        }
        finish({ ok: true, statusCode, body: parsed });
      });

      res.on('error', (err: NodeJS.ErrnoException) => {
        const code = err?.code;
        const reason =
          typeof code === 'string' && SAFE_ERRNO_CODE_RE.test(code)
            ? `network_${code.toLowerCase()}`
            : 'network_error';
        finish({ ok: false, statusCode, reason });
      });
    });

    const onAbort = (): void => {
      activeRes?.destroy();
      req.destroy();
      finish({ ok: false, reason: 'aborted' });
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      activeRes?.destroy();
      req.destroy();
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    req.on('error', (err: NodeJS.ErrnoException) => {
      const code = err?.code;
      const reason =
        typeof code === 'string' && SAFE_ERRNO_CODE_RE.test(code)
          ? `network_${code.toLowerCase()}`
          : 'network_error';
      finish({ ok: false, reason });
    });

    req.write(bodyBuffer);
    req.end();
  });
}

function computePruneStats(
  originalEvents: readonly ContextGraphToolEvent[],
  prunedEvents: readonly ContextGraphPrunedEvent[],
  prunedObj: Record<string, unknown>
): { prunedCount: number; charsSaved: number } {
  const statsObj = isPlainObject(prunedObj.stats) ? prunedObj.stats : undefined;
  const serverPrunedCount =
    typeof prunedObj.prunedCount === 'number' && Number.isFinite(prunedObj.prunedCount)
      ? prunedObj.prunedCount
      : typeof statsObj?.prunedCount === 'number' && Number.isFinite(statsObj.prunedCount)
        ? statsObj.prunedCount
        : undefined;
  const serverCharsSaved =
    typeof prunedObj.charsSaved === 'number' && Number.isFinite(prunedObj.charsSaved)
      ? prunedObj.charsSaved
      : typeof statsObj?.charsSaved === 'number' && Number.isFinite(statsObj.charsSaved)
        ? statsObj.charsSaved
        : undefined;

  if (serverPrunedCount !== undefined && serverCharsSaved !== undefined) {
    return { prunedCount: serverPrunedCount, charsSaved: serverCharsSaved };
  }

  const prunedById = new Map<string, ContextGraphPrunedEvent>();
  for (const ev of prunedEvents) {
    if (ev.callId) prunedById.set(ev.callId, ev);
  }

  let derivedCount = 0;
  let derivedSaved = 0;
  for (const orig of originalEvents) {
    const next = prunedById.get(orig.callId);
    if (!next) continue;
    let changed = false;
    if (typeof next.output === 'string' && next.output !== orig.output) {
      changed = true;
      derivedSaved += Math.max(0, orig.output.length - next.output.length);
    }
    if (next.args !== undefined && orig.args !== undefined) {
      const origJson = safeJsonStringify(orig.args);
      const nextJson = safeJsonStringify(next.args);
      if (origJson !== undefined && nextJson !== undefined && origJson !== nextJson) {
        changed = true;
        derivedSaved += Math.max(0, origJson.length - nextJson.length);
      }
    }
    if (changed) {
      derivedCount += 1;
    }
  }

  return {
    prunedCount: serverPrunedCount ?? derivedCount,
    charsSaved: serverCharsSaved ?? derivedSaved
  };
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
  if (!config) {
    return null;
  }

  const allEvents = extractToolTrajectoryEvents(input.messages);
  if (allEvents.length === 0) {
    return null;
  }

  const events =
    allEvents.length > MAX_TOOL_EVENTS_PER_BATCH
      ? allEvents.slice(-MAX_TOOL_EVENTS_PER_BATCH)
      : allEvents;

  const startedAt = Date.now();
  const deadlineMs = startedAt + config.timeoutMs;
  const elapsed = (): number => Math.max(0, Date.now() - startedAt);

  try {
    const graphId = sessionContextGraphId(input.sessionId);
    const ingestPath = `/v1/graphs/${encodeURIComponent(graphId)}/ingest-artifacts`;
    const compileOptions: Record<string, unknown> = { format: 'compact_markdown' };
    if (
      typeof input.maxOutputChars === 'number' &&
      Number.isFinite(input.maxOutputChars) &&
      input.maxOutputChars > 0
    ) {
      compileOptions.maxOutputChars = Math.floor(input.maxOutputChars);
    }

    const requestBody = {
      events,
      prune: true,
      compile: true,
      compileOptions
    };

    let res = await postJson(config, ingestPath, requestBody, deadlineMs - Date.now(), input.signal);

    if (!res.ok && res.statusCode === 404) {
      const createRes = await postJson(
        config,
        '/v1/graphs',
        { id: graphId, name: 'ppeng-session' },
        deadlineMs - Date.now(),
        input.signal
      );
      const createdOk = createRes.ok || createRes.statusCode === 409;
      if (!createdOk) {
        const fallbackReason =
          createRes.reason === 'timeout' || createRes.reason === 'aborted'
            ? createRes.reason
            : `create_graph_${createRes.reason}`;
        return {
          applied: false,
          fallbackReason,
          durationMs: elapsed()
        };
      }
      res = await postJson(config, ingestPath, requestBody, deadlineMs - Date.now(), input.signal);
    }

    if (!res.ok) {
      return {
        applied: false,
        fallbackReason: res.reason,
        durationMs: elapsed()
      };
    }

    if (res.body.ok === false) {
      return {
        applied: false,
        fallbackReason: 'server_rejected',
        durationMs: elapsed()
      };
    }

    const payload =
      res.body.compiled !== undefined || res.body.pruned !== undefined
        ? res.body
        : isPlainObject(res.body.data)
          ? res.body.data
          : res.body;

    const compiledObj = isPlainObject(payload.compiled) ? payload.compiled : undefined;
    const prunedObj = isPlainObject(payload.pruned) ? payload.pruned : undefined;
    if (
      !compiledObj ||
      typeof compiledObj.promptText !== 'string' ||
      !prunedObj ||
      !Array.isArray(prunedObj.events)
    ) {
      return {
        applied: false,
        fallbackReason: 'invalid_response',
        durationMs: elapsed()
      };
    }

    const prunedEvents: ContextGraphPrunedEvent[] = [];
    for (const rawEv of prunedObj.events) {
      if (!isPlainObject(rawEv) || typeof rawEv.callId !== 'string') {
        return {
          applied: false,
          fallbackReason: 'invalid_response',
          durationMs: elapsed()
        };
      }
      const ev: ContextGraphPrunedEvent = { callId: rawEv.callId };
      if (typeof rawEv.tool === 'string') ev.tool = rawEv.tool;
      if (isPlainObject(rawEv.args)) ev.args = rawEv.args;
      if (typeof rawEv.ok === 'boolean') ev.ok = rawEv.ok;
      if (typeof rawEv.output === 'string') ev.output = rawEv.output;
      if (typeof rawEv.seq === 'number' && Number.isFinite(rawEv.seq)) ev.seq = rawEv.seq;
      prunedEvents.push(ev);
    }

    const { prunedCount, charsSaved } = computePruneStats(events, prunedEvents, prunedObj);

    return {
      applied: true,
      graphId,
      artifactBlock: compiledObj.promptText,
      prunedEvents,
      prunedCount,
      charsSaved,
      durationMs: elapsed()
    };
  } catch {
    return {
      applied: false,
      fallbackReason: 'unexpected_error',
      durationMs: elapsed()
    };
  }
}
