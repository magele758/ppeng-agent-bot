/**
 * Tier 1 Sandbox — OS-level process sandboxing.
 *
 * On macOS: wraps commands with `sandbox-exec -f <profile>`.
 * On Linux:  wraps commands with `bwrap` (bubblewrap) if available.
 * Elsewhere: gracefully degrades to Tier 0 (env sanitization only).
 *
 * The sandbox restricts file access to sensitive directories (~/.ssh, ~/.aws,
 * ~/.gnupg, ~/.config) while allowing the agent workspace and system binaries.
 */

import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createId } from '../id.js';
import { commandHardlineProcessRefusal } from './command-hardline.js';
import { sanitizeSpawnEnv, type SanitizeEnvOptions } from './env-sanitizer.js';
import { TREE_KILL_GRACE_MS, terminateProcessTree, treeKillSpawnOptions } from './process-tree.js';
import { CloudflareComputerProvider } from './cloudflare-computer-provider.js';
import {
  parseSandboxMode,
  resolveSandboxMode,
  getBoundSandboxSettingsStore,
  type SandboxMode
} from './sandbox-settings.js';

export type { SandboxMode };

// ---------------------------------------------------------------------------
// SandboxProvider interface
// ---------------------------------------------------------------------------

export interface SandboxExecOptions {
  /** Working directory for the command. */
  cwd: string;
  /** Allowed read/write workspace path(s) (usually === cwd). */
  workspace: string | string[];
  /** Sanitized env (from Tier 0). */
  env: NodeJS.ProcessEnv;
  /** Timeout in ms. */
  timeoutMs?: number;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Network stays closed unless the caller passes true. */
  allowNetwork?: boolean;
  /** Remote workspace / Durable Object name when the provider is session-aware. */
  sessionId?: string;
  /** Grace between SIGTERM and SIGKILL of the process tree on timeout/abort. */
  killGraceMs?: number;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Which sandbox tier was actually used. */
  tier: 0 | 1 | 2;
}

export interface SandboxProvider {
  readonly name: string;
  readonly tier: 0 | 1 | 2;
  /** Check if this provider is available on the current system. */
  isAvailable(): boolean;
  /** Execute a shell command within the sandbox. */
  execute(command: string, options: SandboxExecOptions): Promise<SandboxExecResult>;
}

// ---------------------------------------------------------------------------
// Shared child runner
// ---------------------------------------------------------------------------

/**
 * Spawn a sandboxed shell in its own process group and collect its output.
 * Timeout and abort terminate the whole tree (SIGTERM, then SIGKILL after
 * `killGraceMs`), so `bash -c "sleep 999 & wait"` cannot outlive the call.
 */
function runSandboxChild(
  file: string,
  args: string[],
  spawnOptions: Pick<SpawnOptions, 'cwd' | 'env' | 'shell'>,
  options: SandboxExecOptions,
  tier: 0 | 1,
): Promise<SandboxExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...spawnOptions,
      ...treeKillSpawnOptions(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let terminated = false;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      terminateProcessTree(child, options.killGraceMs ?? TREE_KILL_GRACE_MS);
    };

    options.signal?.addEventListener('abort', terminate, { once: true });
    const timer = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(terminate, options.timeoutMs) : undefined;
    const cleanup = () => {
      options.signal?.removeEventListener('abort', terminate);
      if (timer) clearTimeout(timer);
    };

    child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code, signal) => {
      cleanup();
      resolve({ stdout, stderr, code, signal, tier });
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    if (options.signal?.aborted) terminate();
  });
}

// ---------------------------------------------------------------------------
// macOS sandbox-exec provider
// ---------------------------------------------------------------------------

function normalizeWorkspaceRoots(workspace: string | string[]): string[] {
  const list = (Array.isArray(workspace) ? workspace : [workspace])
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

function buildSeatbeltProfile(workspace: string | string[], home: string, allowNetwork: boolean): string {
  const roots = normalizeWorkspaceRoots(workspace);
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    '',
    '; --- Deny access to sensitive directories ---',
    `(deny file-read* (subpath "${home}/.ssh"))`,
    `(deny file-write* (subpath "${home}/.ssh"))`,
    `(deny file-read* (subpath "${home}/.aws"))`,
    `(deny file-write* (subpath "${home}/.aws"))`,
    `(deny file-read* (subpath "${home}/.gnupg"))`,
    `(deny file-write* (subpath "${home}/.gnupg"))`,
    `(deny file-read* (subpath "${home}/.kube"))`,
    `(deny file-write* (subpath "${home}/.kube"))`,
    `(deny file-read* (subpath "${home}/.docker"))`,
    `(deny file-write* (subpath "${home}/.docker"))`,
  ];

  if (!allowNetwork) {
    lines.push('', '; --- Deny network ---', '(deny network*)');
  }

  // Explicitly allow workspace roots (overrides broader deny if a root is inside home)
  lines.push('', '; --- Allow workspace ---');
  for (const root of roots) {
    lines.push(`(allow file-read* (subpath "${root}"))`);
    lines.push(`(allow file-write* (subpath "${root}"))`);
  }

  return lines.join('\n') + '\n';
}

/** Network is permitted only when the caller asks for it. */
export function explicitNetworkAllowed(allowNetwork: boolean | undefined): boolean {
  return allowNetwork === true;
}

/** Visible for testing. */
export { buildSeatbeltProfile };

export class MacOSSandboxProvider implements SandboxProvider {
  readonly name = 'sandbox-exec';
  readonly tier = 1 as const;
  private static availabilityCache: boolean | undefined;

  isAvailable(): boolean {
    if (process.platform !== 'darwin') return false;
    if (MacOSSandboxProvider.availabilityCache !== undefined) {
      return MacOSSandboxProvider.availabilityCache;
    }
    if (!existsSync('/usr/bin/sandbox-exec')) {
      MacOSSandboxProvider.availabilityCache = false;
      return false;
    }

    const smoke = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)\n(allow default)\n', '/usr/bin/true'],
      {
        encoding: 'utf8',
        timeout: 3000
      }
    );
    MacOSSandboxProvider.availabilityCache = smoke.status === 0;
    return MacOSSandboxProvider.availabilityCache;
  }

  async execute(command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    const home = options.env.HOME ?? process.env.HOME ?? '/tmp';
    const profile = buildSeatbeltProfile(
      options.workspace,
      home,
      explicitNetworkAllowed(options.allowNetwork),
    );

    // Write profile to a temp file (sandbox-exec requires a file path)
    const profilePath = join(tmpdir(), `sandbox-${createId('sb')}.sb`);
    writeFileSync(profilePath, profile, 'utf8');

    try {
      return await this.spawnSandboxed(profilePath, command, options);
    } finally {
      try { unlinkSync(profilePath); } catch { /* ignore cleanup errors */ }
    }
  }

  private spawnSandboxed(
    profilePath: string,
    command: string,
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    return runSandboxChild(
      'sandbox-exec',
      ['-f', profilePath, '--', 'bash', '-c', command],
      { cwd: options.cwd, env: options.env },
      options,
      1,
    );
  }
}

// ---------------------------------------------------------------------------
// Linux bubblewrap provider
// ---------------------------------------------------------------------------

const SENSITIVE_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker'];

export class LinuxBwrapProvider implements SandboxProvider {
  readonly name = 'bwrap';
  readonly tier = 1 as const;

  isAvailable(): boolean {
    if (process.platform !== 'linux') return false;
    const result = spawnSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 3000 });
    return result.status === 0;
  }

  async execute(command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    const home = options.env.HOME ?? process.env.HOME ?? '/tmp';

    const roots = normalizeWorkspaceRoots(options.workspace);
    const args = [
      // Bind the root filesystem read-only
      '--ro-bind', '/', '/',
      // Mounts apply in order: /tmp must come before the workspace binds or a
      // workspace under /tmp would be hidden by the empty tmpfs.
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      // Bind the workspace roots read-write
      ...roots.flatMap((root) => ['--bind', root, root]),
      // Unshare PID namespace for isolation
      '--unshare-pid',
      // If bwrap itself is SIGKILLed, take the sandboxed tree down with it
      '--die-with-parent',
      // Block sensitive directories by overlaying empty tmpfs. bwrap cannot
      // create a missing mount point on the read-only root, and a missing
      // directory has nothing to hide, so only existing ones are overlaid.
      ...SENSITIVE_HOME_DIRS.map((d) => join(home, d)).filter((p) => existsSync(p)).flatMap((p) => ['--tmpfs', p]),
    ];

    if (!explicitNetworkAllowed(options.allowNetwork)) {
      args.push('--unshare-net');
    }

    // The command to execute
    args.push('--', 'bash', '-c', command);

    return this.spawnBwrap(args, options);
  }

  private spawnBwrap(
    args: string[],
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    return runSandboxChild('bwrap', args, { cwd: options.cwd, env: options.env }, options, 1);
  }
}

// ---------------------------------------------------------------------------
// Tier 0 fallback (no OS sandbox, just env sanitization)
// ---------------------------------------------------------------------------

export class DirectProvider implements SandboxProvider {
  readonly name = 'direct';
  readonly tier = 0 as const;

  isAvailable(): boolean {
    return true; // always available
  }

  async execute(command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    return runSandboxChild(command, [], { cwd: options.cwd, env: options.env, shell: true }, options, 0);
  }
}

// ---------------------------------------------------------------------------
// SandboxManager — auto-selects the best available provider
// ---------------------------------------------------------------------------

export type SandboxModeResolver = SandboxMode | (() => SandboxMode);

export class SandboxManager {
  private provider: SandboxProvider;
  private mode: SandboxMode;
  private readonly resolveMode: () => SandboxMode;

  constructor(mode: SandboxModeResolver = 'auto') {
    this.resolveMode = typeof mode === 'function' ? mode : () => mode;
    this.mode = this.resolveMode();
    this.provider = this.selectProvider(this.mode);
  }

  get activeProvider(): SandboxProvider {
    this.refreshProvider();
    return this.provider;
  }

  get activeTier(): 0 | 1 | 2 {
    return this.activeProvider.tier;
  }

  /**
   * Execute a shell command in the sandbox.
   *
   * Builtin hardline commands are refused before provider selection, so
   * direct, OS, and container/computer backends all miss the spawn.
   * Then applies Tier 0 env sanitization and delegates to the provider.
   * Tool children lose credential env names unless the caller sets
   * `envOptions.stripCredentials` to false. Network is off unless
   * `allowNetwork` is true (seatbelt / bwrap). Direct mode has no network namespace.
   */
  async execute(
    command: string,
    cwd: string,
    options?: {
      workspace?: string | string[];
      timeoutMs?: number;
      signal?: AbortSignal;
      allowNetwork?: boolean;
      envOptions?: SanitizeEnvOptions;
      sessionId?: string;
    },
  ): Promise<SandboxExecResult> {
    const refused = commandHardlineProcessRefusal(command);
    if (refused) {
      return { stdout: '', stderr: refused.stderr, code: refused.code, signal: null, tier: 0 };
    }
    this.refreshProvider();
    const env = sanitizeSpawnEnv({
      ...options?.envOptions,
      stripCredentials: options?.envOptions?.stripCredentials ?? true,
    });
    return this.provider.execute(command, {
      cwd,
      workspace: options?.workspace ?? cwd,
      env,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
      allowNetwork: explicitNetworkAllowed(options?.allowNetwork),
      sessionId: options?.sessionId,
    });
  }

  private refreshProvider(): void {
    const next = this.resolveMode();
    if (next === this.mode) return;
    this.mode = next;
    this.provider = this.selectProvider(next);
  }

  private selectProvider(mode: SandboxMode): SandboxProvider {
    if (mode === 'cloudflare-computer') {
      return new CloudflareComputerProvider();
    }

    if (mode === 'direct') {
      return new DirectProvider();
    }

    if (mode === 'os' || mode === 'auto') {
      const macOS = new MacOSSandboxProvider();
      if (macOS.isAvailable()) return macOS;

      const bwrap = new LinuxBwrapProvider();
      if (bwrap.isAvailable()) return bwrap;

      if (mode === 'os') {
        // Explicitly requested but not available — still fall back gracefully
        return new DirectProvider();
      }
    }

    // 'auto' fallback or 'container' (Tier 2 not yet implemented)
    return new DirectProvider();
  }
}

/** Create a SandboxManager from Lab KV (when bound) or env fallback. */
export function createSandboxFromEnv(env?: NodeJS.ProcessEnv): SandboxManager {
  const e = env ?? process.env;
  return new SandboxManager(() => resolveSandboxMode(getBoundSandboxSettingsStore(), e));
}

export { parseSandboxMode };
