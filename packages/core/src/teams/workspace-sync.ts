import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { WorkspaceManager } from '../workspaces.js';
import type { WorkspaceMode, WorkspaceRecord } from '../types.js';
import type { TeamWorkspaceSyncMode } from './types.js';
import { withSnapshotLock, type SnapshotLockOptions } from './snapshot-lock.js';

export type { SnapshotLockOptions } from './snapshot-lock.js';
export { snapshotLockWaitMs, SNAPSHOT_LOCK_STALE_MS, SNAPSHOT_LOCK_HEARTBEAT_MS } from './snapshot-lock.js';

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
const SKIP_FILE_NAMES = new Set(['.snapshot.lock', '.snapshot.lock.db', '.snapshot.lock.db-journal', '.snapshot.lock.db-wal', '.snapshot.lock.db-shm']);

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
