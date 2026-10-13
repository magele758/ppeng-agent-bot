import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createId, nowIso } from '../id.js';
import { envBool } from '../env.js';
import type { ToolContract } from '../types.js';
import { nextCronRunAt } from './cron-next.js';

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
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
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
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private writeAll(jobs: CronJobRecord[]): void {
    writeFileSync(this.filePath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8');
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
      if (j.scheduleKind === 'event') return false;
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

export function createCronTools(getStore: () => CronJobStore): ToolContract<any>[] {
  const createTool: ToolContract<{
    name: string;
    prompt: string;
    every_ms?: number;
    once_at?: string;
    cron?: string;
  }> = {
    name: 'cron_create',
    description:
      'Schedule a recurring or one-shot agent prompt (first-class cron). Prefer every_ms for simple intervals.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        prompt: { type: 'string' },
        every_ms: { type: 'number' },
        once_at: { type: 'string' },
        cron: { type: 'string', description: '5-field cron expression (stored; tick support is best-effort)' }
      },
      required: ['name', 'prompt']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval: () => true,
    async execute(context, args) {
      let scheduleKind: CronJobRecord['scheduleKind'] = 'every_ms';
      let scheduleValue = '3600000';
      let nextRunAt: string | undefined;
      if (args.every_ms != null && Number(args.every_ms) > 0) {
        scheduleKind = 'every_ms';
        scheduleValue = String(Math.floor(Number(args.every_ms)));
        nextRunAt = new Date(Date.now() + Number(scheduleValue)).toISOString();
      } else if (args.once_at) {
        scheduleKind = 'once_at';
        scheduleValue = args.once_at;
        nextRunAt = args.once_at;
      } else if (args.cron) {
        scheduleKind = 'cron5';
        scheduleValue = args.cron;
        nextRunAt = nextCronRunAt(args.cron).toISOString();
      } else {
        return { ok: false, content: 'Provide every_ms, once_at, or cron' };
      }
      const job = getStore().create({
        sessionId: context.session.id,
        agentId: context.agent.id,
        name: args.name,
        prompt: args.prompt,
        scheduleKind,
        scheduleValue,
        nextRunAt,
        metadata: {
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
      const jobs = getStore().list(
        args.session_only === false ? undefined : { sessionId: context.session.id }
      );
      return { ok: true, content: JSON.stringify(jobs, null, 2) };
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
    async execute(_context, args) {
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
      const nextRunAt = nextCronRunAt(job.scheduleValue, new Date(now)).toISOString();
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
