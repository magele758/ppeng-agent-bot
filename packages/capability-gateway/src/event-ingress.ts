/**
 * Inbound event routines. This is not the IM channel webhook: a signed event
 * wakes a stored routine only after signature, delivery dedupe, and precheck.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  acceptEventRoutine,
  createLogger,
  type AcceptEventRoutineResult,
  type EventProvider,
  type EventRoutineHost
} from '@ppeng/agent-core';
import { claimInboundEvent } from './inbound-guard.js';
import type { GatewayHandleContext } from './http.js';

const log = createLogger('event-ingress');

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function eventProvider(parts: string[]): EventProvider | undefined {
  if (parts.length !== 2 || parts[0] !== 'routines') return undefined;
  const name = parts[1];
  if (name === 'github' || name === 'slack' || name === 'email') return name;
  return undefined;
}

async function readRawBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      throw Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function httpResult(result: AcceptEventRoutineResult): { status: number; body: unknown } {
  if (result.error === 'invalid_json') return { status: 400, body: { error: 'Invalid JSON' } };
  if (result.error === 'invalid_event') return { status: 400, body: { error: 'Unrecognized event' } };
  if (result.outcomes.length === 0) return { status: 200, body: { ok: true, matched: 0 } };
  if (result.outcomes.every((item) => item.status === 'rejected')) {
    const missingDelivery = result.outcomes.every((item) => item.reason === 'no_delivery');
    return missingDelivery
      ? { status: 400, body: { error: 'Missing delivery id' } }
      : { status: 401, body: { error: 'bad_signature' } };
  }
  const queueFull = result.outcomes.some((item) => item.status === 'queue_full');
  return {
    status: queueFull ? 429 : 200,
    body: {
      ok: !queueFull,
      ...(queueFull ? { error: 'queue_full', retryable: true } : {}),
      duplicate: result.outcomes.every((item) => item.status === 'duplicate'),
      wakeAgent: result.outcomes.some((item) => item.status === 'woke' || item.status === 'not_idle'),
      outcomes: result.outcomes.map((item) => ({
        jobId: item.jobId,
        status: item.status,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.sessionId ? { sessionId: item.sessionId } : {})
      }))
    }
  };
}

/**
 * `POST {prefix}/routines/github|slack|email`.
 * Returns false when the path is not an event routine so the caller keeps routing.
 * Signature failure and delivery replay do not start a model turn.
 */
export async function handleEventIngress(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: GatewayHandleContext,
  parts: string[],
  readBodyLimit = 2_000_000
): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const provider = eventProvider(parts);
  if (!provider) return false;

  const rawBody = await readRawBody(request, readBodyLimit);
  let body: unknown;
  try {
    body = rawBody ? (JSON.parse(rawBody) as unknown) : {};
  } catch {
    json(response, 400, { error: 'Invalid JSON' });
    return true;
  }

  const host: EventRoutineHost = {
    stateDir: ctx.stateDir,
    log,
    store: ctx.runtime.store,
    runSession: (sessionId) => ctx.runtime.runSession(sessionId),
    isSessionRunning: (sessionId) => ctx.runtime.isSessionRunning?.(sessionId) ?? false,
    hasUnconfirmedEffects: (sessionId, startedAt) => ctx.runtime.hasUnconfirmedEffects?.(sessionId, startedAt) ?? false,
    cancelSession: (sessionId) => ctx.runtime.cancelSession?.(sessionId)
  };
  const result = await acceptEventRoutine(host, {
    provider,
    rawBody,
    headers: request.headers,
    body,
    claimDelivery: claimInboundEvent
  });
  const out = httpResult(result);
  json(response, out.status, out.body);
  return true;
}
