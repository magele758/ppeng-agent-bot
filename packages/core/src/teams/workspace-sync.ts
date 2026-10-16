import { cp, mkdir, readdir } from 'node:fs/promises';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { WorkspaceManager } from '../workspaces.js';
import type { WorkspaceMode, WorkspaceRecord } from '../types.js';
import type { TeamWorkspaceSyncMode } from './types.js';

export function teamPlanDir(stateDir: string, planId: string): string {
  return join(stateDir, 'teams', planId);
}

export function teamTaskWorkspaceDir(stateDir: string, planId: string, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'task';
  return join(teamPlanDir(stateDir, planId), 'tasks', safe);
}

export function teamIntegrationDir(stateDir: string, planId: string): string {
  return join(teamPlanDir(stateDir, planId), 'integration');
}

const SKIP_DIR_NAMES = new Set(['node_modules', '.agent-state', '.git', 'dist']);
const SKIP_FILE_NAMES = new Set(['.snapshot.lock']);

function shouldCopy(source: string, destinationName: string): boolean {
  const normalized = source.replaceAll('\\', '/');
  if (normalized.includes(`/${destinationName}/`)) return false;
  return ![...SKIP_DIR_NAMES].some((name) => normalized.includes(`/${name}/`) || normalized.endsWith(`/${name}`));
}

export async function copyWorkspaceSnapshot(from: string, to: string, lock?: SnapshotLockOptions): Promise<void> {
  await mkdir(to, { recursive: true });
  await withSnapshotLock(to, () => copyWorkspaceEntries(from, to), lock);
}

async function copyWorkspaceEntries(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  const destinationName = basename(to);
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name) || SKIP_FILE_NAMES.has(entry.name) || entry.name === destinationName) continue;
    const sourcePath = join(from, entry.name);
    const destinationPath = join(to, entry.name);
    const rel = relative(resolve(from), resolve(sourcePath)).replaceAll('\\', '/');
    if (rel.startsWith('dist/')) continue;
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      filter: (source) => shouldCopy(source, destinationName)
    });
  }
}

export async function createTeamWorkerWorkspace(input: {
  workspaceManager?: WorkspaceManager;
  sourceRoot: string;
  destRoot: string;
  taskId: string;
  hint?: string;
  mode: TeamWorkspaceSyncMode;
}): Promise<{ rootPath: string; mode: WorkspaceMode; record?: WorkspaceRecord }> {
  if (input.workspaceManager) {
    const record = await input.workspaceManager.createForTask(input.taskId, input.hint, {
      mode: input.mode,
      rootPath: input.destRoot
    });
    return { rootPath: record.rootPath, mode: record.mode, record };
  }
  await mkdir(input.destRoot, { recursive: true });
  await copyWorkspaceSnapshot(input.sourceRoot, input.destRoot);
  return { rootPath: input.destRoot, mode: 'directory-copy' };
}

export async function syncWorkerResultToPlan(
  workerRoot: string,
  integrationDir: string,
  lock?: SnapshotLockOptions
): Promise<void> {
  await mkdir(integrationDir, { recursive: true });
  await copyWorkspaceSnapshot(workerRoot, integrationDir, lock);
}

const SNAPSHOT_LOCK_STALE_MS = 10_000;
const SNAPSHOT_LOCK_WAIT_MS = 1_000;

export interface SnapshotLockOptions {
  staleMs?: number;
  waitMs?: number;
  now?: () => number;
}

async function withSnapshotLock<T>(dir: string, fn: () => Promise<T>, options: SnapshotLockOptions = {}): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, '.snapshot.lock');
  const token = `${process.pid}:${Date.now()}`;
  const fd = await acquireSnapshotLock(lockPath, token, options);
  try {
    return await fn();
  } finally {
    releaseSnapshotLock(lockPath, fd, token);
  }
}

async function acquireSnapshotLock(lockPath: string, token: string, options: SnapshotLockOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const started = now();
  const waitMs = options.waitMs ?? SNAPSHOT_LOCK_WAIT_MS;
  for (;;) {
    const fd = tryCreateSnapshotLock(lockPath, token);
    if (fd !== undefined) return fd;
    if (snapshotLockStale(lockPath, options.staleMs ?? SNAPSHOT_LOCK_STALE_MS, now())) {
      reclaimSnapshotLock(lockPath);
      continue;
    }
    if (now() - started > waitMs) {
      throw new Error(`Team workspace snapshot lock timed out: ${lockPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tryCreateSnapshotLock(lockPath: string, token: string): number | undefined {
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
 * Missing file is free. A recorded pid that is gone, or an mtime older than
 * `staleMs`, is a crash leftover. A brand-new empty file is live: the holder
 * is between create and writing its token.
 */
function snapshotLockStale(lockPath: string, staleMs: number, now: number): boolean {
  let body: string;
  try {
    body = readFileSync(lockPath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  const age = snapshotLockAge(lockPath, now);
  if (age > staleMs) return true;
  return body.length > 0 && snapshotOwnerDead(body);
}

function snapshotLockAge(lockPath: string, now: number): number {
  try {
    return now - statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Our own pid is a live holder, not a crash leftover. */
function snapshotOwnerDead(body: string): boolean {
  const pid = Number(body.split(':')[0]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function reclaimSnapshotLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* another copier reclaimed or replaced it */
  }
}

function releaseSnapshotLock(lockPath: string, fd: number, token: string): void {
  closeSync(fd);
  try {
    if (readFileSync(lockPath, 'utf8') !== token) return;
    unlinkSync(lockPath);
  } catch {
    /* lock already released or replaced */
  }
}
