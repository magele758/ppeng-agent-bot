import type { RunContext, ToolContract, ToolExecutionResult } from '../types.js';

const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set([
  'agent',
  'scratchpad',
  'verify',
  'jev',
  'console',
  'tools',
  'require',
  'process',
  'fetch',
  'eval',
  'Function',
  'undefined',
  'Promise',
  'Object',
  'Array',
  'JSON',
  'Math',
  'Date'
]);

export function isPtcReservedIdentifier(name: string): boolean {
  return RESERVED.has(name);
}

export const PTC_NAMESPACE_BLOCKED_NAMES = new Set([
  'ptc_exec',
  'spawn_subagent',
  'spawn_teammate',
  'send_message',
  'read_inbox',
  'TodoWrite',
  'task_create',
  'task_update',
  'schedule_social_post',
  'harness_write_spec',
  'memory_set',
  'memory_delete',
  'handoff_state',
  'record_summary',
  'write_file',
  'edit_file',
  'bash',
  'bg_run',
  'spill_tool_result',
  'compact_context',
  'a2ui_render',
  'a2ui_delete_surface'
]);

export interface PtcScratchpad {
  write(key: unknown, content?: unknown): Promise<unknown>;
  read(key: string): Promise<unknown>;
  list(): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** Optional host-injected semantic decide API (no HTTP client in agent-loop). */
export interface PtcJevApi {
  noul(instructions: string): Promise<{ value: boolean; p: number } | null>;
  choice(
    instructions: string,
    options: Record<string, string> | string[]
  ): Promise<{ value: string; p: number } | null>;
}

export interface PtcNamespaceOptions {
  context: RunContext;
  authorizedTools: ToolContract<any>[];
  agent: (spec: unknown) => Promise<unknown>;
  scratchpad: PtcScratchpad;
  verify: (spec: unknown) => Promise<unknown>;
  /**
   * When provided, cells get a global `jev` with `noul` / `choice`.
   * Omit entirely when the host has no Jev ptcDecide chain — do not inject a stub.
   */
  jev?: PtcJevApi;
  onToolCall?: (name: string, result: ToolExecutionResult) => void;
}

export interface PtcNamespace {
  bindings: Record<string, unknown>;
  toolNames: string[];
}

export function isPtcNamespaceTool(tool: ToolContract<any>): boolean {
  return (
    tool.ptc?.kind === 'read' &&
    tool.ptc.requiresConfirm !== true &&
    !PTC_NAMESPACE_BLOCKED_NAMES.has(tool.name)
  );
}

function normalizeToolArgs(name: string, raw: unknown): Record<string, unknown> {
  if (name === 'web_search' && typeof raw === 'string') return { query: raw };
  if (name === 'web_fetch' && typeof raw === 'string') return { url: raw };
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${name}() expects an object argument`);
  }
  return raw as Record<string, unknown>;
}

function readonlyToolHook(
  tool: ToolContract<any>,
  context: RunContext,
  onToolCall?: (name: string, result: ToolExecutionResult) => void
): (raw?: unknown) => Promise<ToolExecutionResult> {
  return async (raw?: unknown) => {
    if (context.abortSignal?.aborted) throw new Error('PTC cell aborted');
    const args = normalizeToolArgs(tool.name, raw);
    if (tool.needsApproval?.(context, args) === true) {
      return {
        ok: false,
        content: JSON.stringify({
          error: 'approval_required',
          tool: tool.name,
          message: 'This call needs approval; PTC cells cannot request it. Call the tool directly.'
        })
      };
    }
    const result = await tool.execute(context, args);
    onToolCall?.(tool.name, result);
    return result;
  };
}

/** Build the cell namespace exclusively from this turn's authorized read surface. */
export function buildPtcNamespace(options: PtcNamespaceOptions): PtcNamespace {
  const bindings: Record<string, unknown> = Object.create(null);
  const toolsBag: Record<string, unknown> = Object.create(null);
  const names: string[] = [];

  bindings.agent = options.agent;
  bindings.scratchpad = Object.freeze({
    write: options.scratchpad.write,
    read: options.scratchpad.read,
    list: options.scratchpad.list,
    delete: options.scratchpad.delete
  });
  bindings.verify = options.verify;
  if (options.jev) {
    bindings.jev = Object.freeze({
      noul: options.jev.noul.bind(options.jev),
      choice: options.jev.choice.bind(options.jev)
    });
  }

  for (const tool of options.authorizedTools) {
    if (!isPtcNamespaceTool(tool)) continue;
    const hook = readonlyToolHook(tool, options.context, options.onToolCall);
    toolsBag[tool.name] = hook;
    names.push(tool.name);
    if (JS_IDENTIFIER.test(tool.name) && !RESERVED.has(tool.name)) {
      bindings[tool.name] = hook;
    }
  }
  bindings.tools = Object.freeze(toolsBag);
  return { bindings, toolNames: names.sort() };
}
