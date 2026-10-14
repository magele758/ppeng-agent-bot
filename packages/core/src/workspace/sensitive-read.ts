import { homedir } from 'node:os';
import { isBlockedPath } from './blocked.js';

export const SENSITIVE_READ_REFUSAL = 'Refused: sensitive path';

/** `.env` / `id_rsa` / `credentials`, including dotted suffixes such as `.env.local`. */
export function isSensitiveSecretBasename(name: string): boolean {
  const base = name.toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === 'id_rsa' || base.startsWith('id_rsa.')) return true;
  if (base === 'credentials' || base.startsWith('credentials.') || base.endsWith('.credentials')) return true;
  return false;
}

export function pathHasSensitiveSecretName(filePath: string): boolean {
  return filePath.split(/[/\\]/).some((part) => part.length > 0 && isSensitiveSecretBasename(part));
}

/** True when a grep glob is aimed at a sensitive filename such as .env, id_rsa, or credentials. */
export function globTargetsSensitiveSecret(glob: string): boolean {
  return glob.split(/[/\\]/).some((part) => {
    if (!part || part === '**' || part === '*') return false;
    const bare = part.toLowerCase().replace(/\*/g, '');
    if (bare && isSensitiveSecretBasename(bare)) return true;
    const segment = part.toLowerCase();
    return (
      /^\.env(\..*)?\*?$/.test(segment) ||
      /^id_rsa(\..*)?\*?$/.test(segment) ||
      /^credentials(\..*)?\*?$/.test(segment) ||
      /^\*\.credentials$/.test(segment)
    );
  });
}

export function sensitiveReadRefusal(absPath: string, home = homedir()): string | undefined {
  if (isBlockedPath(absPath, home) || pathHasSensitiveSecretName(absPath)) return SENSITIVE_READ_REFUSAL;
  return undefined;
}
