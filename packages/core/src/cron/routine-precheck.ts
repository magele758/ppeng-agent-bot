/**
 * Zero-token gate for a bot routine. Runs before any model turn.
 * A script wakes the model only when it exits 0 and its last non-empty
 * stdout line is not a strict `{ "wakeAgent": false }`.
 * Throws, non-zero exits, signals, and timeouts do not wake — even if
 * stdout says `wakeAgent: true`. `{ "wakeAgent": false }` never wakes.
 * The child gets a minimal environment, not the daemon environment, and
 * no general network. It can still read host files, including an event
 * file path passed in explicitly.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { getInjectionVarNames, sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { buildSeatbeltProfile } from '../sandbox/os-sandbox.js';
import { commandHardlineProcessRefusal } from '../sandbox/command-hardline.js';
import { terminateProcessTree, treeKillSpawnOptions } from '../sandbox/process-tree.js';

const PRECHECK_TIMEOUT_MS = 15_000;
const MAX_STDOUT = 65_536;
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const UNSHARE = existsSync('/usr/bin/unshare') ? '/usr/bin/unshare' : 'unshare';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Operational keys only. Daemon secrets and RAW_AGENT_* stay in the parent. */
const MINIMAL_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SYSTEMROOT',
  'PATHEXT',
  'USER',
  'LOGNAME'
] as const;

const BLOCKED_OVERRIDE_KEYS = new Set([
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NPM_CONFIG_AUTHTOKEN',
  'RAW_AGENT_AUTH_TOKEN',
  'RAW_AGENT_HUMAN_RELEASE_SECRET'
]);

export interface RoutinePrecheck {
  kind: 'script' | 'predicate';
  source: string;
}

export interface PrecheckResult {
  wakeAgent: boolean;
  reason?: string;
}

/** Last non-empty line. `false` only when `wakeAgent` is the boolean false. */
export function parseWakeGate(output: string): boolean {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return true;
  try {
    const parsed = JSON.parse(last) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    return (parsed as { wakeAgent?: unknown }).wakeAgent !== false;
  } catch {
    return true;
  }
}

export function readStoredPrecheck(metadata: Record<string, unknown> | undefined): RoutinePrecheck | undefined {
  const raw = metadata?.precheck;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const kind = (raw as { kind?: unknown }).kind;
  const source = (raw as { source?: unknown }).source;
  if ((kind !== 'script' && kind !== 'predicate') || typeof source !== 'string' || !source.trim()) {
    return undefined;
  }
  return { kind, source: source.trim() };
}

function filePredicateWakes(source: string, cwd: string): boolean | undefined {
  const match = source.match(/^file:\s*([\s\S]+)$/i);
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  if (!raw) return true;
  const path = isAbsolute(raw) ? raw : join(cwd, raw);
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function minimalPrecheckBase(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) base[key] = value;
  }
  if (!base.PATH) base.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return base;
}

function overrideAllowed(key: string, deny: Set<string>): boolean {
  if (deny.has(key) || getInjectionVarNames().has(key) || key.startsWith('BASH_FUNC_')) return false;
  if (key.startsWith('RAW_AGENT_') || key.startsWith('AWS_SECRET') || key.startsWith('AWS_SESSION')) return false;
  if (key.startsWith('AZURE_CLIENT_SECRET') || BLOCKED_OVERRIDE_KEYS.has(key)) return false;
  return true;
}

/** Explicit caller vars on a minimal base. Vault and daemon env are dropped. */
function precheckChildEnv(spawnEnv?: { env?: NodeJS.ProcessEnv; denyEnv?: string[] }): NodeJS.ProcessEnv {
  const deny = new Set((spawnEnv?.denyEnv ?? []).filter(Boolean));
  const overrides: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(spawnEnv?.env ?? {})) {
    if (value === undefined || !overrideAllowed(key, deny)) continue;
    overrides[key] = value;
  }
  const base = minimalPrecheckBase();
  const sanitized = sanitizeSpawnEnv({
    base,
    overrides,
    extraDenylist: [...deny],
    stripCredentials: true
  });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && sanitized[key] !== undefined && !deny.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && sanitized[key] !== undefined && overrideAllowed(key, deny)) env[key] = value;
  }
  return env;
}

type Isolation = 'unshare' | 'seatbelt' | 'unavailable';

let cachedIsolation: Isolation | undefined;

function isolationMode(): Isolation {
  if (cachedIsolation) return cachedIsolation;
  if (process.platform === 'linux') {
    const probe = spawnSync(
      UNSHARE,
      ['--user', '--map-root-user', '--net', '--pid', '--fork', '--mount-proc', '--', '/bin/true'],
      { timeout: 3000, stdio: 'ignore' }
    );
    cachedIsolation = probe.status === 0 ? 'unshare' : 'unavailable';
    return cachedIsolation;
  }
  if (process.platform === 'darwin' && existsSync(SANDBOX_EXEC)) {
    cachedIsolation = 'seatbelt';
    return cachedIsolation;
  }
  cachedIsolation = 'unavailable';
  return cachedIsolation;
}

interface ScriptOutput {
  stdout: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function collectChild(child: ChildProcess, cleanup: () => void): Promise<ScriptOutput> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      fn();
    };
    timer = setTimeout(() => terminateProcessTree(child), PRECHECK_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length >= MAX_STDOUT) return;
      stdout += chunk.toString();
      if (stdout.length > MAX_STDOUT) stdout = stdout.slice(0, MAX_STDOUT);
    });
    child.stderr?.on('data', () => {});
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code, signal) => finish(() => resolve({
      stdout: stdout.slice(0, MAX_STDOUT),
      code,
      signal
    })));
  });
}

function seatbeltLaunch(command: string, cwd: string, env: NodeJS.ProcessEnv): { child: ChildProcess; cleanup: () => void } {
  const home = env.HOME ?? '/tmp';
  const roots = [cwd];
  const eventFile = env.PPENG_EVENT_FILE;
  if (typeof eventFile === 'string' && isAbsolute(eventFile)) {
    const dir = dirname(eventFile);
    if (!roots.includes(dir)) roots.push(dir);
  }
  const profilePath = join(tmpdir(), `precheck-${process.pid}-${randomBytes(4).toString('hex')}.sb`);
  writeFileSync(profilePath, buildSeatbeltProfile(roots, home, false), 'utf8');
  const child = spawn(SANDBOX_EXEC, ['-f', profilePath, '--', BASH, '-c', command], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...treeKillSpawnOptions()
  });
  return {
    child,
    cleanup: () => {
      try { unlinkSync(profilePath); } catch { /* profile already removed */ }
    }
  };
}

async function runPrecheckScript(
  command: string,
  cwd: string,
  spawnEnv?: { env?: NodeJS.ProcessEnv; denyEnv?: string[] }
): Promise<ScriptOutput> {
  const refused = commandHardlineProcessRefusal(command);
  if (refused) return { stdout: '', code: refused.code, signal: null };
  const mode = isolationMode();
  const env = precheckChildEnv(spawnEnv);
  switch (mode) {
    case 'unshare': {
      const child = spawn(
        UNSHARE,
        ['--user', '--map-root-user', '--net', '--pid', '--fork', '--mount-proc', '--', BASH, '-c', command],
        { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...treeKillSpawnOptions() }
      );
      return collectChild(child, () => {});
    }
    case 'seatbelt': {
      const launched = seatbeltLaunch(command, cwd, env);
      return collectChild(launched.child, launched.cleanup);
    }
    case 'unavailable':
      throw new Error('Precheck network isolation is unavailable');
    default: {
      const neverMode: never = mode;
      throw new Error(`unknown precheck isolation ${String(neverMode)}`);
    }
  }
}

/**
 * `env` is given to script children only (for example a path to the event file).
 * It is not spliced into the command string. `parseWakeGate` is unchanged.
 * Failure never wakes. Explicit `{ "wakeAgent": false }` never wakes.
 */
export async function evaluateRoutinePrecheck(
  precheck: RoutinePrecheck,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; denyEnv?: string[] }
): Promise<PrecheckResult> {
  const cwd = opts?.cwd ?? process.cwd();
  if (precheck.kind === 'predicate') {
    const fileGate = filePredicateWakes(precheck.source, cwd);
    if (fileGate !== undefined) return { wakeAgent: fileGate };
    return { wakeAgent: parseWakeGate(precheck.source) };
  }
  if (precheck.kind === 'script') {
    try {
      const run = await runPrecheckScript(precheck.source, cwd, { env: opts?.env, denyEnv: opts?.denyEnv });
      const failed = run.code !== 0 || run.signal != null;
      if (failed || !parseWakeGate(run.stdout)) {
        return { wakeAgent: false, ...(failed ? { reason: `Precheck exited ${run.code ?? run.signal ?? 'unknown'}` } : {}) };
      }
      return { wakeAgent: true };
    } catch (error) {
      return { wakeAgent: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const neverKind: never = precheck.kind;
  throw new Error(`unknown precheck kind ${String(neverKind)}`);
}
