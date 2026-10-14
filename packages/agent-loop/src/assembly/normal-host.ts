/**
 * normal assembly: mini + tool-loop defaults, permission-mode, dirty-input,
 * memory LIFO compensation, model retry/watchdog, default autoCompact.
 */

import { moduleIdsForPreset } from './presets.js';
import type { AssembledLoop, CreateAssembledLoopInput } from './io.js';
import { createMiniAssembledLoop } from './mini-host.js';
import { createApprovalBag } from './store-adapter.js';
import {
  checkToolApprovals,
  executeToolCalls,
  filterValidToolCalls,
  processToolResults,
  runTurnWithRetries,
  type ToolLoopHost,
} from '../runtime/tool-loop.js';
import {
  compensateCompletedLifo,
  createCompensationTx,
  runWithCompensation,
} from '../session/compensation.js';
import { runAutoCompact } from '../session/auto-compact.js';
import { resolveHistoryTokenBudget } from '../session/session-budget.js';
import type { ToolCallPart, ToolContract } from '../types.js';

type StoreWithApprovals = AssembledLoop['store'] & {
  createApproval?(input: {
    sessionId: string;
    toolName: string;
    reason: string;
    args: Record<string, unknown>;
    idempotencyKey?: string;
  }): import('../types.js').ApprovalRecord;
  deleteApproval?(id: string): void;
  updateTask?(taskId: string, patch: { artifacts: import('../types.js').TaskArtifact[] }): void;
};

function buildToolLoopHost(
  assembled: AssembledLoop,
  input: CreateAssembledLoopInput
): ToolLoopHost {
  const io = input.io ?? {};
  const bag = createApprovalBag();
  const store = assembled.store as StoreWithApprovals;
  return {
    env: io.env ?? {},
    gateDirtyInput: true,
    appendMessage: (sessionId, role, parts) => {
      store.appendMessage(sessionId, role, parts);
    },
    listApprovals: (filter) => store.listApprovals(filter) as import('../types.js').ApprovalRecord[],
    createApproval: (req) => store.createApproval?.(req) ?? bag.createApproval(req),
    deleteApproval: (id) => {
      if (store.deleteApproval) store.deleteApproval(id);
      else bag.deleteApproval(id);
    },
    getTask: (taskId) => store.getTask?.(taskId),
    updateTask: (taskId, patch) => {
      store.updateTask?.(taskId, patch);
    },
    emitTrace: (sessionId, event) => {
      assembled.host.emitTrace(sessionId, {
        kind: event.kind as Parameters<AssembledLoop['host']['emitTrace']>[1]['kind'],
        data: event.payload ?? {},
      });
    },
    runLifecycleHook: io.runToolLifecycleHook,
    runAfterToolExtension: io.runAfterToolExtension,
    checkCapabilityPin: io.cbom
      ? (name, schema) => io.cbom!.checkPin(name, schema)
      : undefined,
    archiveToolResult: io.archiveToolResult,
    redactSecrets: io.redactSecrets,
    exportToolSpan: io.otel?.exportSpan
      ? ({ sessionId, toolName, ok, durationMs }) =>
          io.otel!.exportSpan!(sessionId, `tool.${toolName}`, {
            ok: String(ok),
            durationMs: String(durationMs),
          })
      : undefined,
    compensate: (items) => compensateCompletedLifo(items),
  };
}

export function createNormalAssembledLoop(input: CreateAssembledLoopInput = {}): AssembledLoop {
  const assembled = createMiniAssembledLoop({ ...input, preset: 'mini' });
  const io = input.io ?? {};
  const toolHost = buildToolLoopHost(assembled, input);
  const tools = (assembled.host.tools ?? []) as ToolContract<Record<string, unknown>>[];
  const maxParallel = io.maxParallelToolCalls ?? 8;

  const toolsOf = (turnTools?: ToolContract<any>[]) =>
    (turnTools ?? assembled.host.tools ?? tools) as ToolContract<Record<string, unknown>>[];

  if (!io.filterValidToolCalls) {
    assembled.host.filterValidToolCalls = (toolCalls, allowExternal, sessionId, turnTools) =>
      filterValidToolCalls(
        toolHost,
        toolsOf(turnTools),
        toolCalls as ToolCallPart[],
        allowExternal,
        sessionId
      );
  }

  if (!io.checkToolApprovals) {
    assembled.host.checkToolApprovals = (toolCalls, context, session, extras) =>
      checkToolApprovals(
        toolHost,
        toolsOf(extras?.turnTools),
        toolCalls as ToolCallPart[],
        context,
        extras?.filePolicy ?? io.filePolicy,
        session,
        io.envApprovalPolicy,
        extras?.closedByGate
      );
  }

  if (!io.executeToolCalls) {
    assembled.host.executeToolCalls = (toolCalls, context, allowExternal, sessionId, turnTools) => {
      const tx = createCompensationTx();
      return runWithCompensation(tx, () =>
        executeToolCalls(
          toolHost,
          toolsOf(turnTools),
          toolCalls as ToolCallPart[],
          context,
          allowExternal,
          sessionId,
          maxParallel
        )
      );
    };
  }

  if (!io.processToolResults) {
    assembled.host.processToolResults = (results, calls, session, _task, sessionId, onChunk) => {
      processToolResults(
        toolHost,
        results,
        calls as ToolCallPart[],
        session,
        session.taskId ? toolHost.getTask(session.taskId) : undefined,
        sessionId,
        onChunk
      );
    };
  }

  if (!io.runTurnWithRetries) {
    assembled.host.runTurnWithRetries = (turnInput, onStream) => {
      let adapter = assembled.host.modelAdapter;
      if (assembled.host.resolveModelAdapter && turnInput.sessionId) {
        const sess = assembled.store.getSession(turnInput.sessionId);
        if (sess) adapter = assembled.host.resolveModelAdapter(sess);
      }
      return runTurnWithRetries(toolHost, adapter, turnInput, onStream);
    };
  }

  if (!io.autoCompact) {
    assembled.host.autoCompact = async (context, opts) => {
      const tokenThreshold = resolveHistoryTokenBudget('RAW_AGENT_COMPACT_TOKEN_THRESHOLD', {
        maxContextTokens: input.config?.maxContextTokens,
      });
      const adapter = assembled.host.resolveModelAdapter?.(context.session) ?? assembled.host.modelAdapter;
      const result = await runAutoCompact({
        store: assembled.store,
        session: context.session,
        agent: context.agent,
        tokenThreshold,
        force: opts?.force,
        summarize: async (messages) => {
          if (typeof adapter.summarizeMessages === 'function') {
            return adapter.summarizeMessages({
              agent: context.agent,
              messages,
              reason: 'auto-compact',
            });
          }
          return messages
            .map((m) =>
              m.parts
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join(' ')
            )
            .join('\n')
            .slice(0, 2_000);
        },
        prepareView: assembled.host.prepareMessagesForModel
          ? (messages) => assembled.host.prepareMessagesForModel!(context.session, messages)
          : undefined,
      });
      return result.replaced ? { replaced: result.replaced } : {};
    };
  }

  return {
    ...assembled,
    preset: 'normal',
    loadedModules: moduleIdsForPreset('normal'),
  };
}
