import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { cwd, env } from 'node:process';
import { createGatewayContext, startGatewayLearnTicker } from '@ppeng/agent-capability-gateway';
import {
  RawAgentRuntime,
  AuthStore,
  PayloadTooLargeError,
  errorMessage,
  httpStatusFromError,
  createLogger,
  createProviderConfigFromEnv,
  validateProviderConfig,
  createCoreStorageContext,
  considerEvolutionSchedule,
  EVOLUTION_DISABLED_CODE,
  type CoreStorageContext,
} from '@ppeng/agent-core';
import { availableDomainIds, loadDomainBundles } from './domain-loader.js';
import { json } from './http-utils.js';
import {
  clientKeyFromRequest,
  createRateLimiter,
  rateLimitConfigFromEnv,
  rejectRateLimited
} from './rate-limit.js';
import { createDaemonApp } from './app.js';
import { writeLoopSettings } from './loop-settings.js';
import { connectRedisWithTimeout, createBestEffortRedis, type BestEffortRedis } from '@ppeng/agent-core';

const SCHEDULER_REDIS_LOCK_KEY = 'ppeng:lock:daemon_scheduler_tick';

/** Only extends TTL if value still equals our lease token (prevents renewing someone else's lock). */
const SCHEDULER_LOCK_RENEW_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2])) else return 0 end";

let schedulerLockRedis: BestEffortRedis | undefined;
let schedulerLockRedisConnect: Promise<void> | undefined;

async function ensureSchedulerLockRedis(): Promise<BestEffortRedis> {
  const url = String(env.REDIS_URL ?? '').trim();
  if (!url) throw new Error('REDIS_URL required for RAW_AGENT_DISPATCH_LOCK_PROVIDER=redis');
  if (!schedulerLockRedis) {
    schedulerLockRedis = createBestEffortRedis(url);
  }
  if (!schedulerLockRedisConnect) {
    const client = schedulerLockRedis;
    schedulerLockRedisConnect = connectRedisWithTimeout(client).then(
      () => undefined,
      (err: unknown) => {
        schedulerLockRedisConnect = undefined;
        if (schedulerLockRedis === client) schedulerLockRedis = undefined;
        throw err;
      }
    );
  }
  await schedulerLockRedisConnect;
  return schedulerLockRedis;
}

async function disconnectSchedulerLockRedis(): Promise<void> {
  if (!schedulerLockRedis) return;
  try {
    await schedulerLockRedis.quit();
  } catch {
    /* ignore */
  }
  schedulerLockRedis = undefined;
  schedulerLockRedisConnect = undefined;
}

type RedisClient = BestEffortRedis;

async function renewSchedulerRedisLock(r: RedisClient, token: string, ttlMs: number): Promise<void> {
  try {
    await r.eval(SCHEDULER_LOCK_RENEW_LUA, {
      keys: [SCHEDULER_REDIS_LOCK_KEY],
      arguments: [token, String(ttlMs)],
    });
  } catch {
    /* transient Redis errors; next renew or lock expiry decides */
  }
}

async function releaseSchedulerRedisLock(r: RedisClient, token: string): Promise<void> {
  try {
    const cur = await r.get(SCHEDULER_REDIS_LOCK_KEY);
    if (cur === token) await r.del(SCHEDULER_REDIS_LOCK_KEY);
  } catch {
    /* ignore */
  }
}

const e2eIsolate = ['1', 'true', 'yes'].includes(String(env.RAW_AGENT_E2E_ISOLATE ?? '').toLowerCase());

/** Playwright/regression: 加载 .env 后强制本地 heuristic adapter，避免误触远程兼容适配器。 */
if (e2eIsolate) {
  env.RAW_AGENT_MODEL_PROVIDER = 'heuristic';
  for (const k of [
    'RAW_AGENT_BASE_URL',
    'RAW_AGENT_API_KEY',
    'RAW_AGENT_MODEL_NAME',
    'RAW_AGENT_VL_MODEL_NAME',
    'RAW_AGENT_VL_BASE_URL',
    'RAW_AGENT_VL_API_KEY'
  ]) {
    delete env[k];
  }
}

const repoRoot = cwd();
const stateDir = env.RAW_AGENT_STATE_DIR ?? join(repoRoot, '.agent-state');
const host = env.RAW_AGENT_DAEMON_HOST ?? '127.0.0.1';
const port = Number(env.RAW_AGENT_DAEMON_PORT ?? 37070);
const readBodyLimit = Number(env.RAW_AGENT_MAX_BODY_BYTES ?? 2_000_000);
const corsOrigins = (env.RAW_AGENT_CORS_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const log = createLogger('daemon');

// 没配 → 本地；配了一半 → 回退本地并 warn；只有「显式强制了云档却缺依赖」才退出。
const missingProviderEnv = validateProviderConfig(createProviderConfigFromEnv(env), env);
if (missingProviderEnv.length > 0) {
  log.error(
    `RAW_AGENT_*_PROVIDER explicitly requests a cloud provider but required settings are missing: ${missingProviderEnv.join(', ')}. ` +
      'Set them, or remove the explicit provider override to fall back to local mode.'
  );
  process.exit(1);
}

let storageCtx: CoreStorageContext;
try {
  storageCtx = await createCoreStorageContext(env, { stateDir, log });
} catch (e) {
  log.error('storage context init failed', errorMessage(e));
  process.exit(1);
}
{
  const c = storageCtx.config;
  log.info(
    `storage: eventBuffer=${c.eventBuffer} skillRegistry=${c.skillRegistry} assets=${c.assetStorage} dispatchLock=${c.dispatchLock} sessions=sqlite`
  );
}

const dispatchLockWantsRedis = storageCtx.resolution.config.dispatchLock === 'redis';
/** Auto-enabled Redis lock that failed: run locally until this timestamp, then try Redis again. */
let dispatchLockRetryAt = 0;

const domains = loadDomainBundles(env);
if (domains.ids.length > 0) {
  const how =
    domains.source === 'auto-detected'
      ? ` (auto-detected: ${Object.entries(domains.detected)
          .map(([id, keys]) => `${id} via ${keys.join('/')}`)
          .join('; ')})`
      : '';
  log.info(`domain bundles mounted: ${domains.ids.join(', ')}${how}`);
}
if (domains.unknown.length > 0) {
  log.warn(
    `unknown RAW_AGENT_DOMAINS entries (skipped): ${domains.unknown.join(', ')}; available: ${availableDomainIds().join(', ')}`
  );
}

const runtime = new RawAgentRuntime({
  repoRoot,
  stateDir,
  extraAgents: domains.merged.agents,
  extraTools: domains.merged.tools,
  extraSkills: domains.merged.skills,
  eventBufferRepository: storageCtx.eventBuffer,
  cloudSkillsLoader: storageCtx.cloudSkillsLoader,
  tieredAssetStorage: storageCtx.tieredAssets,
});

const loopOn = writeLoopSettings(runtime.store, {
  kernelVariant: 'agent-loop',
  assemblyPreset: 'max'
});
log.info(`loop kernel=${loopOn.kernelVariant} assembly=${loopOn.assemblyPreset}`);

const gatewayCtx = await createGatewayContext(runtime, repoRoot, stateDir);
if (gatewayCtx) {
  log.info(`capability-gateway enabled at ${gatewayCtx.env.pathPrefix}`);
  startGatewayLearnTicker(() => gatewayCtx, (e) => log.error('gateway learn tick failed', e)).unref();
}

let pkgVersion = '0.0.0';
let pkgName = '@ppeng/agent-workspace';
try {
  const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { name?: string; version?: string };
  if (pkg.version) pkgVersion = pkg.version;
  if (pkg.name) pkgName = pkg.name;
} catch {
  /* keep defaults */
}

function applyCors(request: IncomingMessage, response: ServerResponse<IncomingMessage>): boolean {
  if (corsOrigins.length === 0) return true;
  const origin = request.headers.origin;
  const allow =
    corsOrigins.includes('*') || (typeof origin === 'string' && corsOrigins.includes(origin));
  if (allow && origin) {
    response.setHeader('access-control-allow-origin', corsOrigins.includes('*') ? '*' : origin);
    response.setHeader('vary', 'Origin');
  }
  if (allow) {
    response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type, authorization');
  }
  return allow;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = Number.isFinite(readBodyLimit) && readBodyLimit > 0 ? readBodyLimit : 2_000_000;
  for await (const chunk of request) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > limit) throw new PayloadTooLargeError(limit);
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyntaxError('Invalid JSON body');
  }
}

const authStore = new AuthStore(runtime.store.db);

// E3: rate-limit endpoints that drive the model adapter (real $$ on remote
// providers). Heuristic adapter is also rate-limited but it's basically free.
const limiterConfig = rateLimitConfigFromEnv(env);
const limiter = createRateLimiter(limiterConfig);
const limiterSweep = setInterval(() => limiter.sweep(), 60_000);
limiterSweep.unref();

function isExpensiveEndpoint(method: string, pathname: string): boolean {
  if (method !== 'POST') return false;
  // Direct model-spending endpoints
  if (pathname === '/api/chat' || pathname === '/api/chat/stream') return true;
  if (pathname === '/api/scheduler/run') return true;
  if (pathname === '/api/teams') return true;
  if (pathname === '/api/tasks') return true;
  // /api/sessions (create with autoRun)
  if (pathname === '/api/sessions') return true;
  // /api/sessions/:id/(run|stream|messages)
  if (/^\/api\/sessions\/[^/]+\/(run|stream|messages)$/.test(pathname)) return true;
  // /api/sessions/:id/images/fetch-url (also SSRF surface)
  if (/^\/api\/sessions\/[^/]+\/images\/fetch-url$/.test(pathname)) return true;
  // /api/approvals/:id/:decision (approve triggers runSession)
  if (/^\/api\/approvals\/[^/]+\/(approve|reject)$/.test(pathname)) return true;
  return false;
}

/**
 * Defensive headers applied to every response (static + API + SSE).
 *  - X-Content-Type-Options: stop browsers MIME-sniffing JSON as HTML.
 *  - Referrer-Policy: don't leak agent URLs to upstream RSS / image CDNs.
 *  - X-Frame-Options: prevent click-jacking the dev console.
 *  - CSP: deny all by default for the stub HTML; the Next.js console runs
 *    through its own middleware where richer CSP belongs.
 */
function applySecurityHeaders(response: ServerResponse<IncomingMessage>, isHtml: boolean): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-frame-options', 'DENY');
  if (isHtml) {
    response.setHeader(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
    );
  }
}

async function serveStatic(pathname: string, response: ServerResponse<IncomingMessage>) {
  const webRoot = resolve(repoRoot, 'apps/daemon/web-stub');
  const relative = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\//, '');
  if (relative.includes('..') || relative.startsWith('/')) {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }
  const sourcePath = normalize(join(webRoot, relative));
  // Reject paths that share only a prefix (e.g. webRoot="/a" vs sourcePath="/ab/c")
  // by requiring an explicit separator boundary or exact match.
  if (sourcePath !== webRoot && !sourcePath.startsWith(webRoot + sep)) {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }

  const typeMap: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
  };

  try {
    const content = await readFile(sourcePath);
    response.statusCode = 200;
    const ct = typeMap[extname(sourcePath)] ?? 'text/plain; charset=utf-8';
    response.setHeader('content-type', ct);
    applySecurityHeaders(response, ct.startsWith('text/html'));
    response.end(content);
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
}

const app = createDaemonApp({
  runtime,
  authStore,
  env,
  repoRoot,
  config: { storageCtx, domainsMounted: domains.ids },
  pkgName,
  pkgVersion,
  readBody,
  readBodyLimit,
  applyCors,
  gateway: () => gatewayCtx ?? undefined,
  admit: (request, response, url) => {
    // Isolated harnesses fire many POSTs in <1s; the 1/s burst-10 bucket is for real daemons.
    if (e2eIsolate || !isExpensiveEndpoint(request.method ?? '', url.pathname)) return true;
    const decision = limiter.take(clientKeyFromRequest(request, limiterConfig.trustProxy));
    if (decision.ok) return true;
    rejectRateLimited(response, decision.retryAfterMs);
    return false;
  }
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  try {
    // API / gateway responses are JSON or SSE — apply non-HTML security headers
    // up-front so even error paths get them (static files reapply their own).
    applySecurityHeaders(response, false);
    if (await app.handle(request, response)) return;
    await serveStatic(url.pathname, response);
  } catch (error) {
    const status = httpStatusFromError(error);
    json(response, status, { error: errorMessage(error) });
  }
});

function maybeAutoStartSelfHeal(): void {
  const v = String(env.RAW_AGENT_SELF_HEAL_AUTO_START ?? '').trim().toLowerCase();
  if (!['1', 'true', 'yes'].includes(v)) return;
  try {
    const run = runtime.startSelfHealRun();
    log.info(`self-heal auto-start: run ${run.id} (policy from RAW_AGENT_SELF_HEAL_* env)`);
  } catch (e) {
    const msg = errorMessage(e);
    if (msg.includes('Another self-heal')) {
      log.info('self-heal auto-start skipped: another run already active');
    } else {
      log.error('self-heal auto-start failed:', msg);
    }
  }
}

function maybeAutoStartEvolution(): void {
  const decision = considerEvolutionSchedule({ reason: 'boot' });
  if (!decision.started) {
    log.info(`${EVOLUTION_DISABLED_CODE}: evolution will not auto-start`);
  }
}

server.listen(port, host, () => {
  log.info(`listening on http://${host}:${port}`);
  maybeAutoStartSelfHeal();
  maybeAutoStartEvolution();
});

// `setInterval` does not wait for an async callback: a scheduler tick that is
// still awaiting (self-heal `npm run test:unit`, a model turn, a merge) must not
// be overlapped by the next one, or the same work gets spawned every 1.5s.
let schedulerTickInFlight = false;
const schedulerTimer = setInterval(async () => {
  if (schedulerTickInFlight) return;
  schedulerTickInFlight = true;
  try {
    await schedulerTick();
  } finally {
    schedulerTickInFlight = false;
  }
}, 1_500);
schedulerTimer.unref();

async function schedulerTick(): Promise<void> {
  const tickBody = async () => {
    try {
      await runtime.runScheduler();
    } catch (error) {
      log.error('scheduler loop failed', error);
    }
  };

  if (dispatchLockWantsRedis && Date.now() < dispatchLockRetryAt) {
    await tickBody();
    return;
  }

  if (dispatchLockWantsRedis) {
    try {
      const r = await ensureSchedulerLockRedis();
      const ttlRaw = Number(env.RAW_AGENT_DISPATCH_LOCK_TTL_MS ?? 8000);
      const ttlMs = Number.isFinite(ttlRaw) && ttlRaw >= 1500 ? ttlRaw : 8000;
      const token = randomBytes(16).toString('hex');
      const ok = await r.set(SCHEDULER_REDIS_LOCK_KEY, token, { NX: true, PX: ttlMs });
      delete storageCtx.fallbacks.dispatchLock;
      if (ok !== 'OK') return;
      // Refresh lease while tick runs so slow scheduler work cannot overlap across replicas.
      const renewMs = Math.max(500, Math.min(Math.floor(ttlMs / 3), ttlMs - 500));
      const renewTimer = setInterval(() => {
        void renewSchedulerRedisLock(r, token, ttlMs);
      }, renewMs);
      try {
        await tickBody();
      } finally {
        clearInterval(renewTimer);
        await releaseSchedulerRedisLock(r, token);
      }
    } catch (e) {
      if (storageCtx.isExplicit('dispatchLock')) {
        log.error('scheduler redis-lock tick failed', errorMessage(e));
        return;
      }
      // REDIS_URL only auto-enabled the lock; Redis being down must not stall the scheduler.
      if (!storageCtx.fallbacks.dispatchLock) {
        log.warn(`REDIS_URL is set but Redis is unreachable (${errorMessage(e)}); scheduler uses the in-process lock until it recovers.`);
      }
      storageCtx.fallbacks.dispatchLock = {
        code: 'redis_unreachable',
        message: `REDIS_URL is set but Redis is unreachable (${errorMessage(e)}); using the in-process scheduler lock.`,
        params: { error: errorMessage(e) }
      };
      dispatchLockRetryAt = Date.now() + 30_000;
      await disconnectSchedulerLockRedis();
      await tickBody();
    }
    return;
  }

  await tickBody();
}

/**
 * Graceful shutdown:
 *   - stop the scheduler tick so SQLite isn't accessed during teardown,
 *   - close the HTTP server so in-flight requests finish (with a hard 5s cap),
 *   - call runtime.destroy() to abort sandbox jobs + tear down MCP stdio,
 *   - then exit. Repeated signals force-exit to recover from a stuck close.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.warn(`received ${signal} during shutdown — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  log.info(`received ${signal}, starting graceful shutdown`);
  clearInterval(schedulerTimer);
  clearInterval(limiterSweep);

  // Give in-flight requests 5s to finish; after that, force-close every socket
  // (SSE streams would otherwise keep the server open indefinitely).
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      log.warn('shutdown: server.close timeout (5s), forcing closeAllConnections');
      // Node ≥18.2 — terminates every tracked socket immediately.
      if (typeof (server as any).closeAllConnections === 'function') {
        (server as any).closeAllConnections();
      }
      resolve();
    }, 5_000);
    server.close(() => {
      clearTimeout(deadline);
      resolve();
    });
  });

  try {
    await runtime.destroy();
  } catch (e) {
    log.error('runtime.destroy failed', e);
  }
  try {
    await storageCtx.shutdown();
  } catch (e) {
    log.error('storage shutdown failed', e);
  }
  await disconnectSchedulerLockRedis();
  log.info('shutdown complete');
  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { void shutdown(sig); });
}
