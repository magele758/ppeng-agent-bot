import { homedir } from 'node:os';
import { isBlockedPath } from './blocked.js';

export const SENSITIVE_READ_REFUSAL = 'Refused: sensitive path';

/** Checked-in samples. A real `.env` / `.env.local` is still refused. */
const ENV_FILE_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

/**
 * Secret filename, not a directory.
 * `.env` and `id_rsa` include dotted suffixes such as `.env.local` and `id_rsa.pub`.
 * `credentials` is only the exact basename (`credentials`, `.aws/credentials`).
 * `credentials.ts`, `credentials.test.ts`, and files under a `credentials/` directory are code.
 */
export function isSensitiveSecretBasename(name: string): boolean {
  const base = name.toLowerCase();
  if (ENV_FILE_TEMPLATES.has(base)) return false;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === 'id_rsa' || base.startsWith('id_rsa.')) return true;
  if (base === 'credentials') return true;
  return false;
}

/** Parent directories named credentials do not hide the code inside them. */
function parentSegmentBlocks(name: string): boolean {
  const base = name.toLowerCase();
  if (base === 'credentials' || ENV_FILE_TEMPLATES.has(base)) return false;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === 'id_rsa' || base.startsWith('id_rsa.')) return true;
  return false;
}

export function pathHasSensitiveSecretName(filePath: string): boolean {
  const parts = filePath.split(/[/\\]/).filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  const base = parts[parts.length - 1] ?? '';
  if (isSensitiveSecretBasename(base)) return true;
  return parts.slice(0, -1).some((part) => parentSegmentBlocks(part));
}

function globSegmentTargetsSecretFile(segment: string): boolean {
  const last = segment.toLowerCase();
  if (!last || last === '**' || last === '*') return false;
  if (ENV_FILE_TEMPLATES.has(last)) return false;
  if (!last.includes('*') && isSensitiveSecretBasename(last)) return true;
  return last === '.env.*' || last === '.env*' || last === 'id_rsa.*' || last === 'id_rsa*';
}

function globParentBlocks(segment: string): boolean {
  const part = segment.toLowerCase();
  if (!part || part === '**' || part === '*' || part === 'credentials' || part.startsWith('credentials')) return false;
  if (ENV_FILE_TEMPLATES.has(part)) return false;
  if (part === '.env' || part === '.env.*' || part === '.env*' || part.startsWith('.env.')) return true;
  if (part === 'id_rsa' || part === 'id_rsa.*' || part === 'id_rsa*' || part.startsWith('id_rsa.')) return true;
  return false;
}

/** True when a grep glob is aimed at a secret file such as .env, id_rsa, or a file named credentials. */
export function globTargetsSensitiveSecret(glob: string): boolean {
  const parts = glob.split(/[/\\]/).filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  const last = parts[parts.length - 1] ?? '';
  if (globSegmentTargetsSecretFile(last)) return true;
  return parts.slice(0, -1).some((part) => globParentBlocks(part));
}

export function sensitiveReadRefusal(absPath: string, home = homedir()): string | undefined {
  if (isBlockedPath(absPath, home) || pathHasSensitiveSecretName(absPath)) return SENSITIVE_READ_REFUSAL;
  return undefined;
}
