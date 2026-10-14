import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { isBlockedPath } from '../workspace/blocked.js';
import {
  SENSITIVE_READ_REFUSAL,
  globTargetsSensitiveSecret,
  pathHasSensitiveSecretName,
  sensitiveReadRefusal
} from '../workspace/sensitive-read.js';

export interface GrepOptions {
  cwd: string;
  pattern: string;
  glob?: string;
  maxMatches: number;
  contextLines?: number;
}

function runCmd(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, env: sanitizeSpawnEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', () => {
      resolve({ code: -1, stdout: '', stderr: 'spawn error' });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const RG_SECRET_EXCLUDES = [
  '--glob',
  '!**/.env',
  '--glob',
  '!**/.env.*',
  '--glob',
  '!**/id_rsa',
  '--glob',
  '!**/id_rsa.*',
  '--glob',
  '!**/credentials',
  '--glob',
  '!**/credentials.*',
  '--glob',
  '!**/*.credentials',
  '--glob',
  '!**/credentials/**'
];

function grepLinePath(line: string): string | undefined {
  const numbered = /^(.*?):\d+:/.exec(line) ?? /^(.*?)-\d+-/.exec(line);
  const path = numbered?.[1]?.trim();
  return path || undefined;
}

function sensitiveGrepLine(line: string, cwd: string): boolean {
  const rel = grepLinePath(line);
  if (!rel) return false;
  if (pathHasSensitiveSecretName(rel)) return true;
  const abs = isAbsolute(rel) ? rel : resolve(cwd, rel);
  return pathHasSensitiveSecretName(abs) || isBlockedPath(abs);
}

function withoutSensitiveMatches(content: string, cwd: string): string {
  if (!content || content === '(no matches)') return content || '(no matches)';
  const kept = content.split('\n').filter((line) => line.length === 0 || !sensitiveGrepLine(line, cwd));
  const text = kept.join('\n').trim();
  return text || '(no matches)';
}

/** Run ripgrep if available, else recursive grep. Sensitive filenames and blocked paths are not returned. */
export async function runWorkspaceGrep(options: GrepOptions): Promise<{ ok: boolean; content: string }> {
  const { cwd, pattern, glob, maxMatches, contextLines = 0 } = options;
  if (sensitiveReadRefusal(cwd) || (glob && globTargetsSensitiveSecret(glob))) {
    return { ok: false, content: SENSITIVE_READ_REFUSAL };
  }
  const limit = Math.min(Math.max(maxMatches, 1), 500);

  const rgArgs = [
    '--line-number',
    '--no-heading',
    '--max-count',
    String(limit),
    ...(contextLines > 0 ? ['-C', String(contextLines)] : []),
    ...RG_SECRET_EXCLUDES,
    ...(glob ? ['--glob', glob] : []),
    pattern,
    '.'
  ];

  const rg = await runCmd('rg', rgArgs, cwd);
  if (rg.code !== -1) {
    if (rg.code === 0 || rg.stdout.trim()) {
      return { ok: true, content: withoutSensitiveMatches(rg.stdout.trim(), cwd) || '(no matches)' };
    }
    if (rg.code === 1) {
      return { ok: true, content: '(no matches)' };
    }
  }

  const grepArgs = ['-RIn', '--max-count', String(limit), pattern, '.'];
  const g = await runCmd('grep', grepArgs, cwd);
  if (g.code === -1) {
    return { ok: false, content: 'Neither rg nor grep is available in PATH.' };
  }
  if (g.code === 0 || g.stdout.trim()) {
    return { ok: true, content: withoutSensitiveMatches(g.stdout.trim(), cwd) || '(no matches)' };
  }
  if (g.code === 1) {
    return { ok: true, content: '(no matches)' };
  }
  return { ok: false, content: g.stderr.trim() || 'grep failed' };
}
