import { createId } from '../id.js';
import { routineExpired } from './routine-deadline.js';
import { RoutineRunStore, drainRoutineRuns, type RoutineRuntimeHost, type RoutineRun } from './routine-runtime.js';
import { normalizeExpiresAt } from './routine-deadline.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js';
import { resolveBotPrincipal, principalFromSession } from '../bots/bot-identity.js';
import { assertBotRoomTarget } from '../rooms/index.js';
import { openBot } from '../bots/bot-facade.js';
import type { SessionFacadeHost } from '../runtime/session-facade.js';
import type { CronJobRecord } from './cron-store.js';
import { CronJobStore } from './cron-store.js';
import { nextZonedCronRunAt, normalizeRoutineTimezone, parseCron5 } from './cron-next.js';
import { normalizeCiConclusions, parseEventScheduleValue } from './event-routine.js';
import type { RoutinePrecheck } from './routine-precheck.js';
import { assertCredentialEnvName } from '../secrets/credential-env.js';

export interface CreateCronJobInput {
  name: string;
  prompt: string;
  onceAt?: string;
  expiresAt?: string | null;
  intervalMs?: number;
  timezone?: string;
  missedPolicy?: 'coalesce' | 'skip' | 'catch_up';
  userId?: string;
  tenantId?: string;
  /** 5-field cron. Omit when `event` is set. */
  cron?: string;
  /**
   * Event schedule, for example `github/push`, `slack/message`, `email/received`.
   * Event routines are not time-polled.
   */
  event?: string;
  /** Lab Secret Vault credential name, with legacy environment fallback. Never the secret itself. */
  secretEnv?: string;
  /** Empty array accepts every completed CI conclusion. */
  conclusions?: string[];
  sessionId?: string;
  botId?: string;
  /** Group that receives a non-empty completed result. The owning bot must be a member. */
  roomId?: string;
  enabled?: boolean;
  /** Script or predicate run before the model. Persisted on the routine. */
  precheck?: unknown;
}

export interface UpdateCronJobInput {
  name?: string;
  prompt?: string;
  onceAt?: string;
  expiresAt?: string | null;
  intervalMs?: number;
  event?: string;
  secretEnv?: string;
  /** Empty array accepts every completed CI conclusion. */
  conclusions?: string[];
  timezone?: string;
  missedPolicy?: 'coalesce' | 'skip' | 'catch_up';
  cron?: string;
  enabled?: boolean;
  /** `null` clears the target room. */
  roomId?: string | null;
  /** `null` clears a saved precheck. */
  precheck?: unknown;
}

export interface ListCronJobsFilter {
  sessionId?: string;
  botId?: string;
  enabled?: boolean;
}

export interface CronFacadeHost extends SessionFacadeHost {
  stateDir: string;
  cronStore: CronJobStore | undefined;
  setCronStore(store: CronJobStore): void;
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ValidationError('name is required');
  if (name.length > 80) throw new ValidationError('name must be ≤ 80 characters');
  return name;
}

function normalizePrompt(raw: string): string {
  const prompt = raw.trim();
  if (!prompt) throw new ValidationError('prompt is required');
  if (prompt.length > 8000) throw new ValidationError('prompt must be ≤ 8000 characters');
  return prompt;
}

function normalizeCron(raw: string): string {
  const cron = raw.trim();
  parseCron5(cron);
  return cron;
}

function normalizeSecretEnv(raw: string): string {
  const name = raw.trim();
  assertCredentialEnvName(name);
  return name;
}

const MAX_PRECHECK_SOURCE = 4000;

export function parseRoutinePrecheck(raw: unknown): RoutinePrecheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('precheck must be an object');
  }
  const kind = (raw as { kind?: unknown }).kind;
  const source = (raw as { source?: unknown }).source;
  if (kind !== 'script' && kind !== 'predicate') {
    throw new ValidationError('precheck.kind must be script or predicate');
  }
  if (typeof source !== 'string' || !source.trim()) {
    throw new ValidationError('precheck.source is required');
  }
  if (source.length > MAX_PRECHECK_SOURCE) {
    throw new ValidationError('precheck.source must be ≤ 4000 characters');
  }
  return { kind, source: source.trim() };
}

export function ensureCronStore(host: CronFacadeHost): CronJobStore {
  if (!host.cronStore) {
    const store = new CronJobStore(host.stateDir);
    host.setCronStore(store);
    host.cronStore = store;
  }
  return host.cronStore;
}

export function listCronJobs(host: CronFacadeHost, filter?: ListCronJobsFilter): CronJobRecord[] {
  return ensureCronStore(host).list(filter);
}

export function getCronJob(host: CronFacadeHost, id: string): CronJobRecord {
  const job = ensureCronStore(host).get(id);
  if (!job) throw new NotFoundError('CronJob', id);
  return job;
}

function jobPrincipal(host:CronFacadeHost,job:CronJobRecord):ReturnType<typeof principalFromSession> {
 const session=host.store.getSession(job.sessionId);
 if(session)return principalFromSession(host.store,session);
 const raw=job.metadata.principal;
 if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&typeof (raw as {userId?:unknown}).userId==='string'&&(raw as {userId:string}).userId.trim()){
  const tenant=(raw as {tenantId?:unknown}).tenantId;
  return {userId:(raw as {userId:string}).userId.trim(),...(typeof tenant==='string'&&tenant.trim()?{tenantId:tenant.trim()}:{})};
 }
 throw new AuthorizationError();
}
function resolveCronBinding(host:CronFacadeHost,input:CreateCronJobInput) {
 let sessionId=input.sessionId?.trim();let botId=input.botId?.trim();
 if(botId)sessionId=openBot(host,botId,resolveBotPrincipal(host.store,input)).sessionId;
 if(!sessionId)throw new ValidationError('sessionId or botId is required');
 const session=host.store.getSession(sessionId);if(!session)throw new NotFoundError('Session',sessionId);
 if(!botId&&typeof session.metadata.botId==='string')botId=session.metadata.botId;
 return {session,botId};
}
function normalizeMissedPolicy(value:string|undefined):NonNullable<CronJobRecord['missedPolicy']>{
 const policy=value??'coalesce';if(!['coalesce','skip','catch_up'].includes(policy))throw new ValidationError('invalid missedPolicy');return policy as NonNullable<CronJobRecord['missedPolicy']>;
}
function intervalSchedule(value:number):Pick<CronJobRecord,'scheduleKind'|'scheduleValue'|'nextRunAt'>{
 if(!Number.isInteger(value)||value<60000)throw new ValidationError('intervalMs must be >= 60000');
 return {scheduleKind:'every_ms',scheduleValue:String(value),nextRunAt:new Date(Date.now()+value).toISOString()};
}
function onceSchedule(value:string):Pick<CronJobRecord,'scheduleKind'|'scheduleValue'|'nextRunAt'>{
 const instant=Date.parse(value);if(!Number.isFinite(instant))throw new ValidationError('invalid onceAt');const at=new Date(instant).toISOString();return {scheduleKind:'once_at',scheduleValue:at,nextRunAt:at};
}
function eventSchedule(value:string):Pick<CronJobRecord,'scheduleKind'|'scheduleValue'|'nextRunAt'>{
 const event=parseEventScheduleValue(value);if(!event)throw new ValidationError('invalid event');return {scheduleKind:'event',scheduleValue:event,nextRunAt:undefined};
}
function normalizeSchedule(input:Pick<CreateCronJobInput,'cron'|'event'|'onceAt'|'intervalMs'>,timezone:string):Pick<CronJobRecord,'scheduleKind'|'scheduleValue'|'nextRunAt'>{
 const selectors=[input.cron,input.event,input.onceAt,input.intervalMs].filter(value=>value!==undefined&&value!=='');
 if(selectors.length!==1)throw new ValidationError('choose exactly one schedule');
 if(input.onceAt!==undefined)return onceSchedule(input.onceAt);
 if(input.intervalMs!==undefined)return intervalSchedule(input.intervalMs);
 if(input.event!==undefined)return eventSchedule(input.event);
 const cron=normalizeCron(input.cron!);return {scheduleKind:'cron5',scheduleValue:cron,nextRunAt:nextZonedCronRunAt(cron,timezone).toISOString()};
}
export function createCronJob(host:CronFacadeHost,input:CreateCronJobInput):CronJobRecord {
 const name=normalizeName(input.name),prompt=normalizePrompt(input.prompt);
 const {session,botId}=resolveCronBinding(host,input);const timezone=normalizeRoutineTimezone(input.timezone);
 const schedule=normalizeSchedule(input,timezone);
 const principal=principalFromSession(host.store,session);
 const roomId=input.roomId?.trim();
 if(roomId)assertBotRoomTarget(host.store,roomId,botId,principal);
 const metadata:Record<string,unknown>={principal};
 if(botId)metadata.botId=botId;
 if(roomId)metadata.roomId=roomId;
 if(input.conclusions!==undefined)metadata.conclusions=normalizeCiConclusions(input.conclusions);
 if(input.precheck!=null)metadata.precheck=parseRoutinePrecheck(input.precheck);
 if(schedule.scheduleKind==='event'){if(!input.secretEnv)throw new ValidationError('secretEnv required for event');metadata.secretEnv=normalizeSecretEnv(input.secretEnv);metadata.prompt=prompt;}
 return ensureCronStore(host).create({expiresAt:normalizeExpiresAt(input.expiresAt,schedule.scheduleKind),name,prompt,sessionId:session.id,agentId:session.agentId,timezone,missedPolicy:normalizeMissedPolicy(input.missedPolicy),ruleVersion:1,metadata,enabled:input.enabled!==false,...schedule});
}
function schedulePatch(current:CronJobRecord,patch:UpdateCronJobInput):Partial<CronJobRecord>{
 const next:Partial<CronJobRecord>={};
 if(patch.timezone!==undefined)next.timezone=normalizeRoutineTimezone(patch.timezone);
 if(patch.missedPolicy!==undefined)next.missedPolicy=normalizeMissedPolicy(patch.missedPolicy);
 const selectors=[patch.cron,patch.onceAt,patch.intervalMs,patch.event].filter(value=>value!==undefined);
 if(selectors.length>1)throw new ValidationError('choose exactly one schedule');
 if(selectors.length)Object.assign(next,normalizeSchedule(patch,next.timezone??current.timezone??'UTC'));
 if(selectors.length||patch.timezone!==undefined){next.ruleVersion=(current.ruleVersion??1)+1;next.metadata={...current.metadata,catchUpPlan:undefined};}
 if(!selectors.length&&(patch.enabled===true||patch.timezone!==undefined)&&current.scheduleKind==='cron5'){
  const due=Date.parse(current.nextRunAt??'');if(patch.timezone!==undefined||!Number.isFinite(due)||due<=Date.now())next.nextRunAt=nextZonedCronRunAt(current.scheduleValue,next.timezone??current.timezone??'UTC').toISOString();
 }
 return next;
}
function contentPatch(host:CronFacadeHost,current:CronJobRecord,patch:UpdateCronJobInput,next:Partial<CronJobRecord>):void {
 if(patch.name!==undefined)next.name=normalizeName(patch.name);
 if(patch.prompt!==undefined)next.prompt=normalizePrompt(patch.prompt);
 if(patch.enabled!==undefined)next.enabled=patch.enabled;
 const metadata={...(next.metadata??current.metadata)};
 if(patch.conclusions!==undefined)metadata.conclusions=normalizeCiConclusions(patch.conclusions);
 if(patch.secretEnv!==undefined)metadata.secretEnv=normalizeSecretEnv(patch.secretEnv);
 if(patch.precheck!==undefined){if(patch.precheck===null)delete metadata.precheck;else metadata.precheck=parseRoutinePrecheck(patch.precheck);}
 if(patch.roomId!==undefined){
  if(patch.roomId===null)delete metadata.roomId;
  else {const roomId=patch.roomId.trim();if(!roomId)throw new ValidationError('roomId is required');const botId=typeof metadata.botId==='string'?metadata.botId:undefined;assertBotRoomTarget(host.store,roomId,botId,jobPrincipal(host,current));metadata.roomId=roomId;}
 }
 if((next.scheduleKind??current.scheduleKind)==='event'){
  if(typeof metadata.secretEnv!=='string')throw new ValidationError('secretEnv required for event');metadata.prompt=next.prompt??current.prompt;
 }
 next.metadata=metadata;
}
export function updateCronJob(host:CronFacadeHost,id:string,patch:UpdateCronJobInput):CronJobRecord {
 const current=getCronJob(host,id);const next=schedulePatch(current,patch);contentPatch(host,current,patch,next);
 if(patch.expiresAt!==undefined)next.expiresAt=normalizeExpiresAt(patch.expiresAt,next.scheduleKind??current.scheduleKind);
 else if(next.scheduleKind&&!['cron5','every_ms'].includes(next.scheduleKind))next.expiresAt=undefined;
 const updated=ensureCronStore(host).update(id,next);if(!updated)throw new NotFoundError('CronJob',id);return updated;
}

export function deleteCronJob(host: CronFacadeHost, id: string): void {
  getCronJob(host, id);
  ensureCronStore(host).remove(id);
}

/** Manual admission uses the normal serial worker and does not advance future triggers. */
export async function runCronJobNow(host: RoutineRuntimeHost, job: CronJobRecord): Promise<RoutineRun> {
  if (!job.enabled || routineExpired(job)) throw new ValidationError('Routine is paused or expired');
  const runs = new RoutineRunStore(host.store);
  const run = runs.enqueue(job, new Date().toISOString(), {key:createId('manual')});
  await drainRoutineRuns(host);
  return runs.get(run.id)!;
}
