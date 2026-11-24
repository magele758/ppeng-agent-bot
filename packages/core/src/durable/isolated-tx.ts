/**
 * Tier 2 WorkspaceTx Backends: Isolated Long-Task Workspaces.
 *
 * - ApfsCloneWorkspaceTx: macOS APFS `cp -cR` zero-copy clonefile isolation.
 * - GitWorktreeTx: cross-platform detached `git worktree` isolation fallback.
 *
 * Both keep the user's main workspace untouched until `commitScope()` validates
 * CAS against the baseline and atomically applies deltas via temp+rename.
 * `abortScope()` removes the isolated copy cleanly with zero residue.
 * Every helper kept at CC <= 5.
 */

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type WorkspaceCommitResult,
  type WorkspaceRollbackConflict,
  type WorkspaceSavepoint,
} from '@ppeng/agent-loop';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import {
  CasFileJournalTx,
  atomicWriteFile,
  collectUnionPaths,
  entriesEqual,
  isExternallyModified,
  pruneEmptyParentDirs,
  type CasManifest,
} from './cas-file-tx.js';

const execFileAsync = promisify(execFile);

export interface IsolatedScopeState {
  scopeId: string;
  backend: 'apfs_clone' | 'git_worktree';
  workspaceRoot: string;
  execRoot: string;
  baselineManifestId: string;
}

async function runCmd(cmd: string, args: string[], cwd?: string): Promise<void> {
  await execFileAsync(cmd, args, {
    cwd,
    env: sanitizeSpawnEnv(process.env),
    maxBuffer: 16 * 1024 * 1024,
  });
}

export async function tryCreateApfsClone(workspaceRoot: string, destDir: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    mkdirSync(join(destDir, '..'), { recursive: true });
    await runCmd('cp', ['-cR', workspaceRoot, destDir]);
    return true;
  } catch {
    try {
      if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup */
    }
    return false;
  }
}

export async function tryCreateGitWorktree(
  workspaceRoot: string,
  destDir: string,
  cas: CasFileJournalTx,
  baseline: CasManifest
): Promise<boolean> {
  try {
    mkdirSync(join(destDir, '..'), { recursive: true });
    await runCmd('git', ['worktree', 'add', '--detach', destDir, 'HEAD'], workspaceRoot);
    overlayBaselineFiles(destDir, cas, baseline);
    return true;
  } catch {
    try {
      if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

function overlayBaselineFiles(destDir: string, cas: CasFileJournalTx, baseline: CasManifest): void {
  for (const [rel, entry] of Object.entries(baseline.files)) {
    const abs = join(destDir, rel);
    const data = cas.readBlob(entry.sha256);
    if (!data) continue;
    if (existsSync(abs) && lstatSync(abs).size === entry.size && readFileSync(abs).equals(data)) continue;
    atomicWriteFile(abs, data, entry.mode);
  }
}

export async function removeIsolatedDir(state: IsolatedScopeState): Promise<void> {
  if (state.backend === 'git_worktree') {
    try {
      await runCmd('git', ['worktree', 'remove', '--force', state.execRoot], state.workspaceRoot);
    } catch {
      /* fall through to rmSync */
    }
  }
  if (existsSync(state.execRoot)) {
    rmSync(state.execRoot, { recursive: true, force: true });
  }
}

/**
 * Compute deltas between baseline and isolated execRoot, verify CAS against
 * current main workspaceRoot (unless `force`), and atomically apply changes.
 */
export function commitIsolatedDelta(input: {
  cas: CasFileJournalTx;
  state: IsolatedScopeState;
  force?: boolean;
}): WorkspaceCommitResult {
  const baseline = input.cas.readManifest(input.state.baselineManifestId);
  if (!baseline) {
    return { ok: false, changedFiles: [], conflicts: [], error: 'Missing isolated baseline manifest' };
  }
  const isolated = input.cas.captureManifest(input.state.scopeId, input.state.execRoot);
  const currentMain = input.cas.captureManifest(input.state.scopeId, input.state.workspaceRoot);
  const paths = collectUnionPaths(baseline.files, isolated.files);
  const conflicts = findCommitConflicts(paths, baseline, isolated, currentMain, input.force === true);
  if (conflicts.length > 0) {
    return { ok: false, changedFiles: [], conflicts };
  }
  const changedFiles = applyIsolatedChanges(paths, baseline, isolated, input.state, input.cas);
  return { ok: true, changedFiles, conflicts: [] };
}

function findCommitConflicts(
  paths: readonly string[],
  baseline: CasManifest,
  isolated: CasManifest,
  currentMain: CasManifest,
  force: boolean
): WorkspaceRollbackConflict[] {
  if (force) return [];
  const conflicts: WorkspaceRollbackConflict[] = [];
  for (const rel of paths) {
    if (entriesEqual(baseline.files[rel], isolated.files[rel])) continue;
    if (isExternallyModified(baseline.files[rel], currentMain.files[rel])) {
      conflicts.push({ path: rel, reason: 'modified_externally' });
    }
  }
  return conflicts;
}

function applyIsolatedChanges(
  paths: readonly string[],
  baseline: CasManifest,
  isolated: CasManifest,
  state: IsolatedScopeState,
  cas: CasFileJournalTx
): string[] {
  const changed: string[] = [];
  for (const rel of paths) {
    const next = isolated.files[rel];
    if (entriesEqual(baseline.files[rel], next)) continue;
    const dest = join(state.workspaceRoot, rel);
    if (next) {
      const data = cas.readBlob(next.sha256);
      if (!data) throw new Error(`Missing blob ${next.sha256} for ${rel}`);
      atomicWriteFile(dest, data, next.mode);
    } else if (existsSync(dest)) {
      unlinkSync(dest);
      pruneEmptyParentDirs(dest, state.workspaceRoot);
    }
    changed.push(rel);
  }
  return changed;
}

export function buildIsolatedBaselineSavepoint(
  scopeId: string,
  backend: 'apfs_clone' | 'git_worktree',
  manifest: CasManifest
): WorkspaceSavepoint {
  return {
    id: `sp_base_${scopeId}`,
    scopeId,
    backend,
    ref: manifest.id,
    baselineDirty: true,
    label: 'baseline',
    createdAt: manifest.createdAt,
  };
}
