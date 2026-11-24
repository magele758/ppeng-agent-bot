/**
 * Tier 1 WorkspaceTx Backend: Git Shadow Savepoint.
 *
 * Uses an isolated GIT_INDEX_FILE under `<stateDir>/tx-idx/<scopeId>.idx` to
 * snapshot the full working tree (including user's pre-existing dirty edits and
 * untracked non-ignored files) via `git add -A` + `git write-tree` without ever
 * touching `.git/index`, HEAD, branches, or commits.
 *
 * Rollback restores exact blobs directly via `git cat-file blob` + atomic rename,
 * preserving pre-existing dirty files and skipping externally edited files unless
 * `force: true`. Every helper kept at CC <= 5.
 */

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  createId,
  nowIso,
  type WorkspaceRollbackConflict,
  type WorkspaceRollbackResult,
  type WorkspaceSavepoint,
} from '@ppeng/agent-loop';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { atomicWriteFile, pruneEmptyParentDirs } from './cas-file-tx.js';

const execFileAsync = promisify(execFile);

interface DiffTreeEntry {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  status: string;
  path: string;
}

async function runGit(
  cwd: string,
  args: string[],
  opts?: { indexFile?: string; maxBuffer?: number; encoding?: 'utf8' | 'buffer' }
): Promise<{ stdout: string | Buffer }> {
  const env = sanitizeSpawnEnv(process.env);
  if (opts?.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
  const result = await execFileAsync('git', args, {
    cwd,
    env,
    maxBuffer: opts?.maxBuffer ?? 32 * 1024 * 1024,
    encoding: opts?.encoding ?? 'utf8',
  });
  return { stdout: result.stdout };
}

export async function isGitWorkspace(workspaceRoot: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
    return String(stdout).trim() === 'true';
  } catch {
    return false;
  }
}

export async function isGitDirty(workspaceRoot: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(workspaceRoot, ['status', '--porcelain', '--untracked-files=normal']);
    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Parse `git diff-tree -r --raw -z <treeA> <treeB>` output cleanly.
 * Format: `:oldMode newMode oldSha newSha status\0path\0`
 */
export function parseRawDiffTreeZ(raw: string): DiffTreeEntry[] {
  if (!raw) return [];
  const tokens = raw.split('\0');
  const entries: DiffTreeEntry[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i]!;
    const path = tokens[i + 1]!;
    if (!meta.startsWith(':') || !path) continue;
    const parts = meta.slice(1).split(/\s+/);
    if (parts.length < 5) continue;
    entries.push({
      oldMode: parts[0]!,
      newMode: parts[1]!,
      oldSha: parts[2]!,
      newSha: parts[3]!,
      status: parts[4]!,
      path,
    });
  }
  return entries;
}

function parseGitFileMode(modeStr: string): number {
  return modeStr === '100755' ? 0o755 : 0o644;
}

export class GitShadowWorkspaceTx {
  private readonly idxDir: string;

  constructor(private readonly stateDir: string) {
    this.idxDir = join(stateDir, 'tx-idx');
    mkdirSync(this.idxDir, { recursive: true });
  }

  private tempIndexPath(scopeId: string): string {
    return join(this.idxDir, `${scopeId}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.idx`);
  }

  private async seedShadowIndex(workspaceRoot: string, idxFile: string): Promise<void> {
    try {
      const { stdout } = await runGit(workspaceRoot, ['rev-parse', '--git-path', 'index']);
      const realIdx = resolve(workspaceRoot, String(stdout).trim());
      if (existsSync(realIdx)) copyFileSync(realIdx, idxFile);
    } catch {
      /* empty index works fine if no real index exists yet (e.g. fresh git init) */
    }
  }

  /**
   * Snapshot the current workspace into a detached Git tree SHA without
   * modifying `.git/index`, HEAD, or creating commits.
   */
  async captureTreeSha(scopeId: string, workspaceRoot: string): Promise<{ treeSha: string; durationMs: number }> {
    const started = Date.now();
    const idxFile = this.tempIndexPath(scopeId);
    try {
      await this.seedShadowIndex(workspaceRoot, idxFile);
      await runGit(workspaceRoot, ['add', '-A'], { indexFile: idxFile });
      const { stdout } = await runGit(workspaceRoot, ['write-tree'], { indexFile: idxFile });
      return { treeSha: String(stdout).trim(), durationMs: Date.now() - started };
    } finally {
      try {
        if (existsSync(idxFile)) rmSync(idxFile, { force: true });
      } catch {
        /* ignore cleanup error */
      }
    }
  }

  async createSavepoint(
    scopeId: string,
    workspaceRoot: string,
    label?: string
  ): Promise<{ savepoint: WorkspaceSavepoint; durationMs: number }> {
    const dirty = await isGitDirty(workspaceRoot);
    const { treeSha, durationMs } = await this.captureTreeSha(scopeId, workspaceRoot);
    return {
      durationMs,
      savepoint: {
        id: createId('sp'),
        scopeId,
        backend: 'git_shadow',
        ref: treeSha,
        baselineDirty: dirty,
        ...(label ? { label } : {}),
        createdAt: nowIso(),
      },
    };
  }

  private async diffTrees(workspaceRoot: string, fromTree: string, toTree: string): Promise<DiffTreeEntry[]> {
    if (fromTree === toTree) return [];
    const { stdout } = await runGit(workspaceRoot, ['diff-tree', '-r', '--raw', '-z', '--no-renames', fromTree, toTree]);
    return parseRawDiffTreeZ(String(stdout));
  }

  private async readBlob(workspaceRoot: string, blobSha: string): Promise<Buffer> {
    const { stdout } = await runGit(workspaceRoot, ['cat-file', 'blob', blobSha], { encoding: 'buffer' });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async rollbackToTree(input: {
    scopeId: string;
    workspaceRoot: string;
    targetTreeSha: string;
    expectedCurrentTreeSha?: string;
    force?: boolean;
  }): Promise<WorkspaceRollbackResult> {
    const { treeSha: currentTree } = await this.captureTreeSha(input.scopeId, input.workspaceRoot);
    const targetToCurrent = await this.diffTrees(input.workspaceRoot, input.targetTreeSha, currentTree);
    const externalSet = await this.detectExternalEdits(input, currentTree);

    const conflicts: WorkspaceRollbackConflict[] = [];
    const restoredFiles: string[] = [];
    const removedFiles: string[] = [];

    for (const entry of targetToCurrent) {
      if (externalSet.has(entry.path)) {
        conflicts.push({ path: entry.path, reason: 'modified_externally' });
        continue;
      }
      await this.revertEntry(input.workspaceRoot, entry, restoredFiles, removedFiles);
    }

    return { ok: conflicts.length === 0, restoredFiles, removedFiles, conflicts };
  }

  private async detectExternalEdits(
    input: { workspaceRoot: string; expectedCurrentTreeSha?: string; force?: boolean },
    currentTree: string
  ): Promise<Set<string>> {
    if (input.force || !input.expectedCurrentTreeSha) return new Set();
    const externalDiff = await this.diffTrees(input.workspaceRoot, input.expectedCurrentTreeSha, currentTree);
    return new Set(externalDiff.map((e) => e.path));
  }

  private async revertEntry(
    workspaceRoot: string,
    entry: DiffTreeEntry,
    restoredFiles: string[],
    removedFiles: string[]
  ): Promise<void> {
    const abs = join(workspaceRoot, entry.path);
    // In diff(target -> current): 'A' means file did not exist in target, so remove it.
    if (entry.status === 'A') {
      if (existsSync(abs)) {
        unlinkSync(abs);
        pruneEmptyParentDirs(abs, workspaceRoot);
        removedFiles.push(entry.path);
      }
      return;
    }
    // 'M', 'D', 'T': restore exact blob + mode from target (oldSha / oldMode).
    const data = await this.readBlob(workspaceRoot, entry.oldSha);
    atomicWriteFile(abs, data, parseGitFileMode(entry.oldMode));
    restoredFiles.push(entry.path);
  }
}
