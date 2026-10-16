import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** A lock whose body is empty or not ours is not stale; age is the file mtime. */
const CLAIM_LOCK_STALE_MS = 10_000;
const CLAIM_LOCK_WAIT_MS = 5_000;

export interface PersistedClaimLockOptions {
  /** How long a live lock may be held before another process may reclaim it. */
  staleMs?: number;
  /** How long to wait for a fresh lock before giving up. */
  waitMs?: number;
  now?: () => number;
  /** Test seam: runs after the lock is held and before the claim body. */
  onAcquired?: (lockPath: string, token: string) => void;
}

/**
 * Exclusive claim of one persisted dedupe file so concurrent deliveries cannot both win.
 * Returns false when the lock cannot be acquired before the wait expires — the caller
 * must treat that as "do not claim", not as an error.
 */
function withPersistedClaimLock<T>(dir: string, fn: () => T, options: PersistedClaimLockOptions = {}): T | false {
  mkdirSync(dir, { recursive: true });
  const lockPath = `${dedupePath(dir)}.lock`;
  const token = randomBytes(8).toString('hex');
  const fd = acquireClaimLock(lockPath, token, options);
  if (fd === undefined) return false;
  try {
    options.onAcquired?.(lockPath, token);
    return fn();
  } finally {
    releaseClaimLock(lockPath, fd, token);
  }
}

function acquireClaimLock(lockPath: string, token: string, options: PersistedClaimLockOptions): number | undefined {
  const now = options.now ?? Date.now;
  const started = now();
  const waitMs = options.waitMs ?? CLAIM_LOCK_WAIT_MS;
  for (;;) {
    const fd = tryAcquireClaimLock(lockPath, token);
    if (fd !== undefined) return fd;
    if (claimLockStale(lockPath, options.staleMs ?? CLAIM_LOCK_STALE_MS, now())) {
      reclaimStaleClaimLock(lockPath);
      continue;
    }
    if (now() - started > waitMs) return undefined;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

/** `wx` create. undefined means the lock is held; other open errors propagate. */
function tryAcquireClaimLock(lockPath: string, token: string): number | undefined {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, token);
    return fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
}

/**
 * Empty or unparseable content is a holder that has not finished writing.
 * Only an mtime older than `staleMs` (or a missing file, which is free) is stale.
 */
function claimLockStale(lockPath: string, staleMs: number, now: number): boolean {
  try {
    return now - statSync(lockPath).mtimeMs > staleMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function reclaimStaleClaimLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* another claimant removed or replaced the stale lock */
  }
}

/** Unlink only while the file still names us, so a stolen lock is left for its new owner. */
function releaseClaimLock(lockPath: string, fd: number, token: string): void {
  closeSync(fd);
  try {
    if (readFileSync(lockPath, 'utf8') !== token) return;
    unlinkSync(lockPath);
  } catch {
    /* lock already released or replaced */
  }
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

/**
 * Atomically claim an inbound event id. Returns false when it was already claimed
 * (platform retry / replay). The persisted path holds an exclusive file lock so
 * concurrent deliveries cannot both win.
 * Pass `persistDir` (the gateway directory) to record the claim next to the
 * delivery ledger. Those claims do not expire with the in-memory 6h window,
 * survive process restart, and are not copied into the memory map (that map
 * would otherwise grow without the 6h TTL). `resetInboundDedupe` clears only
 * the memory map.
 */
export function claimInboundEvent(
  key: string,
  now = Date.now(),
  persistDir?: string,
  lock?: PersistedClaimLockOptions
): boolean {
  if (persistDir) {
    const claimed = withPersistedClaimLock(persistDir, () => {
      const claims = readPersistedClaims(persistDir);
      if (Object.prototype.hasOwnProperty.call(claims, key)) return false;
      rememberPersistedClaim(claims, key, now);
      writePersistedClaims(persistDir, claims);
      return true;
    }, lock);
    return claimed === true;
  }
  const at = seen.get(key);
  if (at !== undefined && now - at < DEDUPE_TTL_MS) return false;
  seen.delete(key);
  seen.set(key, now);
  if (seen.size > DEDUPE_MAX) {
    for (const [k, t] of seen) {
      if (seen.size <= DEDUPE_MAX && now - t < DEDUPE_TTL_MS) break;
      seen.delete(k);
    }
  }
  return true;
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
