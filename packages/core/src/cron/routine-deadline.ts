import { ValidationError } from '../errors.js';

/** Deadlines are absolute instants, independent of the routine's display timezone. */
export function normalizeExpiresAt(value: unknown, kind: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!['cron5', 'every_ms'].includes(kind)) throw new ValidationError('expiresAt requires a recurring schedule');
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) {
    throw new ValidationError('expiresAt must be a future ISO timestamp with timezone');
  }
  return new Date(value).toISOString();
}

export function routineExpired(job: { expiresAt?: string }, now = Date.now()): boolean {
  return job.expiresAt !== undefined && now >= Date.parse(job.expiresAt);
}
