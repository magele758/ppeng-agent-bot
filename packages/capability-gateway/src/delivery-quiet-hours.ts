/**
 * Global quiet hours for user-facing outbound (UserDeliveryPort).
 * Persisted in daemon_control KV and edited through GET/PATCH /api/delivery/quiet-hours
 * (no env switch). Window semantics match cron attention policy (`notificationDecision`):
 * local hours in `timezone`, `[startHour, endHour)`, wrapping past midnight when start > end;
 * start === end means no window.
 */

import { ValidationError } from '@ppeng/agent-core';
import type { GatewaySettingsStore } from './gateway-settings.js';

export const DELIVERY_QUIET_HOURS_KEY = 'delivery_quiet_hours';

export interface QuietHoursPolicy {
  enabled: boolean;
  startHour: number;
  endHour: number;
  /** IANA timezone, e.g. Asia/Shanghai. */
  timezone: string;
}

export interface QuietHoursSettings extends QuietHoursPolicy {
  updatedAt: string;
}

export type QuietHoursPatch = Partial<QuietHoursPolicy>;

const STEP_MS = 15 * 60_000;
const MAX_STEPS = (24 * 60 * 60_000) / STEP_MS;

export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function defaultQuietHours(): QuietHoursSettings {
  return {
    enabled: false,
    startHour: 22,
    endHour: 8,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    updatedAt: new Date(0).toISOString()
  };
}

function hourOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback;
}

export function normalizeQuietHours(raw: unknown): QuietHoursSettings {
  const base = defaultQuietHours();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const timezone = typeof r.timezone === 'string' && validTimezone(r.timezone) ? r.timezone : base.timezone;
  return {
    enabled: r.enabled === true,
    startHour: hourOr(r.startHour, base.startHour),
    endHour: hourOr(r.endHour, base.endHour),
    timezone,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : base.updatedAt
  };
}

export function readQuietHours(store: GatewaySettingsStore | undefined): QuietHoursSettings {
  if (!store || typeof store.getDaemonControl !== 'function') return defaultQuietHours();
  return normalizeQuietHours(store.getDaemonControl(DELIVERY_QUIET_HOURS_KEY));
}

export function writeQuietHours(store: GatewaySettingsStore, patch: QuietHoursPatch): QuietHoursSettings {
  if (typeof store.setDaemonControl !== 'function') throw new Error('quiet hours store cannot persist');
  const next: QuietHoursSettings = {
    ...readQuietHours(store),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  store.setDaemonControl(DELIVERY_QUIET_HOURS_KEY, next);
  return next;
}

function patchHour(body: Record<string, unknown>, key: 'startHour' | 'endHour'): number | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23) {
    throw new ValidationError(`${key} must be an integer 0-23`);
  }
  return v;
}

function patchTimezone(body: Record<string, unknown>): string | undefined {
  if (!('timezone' in body)) return undefined;
  const v = body.timezone;
  if (typeof v !== 'string' || !validTimezone(v)) throw new ValidationError('timezone must be a valid IANA timezone');
  return v;
}

function patchEnabled(body: Record<string, unknown>): boolean | undefined {
  if (!('enabled' in body)) return undefined;
  if (typeof body.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
  return body.enabled;
}

/** Validate an untrusted PATCH body (throws ValidationError → 400). */
export function parseQuietHoursPatch(body: unknown): QuietHoursPatch {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('body must be an object');
  const o = body as Record<string, unknown>;
  const patch: QuietHoursPatch = {
    enabled: patchEnabled(o),
    startHour: patchHour(o, 'startHour'),
    endHour: patchHour(o, 'endHour'),
    timezone: patchTimezone(o)
  };
  for (const key of Object.keys(patch) as (keyof QuietHoursPatch)[]) {
    if (patch[key] === undefined) delete patch[key];
  }
  return patch;
}

function localHour(now: number, timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

/** True when `now` falls inside an enabled quiet window. */
export function isQuietNow(policy: QuietHoursPolicy | undefined, now: number): boolean {
  if (!policy?.enabled || policy.startHour === policy.endHour) return false;
  const hour = localHour(now, policy.timezone);
  const { startHour: start, endHour: end } = policy;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * First instant after `now` outside the window. Real timezone offsets are multiples of
 * 15 minutes, so local hour boundaries sit on 15-minute epoch boundaries.
 */
export function quietWindowEnd(policy: QuietHoursPolicy, now: number): number | undefined {
  let t = Math.floor(now / STEP_MS) * STEP_MS + STEP_MS;
  for (let i = 0; i < MAX_STEPS; i += 1, t += STEP_MS) {
    if (!isQuietNow(policy, t)) return t;
  }
  return undefined;
}
