import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * One trust bit per repo root. A missing record is written as trusted so an
 * existing checkout keeps its skills. `setRepoTrust(..., false)` is the gate.
 */
export interface RepoTrustRecord {
  trusted: boolean;
  /** True only for the automatic first write. An explicit set clears it. */
  migrated: boolean;
  updatedAt: string;
}

interface RepoTrustFile {
  repos: Record<string, RepoTrustRecord>;
}

export function repoTrustKey(repoRoot: string): string {
  return resolve(repoRoot);
}

export function repoTrustPath(stateDir: string): string {
  return join(stateDir, 'repo-trust.json');
}

/** True when `target` is `repoRoot` or a path inside it. */
export function repoOwnedPath(repoRoot: string, target: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function emptyFile(): RepoTrustFile {
  return { repos: {} };
}

export function readRepoTrustFile(stateDir: string): RepoTrustFile {
  try {
    const parsed = JSON.parse(readFileSync(repoTrustPath(stateDir), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyFile();
    const repos = (parsed as { repos?: unknown }).repos;
    if (!repos || typeof repos !== 'object' || Array.isArray(repos)) return emptyFile();
    return { repos: repos as Record<string, RepoTrustRecord> };
  } catch {
    return emptyFile();
  }
}

function writeRepoTrustFile(stateDir: string, file: RepoTrustFile): void {
  const path = repoTrustPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

export function ensureRepoTrust(stateDir: string, repoRoot: string): RepoTrustRecord {
  const file = readRepoTrustFile(stateDir);
  const key = repoTrustKey(repoRoot);
  const existing = file.repos[key];
  if (existing && typeof existing.trusted === 'boolean') {
    return {
      trusted: existing.trusted,
      migrated: existing.migrated === true,
      updatedAt: typeof existing.updatedAt === 'string' ? existing.updatedAt : ''
    };
  }
  const record: RepoTrustRecord = {
    trusted: true,
    migrated: true,
    updatedAt: new Date().toISOString()
  };
  file.repos[key] = record;
  writeRepoTrustFile(stateDir, file);
  return record;
}

export function setRepoTrust(stateDir: string, repoRoot: string, trusted: boolean): RepoTrustRecord {
  const file = readRepoTrustFile(stateDir);
  const record: RepoTrustRecord = {
    trusted,
    migrated: false,
    updatedAt: new Date().toISOString()
  };
  file.repos[repoTrustKey(repoRoot)] = record;
  writeRepoTrustFile(stateDir, file);
  return record;
}

/** No state dir means the caller cannot persist a denial, so repo sources stay loaded. */
export function isRepoTrusted(stateDir: string | undefined, repoRoot: string): boolean {
  if (!stateDir) return true;
  return ensureRepoTrust(stateDir, repoRoot).trusted;
}

/** Drop hook scripts that live inside an untrusted repo. Operator env is unchanged here. */
export function filterUntrustedRepoHooks(
  hookEnv: Record<string, string>,
  repoRoot: string,
  trusted: boolean
): Record<string, string> {
  if (trusted) return hookEnv;
  const kept: Record<string, string> = {};
  for (const [key, scriptPath] of Object.entries(hookEnv)) {
    if (!repoOwnedPath(repoRoot, scriptPath)) kept[key] = scriptPath;
  }
  return kept;
}
