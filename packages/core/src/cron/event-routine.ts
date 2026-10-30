/**
 * Event-triggered routines. A signed webhook can wake the owning session.
 * Time-based ticks never see these jobs (`scheduleKind: 'event'`).
 *
 * The event JSON is written to a temp file. Script prechecks receive that path
 * in `PPENG_EVENT_FILE` and the stored command is not rewritten.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretVault, type SecretVaultStore } from '../secrets/secret-vault.js';
import { ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import { fenceExternalContent } from '../safety/external-content.js';
import { assertCredentialEnvName } from '../secrets/credential-env.js';
import type { MessagePart, SessionRecord } from '../types.js';
import { textPart } from '../runtime/session-facade.js';
import { BotQueueCapacityError } from '../bots/bot-work.js';
import { RoutineRunStore, drainRoutineRuns, repairRoutineOwnerSession } from './routine-runtime.js';
import type { SqliteStateStore } from '../storage.js';
import { startIdleSessionRun } from '../runtime/scheduler-host.js';
import { CronJobStore, markCronJobRan, type CronJobRecord } from './cron-store.js';
import { evaluateRoutinePrecheck, readStoredPrecheck } from './routine-precheck.js';

/** Child env var. The value is a file path, never the event JSON. */
export const EVENT_PRECHECK_FILE_ENV = 'PPENG_EVENT_FILE';

/** Slack, email, and GitHub reject timestamps further than this from now. */
export const EVENT_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

const SUMMARY_MAX = 12_000;
const EVENT_SCHEDULE = /^(?:(github|slack|email)\/[a-z][a-z0-9_-]{0,64}|webhook\/generic|ci\/status)$/;

export type EventProvider = 'github' | 'slack' | 'email' | 'webhook' | 'ci';

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
  isSessionRunning?(sessionId:string):boolean;
  hasUnconfirmedEffects?(sessionId:string,startedAt:string):boolean;
  cancelSession?(sessionId:string):unknown;
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
  /** `claimInboundEvent` from the gateway. False means this delivery was already claimed. A throw is a retryable lock timeout, not a duplicate. */
  claimDelivery: (key: string) => boolean | Promise<boolean>;
}

export interface EventJobOutcome {
  jobId: string;
  status: 'rejected' | 'duplicate' | 'skipped' | 'woke' | 'not_idle' | 'missing_session' | 'queue_full' | 'queued';
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
  const left = createHash('sha256').update(expected.toLowerCase()).digest();
  const right = createHash('sha256').update(provided.trim().toLowerCase()).digest();
  return timingSafeEqual(left, right);
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * `X-Hub-Signature-256` is `sha256=` + HMAC-SHA256(secret, `${timestamp}.${deliveryId}.${rawBody}`).
 * `X-Github-Timestamp` is unix seconds. `X-Github-Delivery` is the delivery id.
 * Both are inside the MAC, and a timestamp more than 5 minutes from now is rejected.
 * A captured body signature cannot be replayed with another delivery id or a fresh time.
 */
export function verifyGithubSignature(input: {
  rawBody: string;
  secret: string;
  signature: string | undefined;
  deliveryId?: string;
  timestamp?: string;
  nowMs?: number;
}): boolean {
  if (!input.secret || !input.signature) return false;
  const deliveryId = clampDeliveryId(input.deliveryId);
  const timestamp = freshTimestamp(input.timestamp, input.nowMs ?? Date.now());
  if (!deliveryId || !timestamp) return false;
  const expected = `sha256=${hmacHex(input.secret, `${timestamp}.${deliveryId}.${input.rawBody}`)}`;
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
 * `X-Ppeng-Signature: sha256=<hex>` is HMAC-SHA256(secret, `${timestamp}.${deliveryId}.${rawBody}`).
 * `X-Ppeng-Timestamp` is unix seconds. The delivery id (`X-Ppeng-Delivery`, or the
 * equivalent id on the message) is inside the MAC, and a timestamp more than 5
 * minutes from now is rejected. A captured signature cannot be replayed with
 * another delivery id or a fresh time.
 */
export function verifyEmailSignature(input: {
  rawBody: string;
  secret: string;
  signature: string | undefined;
  deliveryId?: string;
  timestamp?: string;
  nowMs?: number;
}): boolean {
  if (!input.secret || !input.signature) return false;
  const deliveryId = clampDeliveryId(input.deliveryId);
  const timestamp = freshTimestamp(input.timestamp, input.nowMs ?? Date.now());
  if (!deliveryId || !timestamp) return false;
  const expected = `sha256=${hmacHex(input.secret, `${timestamp}.${deliveryId}.${input.rawBody}`)}`;
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


const CI_CONCLUSIONS = new Set(['success', 'failure', 'error', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']);
export function normalizeCiConclusions(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !CI_CONCLUSIONS.has(item))) {
    throw new ValidationError('conclusions must be an array of CI completion conclusions');
  }
  return [...new Set(value as string[])];
}
function ciConclusion(headers: EventRoutineHeaders, body: unknown): string | undefined {
  const event = headerValue(headers, 'x-github-event');
  const rec = asRecord(body);
  if (event === 'status') return ['success', 'failure', 'error'].includes(String(rec?.state)) ? String(rec?.state) : undefined;
  if (event !== 'check_run' && event !== 'workflow_run') return undefined;
  const run = asRecord(rec?.[event]);
  if (rec?.action !== 'completed' || run?.status !== 'completed') return undefined;
  return typeof run.conclusion === 'string' && CI_CONCLUSIONS.has(run.conclusion) ? run.conclusion : undefined;
}

function resolveScheduleValue(
  provider: EventProvider,
  headers: EventRoutineHeaders,
  body: unknown
): string | undefined {
  if (provider === 'webhook') return 'webhook/generic';
  if (provider === 'ci') return ciConclusion(headers, body) ? 'ci/status' : undefined;
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
  if (provider === 'github' || provider === 'ci') return clampDeliveryId(headerValue(headers, 'x-github-delivery'));
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

function resolveRoutineSecret(name: unknown, env: NodeJS.ProcessEnv, store: EventRoutineStore): { name?: string; value?: string } {
  if (typeof name !== 'string') return {};
  try {
    assertCredentialEnvName(name);
  } catch {
    return {};
  }
  const vault = 'getDaemonControl' in store && 'setDaemonControl' in store ? new SecretVault(store as EventRoutineStore & SecretVaultStore) : undefined;
  const value = vault?.get(name) ?? env[name];
  if (typeof value !== 'string' || value.length === 0) return { name };
  return { name, value };
}

function signatureOk(
  provider: EventProvider,
  rawBody: string,
  secret: string,
  headers: EventRoutineHeaders,
  nowMs: number,
  deliveryId?: string
): boolean {
  if (provider === 'github' || provider === 'ci') {
    return verifyGithubSignature({
      rawBody,
      secret,
      signature: headerValue(headers, 'x-hub-signature-256'),
      deliveryId: headerValue(headers, 'x-github-delivery'),
      timestamp: headerValue(headers, 'x-github-timestamp'),
      nowMs
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
    deliveryId,
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

function slackThreadLine(rawBody: string): string {
  try {
    const body = JSON.parse(rawBody) as { event?: { channel?: unknown; thread_ts?: unknown; ts?: unknown } };
    const channel = typeof body.event?.channel === 'string' ? body.event.channel.trim() : '';
    const thread = typeof body.event?.thread_ts === 'string' ? body.event.thread_ts.trim() : '';
    const ts = typeof body.event?.ts === 'string' ? body.event.ts.trim() : '';
    const threadTs = thread || ts;
    if (!/^[A-Z0-9]{1,32}$/.test(channel) || !/^\d{1,16}\.\d{1,8}$/.test(threadTs)) return '';
    return `thread: slack:${channel}:${threadTs}\n`;
  } catch {
    return '';
  }
}

function summarizeEvent(scheduleValue: string, deliveryId: string, rawBody: string): string {
  const body = rawBody.length > SUMMARY_MAX ? `${rawBody.slice(0, SUMMARY_MAX)}\n…[truncated]` : rawBody;
  const thread = scheduleValue === 'slack/message' ? slackThreadLine(rawBody) : '';
  return `delivery: ${deliveryId}\nschedule: ${scheduleValue}\n${thread}${body}`;
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

function verifyRoutineDelivery(job:CronJobRecord,input:AcceptEventRoutineInput,env:NodeJS.ProcessEnv,nowMs:number,store:EventRoutineStore):{deliveryId:string;secretName?:string}|EventJobOutcome {
 const secret=resolveRoutineSecret(job.metadata.secretEnv,env,store);
 const deliveryId=deliveryIdOf(input.provider,input.headers,input.body);
 if(!secret.value||!signatureOk(input.provider,input.rawBody,secret.value,input.headers,nowMs,deliveryId))return {jobId:job.id,status:'rejected',reason:'bad_signature'};
 if(!deliveryId)return {jobId:job.id,status:'rejected',reason:'no_delivery'};
 return {deliveryId,secretName:secret.name};
}
async function acceptDurableRoutineEvent(host:EventRoutineHost,config:CronJobStore,job:CronJobRecord,input:AcceptEventRoutineInput,scheduleValue:string,deliveryId:string,nowMs:number):Promise<EventJobOutcome>{
 const runtimeHost={...host,store:host.store as SqliteStateStore};
 const session=host.store.getSession(job.sessionId)??repairRoutineOwnerSession(runtimeHost,job);
 if(!session){config.update(job.id,{enabled:false});return {jobId:job.id,status:'missing_session'};}
 const runs=new RoutineRunStore(runtimeHost.store),key=`event:${job.id}:${deliveryId}`;
 if(runs.findByKey(key))return {jobId:job.id,status:'duplicate'};
 let run;
 try{run=runs.enqueue(job,new Date(nowMs).toISOString(),{key,prompt:eventUserText(job,scheduleValue,deliveryId,input.rawBody),eventBody:input.rawBody});}
 catch(error){if(error instanceof BotQueueCapacityError){config.update(job.id,{metadata:{...job.metadata,queueBlockedReason:error.message}});return {jobId:job.id,status:'queue_full'};}throw error;}
 if(!input.claimDelivery(`event-routine:${job.id}:${deliveryId}`)){runs.update(run.id,{status:'unknown',error:'External dedupe receipt exists without a local occurrence; verify effects before retry'});return {jobId:job.id,status:'duplicate'};}
 markCronJobRan(config,job,nowMs);config.update(job.id,{metadata:{...job.metadata,queueBlockedReason:undefined}});
 await drainRoutineRuns(runtimeHost);const saved=runs.get(run.id)!;
 return {jobId:job.id,status:saved.status==='skipped'?'skipped':saved.sessionId?'woke':'queued',...(saved.sessionId?{sessionId:saved.sessionId}:{})};
}
async function legacyEventPrecheck(host:EventRoutineHost,job:CronJobRecord,rawBody:string,secretName?:string):Promise<boolean>{
 const precheck=readStoredPrecheck(job.metadata);if(!precheck)return true;
 let directory:string|undefined;let env:NodeJS.ProcessEnv|undefined;
 try{
  if(precheck.kind==='script'){directory=mkdtempSync(join(tmpdir(),'ppeng-event-'));const path=join(directory,'event.json');writeFileSync(path,rawBody,{encoding:'utf8',mode:0o600});env={[EVENT_PRECHECK_FILE_ENV]:path};}
  const result=await evaluateRoutinePrecheck(precheck,{cwd:host.stateDir,...(env?{env}:{}),...(secretName?{denyEnv:[secretName]}:{})});return result.wakeAgent;
 }finally{if(directory)rmSync(directory,{recursive:true,force:true});}
}
async function acceptLegacyRoutineEvent(host:EventRoutineHost,config:CronJobStore,job:CronJobRecord,input:AcceptEventRoutineInput,scheduleValue:string,deliveryId:string,secretName?:string):Promise<EventJobOutcome>{
 if(!input.claimDelivery(`event-routine:${job.id}:${deliveryId}`))return {jobId:job.id,status:'duplicate'};
 if(!await legacyEventPrecheck(host,job,input.rawBody,secretName)){markCronJobRan(config,job);return {jobId:job.id,status:'skipped'};}
 const session=host.store.getSession(job.sessionId);
 if(!session){config.update(job.id,{enabled:false});return {jobId:job.id,status:'missing_session'};}
 host.store.appendMessage(job.sessionId,'user',[textPart(eventUserText(job,scheduleValue,deliveryId,input.rawBody))]);markCronJobRan(config,job);
 const started=startIdleSessionRun(host,session,`event:${job.id}`);return {jobId:job.id,status:started?'woke':'not_idle',sessionId:session.id};
}
/** Validated events are durably admitted before claiming external dedupe; compatibility stores keep their old wake contract. */
export async function acceptEventRoutine(host:EventRoutineHost,input:AcceptEventRoutineInput):Promise<AcceptEventRoutineResult>{
 let parsed=input.body;
 if(parsed===undefined){try{parsed=JSON.parse(input.rawBody);}catch{return {outcomes:[],error:'invalid_json'};}}
 const scheduleValue=resolveScheduleValue(input.provider,input.headers,parsed);if(!scheduleValue)return {outcomes:[],error:'invalid_event'};
 const config=cronStoreOf(host),env=input.env??process.env,nowMs=input.nowMs??Date.now();
 const conclusion = input.provider==='github'||input.provider==='ci' ? ciConclusion(input.headers,parsed) : undefined;
 const jobs=config.list({enabled:true}).filter(job=>job.scheduleKind==='event' && (job.scheduleValue===scheduleValue || (job.scheduleValue==='ci/status' && conclusion!==undefined)) && (job.scheduleValue!=='ci/status' || !Array.isArray(job.metadata.conclusions) || !job.metadata.conclusions.length || job.metadata.conclusions.includes(conclusion)));const outcomes:EventJobOutcome[]=[];
 const verifiedInput={...input,body:parsed};
 for(const job of jobs){
  const verified=verifyRoutineDelivery(job,verifiedInput,env,nowMs,host.store);
  if('jobId' in verified){outcomes.push(verified);continue;}
  const outcome='db' in host.store&&'createSession' in host.store?await acceptDurableRoutineEvent(host,config,job,verifiedInput,job.scheduleValue,verified.deliveryId,nowMs):await acceptLegacyRoutineEvent(host,config,job,verifiedInput,job.scheduleValue,verified.deliveryId,verified.secretName);
  outcomes.push(outcome);
 }
 return {scheduleValue,outcomes};
}
