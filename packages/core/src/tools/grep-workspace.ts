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

interface RgEvent {
  type?: string;
  data?: { path?: RgByteText; lines?: RgByteText; line_number?: number };
}

function parseRgEvent(raw: string): RgEvent | undefined {
  try {
    return JSON.parse(raw) as RgEvent;
  } catch {
    return undefined;
  }
}

function formatRgHit(filePath: string, kind: string, lineNo: number | undefined, text: string): string {
  const sep = kind === 'context' ? '-' : ':';
  const body = text.replace(/\n$/, '');
  if (!lineNo) return `${filePath}${sep}${body}`;
  return `${filePath}${sep}${lineNo}${sep}${body}`;
}

function rgHitLine(event: RgEvent, cwd: string): string {
  if (event.type !== 'match' && event.type !== 'context') return '';
  const filePath = rgText(event.data?.path);
  if (!filePath || sensitiveGrepPath(filePath, cwd)) return '';
  return formatRgHit(filePath, event.type, event.data?.line_number, rgText(event.data?.lines));
}

function rgLine(raw: string, cwd: string): string {
  if (!raw) return '';
  const event = parseRgEvent(raw);
  if (!event) return '';
  return rgHitLine(event, cwd);
}

/** Render rg --json and drop every record whose path is a secret file. */
function renderRgJson(stdout: string, cwd: string): string {
  const kept = stdout.split('\n').map((raw) => rgLine(raw, cwd)).filter((line) => line.length > 0);
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
  const refused = refuseSensitiveGrep(options);
  if (refused) return refused;
  const rg = await runRipgrep(options);
  if (rg) return rg;
  return runGrepFallback(options);
}

function refuseSensitiveGrep(options: GrepOptions): { ok: false; content: string } | undefined {
  if (sensitiveReadRefusal(options.cwd, undefined, 'directory')) return { ok: false, content: SENSITIVE_READ_REFUSAL };
  if (options.glob && globTargetsSensitiveSecret(options.glob)) return { ok: false, content: SENSITIVE_READ_REFUSAL };
  return undefined;
}

function grepLimit(maxMatches: number): number {
  return Math.min(Math.max(maxMatches, 1), 500);
}

async function runRipgrep(options: GrepOptions): Promise<{ ok: boolean; content: string } | undefined> {
  const rg = await runCmd('rg', ripgrepArgs(options), options.cwd);
  return ripgrepResult(rg, options.cwd);
}

function ripgrepArgs(options: GrepOptions): string[] {
  const limit = grepLimit(options.maxMatches);
  const context = options.contextLines ?? 0;
  return [
    '--json',
    '--hidden',
    '--max-count',
    String(limit),
    ...(context > 0 ? ['-C', String(context)] : []),
    ...RG_SECRET_EXCLUDES,
    ...(options.glob ? ['--glob', options.glob] : []),
    options.pattern,
    '.'
  ];
}

function ripgrepResult(
  rg: { code: number | null; stdout: string },
  cwd: string
): { ok: boolean; content: string } | undefined {
  if (rg.code === -1) return undefined;
  if (rg.code === 0 || rg.stdout.trim()) return { ok: true, content: renderRgJson(rg.stdout, cwd) };
  if (rg.code === 1) return { ok: true, content: '(no matches)' };
  return undefined;
}

async function runGrepFallback(options: GrepOptions): Promise<{ ok: boolean; content: string }> {
  const limit = grepLimit(options.maxMatches);
  const g = await runCmd('grep', ['-RIn', '--max-count', String(limit), options.pattern, '.'], options.cwd);
  return grepFallbackResult(g, options.cwd);
}

function grepFallbackResult(
  g: { code: number | null; stdout: string; stderr: string },
  cwd: string
): { ok: boolean; content: string } {
  if (g.code === -1) return { ok: false, content: 'Neither rg nor grep is available in PATH.' };
  if (g.code === 0 || g.stdout.trim()) return { ok: true, content: withoutSensitiveGrepLines(g.stdout.trim(), cwd) };
  if (g.code === 1) return { ok: true, content: '(no matches)' };
  return { ok: false, content: g.stderr.trim() || 'grep failed' };
}
