import type { IncomingMessage, ServerResponse } from 'node:http';

export function json(response: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body, null, 2));
}

/**
 * Conditional GET helper: when client sends `If-None-Match` matching the
 * current `etag`, respond 304 with no body. Otherwise set `ETag` and let
 * the caller emit JSON via {@link json}.
 *
 * Usage:
 *   if (sendIfNotModified(request, response, etagFromState(version))) return;
 *   json(response, 200, body);
 */
export function sendIfNotModified(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  etag: string
): boolean {
  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
    response.statusCode = 304;
    response.setHeader('etag', etag);
    response.end();
    return true;
  }
  response.setHeader('etag', etag);
  return false;
}

/** Build a weak ETag from a monotonic state version. */
export function etagFromState(version: number): string {
  return `W/"${version}"`;
}

export function sseInit(response: ServerResponse<IncomingMessage>): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('connection', 'keep-alive');
  response.flushHeaders?.();
}

export function sseSend(
  response: ServerResponse<IncomingMessage>,
  event: string,
  data: unknown
): void {
  if (response.destroyed || response.writableEnded) return;
  try {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* A disconnected client must not fail the run that is still writing. */
  }
}

export function html(response: ServerResponse<IncomingMessage>, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  response.end(body);
}
