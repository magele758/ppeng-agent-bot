import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { terminateProcessTree, treeKillSpawnOptions } from '../sandbox/process-tree.js';
import { buildRedactionEnv, redactToolContent } from '../sandbox/result-redaction.js';
import type { RunContext, ToolContract } from '../types.js';
import { resolveWorkspacePath } from '../workspace/resolve.js';
import {
  isExternalAiAllowedForSession,
  resolveExternalAiSettings,
  type ExternalAiSettingsReadStore,
  type ExternalAiToolName
} from './external-ai-settings.js';

const MAX_OUTPUT_CHARS = 120_000;

export interface LocalCodingAgentSpec {
  toolName: ExternalAiToolName;
  label: string;
  defaultCommand: string;
  binaries: readonly string[];
}

export const LOCAL_CODING_AGENT_SPECS: readonly LocalCodingAgentSpec[] = [
  {
    toolName: 'claude_code',
    label: 'Claude Code',
    defaultCommand: 'claude',
    binaries: ['claude']
  },
  {
    toolName: 'codex_exec',
    label: 'Codex CLI',
    defaultCommand: 'codex',
    binaries: ['codex']
  },
  {
    toolName: 'cursor_agent',
    label: 'Cursor Agent CLI',
    defaultCommand: 'agent',
    binaries: ['agent', 'cursor-agent']
  }
];

export interface LocalCodingAgentInfo {
  toolName: ExternalAiToolName;
  label: string;
  command: string;
  binaries: readonly string[];
  installed: boolean;
  resolvedBinary?: string;
  resolvedPath?: string;
}

function isExecutableFile(fullPath: string): boolean {
  try {
    const st = statSync(fullPath);
    if (!st.isFile()) return false;
    return process.platform === 'win32' || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findBinaryOnPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' ? [bin, `${bin}.cmd`, `${bin}.exe`] : [bin];
  for (const dir of dirs) {
    const hit = candidates.map((c) => join(dir, c)).find(isExecutableFile);
    if (hit) return hit;
  }
  return undefined;
}

/** Detect which supported local coding-agent CLIs exist on PATH. Read-only; never auto-enables tools. */
export function detectLocalCodingAgents(env: NodeJS.ProcessEnv = process.env): LocalCodingAgentInfo[] {
  return LOCAL_CODING_AGENT_SPECS.map((spec) => {
    for (const bin of spec.binaries) {
      const resolvedPath = findBinaryOnPath(bin, env);
      if (resolvedPath) {
        return {
          toolName: spec.toolName,
          label: spec.label,
          command: bin,
          binaries: spec.binaries,
          installed: true,
          resolvedBinary: bin,
          resolvedPath
        };
      }
    }
    return {
      toolName: spec.toolName,
      label: spec.label,
      command: spec.defaultCommand,
      binaries: spec.binaries,
      installed: false
    };
  });
}

export function installedExternalAiToolNames(env: NodeJS.ProcessEnv = process.env): ExternalAiToolName[] {
  return detectLocalCodingAgents(env)
    .filter((agent) => agent.installed)
    .map((agent) => agent.toolName);
}

/** Resolve Cursor Agent model: Lab setting > RAW_AGENT_CURSOR_AGENT_MODEL > EVOLUTION_CURSOR_AGENT_MODEL > default. */
export function resolveCursorAgentModel(
  settingsStore?: ExternalAiSettingsReadStore | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  const fromSettings = resolveExternalAiSettings(settingsStore, env).cursorAgentModel.trim();
  if (fromSettings) return fromSettings;
  const fromEnv =
    env.RAW_AGENT_CURSOR_AGENT_MODEL?.trim() ||
    env.EVOLUTION_CURSOR_AGENT_MODEL?.trim() ||
    'composer-2-fast';
  return fromEnv || 'composer-2-fast';
}

function defaultWorkspaceCwd(context: RunContext): string {
  const primary = context.workspaceRoots?.find((r) => r.primary) ?? context.workspaceRoots?.[0];
  return primary?.path ?? context.workspaceRoot ?? context.repoRoot;
}

function verifyExistingDirectory(resolved: string, rawCwd: string): { ok: true; cwd: string } | { ok: false; error: string } {
  try {
    return statSync(resolved).isDirectory()
      ? { ok: true, cwd: resolved }
      : { ok: false, error: `cwd is not a directory: ${rawCwd}` };
  } catch {
    return { ok: false, error: `cwd directory does not exist: ${rawCwd}` };
  }
}

function resolveExternalCwd(context: RunContext, rawCwd?: unknown): { ok: true; cwd: string } | { ok: false; error: string } {
  if (rawCwd == null || rawCwd === '') return { ok: true, cwd: defaultWorkspaceCwd(context) };
  if (typeof rawCwd !== 'string' || !rawCwd.trim()) {
    return { ok: false, error: 'cwd must be a non-empty relative or workspace path string' };
  }
  try {
    return verifyExistingDirectory(resolveWorkspacePath(context, rawCwd.trim()), rawCwd);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function clipOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, Math.floor(MAX_OUTPUT_CHARS * 0.4));
  const tail = text.slice(-Math.floor(MAX_OUTPUT_CHARS * 0.55));
  return `${head}\n\n… [output truncated: omitted ${text.length - head.length - tail.length} chars] …\n\n${tail}`;
}

function formatMissingCliError(command: string, env: NodeJS.ProcessEnv): string {
  const available = detectLocalCodingAgents(env)
    .filter((item) => item.installed)
    .map((item) => `${item.toolName} (${item.resolvedBinary ?? item.command})`);
  const hint =
    available.length > 0
      ? `Detected local coding agents on PATH: ${available.join(', ')}.`
      : 'No supported local coding-agent CLI (claude, codex, agent/cursor-agent) was detected on PATH.';
  return `Local coding-agent CLI "${command}" is not installed or not on PATH. ${hint}`;
}

/** spawn 无 shell，提示词仅作 argv 传递，避免注入 */
function spawnCaptured(
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv({ base: options?.env }),
      ...treeKillSpawnOptions()
    });

    let stdout = '';
    let stderr = '';

    const onAbort = () => {
      terminateProcessTree(child);
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        terminateProcessTree(child);
      }, options.timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      options?.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      resolve({
        code,
        output:
          options?.signal?.aborted && !combined
            ? '(aborted)'
            : combined || `(exit ${code ?? '?'}, no output)`
      });
    });

    child.on('error', (err) => {
      options?.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

interface ExternalToolDef {
  name: ExternalAiToolName;
  resolveCommand: (env: NodeJS.ProcessEnv) => string;
  description: string;
  extraSchemaProperties?: Record<string, unknown>;
  buildArgs: (args: { prompt: string; [k: string]: unknown }, env: NodeJS.ProcessEnv) => string[];
}

export interface CreateExternalAiToolsOptions {
  settingsStore?: ExternalAiSettingsReadStore | null;
  env?: NodeJS.ProcessEnv;
}

function formatSpawnFailure(err: unknown, command: string, env: NodeJS.ProcessEnv, redactionEnv: NodeJS.ProcessEnv): string {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return formatMissingCliError(command, env);
  return redactToolContent(err instanceof Error ? err.message : String(err), redactionEnv);
}

function validPromptArg(prompt: unknown): prompt is string {
  return typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= 50_000;
}

function resolveTimeoutMs(raw: unknown): number {
  return typeof raw === 'number' && raw > 0 ? raw : 600_000;
}

function createExternalCliTool(
  def: ExternalToolDef,
  options?: CreateExternalAiToolsOptions
): ToolContract<{ prompt: string; cwd?: string; timeout_ms?: number; [k: string]: unknown }> {
  return {
    name: def.name,
    isExternal: true,
    access: 'delegate',
    description: def.description,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Self-contained coding instructions: concrete goal, relevant files/constraints, acceptance criteria, and verification commands to run.'
        },
        cwd: {
          type: 'string',
          description:
            'Optional working directory inside authorized workspace roots (relative path, @alias/path, or workspace subdirectory). Defaults to primary workspace root.'
        },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 600000)' },
        ...(def.extraSchemaProperties ?? {})
      },
      required: ['prompt']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval: () => true,
    async execute(context, args) {
      if (!validPromptArg(args.prompt)) return { ok: false, content: 'prompt must be a non-empty string (max 50k chars)' };
      const cwdRes = resolveExternalCwd(context, args.cwd);
      if (!cwdRes.ok) return { ok: false, content: cwdRes.error };
      const env = options?.env ?? process.env;
      const command = def.resolveCommand(env);
      const redactionEnv = buildRedactionEnv(env);
      try {
        const { code, output } = await spawnCaptured(command, def.buildArgs(args, env), cwdRes.cwd, {
          timeoutMs: resolveTimeoutMs(args.timeout_ms),
          signal: context.abortSignal,
          env
        });
        return { ok: code === 0, content: redactToolContent(clipOutput(output), redactionEnv) };
      } catch (e) {
        return { ok: false, content: formatSpawnFailure(e, command, env, redactionEnv) };
      }
    }
  };
}

/**
 * 可选工具：供 Agent / Bot 在对话与任务中调用本机已安装的编程助手 CLI。
 * 开关由 Lab 持久化设置（external_ai_settings）优先控制，未保存时回退 `RAW_AGENT_EXTERNAL_AI_TOOLS`。
 */
export function createExternalAiTools(options?: CreateExternalAiToolsOptions): ToolContract<any>[] {
  return [
    createExternalCliTool(
      {
        name: 'claude_code',
        resolveCommand: () => 'claude',
        description:
          'Delegate a deep or complex coding task to local Claude Code CLI (`claude -p`). Ideal for multi-file implementation, architectural refactors, root-cause debugging, and fixing complex build/test failures. Provide a clear, self-contained prompt with goal, constraints, and verification commands; pass `cwd` for a target subdirectory. Runs in workspace and requires user approval.',
        buildArgs: (args) => ['-p', args.prompt]
      },
      options
    ),
    createExternalCliTool(
      {
        name: 'codex_exec',
        resolveCommand: () => 'codex',
        description:
          'Delegate a deep or complex coding task to local OpenAI Codex CLI (`codex exec`). Ideal for multi-file feature implementation, refactoring, debugging, and test/build fixes. Default sandbox allows writing workspace; set `full_auto: true` for unattended execution (riskier). Provide concrete goals, constraints, and verification commands; pass `cwd` for a target subdirectory. Requires user approval.',
        extraSchemaProperties: {
          full_auto: {
            type: 'boolean',
            description: 'Use `codex exec --full-auto` instead of `--sandbox workspace-write` (riskier).'
          }
        },
        buildArgs: (args) => {
          const base =
            (args as { full_auto?: boolean }).full_auto === true
              ? ['exec', '--full-auto']
              : ['exec', '--sandbox', 'workspace-write'];
          return [...base, args.prompt];
        }
      },
      options
    ),
    createExternalCliTool(
      {
        name: 'cursor_agent',
        resolveCommand: (env) => {
          const info = detectLocalCodingAgents(env).find((item) => item.toolName === 'cursor_agent');
          return info?.resolvedBinary ?? 'agent';
        },
        description:
          'Delegate a deep or complex coding task to local Cursor Agent CLI (`agent`/`cursor-agent --print --model …`). Ideal for fast multi-file edits, refactors, and fixing build/test failures. Model uses Lab setting or RAW_AGENT_CURSOR_AGENT_MODEL (default composer-2-fast). Provide concrete goals, constraints, and verification commands; pass `cwd` for a target subdirectory. Requires user approval.',
        buildArgs: (args, env) => ['--print', '--model', resolveCursorAgentModel(options?.settingsStore, env), args.prompt]
      },
      options
    )
  ];
}

/**
 * Prompt guidance describing available local coding-agent CLIs and when to delegate
 * deep coding tasks to them instead of grinding inside the Bot loop.
 * Returns empty string when external coding tools are not allowed for this session.
 */
export function buildLocalCodingAgentsPromptBlock(
  store: ExternalAiSettingsReadStore | undefined | null,
  env: NodeJS.ProcessEnv,
  session: { mode?: string; metadata?: Record<string, unknown> | null }
): string {
  if (!isExternalAiAllowedForSession(store, env, session)) return '';
  const settings = resolveExternalAiSettings(store, env);
  const detected = detectLocalCodingAgents(env);
  const installed = detected.filter((item) => item.installed);
  if (installed.length === 0) {
    return [
      'Local coding-agent tools are enabled in settings, but no supported local CLI (claude, codex, agent/cursor-agent) was detected on PATH.',
      'Do not pretend a local coding agent is installed. Handle small coding tasks with built-in tools or inform the user which CLI to install.'
    ].join('\n');
  }
  const installedList = installed.map((item) => `${item.toolName} (${item.label}, CLI: ${item.resolvedBinary ?? item.command})`).join('; ');
  const preferredLine =
    settings.preferredTool !== 'auto'
      ? installed.some((item) => item.toolName === settings.preferredTool)
        ? `User preferred coding agent: ${settings.preferredTool}. Prefer it first unless it fails or another installed agent fits better.`
        : `User preferred coding agent (${settings.preferredTool}) is not currently detected on PATH; choose from the installed agents above.`
      : 'Preferred coding agent: auto (pick the installed agent best suited for the task; switch to another installed one if the first fails).';

  return [
    `Installed local coding agents: ${installedList}.`,
    preferredLine,
    'When to delegate vs handle directly:',
    '- Prefer delegating deep or complex coding work (multi-file features, architectural refactors, root-cause debugging, tricky build/type/test failures, or large test suites) to an installed local coding agent instead of grinding through many manual read_file/edit_file/bash turns in this Bot loop.',
    '- Handle small, straightforward work directly with built-in tools (quick code Q&A, inspecting a few files, trivial single-file edits, or short status checks).',
    'How to use local coding agents effectively:',
    '1. Gather minimal necessary context first (target directory, error logs, user constraints), then write one self-contained prompt with the exact goal, scope/constraints, acceptance criteria, and verification commands (build/test) to run.',
    '2. Pass `cwd` when targeting a specific repository or subdirectory inside authorized workspace roots.',
    '3. Local coding-agent calls require user approval in auto/ask mode; issue the tool call directly when warranted instead of asking permission in prose first.',
    '4. After the coding agent returns, verify the concrete outcome (diffs, exit status, tests) and summarize results and any remaining gaps accurately.'
  ].join('\n');
}
