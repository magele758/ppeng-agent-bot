import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthorizationError, LAB_BROWSER_HOST_HEADER, isPublicHttpHost, libraryFolderPickAllowed } from '@ppeng/agent-core';
import type { MagpieCacheSummary, MagpieCacheWindow, MagpieCacheModel } from '@ppeng/api-types';
import type { RouteContext, RouteSpec } from '../routing.js';
import { hasDaemonBearer } from '../auth.js';
import { headerValue } from '../user-auth.js';
import { json } from '../http-utils.js';

const invalid = () => { throw new Error('invalid_summary'); };
const maxBytes = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return invalid();
  return value;
}

function modelLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) return invalid();
  return value;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}

function ratio(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : invalid();
}

function windowStats(value: unknown): MagpieCacheWindow | null {
  if (value === null) return null;
  const row = record(value);
  const requests = count(row.requests), hitRequests = count(row.hitRequests);
  const input = count(row.input), cached = count(row.cached);
  if (hitRequests > requests || cached > input) return invalid();
  return { from: timestamp(row.from), to: timestamp(row.to), requests, input, cached, hitRequests,
    ratio: ratio(row.ratio), requestHitRatio: ratio(row.requestHitRatio) };
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.find(choice => choice === value) ?? invalid();
}

function modelSummary(value: unknown): MagpieCacheModel {
  const row = record(value);
  const status = enumValue(row.status, ['healthy', 'watching', 'degraded', 'insufficient'] as const);
  if (typeof row.incidentOpen !== 'boolean') return invalid();
  return { provider: modelLabel(row.provider), model: modelLabel(row.model), status, incidentOpen: row.incidentOpen,
    lastValidAt: row.lastValidAt === null ? null : timestamp(row.lastValidAt),
    window: windowStats(row.window), reference: windowStats(row.reference) };
}

function summary(value: unknown): MagpieCacheSummary {
  const row = record(value);
  const sourceStatus = enumValue(row.sourceStatus, ['ok', 'incomplete', 'unavailable'] as const);
  if (row.version !== 1 || !Array.isArray(row.models)) return invalid();
  return { version: 1, checkedAt: timestamp(row.checkedAt), sourceStatus,
    lastValidAt: row.lastValidAt === null ? null : timestamp(row.lastValidAt), models: row.models.map(modelSummary) };
}

// The Lab overwrites both headers. Require a loopback Lab binding as well as a loopback browser origin.
function loopbackLabBinding(browserHost: string, forwarded: string): boolean {
  return Boolean(browserHost && forwarded) && !isPublicHttpHost(forwarded);
}

function localOperator({ request, auth }: RouteContext, env: NodeJS.ProcessEnv): boolean {
  if (auth.isolate) return false;
  const forwarded = headerValue(request, 'x-forwarded-host');
  const browserHost = headerValue(request, LAB_BROWSER_HOST_HEADER);
  const authorized = auth.labProxy ? loopbackLabBinding(browserHost, forwarded) : hasDaemonBearer(request, env);
  return authorized && libraryFolderPickAllowed({
    remoteAddress: request.socket.remoteAddress, forwardedHost: forwarded,
    browserHost: browserHost || headerValue(request, 'host')
  });
}

async function readSummary(stateDir: string): Promise<MagpieCacheSummary> {
  const file = await open(join(stateDir, 'monitoring', 'magpie-cache-summary.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return invalid();
    return summary(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}

export function magpieCacheRoute(stateDir: string, env: NodeJS.ProcessEnv): RouteSpec {
  return { method: 'GET', pattern: '/api/ops/magpie-cache', async handler(ctx) {
    ctx.response.setHeader('cache-control', 'private, no-store');
    if (!localOperator(ctx, env)) throw new AuthorizationError('local_operator_required');
    try {
      json(ctx.response, 200, { summary: await readSummary(stateDir) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') json(ctx.response, 200, { summary: null });
      else json(ctx.response, 503, { error: 'cache_summary_unavailable' });
    }
  } };
}
