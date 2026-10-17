import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  claimLockBodyStale,
  createLockToken,
  holdLockAcquisition,
  lockTokenNonce,
  readStaleLock,
  reclaimStaleLock,
  releaseHeldLock,
  releaseLockAcquisition,
  writeOwnedLock
} from '@ppeng/agent-core';

/** Constant-time string comparison (length-independent via hashing). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Feishu and WeCom timestamps older or newer than this are rejected. */
export const FEISHU_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** Unix seconds within the 5-minute window. Shared by Feishu signatures and the WeCom bridge. */
export function inboundTimestampFresh(timestamp: string, nowMs: number): boolean {
  if (!/^\d{1,16}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(nowMs - seconds * 1000) <= FEISHU_SIGNATURE_WINDOW_MS;
}

/**
 * Feishu request signature: sha256(timestamp + nonce + encryptKey + rawBody), hex.
 * Sent in X-Lark-Request-Timestamp / X-Lark-Request-Nonce / X-Lark-Signature.
 * A timestamp more than 5 minutes from `nowMs` is rejected.
 */
export function verifyFeishuSignature(input: {
  rawBody: string;
  encryptKey: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  nowMs?: number;
}): boolean {
  if (!input.timestamp || !input.nonce || !input.signature) return false;
  if (!inboundTimestampFresh(input.timestamp, input.nowMs ?? Date.now())) return false;
  const expected = createHash('sha256')
    .update(input.timestamp + input.nonce + input.encryptKey + input.rawBody, 'utf8')
    .digest('hex');
  return safeEqual(expected, input.signature.toLowerCase());
}

/** Empty allowlist = unrestricted; otherwise any candidate id must be listed. */
export function isSenderAllowed(allowed: readonly string[], candidates: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  return candidates.some((c) => c && allowed.includes(c));
}

const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const DEDUPE_MAX = 10_000;
const seen = new Map<string, number>();

/** Beside `delivery-ledger.json` in the gateway directory. Restart does not forget claims. */
const INBOUND_DEDUPE_FILE = 'inbound-dedupe.json';

interface InboundDedupeFile {
  version: 1;
  claims: Record<string, number>;
}

function dedupePath(dir: string): string {
  return join(dir, INBOUND_DEDUPE_FILE);
}

function readPersistedClaims(dir: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(dedupePath(dir), 'utf8')) as InboundDedupeFile;
    if (!raw || raw.version !== 1 || !raw.claims || typeof raw.claims !== 'object' || Array.isArray(raw.claims)) {
      return {};
    }
    const claims: Record<string, number> = {};
    for (const [key, at] of Object.entries(raw.claims)) {
      if (typeof at === 'number' && Number.isFinite(at)) claims[key] = at;
    }
    return claims;
  } catch {
    return {};
  }
}

function writePersistedClaims(dir: string, claims: Record<string, number>): void {
  mkdirSync(dir, { recursive: true });
  const path = dedupePath(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, claims } satisfies InboundDedupeFile, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * How long an empty or unparseable lock may sit before another process may
 * reclaim it. A live holder is never reclaimed on age alone.
 */
const CLAIM_LOCK_STALE_MS = 10_000;
/** How long to wait for a fresh lock before giving up. */
const CLAIM_LOCK_WAIT_MS = 5_000;
const CLAIM_WAIT_SLICES_MS = [5, 10, 20, 40, 80] as const;

/** Thrown when the persisted-claim lock stays busy past the wait. Not a duplicate. */
export class InboundClaimTimeoutError extends Error {
  readonly code = 'INBOUND_CLAIM_TIMEOUT';
  readonly retryable = true;

  constructor(lockPath: string) {
    super(`Inbound claim lock timed out: ${lockPath}`);
    this.name = 'InboundClaimTimeoutError';
  }
}

export function isInboundClaimTimeout(error: unknown): error is InboundClaimTimeoutError {
  return error instanceof InboundClaimTimeoutError;
}

export interface PersistedClaimLockOptions {
  /**
   * How long an empty or unparseable lock may sit before it may be reclaimed.
   * A holder whose identity is still alive is never reclaimed on age.
   */
  staleMs?: number;
  /** How long to wait for a fresh lock before giving up. */
  waitMs?: number;
  now?: () => number;
  /** Test seam: runs after the lock is held and before the claim body. */
  onAcquired?: (lockPath: string, token: string) => void;
  /** How many lock-timeouts to retry before throwing. Default 3. */
  attempts?: number;
}

/**
 * Exclusive claim of one persisted dedupe file so concurrent deliveries cannot both win.
 * Throws InboundClaimTimeoutError when the lock stays busy — that is not a duplicate.
 */
async function withPersistedClaimLock<T>(dir: string, fn: () => T, options: PersistedClaimLockOptions = {}): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lockPath = `${dedupePath(dir)}.lock`;
  const held = await holdClaimLock(lockPath, options);
  try {
    options.onAcquired?.(lockPath, held.token);
    return fn();
  } finally {
    held.release();
  }
}

async function holdClaimLock(lockPath: string, options: PersistedClaimLockOptions): Promise<{ token: string; release: () => void }> {
  const token = createLockToken();
  const nonce = lockTokenNonce(token);
  holdLockAcquisition(nonce);
  try {
    const fd = await acquireClaimLock(lockPath, token, options);
    return { token, release: () => releaseClaimLock(lockPath, fd, token, nonce) };
  } catch (error) {
    releaseLockAcquisition(nonce);
    throw error;
  }
}

async function acquireClaimLock(lockPath: string, token: string, options: PersistedClaimLockOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const started = now();
  const waitMs = options.waitMs ?? CLAIM_LOCK_WAIT_MS;
  let step = 0;
  for (;;) {
    if (now() - started > waitMs) throw new InboundClaimTimeoutError(lockPath);
    const fd = tryAcquireClaimLock(lockPath, token);
    if (fd !== undefined) return fd;
    if (reclaimStaleClaimLock(lockPath, options.staleMs ?? CLAIM_LOCK_STALE_MS, now)) continue;
    if (now() - started > waitMs) throw new InboundClaimTimeoutError(lockPath);
    step = await pauseForClaim(step, waitMs - (now() - started));
  }
}

/** Bounded async pause. Returns the next backoff step. Never uses Atomics.wait. */
async function pauseForClaim(step: number, remainingMs: number): Promise<number> {
  const slice = CLAIM_WAIT_SLICES_MS[Math.min(step, CLAIM_WAIT_SLICES_MS.length - 1)] ?? CLAIM_WAIT_SLICES_MS[0];
  if (remainingMs > 0) await delay(Math.min(slice, remainingMs));
  return step + 1;
}

/** `wx` create. undefined means the lock is held; other open errors propagate. */
function tryAcquireClaimLock(lockPath: string, token: string): number | undefined {
  try {
    const fd = openSync(lockPath, 'wx');
    writeOwnedLock(fd, token);
    return fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
}

/**
 * True only when a reclaimable lock was actually removed. A live identity is
 * not reclaimable, and a rename that does not finish is not progress: the
 * caller waits and eventually times out.
 */
function reclaimStaleClaimLock(lockPath: string, staleMs: number, now: () => number): boolean {
  const stale = readStaleLock(lockPath, staleMs, now(), claimLockBodyStale);
  if (!stale) return false;
  return reclaimStaleLock(lockPath, staleMs, now, stale, claimLockBodyStale);
}

/** Unlink only while our fd still names the directory entry and our token. */
function releaseClaimLock(lockPath: string, fd: number, token: string, nonce: string): void {
  releaseHeldLock(lockPath, fd, token);
  releaseLockAcquisition(nonce);
}

function rememberPersistedClaim(claims: Record<string, number>, key: string, now: number): void {
  claims[key] = now;
  const keys = Object.keys(claims);
  if (keys.length <= DEDUPE_MAX) return;
  keys.sort((a, b) => (claims[a] ?? 0) - (claims[b] ?? 0));
  for (const old of keys) {
    if (Object.keys(claims).length <= DEDUPE_MAX) break;
    if (old === key) continue;
    delete claims[old];
  }
}

export type InboundClaimResult = 'claimed' | 'duplicate';

const INBOUND_CLAIM_ATTEMPTS = 3;

/**
 * Atomically claim an inbound event id.
 * `'claimed'` is the first win; `'duplicate'` is a platform retry / replay.
 * A lock that stays busy throws InboundClaimTimeoutError after a few attempts —
 * that is not a duplicate and must not be acknowledged as one.
 * Pass `persistDir` (the gateway directory) to record the claim next to the
 * delivery ledger. Those claims do not expire with the in-memory 6h window,
 * survive process restart, and are not copied into the memory map (that map
 * would otherwise grow without the 6h TTL). `resetInboundDedupe` clears only
 * the memory map.
 */
export async function claimInboundEvent(
  key: string,
  now = Date.now(),
  persistDir?: string,
  lock?: PersistedClaimLockOptions
): Promise<InboundClaimResult> {
  if (!persistDir) return claimInMemory(key, now);
  return claimPersistedWithRetry(key, now, persistDir, lock);
}

async function claimPersistedWithRetry(
  key: string,
  now: number,
  persistDir: string,
  lock?: PersistedClaimLockOptions
): Promise<InboundClaimResult> {
  let last: unknown;
  for (let attempt = 0; attempt < (lock?.attempts ?? INBOUND_CLAIM_ATTEMPTS); attempt += 1) {
    try {
      return await claimPersistedOnce(key, now, persistDir, lock);
    } catch (error) {
      if (!isInboundClaimTimeout(error)) throw error;
      last = error;
    }
  }
  throw last;
}

async function claimPersistedOnce(
  key: string,
  now: number,
  persistDir: string,
  lock?: PersistedClaimLockOptions
): Promise<InboundClaimResult> {
  return withPersistedClaimLock(persistDir, () => {
    const claims = readPersistedClaims(persistDir);
    if (Object.prototype.hasOwnProperty.call(claims, key)) return 'duplicate';
    rememberPersistedClaim(claims, key, now);
    writePersistedClaims(persistDir, claims);
    return 'claimed';
  }, lock);
}

function claimInMemory(key: string, now: number): InboundClaimResult {
  const at = seen.get(key);
  if (at !== undefined && now - at < DEDUPE_TTL_MS) return 'duplicate';
  seen.delete(key);
  seen.set(key, now);
  trimInMemoryClaims(now);
  return 'claimed';
}

function trimInMemoryClaims(now: number): void {
  if (seen.size <= DEDUPE_MAX) return;
  for (const [k, t] of seen) {
    if (seen.size <= DEDUPE_MAX && now - t < DEDUPE_TTL_MS) break;
    seen.delete(k);
  }
}

export function resetInboundDedupe(): void {
  seen.clear();
}

const lanes = new Map<string, Promise<void>>();
const inflight = new Set<Promise<void>>();

/**
 * Run `task` in the background, serialized per `laneKey` so turns of one
 * conversation never interleave. Errors go to `onError`; never rejects.
 */
export function scheduleGatewayTurn(
  laneKey: string,
  task: () => Promise<void>,
  onError: (e: unknown) => void = (e) => console.error('[gateway] background turn failed', e)
): void {
  const prev = lanes.get(laneKey) ?? Promise.resolve();
  const run: Promise<void> = prev
    .then(task)
    .catch(onError)
    .finally(() => {
      inflight.delete(run);
      if (lanes.get(laneKey) === run) lanes.delete(laneKey);
    });
  lanes.set(laneKey, run);
  inflight.add(run);
}

/** Resolves once all scheduled background turns have settled (tests / graceful shutdown). */
export async function drainGatewayTurns(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}
