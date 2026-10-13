/**
 * Event-triggered routines. A signed webhook can wake the owning session.
 * Time-based ticks never see these jobs (`scheduleKind: 'event'`).
 *
 * The event JSON is written to a temp file. Script prechecks receive that path
 * in `PPENG_EVENT_FILE` and the stored command is not rewritten.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import { fenceExternalContent } from '../safety/external-content.js';
import type { MessagePart, SessionRecord } from '../types.js';
import { textPart } from '../runtime/session-facade.js';
import { startIdleSessionRun } from '../runtime/scheduler-host.js';
import { CronJobStore, markCronJobRan, type CronJobRecord } from './cron-store.js';
import { evaluateRoutinePrecheck, readStoredPrecheck } from './routine-precheck.js';

/** Child env var. The value is a file path, never the event JSON. */
export const EVENT_PRECHECK_FILE_ENV = 'PPENG_EVENT_FILE';

/** Slack and email reject timestamps further than this from now. */
export const EVENT_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

const SUMMARY_MAX = 12_000;
const EVENT_SCHEDULE = /^(github|slack|email)\/[a-z][a-z0-9_-]{0,64}$/;

export type EventProvider = 'github' | 'slack' | 'email';

export interface EventRoutineHeaders {
  [name: string]: string | string[] | undefined;
}

export interface EventRoutineStore {
  getSession(id: string): SessionRecord | undefined;
  appendMessage(sessionId: string, role: 'user', parts: MessagePart[]): unknown;
  updateSession(id: string, patch: Partial<Pick<SessionRecord, 'status' | 'metadata'>>): SessionRecord;
  enqueueSchedulerWake(sessionId: string, reason: string): void;
}

export interface EventRoutineHost {
  stateDir: string;
  log: Logger;
  store: EventRoutineStore;
  runSession(sessionId: string): Promise<unknown>;
  cronStore?: CronJobStore;
  setCronStore?(store: CronJobStore): void;
}

export interface AcceptEventRoutineInput {
  provider: EventProvider;
  rawBody: string;
  headers: EventRoutineHeaders;
  /** Parsed JSON. When omitted, `rawBody` is parsed. */
  body?: unknown;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  /** `claimInboundEvent` from the gateway. False means this delivery was already claimed. */
  claimDelivery: (key: string) => boolean;
}

export interface EventJobOutcome {
  jobId: string;
  status: 'rejected' | 'duplicate' | 'skipped' | 'woke' | 'not_idle' | 'missing_session';
  reason?: 'bad_signature' | 'no_delivery';
  sessionId?: string;
}

export interface AcceptEventRoutineResult {
  scheduleValue?: string;
  error?: 'invalid_json' | 'invalid_event';
  outcomes: EventJobOutcome[];
}

export function parseEventScheduleValue(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  return EVENT_SCHEDULE.test(value) ? value : undefined;
}

function signaturesMatch(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const left = Buffer.from(expected.toLowerCase(), 'utf8');
  const right = Buffer.from(provided.trim().toLowerCase(), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** `X-Hub-Signature-256` is `sha256=` + HMAC-SHA256(secret, rawBody). */
export function verifyGithubSignature(input: {
  rawBody: string;
  secret: string;
  signature: string | undefined;
}): boolean {
  if (!input.secret || !input.signature) return false;
  const expected = `sha256=${hmacHex(input.secret, input.rawBody)}`;
  return signaturesMatch(expected, input.signature);
}

function freshTimestamp(timestamp: string | undefined, nowMs: number): string | undefined {
  if (!timestamp || !/^\d{1,16}$/.test(timestamp)) return undefined;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return undefined;
  if (Math.abs(nowMs - seconds * 1000) > EVENT_SIGNATURE_WINDOW_MS) return undefined;
  return timestamp;
}

/**
 * Slack v0: HMAC-SHA256(secret, `v0:{timestamp}:{rawBody}`) with prefix `v0=`.
 * Timestamps more than 5 minutes from now are rejected.
 */
export function verifySlackSignature(input: {
  rawBody: string;
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
}): boolean {
  if (!input.secret || !input.signature) return false;
  const timestamp = freshTimestamp(input.timestamp, input.nowMs ?? Date.now());
  if (!timestamp) return false;
  const expected = `v0=${hmacHex(input.secret, `v0:${timestamp}:${input.rawBody}`)}`;
  return signaturesMatch(expected, input.signature);
}

/**
 * `X-Ppeng-Signature: sha256=<hex>` is HMAC-SHA256(secret, `{timestamp}.{rawBody}`).
 * `X-Ppeng-Timestamp` is unix seconds and must be within 5 minutes. The timestamp
 * is inside the MAC so a captured signature cannot be reused with a fresh time.
 */
export function verifyEmailSignature(input: {
  rawBody: string;
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
}): boolean {
  if (!input.secret || !input.signature) return false;
  const timestamp = freshTimestamp(input.timestamp, input.nowMs ?? Date.now());
  if (!timestamp) return false;
  const expected = `sha256=${hmacHex(input.secret, `${timestamp}.${input.rawBody}`)}`;
  return signaturesMatch(expected, input.signature);
}

export function headerValue(headers: EventRoutineHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function eventName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const name = raw.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,64}$/.test(name) ? name : undefined;
}

function resolveScheduleValue(
  provider: EventProvider,
  headers: EventRoutineHeaders,
  body: unknown
): string | undefined {
  if (provider === 'github') {
    const name = eventName(headerValue(headers, 'x-github-event'));
    return name ? parseEventScheduleValue(`github/${name}`) : undefined;
  }
  if (provider === 'slack') {
    const rec = asRecord(body);
    const inner = asRecord(rec?.event);
    const name = eventName(typeof inner?.type === 'string' ? inner.type : typeof rec?.type === 'string' ? rec.type : undefined);
    return name ? parseEventScheduleValue(`slack/${name}`) : undefined;
  }
  const fromHeader = eventName(headerValue(headers, 'x-ppeng-event'));
  const rec = asRecord(body);
  const fromBody = eventName(typeof rec?.type === 'string' ? rec.type : undefined);
  return parseEventScheduleValue(`email/${fromHeader || fromBody || 'received'}`);
}

function clampDeliveryId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const id = raw.trim();
  if (!id || id.length > 200 || /[\r\n]/.test(id)) return undefined;
  return id;
}

function deliveryIdOf(provider: EventProvider, headers: EventRoutineHeaders, body: unknown): string | undefined {
  if (provider === 'github') return clampDeliveryId(headerValue(headers, 'x-github-delivery'));
  if (provider === 'slack') {
    const rec = asRecord(body);
    return clampDeliveryId(typeof rec?.event_id === 'string' ? rec.event_id : undefined);
  }
  const rec = asRecord(body);
  return clampDeliveryId(
    headerValue(headers, 'x-ppeng-delivery') ??
      (typeof rec?.deliveryId === 'string' ? rec.deliveryId : undefined)
  );
}

function secretFromEnv(name: unknown, env: NodeJS.ProcessEnv): { name?: string; value?: string } {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return {};
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) return { name };
  return { name, value };
}

function signatureOk(
  provider: EventProvider,
  rawBody: string,
  secret: string,
  headers: EventRoutineHeaders,
  nowMs: number
): boolean {
  if (provider === 'github') {
    return verifyGithubSignature({
      rawBody,
      secret,
      signature: headerValue(headers, 'x-hub-signature-256')
    });
  }
  if (provider === 'slack') {
    return verifySlackSignature({
      rawBody,
      secret,
      timestamp: headerValue(headers, 'x-slack-request-timestamp'),
      signature: headerValue(headers, 'x-slack-signature'),
      nowMs
    });
  }
  return verifyEmailSignature({
    rawBody,
    secret,
    timestamp: headerValue(headers, 'x-ppeng-timestamp'),
    signature: headerValue(headers, 'x-ppeng-signature'),
    nowMs
  });
}

function routinePrompt(job: CronJobRecord): string {
  const fromMeta = job.metadata?.prompt;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
  return job.prompt.trim();
}

function summarizeEvent(scheduleValue: string, deliveryId: string, rawBody: string): string {
  const body = rawBody.length > SUMMARY_MAX ? `${rawBody.slice(0, SUMMARY_MAX)}\n…[truncated]` : rawBody;
  return `delivery: ${deliveryId}\nschedule: ${scheduleValue}\n${body}`;
}

function eventUserText(job: CronJobRecord, scheduleValue: string, deliveryId: string, rawBody: string): string {
  const fenced = fenceExternalContent({
    source: 'event',
    label: scheduleValue,
    body: summarizeEvent(scheduleValue, deliveryId, rawBody)
  });
  return `[event:${job.name}] ${routinePrompt(job)}\n\n${fenced}`;
}

function cronStoreOf(host: EventRoutineHost): CronJobStore {
  if (host.cronStore) return host.cronStore;
  const store = new CronJobStore(host.stateDir);
  host.setCronStore?.(store);
  host.cronStore = store;
  return store;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Verify the signature, drop replays, and run the existing precheck.
 * A bad signature, a replayed delivery id, or `wakeAgent: false` does not call the model.
 */
export async function acceptEventRoutine(
  host: EventRoutineHost,
  input: AcceptEventRoutineInput
): Promise<AcceptEventRoutineResult> {
  let parsed = input.body;
  if (parsed === undefined) {
    try {
      parsed = input.rawBody ? (JSON.parse(input.rawBody) as unknown) : {};
    } catch {
      return { outcomes: [], error: 'invalid_json' };
    }
  }
  const scheduleValue = resolveScheduleValue(input.provider, input.headers, parsed);
  if (!scheduleValue) return { outcomes: [], error: 'invalid_event' };

  const env = input.env ?? process.env;
  const nowMs = input.nowMs ?? Date.now();
  const store = cronStoreOf(host);
  const jobs = store
    .list({ enabled: true })
    .filter((job) => job.scheduleKind === 'event' && job.scheduleValue === scheduleValue);
  if (jobs.length === 0) return { scheduleValue, outcomes: [] };

  let eventDir: string | undefined;
  let eventFile: string | undefined;
  const ensureEventFile = (): string => {
    if (eventFile) return eventFile;
    eventDir = mkdtempSync(join(tmpdir(), 'ppeng-event-'));
    eventFile = join(eventDir, 'event.json');
    writeFileSync(eventFile, input.rawBody, { encoding: 'utf8', mode: 0o600 });
    return eventFile;
  };

  const outcomes: EventJobOutcome[] = [];
  try {
    for (const job of jobs) {
      const secret = secretFromEnv(job.metadata?.secretEnv, env);
      if (!secret.value || !signatureOk(input.provider, input.rawBody, secret.value, input.headers, nowMs)) {
        outcomes.push({ jobId: job.id, status: 'rejected', reason: 'bad_signature' });
        continue;
      }
      const deliveryId = deliveryIdOf(input.provider, input.headers, parsed);
      if (!deliveryId) {
        outcomes.push({ jobId: job.id, status: 'rejected', reason: 'no_delivery' });
        continue;
      }
      if (!input.claimDelivery(`event-routine:${job.id}:${deliveryId}`)) {
        outcomes.push({ jobId: job.id, status: 'duplicate' });
        continue;
      }

      const precheck = readStoredPrecheck(job.metadata);
      let wakeAgent = true;
      if (precheck) {
        try {
          const gate = await evaluateRoutinePrecheck(precheck, {
            cwd: host.stateDir,
            env:
              precheck.kind === 'script'
                ? { [EVENT_PRECHECK_FILE_ENV]: ensureEventFile() }
                : undefined,
            denyEnv: secret.name ? [secret.name] : undefined
          });
          wakeAgent = gate.wakeAgent;
        } catch (err) {
          host.log.warn('event precheck failed open', { jobId: job.id, error: errorText(err) });
          wakeAgent = true;
        }
      }
      if (!wakeAgent) {
        markCronJobRan(store, job);
        host.log.info('event precheck skipped model turn', { jobId: job.id, name: job.name });
        outcomes.push({ jobId: job.id, status: 'skipped' });
        continue;
      }

      const session = host.store.getSession(job.sessionId);
      if (!session) {
        store.update(job.id, { enabled: false });
        outcomes.push({ jobId: job.id, status: 'missing_session' });
        continue;
      }
      host.store.appendMessage(job.sessionId, 'user', [
        textPart(eventUserText(job, scheduleValue, deliveryId, input.rawBody))
      ]);
      markCronJobRan(store, job);
      const started = startIdleSessionRun(host, session, `event:${job.id}`);
      outcomes.push(
        started
          ? { jobId: job.id, status: 'woke', sessionId: session.id }
          : { jobId: job.id, status: 'not_idle', sessionId: session.id }
      );
    }
  } finally {
    if (eventDir) rmSync(eventDir, { recursive: true, force: true });
  }
  return { scheduleValue, outcomes };
}
