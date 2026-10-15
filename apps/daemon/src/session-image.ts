import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface SessionImageAsset {
  sessionId: string;
  localRelPath: string;
  mimeType: string;
}

export interface SessionImageFile {
  absPath: string;
  mimeType: string;
}

/** File to serve for a session-owned image, or undefined when it must not be sent. */
export function resolveSessionImagePath(
  stateDir: string,
  asset: SessionImageAsset | undefined,
  sessionId: string
): SessionImageFile | undefined {
  if (!asset || asset.sessionId !== sessionId) return undefined;
  const mimeType = asset.mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) return undefined;
  const relPath = asset.localRelPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relPath || relPath.split('/').includes('..')) return undefined;
  const root = resolve(stateDir);
  const absPath = resolve(root, relPath);
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  if (!existsSync(absPath)) return undefined;
  return { absPath, mimeType };
}
