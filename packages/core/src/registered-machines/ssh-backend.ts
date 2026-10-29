import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix } from 'node:path';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { terminateProcessTree, treeKillSpawnOptions } from '../sandbox/process-tree.js';
import { pathHasSensitiveSecretName, sensitiveReadRefusal, SENSITIVE_READ_REFUSAL } from '../workspace/sensitive-read.js';
import type {
  RegisteredMachine,
  RegisteredMachineBackend,
  RegisteredMachineCopyInput,
  RegisteredMachineOpResult,
  RegisteredMachineReadInput,
  RegisteredMachineShellInput
} from './types.js';

/**
 * Live backend for personal registered machines: the user's own `ssh` client and
 * `~/.ssh/config` alias. Deliberately does not import FactoryTransport / factory
 * settings — Factory runs a fixed read-only worker with receipts; this rail runs
 * user-approved shell/read/copy on a host the user registered.
 */

const PROBE_TTL_MS = 30_000;
const PROBE_FAIL_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_SHELL_TIMEOUT_MS = 900_000;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_COPY_BYTES = 10 * 1024 * 1024;
const COPY_TIMEOUT_MS = 120_000;
const DEFAULT_READ_LINES = 2000;
const MAX_READ_LINES = 10_000;
const SENSITIVE_REMOTE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);
const TRANSPORT_STDERR =
  /^(ssh: |Permission denied|Host key verification failed|Connection (refused|closed|timed out|reset)|kex_exchange|Could not resolve|Operation timed out|Load key|no such identity)/m;

const READ_SCRIPT = [
  'p=$1; off=$2; lim=$3',
  'case "$p" in "~") p="$HOME";; "~/"*) p="$HOME/${p#??}";; esac',
  'if [ -d "$p" ]; then ls -1Ap -- "$p" | head -n "$lim"',
  'elif [ -f "$p" ]; then tail -n +"$((off+1))" -- "$p" | head -n "$lim"',
  'else echo "not a file or directory: $p" >&2; exit 2; fi'
].join('\n');

const COPY_TO_SCRIPT = [
  'p=$1',
  'case "$p" in "~") exit 2;; "~/"*) p="$HOME/${p#??}";; esac',
  'if [ -d "$p" ] || [ -L "$p" ]; then echo "destination is a directory or symlink" >&2; exit 2; fi',
  't="$p.ppeng-$$.tmp"',
  'if cat > "$t"; then mv -f -- "$t" "$p"; else rm -f -- "$t"; exit 1; fi'
].join('\n');

const COPY_FROM_SCRIPT = [
  'p=$1',
  'case "$p" in "~") exit 2;; "~/"*) p="$HOME/${p#??}";; esac',
  '[ -f "$p" ] || { echo "not a regular file: $p" >&2; exit 2; }',
  'cat -- "$p"'
].join('\n');

export interface SshRegisteredMachineBackendOptions {
  /** ssh executable (tests inject a stub). Defaults to `ssh` on PATH. */
  sshBin?: string;
  now?: () => number;
}

interface SshRun {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  spawnFailed: boolean;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function json(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function fail(error: string, machine: RegisteredMachine, message: string, extra?: Record<string, unknown>) {
  return { ok: false, content: json({ error, machineId: machine.machineId, message, ...extra }) };
}

function disconnected(machine: RegisteredMachine): RegisteredMachineOpResult {
  return fail('machine_disconnected', machine, 'Registered machine is not connected');
}

function isTransportFailure(run: SshRun): boolean {
  if (run.spawnFailed) return true;
  return run.code === 255 && TRANSPORT_STDERR.test(run.stderr);
}

function sshArgs(alias: string, remoteCommand: string): string[] {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no',
    '--',
    alias,
    remoteCommand
  ];
}

function runSsh(
  sshBin: string,
  alias: string,
  remoteCommand: string,
  opts: { timeoutMs: number; maxStdout: number; stdin?: Buffer }
): Promise<SshRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(sshBin, sshArgs(alias, remoteCommand), {
        env: sanitizeSpawnEnv({ stripCredentials: true }),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...treeKillSpawnOptions()
      });
    } catch {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, truncated: false, spawnFailed: true });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr, timedOut, truncated, spawnFailed });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, opts.timeoutMs);
    child.stdout?.on('data', (part: Buffer) => {
      if (outBytes >= opts.maxStdout) {
        truncated = true;
        return;
      }
      const room = opts.maxStdout - outBytes;
      const slice = part.length > room ? part.subarray(0, room) : part;
      if (slice.length < part.length) truncated = true;
      out.push(slice);
      outBytes += slice.length;
    });
    child.stderr?.on('data', (part: Buffer) => {
      if (stderr.length < MAX_TEXT_BYTES) stderr += part.toString('utf8');
    });
    child.on('error', () => {
      spawnFailed = true;
      finish(null);
    });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.stdin);
  });
}

function remoteRefusal(path: string): string | undefined {
  if (path.includes('\0') || path.length > 4096) return 'Invalid remote path';
  const normalized = posix.normalize(path);
  if (pathHasSensitiveSecretName(normalized)) return SENSITIVE_READ_REFUSAL;
  if (normalized.split('/').some((segment) => SENSITIVE_REMOTE_DIRS.has(segment))) return SENSITIVE_READ_REFUSAL;
  return undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function formatShell(run: SshRun): string {
  const parts: string[] = [];
  const stdout = run.stdout.toString('utf8');
  if (stdout) parts.push(stdout.replace(/\n$/, ''));
  if (run.stderr.trim()) parts.push(`[stderr]\n${run.stderr.replace(/\n$/, '')}`);
  if (run.truncated) parts.push(`[output truncated at ${MAX_TEXT_BYTES} bytes]`);
  if (run.timedOut) parts.push('[timed out]');
  if (run.code !== null && run.code !== 0) parts.push(`[exit_code: ${run.code}]`);
  return parts.join('\n') || '(no output)';
}

export function createSshRegisteredMachineBackend(
  options: SshRegisteredMachineBackendOptions = {}
): RegisteredMachineBackend {
  const sshBin = options.sshBin ?? 'ssh';
  const now = options.now ?? Date.now;
  const cache = new Map<string, { ok: boolean; at: number }>();
  const inflight = new Map<string, Promise<boolean>>();

  function cached(alias: string): boolean | undefined {
    const hit = cache.get(alias);
    if (!hit) return undefined;
    const ttl = hit.ok ? PROBE_TTL_MS : PROBE_FAIL_TTL_MS;
    return now() - hit.at < ttl ? hit.ok : undefined;
  }

  function remember(alias: string, ok: boolean): void {
    cache.set(alias, { ok, at: now() });
  }

  async function probeAlias(alias: string): Promise<boolean> {
    const known = cached(alias);
    if (known !== undefined) return known;
    const pending = inflight.get(alias);
    if (pending) return pending;
    const task = runSsh(sshBin, alias, 'exit 0', { timeoutMs: PROBE_TIMEOUT_MS, maxStdout: 1024 })
      .then((run) => run.code === 0 && !run.timedOut)
      .then((ok) => {
        remember(alias, ok);
        return ok;
      })
      .finally(() => inflight.delete(alias));
    inflight.set(alias, task);
    return task;
  }

  /** Run one fixed remote command; maps transport loss to machine_disconnected and updates the cache. */
  async function exec(
    machine: RegisteredMachine,
    remoteCommand: string,
    opts: { timeoutMs: number; maxStdout: number; stdin?: Buffer }
  ): Promise<{ run: SshRun } | { result: RegisteredMachineOpResult }> {
    const alias = machine.sshAlias;
    if (!alias) return { result: disconnected(machine) };
    const run = await runSsh(sshBin, alias, remoteCommand, opts);
    if (isTransportFailure(run)) {
      remember(alias, false);
      return { result: disconnected(machine) };
    }
    remember(alias, true);
    return { run };
  }

  async function copyTo(machine: RegisteredMachine, input: RegisteredMachineCopyInput) {
    const handle = await open(input.localPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
    if (!handle) return fail('local_unreadable', machine, 'Local file is missing, a symlink, or unreadable');
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) return fail('local_not_file', machine, 'Local path is not a regular file');
      if (info.size > MAX_COPY_BYTES) return fail('too_large', machine, `File exceeds ${MAX_COPY_BYTES} bytes`);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const script = `sh -c ${quote(COPY_TO_SCRIPT)} sh ${quote(input.remotePath)}`;
    const res = await exec(machine, script, { timeoutMs: COPY_TIMEOUT_MS, maxStdout: 4096, stdin: bytes });
    if ('result' in res) return res.result;
    if (res.run.code !== 0) {
      return fail('copy_failed', machine, res.run.stderr.trim() || 'Remote write failed', { exitCode: res.run.code });
    }
    return {
      ok: true,
      content: json({ copied: 'to', machineId: machine.machineId, bytes: bytes.length, remotePath: input.remotePath })
    };
  }

  async function copyFrom(machine: RegisteredMachine, input: RegisteredMachineCopyInput) {
    const existing = await lstat(input.localPath).catch(() => undefined);
    if (existing && !existing.isFile()) {
      return fail('local_not_file', machine, 'Local destination exists and is not a regular file');
    }
    const script = `sh -c ${quote(COPY_FROM_SCRIPT)} sh ${quote(input.remotePath)}`;
    const res = await exec(machine, script, {
      timeoutMs: COPY_TIMEOUT_MS,
      maxStdout: MAX_COPY_BYTES + 1
    });
    if ('result' in res) return res.result;
    const { run } = res;
    if (run.code !== 0) {
      return fail('copy_failed', machine, run.stderr.trim() || 'Remote read failed', { exitCode: run.code });
    }
    if (run.truncated || run.stdout.length > MAX_COPY_BYTES) {
      return fail('too_large', machine, `Remote file exceeds ${MAX_COPY_BYTES} bytes`);
    }
    await mkdir(dirname(input.localPath), { recursive: true });
    const tmp = `${input.localPath}.ppeng-${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, run.stdout, { flag: 'wx' });
      await rename(tmp, input.localPath);
    } catch (error) {
      await rm(tmp, { force: true });
      return fail('local_write_failed', machine, error instanceof Error ? error.message : String(error));
    }
    return {
      ok: true,
      content: json({ copied: 'from', machineId: machine.machineId, bytes: run.stdout.length, localPath: input.localPath })
    };
  }

  return {
    isConnected(_machineId, machine) {
      return machine?.sshAlias ? cached(machine.sshAlias) === true : false;
    },
    async probe(machine) {
      return machine.sshAlias ? probeAlias(machine.sshAlias) : false;
    },
    async shell(machine, input: RegisteredMachineShellInput) {
      if (Buffer.byteLength(input.command) > MAX_COMMAND_BYTES || input.command.includes('\0')) {
        return fail('invalid_command', machine, 'Command too large or contains NUL');
      }
      if (input.cwd?.includes('\0')) return fail('invalid_command', machine, 'Invalid cwd');
      const script = (input.cwd ? `cd ${quote(input.cwd)} || exit 126\n` : '') + input.command;
      const timeoutMs = clampInt(input.timeoutMs, DEFAULT_SHELL_TIMEOUT_MS, 1_000, MAX_SHELL_TIMEOUT_MS);
      const res = await exec(machine, `sh -c ${quote(script)}`, { timeoutMs, maxStdout: MAX_TEXT_BYTES });
      if ('result' in res) return res.result;
      return { ok: res.run.code === 0, content: formatShell(res.run), ...(res.run.code !== null ? { exitCode: res.run.code } : {}) };
    },
    async read(machine, input: RegisteredMachineReadInput) {
      const refused = remoteRefusal(input.path);
      if (refused) return fail('refused_path', machine, refused);
      const limit = clampInt(input.limit, DEFAULT_READ_LINES, 1, MAX_READ_LINES);
      const offset = clampInt(input.offsetLine, 0, 0, Number.MAX_SAFE_INTEGER);
      const script = `sh -c ${quote(READ_SCRIPT)} sh ${quote(input.path)} ${offset} ${limit + 1}`;
      const res = await exec(machine, script, { timeoutMs: 30_000, maxStdout: MAX_TEXT_BYTES });
      if ('result' in res) return res.result;
      const { run } = res;
      if (run.code !== 0) {
        return fail('read_failed', machine, run.stderr.trim() || 'Remote read failed', { exitCode: run.code });
      }
      const lines = run.stdout.toString('utf8').replace(/\n$/, '').split('\n');
      const more = lines.length > limit;
      const body = (more ? lines.slice(0, limit) : lines).join('\n');
      const header = offset > 0 || more ? `lines ${offset}-${offset + Math.min(lines.length, limit) - 1}${more ? ' (more below)' : ''}\n` : '';
      const note = run.truncated ? `\n[output truncated at ${MAX_TEXT_BYTES} bytes]` : '';
      return { ok: true, content: header + body + note };
    },
    async copy(machine, input) {
      if (!isAbsolute(input.localPath)) {
        return fail('invalid_local_path', machine, 'localPath must be absolute (resolved inside the workspace)');
      }
      if (sensitiveReadRefusal(input.localPath)) return fail('refused_path', machine, SENSITIVE_READ_REFUSAL);
      const refused = remoteRefusal(input.remotePath);
      if (refused) return fail('refused_path', machine, refused);
      return input.direction === 'to' ? copyTo(machine, input) : copyFrom(machine, input);
    }
  };
}
