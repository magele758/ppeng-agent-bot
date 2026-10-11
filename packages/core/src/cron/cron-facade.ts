import { NotFoundError, ValidationError } from '../errors.js';
import { openBot } from '../bots/bot-facade.js';
import type { SessionFacadeHost } from '../runtime/session-facade.js';
import type { CronJobRecord } from './cron-store.js';
import { CronJobStore } from './cron-store.js';
import { nextCronRunAt, parseCron5 } from './cron-next.js';
import type { RoutinePrecheck } from './routine-precheck.js';

export interface CreateCronJobInput {
  name: string;
  prompt: string;
  cron: string;
  sessionId?: string;
  botId?: string;
  enabled?: boolean;
  /** Script or predicate run before the model. Persisted on the routine. */
  precheck?: unknown;
}

export interface UpdateCronJobInput {
  name?: string;
  prompt?: string;
  cron?: string;
  enabled?: boolean;
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

export function createCronJob(host: CronFacadeHost, input: CreateCronJobInput): CronJobRecord {
  const name = normalizeName(input.name);
  const prompt = normalizePrompt(input.prompt);
  const cron = normalizeCron(input.cron);
  let sessionId = input.sessionId?.trim() || undefined;
  let agentId = 'general';
  let botId = input.botId?.trim() || undefined;

  if (botId) {
    const opened = openBot(host, botId);
    sessionId = opened.sessionId;
    agentId = opened.bot.agentId;
  }
  if (!sessionId) throw new ValidationError('sessionId or botId is required');

  const session = host.store.getSession(sessionId);
  if (!session) throw new NotFoundError('Session', sessionId);
  agentId = session.agentId;
  if (!botId && typeof session.metadata?.botId === 'string') {
    botId = session.metadata.botId;
  }

  const metadata: Record<string, unknown> = {};
  if (botId) metadata.botId = botId;
  if (input.precheck != null) metadata.precheck = parseRoutinePrecheck(input.precheck);

  return ensureCronStore(host).create({
    sessionId,
    agentId,
    name,
    prompt,
    scheduleKind: 'cron5',
    scheduleValue: cron,
    enabled: input.enabled !== false,
    nextRunAt: nextCronRunAt(cron).toISOString(),
    metadata
  });
}

export function updateCronJob(
  host: CronFacadeHost,
  id: string,
  patch: UpdateCronJobInput
): CronJobRecord {
  const current = getCronJob(host, id);
  const next: Partial<CronJobRecord> = {};
  if (patch.name !== undefined) next.name = normalizeName(patch.name);
  if (patch.prompt !== undefined) next.prompt = normalizePrompt(patch.prompt);
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.precheck !== undefined) {
    const metadata = { ...(current.metadata ?? {}) };
    if (patch.precheck === null) delete metadata.precheck;
    else metadata.precheck = parseRoutinePrecheck(patch.precheck);
    next.metadata = metadata;
  }
  if (patch.cron !== undefined) {
    const cron = normalizeCron(patch.cron);
    next.scheduleKind = 'cron5';
    next.scheduleValue = cron;
    next.nextRunAt = nextCronRunAt(cron).toISOString();
  } else if (patch.enabled === true && current.scheduleKind === 'cron5') {
    const due = current.nextRunAt ? Date.parse(current.nextRunAt) : NaN;
    if (!Number.isFinite(due) || due <= Date.now()) {
      next.nextRunAt = nextCronRunAt(current.scheduleValue).toISOString();
    }
  }
  const updated = ensureCronStore(host).update(id, next);
  if (!updated) throw new NotFoundError('CronJob', id);
  return updated;
}

export function deleteCronJob(host: CronFacadeHost, id: string): void {
  getCronJob(host, id);
  ensureCronStore(host).remove(id);
}
