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

/**
 * Only negative globs. A positive glob would whitelist the whole search.
 * Dotfiles need --hidden so .env.example, .env.sample, and .env.template can match.
 * Excluding every dotted env name would hide those templates. Excluding the
 * credentials basename would skip a credentials directory. The JS filter drops
 * real secret files and keeps the rest. VCS directories stay excluded.
 */
const RG_SECRET_EXCLUDES = [
  '--glob',
  '!**/.git/**',
  '--glob',
  '!**/.svn/**',
  '--glob',
  '!**/.hg/**',
  '--glob',
  '!**/.env',
  '--glob',
  '!**/id_rsa',
  '--glob',
  '!**/id_rsa.*'
];

function sensitiveGrepPath(filePath: string, cwd: string): boolean {
  if (pathHasSensitiveSecretName(filePath)) return true;
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  return pathHasSensitiveSecretName(abs) || isBlockedPath(abs);
}

interface RgByteText {
  text?: string;
  bytes?: string;
}

function rgText(value: RgByteText | undefined): string {
  if (!value) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.bytes === 'string') return Buffer.from(value.bytes, 'base64').toString('utf8');
  return '';
}

/** Render rg --json and drop every record whose path is a secret file. */
function renderRgJson(stdout: string, cwd: string): string {
  const kept: string[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    let event: { type?: string; data?: { path?: RgByteText; lines?: RgByteText; line_number?: number } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== 'match' && event.type !== 'context') continue;
    const filePath = rgText(event.data?.path);
    if (!filePath || sensitiveGrepPath(filePath, cwd)) continue;
    const text = rgText(event.data?.lines).replace(/\n$/, '');
    const lineNo = event.data?.line_number;
    const sep = event.type === 'context' ? '-' : ':';
    kept.push(lineNo ? `${filePath}${sep}${lineNo}${sep}${text}` : `${filePath}${sep}${text}`);
  }
  return kept.join('\n').trim() || '(no matches)';
}

/**
 * grep(1) has no structured path. A line is dropped when any `path:line:` or
 * `path-line-` prefix is itself a secret file, so context text like
 * `credentials-2-secret:12:34` cannot hide the real path.
 */
function fallbackLineSensitive(line: string, cwd: string): boolean {
  const marks = /:\d+:|-\d+-/g;
  let match: RegExpExecArray | null;
  while ((match = marks.exec(line))) {
    const candidate = line.slice(0, match.index);
    if (candidate && sensitiveGrepPath(candidate, cwd)) return true;
  }
  return false;
}

function withoutSensitiveGrepLines(content: string, cwd: string): string {
  if (!content || content === '(no matches)') return content || '(no matches)';
  const kept = content.split('\n').filter((line) => line.length === 0 || !fallbackLineSensitive(line, cwd));
  const text = kept.join('\n').trim();
  return text || '(no matches)';
}

/** Run ripgrep if available, else recursive grep. Sensitive filenames and blocked paths are not returned. */
export async function runWorkspaceGrep(options: GrepOptions): Promise<{ ok: boolean; content: string }> {
  const { cwd, pattern, glob, maxMatches, contextLines = 0 } = options;
  if (sensitiveReadRefusal(cwd, undefined, 'directory') || (glob && globTargetsSensitiveSecret(glob))) {
    return { ok: false, content: SENSITIVE_READ_REFUSAL };
  }
  const limit = Math.min(Math.max(maxMatches, 1), 500);

  const rgArgs = [
    '--json',
    '--hidden',
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
      return { ok: true, content: renderRgJson(rg.stdout, cwd) };
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
    return { ok: true, content: withoutSensitiveGrepLines(g.stdout.trim(), cwd) };
  }
  if (g.code === 1) {
    return { ok: true, content: '(no matches)' };
  }
  return { ok: false, content: g.stderr.trim() || 'grep failed' };
}
