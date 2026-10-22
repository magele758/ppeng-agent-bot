/**
 * Upstream model error classification for the configured fallback chain.
 *
 * Adapters throw plain `Error`s whose message carries the HTTP status
 * ("Remote adapter request failed with 503: ...", "OpenAI stream failed 429: ..."),
 * and network failures arrive as `TypeError: fetch failed` with a `cause.code`.
 * Only a narrow class of errors ("the upstream is down or saturated") is worth
 * switching models for; everything else would fail identically on the backup.
 */

export type ModelErrorCategory =
  | 'server_error'
  | 'rate_limited'
  | 'timeout'
  | 'connection'
  | 'overloaded'
  | 'auth'
  | 'bad_request'
  | 'content_filter'
  | 'aborted'
  | 'watchdog'
  | 'unknown';

export interface ModelErrorClassification {
  category: ModelErrorCategory;
  /** True only for upstream outage / saturation classes (5xx, 429, timeout, connection, overloaded). */
  upstreamRetryable: boolean;
  status?: number;
}

const UPSTREAM_RETRYABLE: ReadonlySet<ModelErrorCategory> = new Set([
  'server_error',
  'rate_limited',
  'timeout',
  'connection',
  'overloaded'
]);

/** Categories that must stop the whole fallback chain, even when a backup is the one failing. */
const TERMINAL: ReadonlySet<ModelErrorCategory> = new Set(['aborted', 'watchdog', 'content_filter']);

export function isUpstreamRetryableCategory(category: ModelErrorCategory): boolean {
  return UPSTREAM_RETRYABLE.has(category);
}

export function isTerminalModelErrorCategory(category: ModelErrorCategory): boolean {
  return TERMINAL.has(category);
}

const WATCHDOG_RE = /repetition loop aborted|reasoning[ _-]?spin/i;
const ABORT_RE = /\bAbortError\b|\bsession aborted\b|\b(?:request|operation|fetch) (?:was )?aborted\b|\baborted by (?:user|signal)\b/i;
const CONTENT_FILTER_RE =
  /content[_ -]?(?:filter|policy|management)|moderation|safety[_ -]?(?:system|filter|policy|block)|responsible[ _-]?ai|flagged (?:as|by)|violates? (?:our |the )?(?:usage |content )?policy/i;
const OVERLOADED_RE = /overload|over capacity|at capacity|capacity exceeded|engine is currently overloaded/i;
const RATE_LIMIT_RE = /rate[ _-]?limit|too many requests|quota exceeded|insufficient[_ ]quota/i;
const TIMEOUT_RE = /timeout|timed out|ETIMEDOUT|UND_ERR_(?:HEADERS|BODY|CONNECT)_TIMEOUT|deadline exceeded/i;
const CONNECTION_RE =
  /fetch failed|socket hang up|network error|connection error|connection (?:reset|refused|closed|terminated)|ECONN(?:RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|other side closed|(?:^|\|\s*)terminated\s*(?:\||$)/i;
/** Self-describing upstream fault payloads (no HTTP status on the error): outrank body keywords like "moderation". */
const STRUCTURED_SERVER_RE =
  /server_error|service_unavailable_error|the server had an error while processing your request|responses stream ended with status=failed/i;
const SERVER_RE = /service unavailable|bad gateway|gateway time-?out|internal server error|upstream (?:error|unavailable)/i;
const AUTH_RE = /authentication_error|permission_denied|invalid_api_key|incorrect api key|\bunauthorized\b|\bforbidden\b/i;
const BAD_REQUEST_RE = /invalid_request_error|model_not_found|\bbad request\b/i;
const STATUS_IN_MESSAGE_RE = /\b(?:failed(?: with)?|status(?: code)?|http(?: error)?)[\s:=]+([1-5]\d{2})\b/i;

function errorChain(err: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth += 1) {
    out.push(cur as Record<string, unknown>);
    cur = (cur as Record<string, unknown>).cause;
  }
  return out;
}

function chainText(chain: Array<Record<string, unknown>>, fallback: unknown): string {
  const parts: string[] = [];
  for (const item of chain) {
    if (typeof item.message === 'string') parts.push(item.message);
    if (typeof item.code === 'string') parts.push(item.code);
    if (typeof item.name === 'string') parts.push(item.name);
  }
  if (parts.length === 0) parts.push(typeof fallback === 'string' ? fallback : '');
  return parts.join(' | ');
}

function statusOf(chain: Array<Record<string, unknown>>, text: string): number | undefined {
  for (const item of chain) {
    const raw =
      item.statusCode ?? item.status ?? (item.response as { status?: unknown } | undefined)?.status;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n < 600) return n;
  }
  const m = STATUS_IN_MESSAGE_RE.exec(text);
  if (m) return Number(m[1]);
  return undefined;
}

function hasAbortedSignal(chain: Array<Record<string, unknown>>): boolean {
  return chain.some((c) => typeof AbortSignal !== 'undefined' && c.signal instanceof AbortSignal && c.signal.aborted);
}

export function classifyModelError(err: unknown): ModelErrorClassification {
  if (err === null || err === undefined) return modelErrorClassification('unknown');
  const chain = errorChain(err);
  const text = chainText(chain, typeof err === 'string' ? err : '');
  const names = chain.map((c) => (typeof c.name === 'string' ? c.name : ''));
  const parsedStatus = statusOf(chain, text);
  const status = parsedStatus !== undefined && parsedStatus >= 400 ? parsedStatus : undefined;

  const structured = classifyStructuredError(chain, names, status);
  if (structured) return structured;

  // 2. Upstream-outage status codes outrank body keywords (a 503 body may mention "moderation").
  if (status !== undefined) {
    if (status === 429) return modelErrorClassification('rate_limited', status);
    if (status === 408) return modelErrorClassification('timeout', status);
    if (status === 504) return modelErrorClassification('server_error', status);
    if (status === 529) return modelErrorClassification('overloaded', status);
    if (status >= 500) return modelErrorClassification(OVERLOADED_RE.test(text) ? 'overloaded' : 'server_error', status);
  }

  // 3. Keyword classes: terminal ones only when no outage status already decided.
  if (status === undefined && STRUCTURED_SERVER_RE.test(text)) {
    return modelErrorClassification(OVERLOADED_RE.test(text) ? 'overloaded' : 'server_error');
  }
  if (WATCHDOG_RE.test(text)) return modelErrorClassification('watchdog');
  if (ABORT_RE.test(text)) return modelErrorClassification('aborted');
  if (CONTENT_FILTER_RE.test(text)) return modelErrorClassification('content_filter', status);

  if (status !== undefined) {
    if (status === 401 || status === 403) return modelErrorClassification('auth', status);
    return modelErrorClassification('bad_request', status);
  }

  if (AUTH_RE.test(text)) return modelErrorClassification('auth');
  if (BAD_REQUEST_RE.test(text)) return modelErrorClassification('bad_request');
  if (OVERLOADED_RE.test(text)) return modelErrorClassification('overloaded');
  if (RATE_LIMIT_RE.test(text)) return modelErrorClassification('rate_limited');
  if (TIMEOUT_RE.test(text)) return modelErrorClassification('timeout');
  if (CONNECTION_RE.test(text)) return modelErrorClassification('connection');
  if (SERVER_RE.test(text)) return modelErrorClassification('server_error');
  return modelErrorClassification('unknown', parsedStatus);
}

function modelErrorClassification(category: ModelErrorCategory, status?: number): ModelErrorClassification {
  return {
    category,
    upstreamRetryable: UPSTREAM_RETRYABLE.has(category),
    ...(status !== undefined ? { status } : {})
  };
}

function classifyStructuredError(chain: Array<Record<string, unknown>>, names: string[], status?: number): ModelErrorClassification | undefined {
  // 1. Structured signals always win.
  if (names.includes('RepetitionLoopAbortError')) return modelErrorClassification('watchdog');
  if (names.includes('TimeoutError')) return modelErrorClassification('timeout', status);
  if (names.includes('AbortError') || chain.some((c) => c.code === 'ABORT_ERR') || hasAbortedSignal(chain)) {
    return modelErrorClassification('aborted');
  }
  if (chain.some((c) => c.code === 'content_filter' || c.type === 'content_filter')) {
    return modelErrorClassification('content_filter', status);
  }

  return undefined;
}
