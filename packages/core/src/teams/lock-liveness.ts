/**
 * Shared lock-owner identity and stale reclaim.
 *
 * Lock body (one line, no spaces):
 *   v2 <pid>:<start>:<procToken>:<nonce>
 *     pid        owner pid
 *     start      Linux /proc/<pid>/stat field 22 (starttime, clock ticks since boot),
 *                parsed after the last ')' because comm may contain spaces or parens.
 *                `na` when this platform cannot read a start time (macOS / Windows).
 *     procToken  random hex, generated once per process
 *     nonce      random hex, unique per acquisition (release matches this whole body)
 *
 *   v1 <pid>:<epochMs>   (a736bf2 and earlier; second field is all digits, or absent)
 *   empty / anything else is unparseable and cannot prove an owner.
 *
 * Alive means every recorded identity field still matches a live process:
 *   our own pid is alive only when procToken is this process's token
 *   (same pid + different token is a previous incarnation, e.g. PID reuse);
 *   another pid is alive when kill(pid, 0) succeeds or returns EPERM, and its
 *   current start time equals the recorded one. If the recorded start is `na`
 *   or the current start cannot be read, identity cannot be proven either way,
 *   so liveness falls back to the pid check. PID reuse on that platform is
 *   bounded by the mtime rule below. Only a definite mismatch of two real
 *   start times means the recorded owner is dead.
 *
 * A proven-alive owner is still reclaimable when this process does not hold the
 * lock and the file mtime is older than the stale threshold. Mailbox holders do
 * not heartbeat, so a short critical section that outlives staleMs is abandoned.
 * Snapshot holders touch mtime on a heartbeat and stay inside the held set, so
 * a live in-process hold is never reclaimed even if something ages the mtime.
 * v1 with a dead pid is reclaimable immediately; v1 with a live pid, and an
 * empty body (holder may be between create and write), wait until mtime is stale.
 */

import { linkSync, readFileSync, renameSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Recorded when /proc starttime cannot be read. Not itself a start time:
 * compared with another `na` it proves nothing, and it never equals a real one.
 */
export const LOCK_START_UNKNOWN = 'na';

const TOKEN_BYTES = 8;

/** One token per process. A reused pid will not know it. */
const PROCESS_LOCK_TOKEN = randomBytes(TOKEN_BYTES).toString('hex');

/** Acquisition nonces this process currently holds. Aged mtime must not steal these. */
const heldAcquisitions = new Set<string>();

export function currentProcessLockToken(): string {
  return PROCESS_LOCK_TOKEN;
}

/** Body written into a newly created lock file. */
export function createLockToken(): string {
  const nonce = randomBytes(TOKEN_BYTES).toString('hex');
  const start = readProcStartTime(process.pid);
  return `${process.pid}:${start}:${PROCESS_LOCK_TOKEN}:${nonce}`;
}

export function holdLockAcquisition(nonce: string): void {
  heldAcquisitions.add(nonce);
}

export function releaseLockAcquisition(nonce: string): void {
  heldAcquisitions.delete(nonce);
}

export function lockAcquisitionHeld(nonce: string): boolean {
  return heldAcquisitions.has(nonce);
}

/** Nonce of a v2 body, or the whole body when it is not v2. */
export function lockTokenNonce(token: string): string {
  const identity = parseLockIdentity(token);
  return identity.kind === 'v2' ? identity.nonce : token;
}

/** Linux starttime, or LOCK_START_UNKNOWN when /proc is unavailable or unreadable. */
export function readProcStartTime(pid: number): string {
  return readProcStartTimeImpl(pid);
}

function readProcStartTimeFromProc(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return LOCK_START_UNKNOWN;
  try {
    return startTimeAfterComm(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return LOCK_START_UNKNOWN;
  }
}

/** Tests only. Replaces the start-time reader; pass undefined to restore /proc. */
let readProcStartTimeImpl: (pid: number) => string = readProcStartTimeFromProc;

export function setProcStartTimeReaderForTests(reader: ((pid: number) => string) | undefined): void {
  readProcStartTimeImpl = reader ?? readProcStartTimeFromProc;
}

/** Field 22 of `/proc/<pid>/stat`, which follows the final ')' of comm. */
function startTimeAfterComm(raw: string): string {
  const marker = raw.lastIndexOf(')');
  if (marker < 0) return LOCK_START_UNKNOWN;
  const start = raw.slice(marker + 1).trim().split(/\s+/)[19];
  if (!start || !/^\d+$/.test(start)) return LOCK_START_UNKNOWN;
  return start;
}

interface V2Identity {
  kind: 'v2';
  pid: number;
  start: string;
  procToken: string;
  nonce: string;
}

interface V1Identity {
  kind: 'v1';
  pid: number;
}

type LockIdentity = V2Identity | V1Identity | { kind: 'empty' } | { kind: 'unknown' };

export function parseLockIdentity(body: string): LockIdentity {
  if (body.length === 0) return { kind: 'empty' };
  const parts = body.split(':');
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'unknown' };
  return v2Identity(pid, parts) ?? v1Identity(pid, parts) ?? { kind: 'unknown' };
}

function v2Identity(pid: number, parts: string[]): V2Identity | undefined {
  if (parts.length !== 4) return undefined;
  const start = parts[1] ?? '';
  const procToken = parts[2] ?? '';
  const nonce = parts[3] ?? '';
  if (!v2FieldsPresent(start, procToken, nonce)) return undefined;
  return { kind: 'v2', pid, start, procToken, nonce };
}

function v2FieldsPresent(start: string, procToken: string, nonce: string): boolean {
  return Boolean(start && procToken && nonce && isStartField(start));
}

function v1Identity(pid: number, parts: string[]): V1Identity | undefined {
  if (!isLegacyBody(parts)) return undefined;
  return { kind: 'v1', pid };
}

function isStartField(value: string): boolean {
  return value === LOCK_START_UNKNOWN || /^\d+$/.test(value);
}

/**
 * Pre-v2 body: `<pid>`, `<pid>:<epochMs>`, or `<pid>:<arbitrary>` (a736bf2 tests
 * wrote `pid:live`). A second field that itself contains ':' is not v1 — that
 * shape is only produced by v2, so a broken v2 body stays unknown.
 */
function isLegacyBody(parts: string[]): boolean {
  return parts.length === 1 || parts.length === 2;
}

/** kill(pid, 0) succeeds, or we are not allowed to signal a process that exists. */
export function lockPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * True when pid, start time, and process token all still name a live owner.
 * Does not look at mtime or the in-process held set.
 */
export function lockIdentityAlive(body: string): boolean {
  const identity = parseLockIdentity(body);
  if (identity.kind !== 'v2') return false;
  if (identity.pid === process.pid) return selfIdentityAlive(identity);
  if (!lockPidAlive(identity.pid)) return false;
  return foreignStartMatches(identity);
}

function selfIdentityAlive(identity: V2Identity): boolean {
  if (identity.procToken !== PROCESS_LOCK_TOKEN) return false;
  return identity.start === readProcStartTime(process.pid);
}

/**
 * Two real start times that differ are a dead owner. `na` on either side
 * proves nothing, so a live pid (already checked) keeps the lock until mtime
 * says it is stale. That is the macOS / Windows case, where /proc is absent.
 */
function foreignStartMatches(identity: V2Identity): boolean {
  const current = readProcStartTime(identity.pid);
  if (current === LOCK_START_UNKNOWN || identity.start === LOCK_START_UNKNOWN) return true;
  return current === identity.start;
}

export interface LockStaleInput {
  body: string | undefined;
  ageMs: number;
  staleMs: number;
}

/**
 * Missing file (`body === undefined`) is free.
 * A held acquisition is never stale. Otherwise a stale mtime is reclaimable
 * even when the recorded pid still looks alive.
 */
export function lockBodyStale(input: LockStaleInput): boolean {
  if (input.body === undefined) return true;
  const identity = parseLockIdentity(input.body);
  if (identity.kind === 'v2' && lockAcquisitionHeld(identity.nonce)) return false;
  if (input.ageMs > input.staleMs) return true;
  return identityExpired(identity, input.body);
}

/** Fresh empty body is a holder between create and write. Anything else with no live identity is due. */
function identityExpired(identity: LockIdentity, body: string): boolean {
  if (identity.kind === 'unknown') return true;
  if (identity.kind === 'v1') return !lockPidAlive(identity.pid);
  if (identity.kind === 'v2') return !lockIdentityAlive(body);
  return false;
}

/** undefined when the lock vanished; '' when it exists but cannot be read. */
export function readLockBody(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return '';
  }
}

export function lockMtimeAge(lockPath: string, now: number): number {
  try {
    return now - statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function lockFileStale(lockPath: string, staleMs: number, now: number): boolean {
  // Age first. A holder may age the mtime after writing the body; reading the
  // body first would pair a not-yet-held nonce with the aged timestamp.
  const ageMs = lockMtimeAge(lockPath, now);
  return lockBodyStale({ body: readLockBody(lockPath), ageMs, staleMs });
}

/**
 * Move the file aside, then unlink only if that same inode is still stale.
 * A replacement created at `lockPath` is linked back and left alone.
 */
export function reclaimStaleLock(lockPath: string, staleMs: number, now: () => number): void {
  const seen = statOrUndefined(lockPath);
  if (!seen) return;
  const parked = parkedLockPath(lockPath);
  try {
    renameSync(lockPath, parked);
  } catch {
    return;
  }
  if (!sameLockInode(parked, seen) || !lockFileStale(parked, staleMs, now())) {
    restoreParkedLock(parked, lockPath);
    return;
  }
  unlinkQuiet(parked);
}

function statOrUndefined(lockPath: string): Stats | undefined {
  try {
    return statSync(lockPath);
  } catch {
    return undefined;
  }
}

function parkedLockPath(lockPath: string): string {
  return `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.reclaim`;
}

function sameLockInode(path: string, seen: Stats): boolean {
  try {
    const current = statSync(path);
    return current.ino === seen.ino && current.dev === seen.dev;
  } catch {
    return false;
  }
}

function restoreParkedLock(parked: string, lockPath: string): void {
  try {
    linkSync(parked, lockPath);
    unlinkSync(parked);
  } catch {
    /* a new owner already created lockPath; leave the parked file */
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already removed */
  }
}

/** Release removes the lock only when the body is still exactly our token. */
export function releaseLockIfToken(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, 'utf8') !== token) return;
    unlinkSync(lockPath);
  } catch {
    /* already released or replaced */
  }
}
