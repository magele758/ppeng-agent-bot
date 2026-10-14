/**
 * Host-side macOS app control. The portable loop only sees tool names and results.
 * The first osascript call can raise the normal macOS TCC dialog (Automation, and
 * Accessibility for keystrokes). This module does not pre-grant or edit TCC.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { homedir, platform as hostPlatform } from 'node:os';
import type { RunContext, ToolContract, ToolExecutionResult } from '../types.js';
import { stableJsonHash } from '../runtime/helpers.js';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { planAppControlCall } from './script.js';
import { isAppControlToolName, type AppControlToolName } from './settings.js';

const UNAVAILABLE =
  'macOS app control is unavailable on this operating system. No command was started.';
const DISABLED = 'macOS app control is off. No command was started.';
const NEEDS_APPROVAL =
  'Lab approval is required for this app-control action. Approving one action does not allow a different one. No command was started.';
const CANCELLED = 'macOS app control was cancelled. No command was started.';

const ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'USER', 'LOGNAME'] as const;

export interface AppControlApprovalRow {
  sessionId: string;
  toolName: string;
  status: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface AppControlApprovals {
  listApprovals(filter?: { status?: 'pending' | 'approved' | 'rejected' }): AppControlApprovalRow[];
}

export interface AppControlChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface AppControlSpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: true;
}

export type AppControlSpawn = (
  command: string,
  args: string[],
  options: AppControlSpawnOptions
) => AppControlChild;

export interface AppControlToolDeps {
  enabled: () => boolean;
  approvals: AppControlApprovals;
  platform?: () => NodeJS.Platform;
  spawn?: AppControlSpawn;
  osascriptPath?: string;
}

export function appControlChildEnv(): NodeJS.ProcessEnv {
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
  for (const key of ENV_KEYS) {
    const value = sanitized[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

function actionApproved(
  approvals: AppControlApprovals,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): boolean {
  const want = stableJsonHash(toolName, args);
  for (const row of approvals.listApprovals({ status: 'approved' })) {
    if (row.sessionId !== sessionId || row.toolName !== toolName || row.status !== 'approved') continue;
    if (stableJsonHash(toolName, row.args) === want) return true;
  }
  return false;
}

function clip(value: string): string {
  return value.length > 500 ? value.slice(0, 500) : value;
}

function runOsascript(
  spawn: AppControlSpawn,
  command: string,
  args: string[],
  signal: AbortSignal | undefined
): Promise<{ ok: boolean; content: string }> {
  return new Promise((resolve) => {
    let child: AppControlChild;
    try {
      child = spawn(command, args, {
        env: appControlChildEnv(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ ok: false, content: `macOS app control could not start: ${clip(message)}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { ok: boolean; content: string }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    child.stdout?.on('data', (chunk) => { stdout = clip(stdout + String(chunk)); });
    child.stderr?.on('data', (chunk) => { stderr = clip(stderr + String(chunk)); });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      finish({ ok: false, content: `macOS app control could not start: ${clip(error.message)}` });
    });
    child.on('close', (code) => {
      if (signal?.aborted) {
        finish({ ok: false, content: CANCELLED });
        return;
      }
      if (code === 0) {
        finish({ ok: true, content: '' });
        return;
      }
      const detail = clip(stderr || stdout || `exit ${code ?? 'unknown'}`);
      finish({ ok: false, content: `macOS app control failed: ${detail}` });
    });
  });
}

function successContent(toolName: AppControlToolName, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'app_activate':
      return `Activated ${String(args.app)}.`;
    case 'app_type_text':
      return 'Typed text into the frontmost app.';
    case 'app_keystroke':
      return `Sent the ${String(args.key)} keystroke.`;
    default: {
      const unreachable: never = toolName;
      return unreachable;
    }
  }
}

async function executeAppControl(
  deps: AppControlToolDeps,
  toolName: AppControlToolName,
  context: RunContext,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  if (!deps.enabled()) return { ok: false, content: DISABLED };
  const plan = planAppControlCall(toolName, args);
  if (!plan.ok) return { ok: false, content: plan.content };
  if ((deps.platform ?? hostPlatform)() !== 'darwin') return { ok: false, content: UNAVAILABLE };
  if (context.abortSignal?.aborted) return { ok: false, content: CANCELLED };
  if (!actionApproved(deps.approvals, context.session.id, toolName, args)) {
    return { ok: false, content: NEEDS_APPROVAL };
  }
  const spawn = (deps.spawn ?? nodeSpawn) as AppControlSpawn;
  const command = deps.osascriptPath ?? '/usr/bin/osascript';
  const result = await runOsascript(spawn, command, ['-e', plan.script, ...plan.extraArgs], context.abortSignal);
  if (!result.ok) return result;
  return { ok: true, content: successContent(toolName, args) };
}

function toolContract(
  deps: AppControlToolDeps,
  spec: { name: AppControlToolName; description: string; inputSchema: Record<string, unknown> }
): ToolContract<Record<string, unknown>> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    approvalMode: 'auto',
    sideEffectLevel: 'system',
    needsApproval(_context, args) {
      if (!deps.enabled()) return false;
      if (!planAppControlCall(spec.name, args).ok) return false;
      return (deps.platform ?? hostPlatform)() === 'darwin';
    },
    execute: (context, args) => executeAppControl(deps, spec.name, context, args)
  };
}

export function createAppControlTools(deps: AppControlToolDeps): ToolContract<Record<string, unknown>>[] {
  const tools = [
    toolContract(deps, {
      name: 'app_activate',
      description:
        'Bring a named macOS app to the front, for example Cursor or TextEdit. Pass only the app name. Not AppleScript. Each call needs Lab approval. Unavailable off macOS.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { app: { type: 'string', description: 'Application name shown in the Dock.' } },
        required: ['app']
      }
    }),
    toolContract(deps, {
      name: 'app_type_text',
      description:
        'Type plain text into the frontmost macOS app. Not a script or URL. Each call needs Lab approval. Unavailable off macOS.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', description: 'Plain text to type.' } },
        required: ['text']
      }
    }),
    toolContract(deps, {
      name: 'app_keystroke',
      description:
        'Send one allowed key to the frontmost macOS app: return, tab, escape, up, down, left, right, cmd-c, or cmd-v. Each call needs Lab approval. Unavailable off macOS.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: {
            type: 'string',
            enum: ['return', 'tab', 'escape', 'up', 'down', 'left', 'right', 'cmd-c', 'cmd-v']
          }
        },
        required: ['key']
      }
    })
  ];
  return tools.filter((tool) => isAppControlToolName(tool.name));
}
