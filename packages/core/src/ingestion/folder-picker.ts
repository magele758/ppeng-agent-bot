/**
 * Opens the macOS folder dialog on the machine running the daemon and returns
 * the folder the person selected. The script is fixed: a request cannot name
 * a path to read, and this function never lists or returns file contents.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { homedir, platform as hostPlatform } from 'node:os';
import { isIP } from 'node:net';
import { isPublicHttpHost } from '../auth/oauth-config.js';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { checkLibraryDir } from './library-paths.js';

export const LIBRARY_FOLDER_PICK_COMMAND = '/usr/bin/osascript';

/** Fixed AppleScript. Do not interpolate request data into this. */
export const LIBRARY_FOLDER_PICK_ARGS = [
  '-e',
  'try',
  '-e',
  'POSIX path of (choose folder with prompt "Choose a folder to add to the knowledge base")',
  '-e',
  'on error number -128',
  '-e',
  '"CANCELLED"',
  '-e',
  'end try'
] as const;

const OUTPUT_LIMIT = 4096;
const PICKER_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'USER', 'LOGNAME'] as const;

const SUPPLIED_PATH_KEYS = new Set([
  'path',
  'paths',
  'dir',
  'dirs',
  'directory',
  'directories',
  'root',
  'file',
  'files',
  'folder',
  'folders',
  'libraryDirs'
]);

export type FolderPickResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'rejected' };

export interface FolderPickerChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface FolderPickerSpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: true;
  signal?: AbortSignal;
}

export type FolderPickerSpawn = (
  command: string,
  args: readonly string[],
  options: FolderPickerSpawnOptions
) => FolderPickerChild;

export interface PickLibraryFolderDeps {
  platform?: () => NodeJS.Platform;
  spawn?: FolderPickerSpawn;
  /** Allow-list root for the chosen folder. The dialog itself always uses the signed-in user's home. */
  home?: string;
  signal?: AbortSignal;
  osascriptPath?: string;
}

function hostSpawn(command: string, args: readonly string[], options: FolderPickerSpawnOptions): FolderPickerChild {
  return nodeSpawn(command, [...args], options) as FolderPickerChild;
}

function pickerChildEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    HOME: homedir(),
    TMPDIR: '/tmp'
  };
  if (process.env.USER) base.USER = process.env.USER;
  if (process.env.LOGNAME || process.env.USER) base.LOGNAME = process.env.LOGNAME || process.env.USER;
  const sanitized = sanitizeSpawnEnv({
    base,
    stripCredentials: true,
    extraDenylist: [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'NO_PROXY',
      'no_proxy'
    ]
  });
  const env: NodeJS.ProcessEnv = {};
  for (const key of PICKER_ENV_KEYS) {
    const value = sanitized[key];
    if (typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value)) env[key] = value;
  }
  return env;
}

function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  let host = address.trim().toLowerCase();
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  if (host === '::1' || host === 'localhost') return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split('.')[0]) === 127;
}

/**
 * The dialog may run only for a loopback client of this Lab.
 * `browserHost` is the page's Host header. Next's X-Forwarded-Host is the bind
 * address (0.0.0.0) when Lab listens on all interfaces, so it cannot prove the
 * browser is local. A public browser host means another machine opened the page.
 */
export function libraryFolderPickAllowed(input: {
  remoteAddress?: string | null;
  forwardedHost?: string | null;
  browserHost?: string | null;
}): boolean {
  if (!isLoopbackAddress(input.remoteAddress)) return false;
  const browser = (input.browserHost ?? '').trim();
  if (browser) return !isPublicHttpHost(browser);
  const forwarded = (input.forwardedHost ?? '').trim();
  if (forwarded && isPublicHttpHost(forwarded)) return false;
  return true;
}

/** Reject a caller-supplied path. The picker does not read it. */
export function libraryPickBodyAllowed(body: unknown): boolean {
  if (body == null) return true;
  if (typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body).every((key) => !SUPPLIED_PATH_KEYS.has(key));
}

export function libraryPickQueryAllowed(params: { has(name: string): boolean }): boolean {
  for (const key of SUPPLIED_PATH_KEYS) {
    if (params.has(key)) return false;
  }
  return true;
}

interface ChildOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  failedToStart: boolean;
  overflow: boolean;
}

function waitForChild(child: FolderPickerChild, signal: AbortSignal | undefined): Promise<ChildOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let settled = false;
    const finish = (result: ChildOutput) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    const take = (current: string, chunk: Buffer | string) => {
      const next = current + String(chunk);
      if (next.length > OUTPUT_LIMIT) overflow = true;
      return next.slice(0, OUTPUT_LIMIT);
    };
    child.stdout?.on('data', (chunk) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = take(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({ code: null, stdout, stderr: error.message, failedToStart: true, overflow });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, failedToStart: false, overflow });
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function stripTrailingSlash(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/\/+$/, '');
}

function cancelledOutput(stdout: string, stderr: string): boolean {
  if (stdout.trim() === 'CANCELLED') return true;
  return /-128\b/.test(stderr) || /user cancel/i.test(stderr);
}

function interpretPick(output: ChildOutput, home: string): FolderPickResult {
  if (output.overflow) return { status: 'unavailable' };
  if (cancelledOutput(output.stdout, output.stderr)) return { status: 'cancelled' };
  const first = output.stdout.split(/\r?\n/)[0] ?? '';
  const path = stripTrailingSlash(first);
  if (output.failedToStart || output.code !== 0 || !path.startsWith('/')) return { status: 'unavailable' };
  const checked = checkLibraryDir(path, home);
  if (!checked.ok) return { status: 'rejected' };
  return { status: 'selected', path: checked.path };
}

export async function pickLibraryFolder(deps: PickLibraryFolderDeps = {}): Promise<FolderPickResult> {
  const platform = deps.platform ?? hostPlatform;
  if (platform() !== 'darwin') return { status: 'unavailable' };
  if (deps.signal?.aborted) return { status: 'cancelled' };
  const spawn = deps.spawn ?? hostSpawn;
  const command = deps.osascriptPath ?? LIBRARY_FOLDER_PICK_COMMAND;
  let child: FolderPickerChild;
  try {
    child = spawn(command, LIBRARY_FOLDER_PICK_ARGS, {
      env: pickerChildEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal: deps.signal
    });
  } catch {
    return { status: 'unavailable' };
  }
  const output = await waitForChild(child, deps.signal);
  if (deps.signal?.aborted) return { status: 'cancelled' };
  return interpretPick(output, deps.home ?? homedir());
}
