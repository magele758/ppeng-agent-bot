/**
 * Content-Addressed File Journal WorkspaceTx backend (Tier 3 / fallback).
 *
 * Stores raw binary blobs under `<stateDir>/tx-blobs/<sha256>` and JSON
 * manifests under `<stateDir>/tx-manifests/<id>.json`. Preserves exact bytes
 * and POSIX file modes, supports CAS external-modification conflict checks,
 * and never mutates `.git`. Every helper kept at CC <= 5.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  createId,
  nowIso,
  type WorkspaceRollbackConflict,
  type WorkspaceRollbackResult,
  type WorkspaceSavepoint,
} from '@ppeng/agent-loop';

export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.agent-state', '.next', 'dist']);

export interface CasFileEntry {
  sha256: string;
  mode: number;
  size: number;
}

export interface CasManifest {
  id: string;
  scopeId: string;
  workspaceRoot: string;
  createdAt: string;
  files: Record<string, CasFileEntry>;
}

function toPosixRel(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function atomicWriteFile(targetPath: string, data: Buffer, mode: number): void {
  ensureDir(dirname(targetPath));
  const tmp = `${targetPath}.tx-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmp, data);
  try {
    chmodSync(tmp, mode & 0o777);
  } catch {
    /* ignore chmod failure on platforms that disallow it */
  }
  renameSync(tmp, targetPath);
}

export function pruneEmptyParentDirs(filePath: string, stopRoot: string): void {
  let cur = dirname(filePath);
  const normRoot = stopRoot.replace(/\/+$/, '');
  while (cur && cur !== normRoot && cur.startsWith(`${normRoot}${sep}`)) {
    try {
      if (readdirSync(cur).length > 0) break;
      rmdirSync(cur);
      cur = dirname(cur);
    } catch {
      break;
    }
  }
}

export function collectWorkspaceFiles(
  root: string,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  extraSkip?: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  walkDir(root, root, maxFileBytes, extraSkip, out);
  return out.sort();
}

function shouldSkipDir(name: string, extraSkip?: ReadonlySet<string>): boolean {
  return SKIPPED_DIRS.has(name) || Boolean(extraSkip?.has(name));
}

function walkDir(
  root: string,
  dir: string,
  maxFileBytes: number,
  extraSkip: ReadonlySet<string> | undefined,
  out: string[]
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name, extraSkip)) walkDir(root, abs, maxFileBytes, extraSkip, out);
    } else if (entry.isFile()) {
      if (fileWithinSizeLimit(abs, maxFileBytes)) out.push(toPosixRel(root, abs));
    }
  }
}

function fileWithinSizeLimit(absPath: string, maxFileBytes: number): boolean {
  try {
    const st = lstatSync(absPath);
    return st.isFile() && st.size <= maxFileBytes;
  } catch {
    return false;
  }
}

export class CasFileJournalTx {
  private readonly blobsDir: string;
  private readonly manifestsDir: string;

  constructor(private readonly stateDir: string, private readonly maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
    this.blobsDir = join(stateDir, 'tx-blobs');
    this.manifestsDir = join(stateDir, 'tx-manifests');
    ensureDir(this.blobsDir);
    ensureDir(this.manifestsDir);
  }

  private blobPath(sha: string): string {
    return join(this.blobsDir, sha);
  }

  private manifestPath(id: string): string {
    return join(this.manifestsDir, `${id}.json`);
  }

  private storeBlob(buf: Buffer): string {
    const sha = sha256Buffer(buf);
    const dest = this.blobPath(sha);
    if (!existsSync(dest)) atomicWriteFile(dest, buf, 0o644);
    return sha;
  }

  readBlob(sha: string): Buffer | undefined {
    const dest = this.blobPath(sha);
    return existsSync(dest) ? readFileSync(dest) : undefined;
  }

  readManifest(id: string): CasManifest | undefined {
    const p = this.manifestPath(id);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as CasManifest;
  }

  captureManifest(scopeId: string, workspaceRoot: string): CasManifest {
    const id = createId('casm');
    const files: Record<string, CasFileEntry> = {};
    for (const rel of collectWorkspaceFiles(workspaceRoot, this.maxFileBytes)) {
      const abs = join(workspaceRoot, rel);
      const st = lstatSync(abs);
      const buf = readFileSync(abs);
      files[rel] = { sha256: this.storeBlob(buf), mode: st.mode & 0o777, size: buf.length };
    }
    const manifest: CasManifest = { id, scopeId, workspaceRoot, createdAt: nowIso(), files };
    writeFileSync(this.manifestPath(id), JSON.stringify(manifest), 'utf8');
    return manifest;
  }

  createSavepoint(scopeId: string, workspaceRoot: string, label?: string): WorkspaceSavepoint {
    const manifest = this.captureManifest(scopeId, workspaceRoot);
    return {
      id: createId('sp'),
      scopeId,
      backend: 'cas_file',
      ref: manifest.id,
      baselineDirty: true,
      ...(label ? { label } : {}),
      createdAt: manifest.createdAt,
    };
  }

  rollbackToManifest(input: {
    workspaceRoot: string;
    targetManifestId: string;
    expectedCurrentManifestId?: string;
    force?: boolean;
  }): WorkspaceRollbackResult {
    const target = this.readManifest(input.targetManifestId);
    if (!target) {
      return { ok: false, restoredFiles: [], removedFiles: [], conflicts: [], error: `Manifest not found: ${input.targetManifestId}` };
    }
    const current = this.captureManifest(target.scopeId, input.workspaceRoot);
    const expected = input.expectedCurrentManifestId ? this.readManifest(input.expectedCurrentManifestId) : undefined;
    const allPaths = collectUnionPaths(target.files, current.files);
    const conflicts: WorkspaceRollbackConflict[] = [];
    const restoredFiles: string[] = [];
    const removedFiles: string[] = [];

    for (const rel of allPaths) {
      const targetEntry = target.files[rel];
      const curEntry = current.files[rel];
      if (entriesEqual(targetEntry, curEntry)) continue;
      if (!input.force && expected && isExternallyModified(expected.files[rel], curEntry)) {
        conflicts.push({ path: rel, reason: 'modified_externally' });
        continue;
      }
      this.applyRollbackEntry(input.workspaceRoot, rel, targetEntry, restoredFiles, removedFiles);
    }

    return { ok: conflicts.length === 0, restoredFiles, removedFiles, conflicts };
  }

  private applyRollbackEntry(
    workspaceRoot: string,
    rel: string,
    targetEntry: CasFileEntry | undefined,
    restoredFiles: string[],
    removedFiles: string[]
  ): void {
    const abs = join(workspaceRoot, rel);
    if (targetEntry) {
      const data = this.readBlob(targetEntry.sha256);
      if (!data) throw new Error(`Missing CAS blob ${targetEntry.sha256} for ${rel}`);
      atomicWriteFile(abs, data, targetEntry.mode);
      restoredFiles.push(rel);
      return;
    }
    if (existsSync(abs)) {
      unlinkSync(abs);
      pruneEmptyParentDirs(abs, workspaceRoot);
      removedFiles.push(rel);
    }
  }
}

export function entriesEqual(a: CasFileEntry | undefined, b: CasFileEntry | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.sha256 === b.sha256 && (a.mode & 0o777) === (b.mode & 0o777);
}

export function isExternallyModified(
  expected: CasFileEntry | undefined,
  current: CasFileEntry | undefined
): boolean {
  return !entriesEqual(expected, current);
}

export function collectUnionPaths(
  a: Record<string, CasFileEntry>,
  b: Record<string, CasFileEntry>
): string[] {
  const set = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  return [...set].sort();
}
