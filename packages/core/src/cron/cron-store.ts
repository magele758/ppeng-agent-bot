import { normalizeExpiresAt, routineExpired } from './routine-deadline.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createId, nowIso } from '../id.js';
import { envBool } from '../env.js';
import type { ToolContract } from '../types.js';
import { principalFromSession } from '../bots/bot-identity.js';
import type { SqliteStateStore } from '../storage.js';
import { ValidationError } from '../errors.js';
import { assertCredentialEnvName } from '../secrets/credential-env.js';
import { nextCronRunAt, nextZonedCronRunAt, normalizeRoutineTimezone } from './cron-next.js';

/**
 * First-class agent cron (SQLite-backed file store under stateDir).
 * Scheduler tick is driven by daemon; tools create/list/remove jobs.
 */

export type CronScheduleKind = 'every_ms' | 'cron5' | 'once_at' | 'event';

export interface CronJobRecord {
  id: string;
  sessionId: string;
  agentId: string;
  name: string;
  prompt: string;
  scheduleKind: CronScheduleKind;
  /**
   * every_ms: interval; cron5: 5-field expression; once_at: ISO timestamp;
   * event: `provider/name` such as `github/push`, `slack/message`, `email/received`.
   */
  scheduleValue: string;
  enabled: boolean;
  expiresAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
  timezone?: string;
  missedPolicy?: 'coalesce' | 'skip' | 'catch_up';
  ruleVersion?: number;
  metadata: Record<string, unknown>;
}

export function cronToolsFeatureEnabled(env: NodeJS.ProcessEnv): boolean {
  return envBool(env, 'RAW_AGENT_CRON_TOOLS', false);
}

export class CronJobStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    const dir = join(stateDir, 'cron');
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'jobs.json');
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, '[]\n', 'utf8');
    }
  }

  private readAll(): CronJobRecord[] {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as CronJobRecord[];
      return Array.isArray(raw) ? raw.map(job=>({...job,timezone:job.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone,missedPolicy:job.missedPolicy??'coalesce',ruleVersion:job.ruleVersion??1})) : [];
    } catch {
      return [];
    }
  }

  private writeAll(jobs: CronJobRecord[]): void {
    const temporary = `${this.filePath}.${process.pid}.${createId('write')}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.filePath);
  }

  list(filter?: { sessionId?: string; enabled?: boolean; botId?: string }): CronJobRecord[] {
    let jobs = this.readAll();
    if (filter?.sessionId) {
      jobs = jobs.filter((j) => j.sessionId === filter.sessionId);
    }
    if (filter?.enabled != null) {
      jobs = jobs.filter((j) => j.enabled === filter.enabled);
    }
    if (filter?.botId) {
      jobs = jobs.filter((j) => j.metadata?.botId === filter.botId);
    }
    return jobs;
  }

  get(id: string): CronJobRecord | undefined {
    return this.readAll().find((j) => j.id === id);
  }

  create(input: Omit<CronJobRecord, 'id' | 'createdAt' | 'updatedAt' | 'enabled'> & { enabled?: boolean }): CronJobRecord {
    const now = nowIso();
    const job: CronJobRecord = {
      ...input,
      id: createId('cron'),
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {}
    };
    const jobs = this.readAll();
    jobs.push(job);
    this.writeAll(jobs);
    return job;
  }

  update(id: string, patch: Partial<CronJobRecord>): CronJobRecord | undefined {
    const jobs = this.readAll();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx < 0) return undefined;
    const next = { ...jobs[idx]!, ...patch, id, updatedAt: nowIso() };
    jobs[idx] = next;
    this.writeAll(jobs);
    return next;
  }

  remove(id: string): boolean {
    const jobs = this.readAll();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length) return false;
    this.writeAll(next);
    return true;
  }

  /**
   * Jobs whose nextRunAt is due (or missing nextRunAt with every_ms elapsed).
   * Event routines are not time-driven and never appear here, even with nextRunAt set.
   */
  dueJobs(now = Date.now()): CronJobRecord[] {
    return this.list({ enabled: true }).filter((j) => {
      if (j.scheduleKind === 'event' || routineExpired(j, now)) return false;
      if (j.nextRunAt) {
        return Date.parse(j.nextRunAt) <= now;
      }
      if (j.scheduleKind === 'every_ms') {
        const ms = Number(j.scheduleValue);
        if (!Number.isFinite(ms) || ms <= 0) return false;
        const last = j.lastRunAt ? Date.parse(j.lastRunAt) : Date.parse(j.createdAt);
        return now - last >= ms;
      }
      if (j.scheduleKind === 'once_at') {
        return Date.parse(j.scheduleValue) <= now;
      }
      if (j.scheduleKind === 'cron5') {
        try {
          const from = j.lastRunAt ? new Date(j.lastRunAt) : new Date(j.createdAt);
          return nextCronRunAt(j.scheduleValue, from).getTime() <= now;
        } catch {
          return false;
        }
      }
      return false;
    });
  }
}

export function createCronTools(getStore: () => CronJobStore, opts?: {store?:SqliteStateStore;isEnabled?:()=>boolean}): ToolContract<any>[] {
  const createTool: ToolContract<{
    name: string;
    prompt: string;
    every_ms?: number;
    once_at?: string;
    expiresAt?: string;
    cron?: string;
    timezone?: string;
    missedPolicy?: 'coalesce'|'skip'|'catch_up';
    event?: string;
    secretEnv?: string;
  }> = {
    name: 'cron_create',
    description:
      'Schedule a recurring or one-shot agent prompt (first-class cron). Prefer every_ms for simple intervals.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        prompt: { type: 'string' },
        every_ms: { type: 'number', minimum: 60000 },
        expiresAt: { type: 'string', description: 'Optional future ISO deadline for cron/every_ms; automatically removes routine after existing runs finish' },
        once_at: { type: 'string' },
        cron: { type: 'string', description: '5-field cron expression' },
        timezone:{type:'string',description:'IANA timezone, e.g. Asia/Shanghai'},
        missedPolicy:{type:'string',enum:['coalesce','skip','catch_up']},
        event:{type:'string',description:'github/push, slack/message, email/received'},
        secretEnv:{type:'string',description:'Environment variable name holding event signature secret'}
      },
      required: ['name', 'prompt']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval: () => true,
    async execute(context, args) {
      if(opts?.isEnabled && !opts.isEnabled())return {ok:false,content:'Routine dialog tools are disabled in Lab settings'};
      const timezone=normalizeRoutineTimezone(args.timezone);
      if([args.every_ms,args.once_at,args.cron,args.event].filter(v=>v!==undefined).length!==1)throw new ValidationError('choose exactly one schedule');
      let scheduleKind: CronJobRecord['scheduleKind'] = 'every_ms';
      let scheduleValue = '3600000';
      let nextRunAt: string | undefined;
      if (args.every_ms != null && Number.isInteger(args.every_ms) && Number(args.every_ms) >= 60000) {
        scheduleKind = 'every_ms';
        scheduleValue = String(Math.floor(Number(args.every_ms)));
        nextRunAt = new Date(Date.now() + Number(scheduleValue)).toISOString();
      } else if (args.once_at) {
        scheduleKind = 'once_at';
        if(!Number.isFinite(Date.parse(args.once_at)))throw new ValidationError('invalid once_at');
        scheduleValue = new Date(args.once_at).toISOString();
        nextRunAt = scheduleValue;
      } else if (args.cron) {
        scheduleKind = 'cron5';
        scheduleValue = args.cron;
        nextRunAt = nextZonedCronRunAt(args.cron,timezone).toISOString();
      } else if (args.event) {
        if(!/^(github|slack|email)\/[a-z][a-z0-9_-]{0,64}$/.test(args.event))throw new ValidationError('valid event and secretEnv required');
        assertCredentialEnvName(String(args.secretEnv ?? ''));
        scheduleKind='event';scheduleValue=args.event;
      } else {
        return { ok: false, content: 'Provide every_ms >= 60000, once_at, or cron' };
      }
      const job = getStore().create({
        sessionId: context.session.id,
        agentId: context.agent.id,
        name: args.name,
        prompt: args.prompt,
        scheduleKind,
        scheduleValue,
        nextRunAt,
        expiresAt: normalizeExpiresAt(args.expiresAt, scheduleKind),
        timezone,
        missedPolicy:args.missedPolicy??'coalesce',
        ruleVersion:1,
        metadata: {
          ...(opts?.store?{principal:principalFromSession(opts.store,context.session)}:{}),
          ...(args.secretEnv?{secretEnv:args.secretEnv,prompt:args.prompt}:{}),
          ...(typeof context.session.metadata?.botId === 'string'
            ? { botId: context.session.metadata.botId }
            : {})
        }
      });
      return { ok: true, content: JSON.stringify(job, null, 2) };
    }
  };

  const listTool: ToolContract<{ session_only?: boolean }> = {
    name: 'cron_list',
    description: 'List cron jobs (default: current session).',
    inputSchema: {
      type: 'object',
      properties: { session_only: { type: 'boolean' } }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      if(opts?.isEnabled && !opts.isEnabled())return {ok:false,content:'Routine dialog tools are disabled in Lab settings'};
      const jobs = getStore().list(
        args.session_only === false ? undefined : { sessionId: context.session.id }
      );
      const owned=opts?.store?jobs.filter(j=>{const parent=opts.store!.getSession(j.sessionId);return parent?.metadata?.userId===context.session.metadata?.userId&&parent?.metadata?.tenantId===context.session.metadata?.tenantId}):jobs;
      return { ok: true, content: JSON.stringify(owned, null, 2) };
    }
  };

  const removeTool: ToolContract<{ id: string }> = {
    name: 'cron_remove',
    description: 'Remove a cron job by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval: () => true,
    async execute(context, args) {
      if(opts?.isEnabled && !opts.isEnabled())return {ok:false,content:'Routine dialog tools are disabled in Lab settings'};
      const job=getStore().get(args.id);
      if(opts?.store&&job){const parent=opts.store.getSession(job.sessionId);if(parent?.metadata?.userId!==context.session.metadata?.userId||parent?.metadata?.tenantId!==context.session.metadata?.tenantId)return {ok:false,content:'Routine not found'};}
      const ok = getStore().remove(args.id);
      return { ok, content: ok ? `Removed ${args.id}` : 'Job not found' };
    }
  };

  return [createTool, listTool, removeTool];
}

/** Advance nextRunAt after a successful fire. Event routines only record lastRunAt. */
export function markCronJobRan(store: CronJobStore, job: CronJobRecord, now = Date.now()): CronJobRecord | undefined {
  const lastRunAt = new Date(now).toISOString();
  switch (job.scheduleKind) {
    case 'once_at':
      return store.update(job.id, { lastRunAt, enabled: false, nextRunAt: undefined });
    case 'every_ms': {
      const ms = Number(job.scheduleValue);
      const nextRunAt = Number.isFinite(ms) && ms > 0 ? new Date(now + ms).toISOString() : undefined;
      return store.update(job.id, { lastRunAt, nextRunAt });
    }
    case 'cron5': {
      const nextRunAt = (job.timezone ? nextZonedCronRunAt(job.scheduleValue, job.timezone, new Date(now)) : nextCronRunAt(job.scheduleValue, new Date(now))).toISOString();
      return store.update(job.id, { lastRunAt, nextRunAt });
    }
    case 'event':
      return store.update(job.id, { lastRunAt, nextRunAt: undefined });
    default: {
      const neverKind: never = job.scheduleKind;
      void neverKind;
      return store.update(job.id, { lastRunAt });
    }
  }
}
