import { parseGoalVerifySpec } from '../goal/verify-spec.js';
import { linkAbortParent } from '../runtime/abort-lineage.js';
import { readGoalSettings, type GoalSettings } from '../goal/settings.js';
import type { GoalVerifySpec } from '../goal/types.js';
import type { RunContext, ToolContract } from '../types.js';
import { createPtcAgentHook } from './agent-hook.js';
import { buildPtcNamespace, type PtcJevApi } from './hooks.js';
import { PtcIsolateError, runPtcCell } from './isolate.js';
import { isPtcSession } from './mode.js';
import {
  PTC_LAST_RETURN_KEY,
  PTC_RESULT_MAX_CHARS,
  PtcScratchpadSession,
  createMemoryScratchPersist,
  type PtcScratchPersist
} from './scratchpad.js';
import type { PtcAgentSpec, PtcExecInput } from './types.js';

export const PTC_EXEC_TOOL_NAME = 'ptc_exec';

export interface PtcExecToolDependencies {
  getAuthorizedTools(context: RunContext): ToolContract<any>[];
  spawnSubagent(context: RunContext, spec: PtcAgentSpec, signal: AbortSignal): Promise<string>;
  createScratchPersist?: (context: RunContext) => PtcScratchPersist;
  scratchpad?: {
    write(context: RunContext, key: string, content: string): Promise<void>;
    read(context: RunContext, key: string): Promise<unknown>;
    list(context: RunContext): Promise<unknown>;
  };
  goalSettingsStore?: Parameters<typeof readGoalSettings>[0];
  /**
   * Optional: verify() support inside ptc_exec cells.
   * Kept optional so callers that do not want I/O-bound verify can omit it;
   * verify() throws at runtime when absent.
   */
  runGoalVerify?: (
    spec: GoalVerifySpec,
    ctx: { workspaceRoot?: string; settings?: GoalSettings; signal?: AbortSignal }
  ) => Promise<{ ok: boolean; reason: string }>;
  /**
   * Optional host callback: when it returns a `jev` API, inject into the cell
   * namespace. Return undefined to leave `jev` absent (default / no ptcDecide).
   * Implementing hosts must not statically import a Jev HTTP client into mini.
   */
  resolveJevHooks?: (input: {
    context: RunContext;
    signal: AbortSignal;
  }) => PtcJevApi | undefined;
  emitTrace?: (
    sessionId: string,
    event: { kind: 'ptc_cell' | 'ptc_hook'; payload?: Record<string, unknown> }
  ) => void;
  saveProgram?: (
    sessionId: string,
    patch: Record<string, unknown>
  ) => void;
}

export function resultJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'function' || typeof item === 'symbol') return String(item);
      return item;
    }, 2) ?? 'null';
  } catch {
    return JSON.stringify({ ok: false, error: 'PTC result is not serializable' });
  }
}

function previewText(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function createPtcExecTool(deps: PtcExecToolDependencies): ToolContract<PtcExecInput> {
  return {
    name: PTC_EXEC_TOOL_NAME,
    description:
      'Execute an async JavaScript workflow cell. Inside the cell use agent(), authorized read-only tools, scratchpad.write/read/list/delete, and verify(). scratchpad.write accepts (key, value) or { key, value, visibility, ttlSec, pin }. Default visibility is session; unpinned keys stay out of the parent memory appendix. Use inherit_scratch on agent() to copy ptc.* keys. Large returns spill to scratchpad __last_return. File writes and shell commands must remain normal parent/worker tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Async JavaScript body; return or final expression is the result.' },
        timeoutMs: { type: 'number', description: 'Optional timeout, clamped to 120000 ms.' }
      },
      required: ['code']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      if (!isPtcSession(context.session)) {
        return {
          ok: false,
          content: 'ptc_exec is only available when orchestrationEngine=ptc or taskRunMode=dynamic_workflow.'
        };
      }
      const code = typeof args.code === 'string' ? args.code : '';
      const controller = new AbortController();
      linkAbortParent(controller.signal, context.abortSignal);
      const onAbort = () => controller.abort();
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });
      const persist = deps.createScratchPersist?.(context) ?? createMemoryScratchPersist();
      const pad = new PtcScratchpadSession(persist);

      const agent = createPtcAgentHook({
        concurrencyCap: 16,
        maxCalls: 64,
        signal: controller.signal,
        spawn: async (spec) => {
          const task = spec.angle ? `[Angle: ${spec.angle}]\n\n${spec.task}` : spec.task;
          return deps.spawnSubagent(context, { ...spec, task }, controller.signal);
        }
      });
      const jev = deps.resolveJevHooks?.({ context, signal: controller.signal });
      const namespace = buildPtcNamespace({
        context: { ...context, abortSignal: controller.signal },
        authorizedTools: deps.getAuthorizedTools(context),
        agent,
        scratchpad: {
          write: (raw, content) => pad.write(raw, content),
          read: (key) => pad.read(key),
          list: () => pad.list(),
          delete: (key) => pad.delete(key)
        },
        verify: async (raw) => {
          const spec = parseGoalVerifySpec(raw);
          if (!spec) throw new Error('verify() requires a valid files_exist or http spec');
          if (!deps.runGoalVerify) throw new Error('verify() is not available in this context');
          const result = await deps.runGoalVerify(spec, {
            workspaceRoot: context.workspaceRoot ?? context.repoRoot,
            settings: deps.goalSettingsStore
              ? readGoalSettings(deps.goalSettingsStore)
              : undefined,
            signal: controller.signal
          });
          if (!result.ok) throw new Error(result.reason);
          return result;
        },
        ...(jev ? { jev } : {}),
        onToolCall: (name, result) => {
          deps.emitTrace?.(context.session.id, {
            kind: 'ptc_hook',
            payload: { name, ok: result.ok }
          });
        }
      });

      deps.emitTrace?.(context.session.id, {
        kind: 'ptc_cell',
        payload: {
          phase: 'start',
          codeChars: code.length,
          timeoutMs: args.timeoutMs ?? null,
          namespaceTools: namespace.toolNames
        }
      });
      try {
        const { value, logs } = await runPtcCell(code, {
          timeoutMs: args.timeoutMs,
          abortController: controller,
          hooks: namespace.bindings
        });
        const executedAt = new Date().toISOString();
        deps.saveProgram?.(context.session.id, {
          ptcLastProgram: code,
          ptcLastExecutedAt: executedAt,
          ptcLastRunOk: true
        });
        deps.emitTrace?.(context.session.id, {
          kind: 'ptc_cell',
          payload: { phase: 'end', ok: true, logs: logs.length }
        });
        const full = resultJson({ ok: true, result: value, logs, callSite: PTC_EXEC_TOOL_NAME });
        if (full.length > PTC_RESULT_MAX_CHARS) {
          await pad.writeReserved(PTC_LAST_RETURN_KEY, full);
          return {
            ok: true,
            content: resultJson({
              ok: true,
              spilled: true,
              ref: PTC_LAST_RETURN_KEY,
              preview: previewText(full),
              logs,
              callSite: PTC_EXEC_TOOL_NAME
            }),
            metadata: {
              ptc: {
                ok: true,
                codeChars: code.length,
                logs: logs.length,
                executedAt,
                ref: PTC_LAST_RETURN_KEY
              }
            }
          };
        }
        return {
          ok: true,
          content: full,
          metadata: {
            ptc: { ok: true, codeChars: code.length, logs: logs.length, executedAt }
          }
        };
      } catch (error) {
        const isolate = error instanceof PtcIsolateError ? error : undefined;
        const message = error instanceof Error ? error.message : String(error);
        deps.saveProgram?.(context.session.id, {
          ptcLastProgram: code,
          ptcLastExecutedAt: new Date().toISOString(),
          ptcLastRunOk: false,
          ptcLastError: message.slice(0, 1000)
        });
        deps.emitTrace?.(context.session.id, {
          kind: 'ptc_cell',
          payload: { phase: 'end', ok: false, code: isolate?.code ?? 'runtime', error: message }
        });
        return {
          ok: false,
          content: resultJson({
            ok: false,
            error: message,
            code: isolate?.code ?? 'runtime',
            logs: [],
            callSite: PTC_EXEC_TOOL_NAME
          })
        };
      } finally {
        pad.dispose();
        context.abortSignal?.removeEventListener('abort', onAbort);
      }
    }
  };
}
