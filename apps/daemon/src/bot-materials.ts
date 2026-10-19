/**
 * Registered files a bot has already produced, and a guarded "open parent folder".
 * Callers pass a material id. Paths never come from the request body.
 */
import { realpathSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { sanitizeSpawnEnv } from '@ppeng/agent-core';

export class RevealRejected extends Error {
  constructor() {
    super('reveal_rejected');
    this.name = 'RevealRejected';
  }
}

export type DirectoryOpener = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore'; windowsHide: boolean }
) => { unref?: () => void };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export type StoredBotMaterial = {
  id: string;
  name: string;
  kind: 'artifact' | 'working-log';
  createdAt: string;
  sourceTool?: string;
  absPath: string;
};

type ArtifactRow = {
  id: string;
  fileName?: string;
  sourceTool?: string;
  localRelPath: string;
  createdAt: string;
};

function isSecretPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  if (/^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?)$/i.test(base)) return true;
  if (/\.(?:pem|key)$/i.test(base)) return true;
  return parts.some((part) => part === '.ssh' || part === '.aws' || part === '.gnupg');
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || /[\\/\0]/.test(value) || value.includes('..');
}

/** Last path segment only, so a stored file name cannot leave as an absolute path. */
export function displayMaterialName(raw: string, fallback: string): string {
  const parts = raw.trim().split(/[\\/]/).filter((part) => part.length > 0);
  const base = parts[parts.length - 1] ?? '';
  if (!base || base === '.' || base === '..' || looksLikePath(base) || isSecretPath(base)) return fallback;
  return base;
}

function contained(root: string, target: string, allowEqual: boolean): boolean {
  const rel = relative(root, target);
  if (rel === '') return allowEqual;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function safeJoined(stateDir: string, relPath: string): string | undefined {
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = rel.split('/');
  if (!rel || parts.some((part) => !part || part === '.' || part === '..')) return undefined;
  if (isSecretPath(rel)) return undefined;
  return join(stateDir, ...parts);
}

export function collectBotMaterials(input: {
  botId: string;
  canonicalSessionId: string;
  stateDir: string;
  sessions: Array<{ id: string; metadata?: Record<string, unknown> | null }>;
  artifactsForSession: (sessionId: string) => ArtifactRow[];
  fileExists: (absPath: string) => boolean;
}): StoredBotMaterial[] {
  const seen = new Set<string>();
  const sessions = input.sessions.filter((session) => {
    if (!session.id || seen.has(session.id)) return false;
    seen.add(session.id);
    return session.id === input.canonicalSessionId || session.metadata?.botId === input.botId;
  });
  const materials: StoredBotMaterial[] = [];
  for (const session of sessions) {
    for (const artifact of input.artifactsForSession(session.id)) {
      const absPath = safeJoined(input.stateDir, artifact.localRelPath);
      if (!absPath || !input.fileExists(absPath) || isSecretPath(artifact.fileName ?? '')) continue;
      const name = displayMaterialName(
        artifact.fileName?.trim() || artifact.localRelPath.split(/[\\/]/).pop() || artifact.id,
        artifact.id
      );
      materials.push({
        id: artifact.id,
        name,
        kind: 'artifact',
        createdAt: artifact.createdAt,
        ...(artifact.sourceTool ? { sourceTool: artifact.sourceTool } : {}),
        absPath
      });
    }
    if (!SESSION_ID.test(session.id)) continue;
    const absPath = join(input.stateDir, 'working-logs', session.id, 'working-memory.md');
    if (!input.fileExists(absPath)) continue;
    materials.push({
      id: `worklog-${session.id}`,
      name: 'working-memory.md',
      kind: 'working-log',
      createdAt: '',
      absPath
    });
  }
  materials.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1));
  return materials;
}

export function resolveBotMaterialParent(input: {
  materialId: string;
  files: readonly StoredBotMaterial[];
  stateDir: string;
  homeDir: string;
}): string {
  if (!input.materialId || /[\\/]|\.\./.test(input.materialId)) throw new RevealRejected();
  const row = input.files.find((file) => file.id === input.materialId);
  if (!row) throw new RevealRejected();
  let fileReal = '';
  let stateReal = '';
  let homeReal = '';
  try {
    fileReal = realpathSync(row.absPath);
    stateReal = realpathSync(input.stateDir);
    homeReal = realpathSync(input.homeDir);
  } catch {
    throw new RevealRejected();
  }
  if (!contained(stateReal, fileReal, false) || !contained(homeReal, fileReal, false) || isSecretPath(fileReal)) {
    throw new RevealRejected();
  }
  const parent = dirname(fileReal);
  if (!contained(homeReal, parent, true) || !contained(stateReal, parent, true) || isSecretPath(parent)) {
    throw new RevealRejected();
  }
  return parent;
}

function openCommand(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'explorer';
  return 'xdg-open';
}

export function openParentDirectory(
  parentDir: string,
  options?: { platform?: NodeJS.Platform; spawn?: DirectoryOpener; env?: NodeJS.ProcessEnv }
): void {
  const spawnFn = options?.spawn ?? ((command, args, opts) => nodeSpawn(command, args, opts));
  const child = spawnFn(openCommand(options?.platform ?? process.platform), [parentDir], {
    env: sanitizeSpawnEnv({ base: options?.env, stripCredentials: true }),
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref?.();
}

export function revealRegisteredMaterial(input: {
  materialId: string;
  files: readonly StoredBotMaterial[];
  stateDir: string;
  homeDir: string;
  platform?: NodeJS.Platform;
  spawn?: DirectoryOpener;
  env?: NodeJS.ProcessEnv;
}): string {
  const parent = resolveBotMaterialParent(input);
  openParentDirectory(parent, input);
  return parent;
}

export type PublicBotMaterial = {
  id: string;
  name: string;
  kind: StoredBotMaterial['kind'];
  createdAt: string;
  sourceTool?: string;
};

/** Fields safe to send to the browser. Never includes a filesystem path. */
export function toPublicBotMaterial(item: StoredBotMaterial): PublicBotMaterial | undefined {
  if (!item.id || looksLikePath(item.id)) return undefined;
  const fallback = item.kind === 'working-log' ? 'working-memory.md' : 'file';
  const name = displayMaterialName(item.name, fallback);
  if (!name || looksLikePath(name) || isSecretPath(name)) return undefined;
  const createdAt = !item.createdAt || looksLikePath(item.createdAt) ? '' : item.createdAt;
  const sourceTool =
    item.sourceTool && !looksLikePath(item.sourceTool) && !isSecretPath(item.sourceTool) ? item.sourceTool : undefined;
  return {
    id: item.id,
    name,
    kind: item.kind,
    createdAt,
    ...(sourceTool ? { sourceTool } : {})
  };
}
