/**
 * full assembly: normal + working-log, EventLog/stepTx, rich prepare-view,
 * context appendix, run-profile, L4 handle, optional file compensation / sqlite.
 */

import { moduleIdsForPreset } from './presets.js';
import type { AssembledLoop, CreateAssembledLoopInput } from './io.js';
import { createNormalAssembledLoop } from './normal-host.js';
import { createEventLogStepTx } from '../session/event-log-saga.js';
import { compileAppendixFromSources } from '../session/context-compiler.js';
import { applyOptionalFoldBudget, prepareRichView } from '../turn/prepare-view.js';
import { runProfileFromSession } from '../runtime/run-profile.js';
import {
  createAgentLoop,
  createAgentLoopFromKernelHost,
  type AgentLoopHandle,
} from '../runtime/agent-loop.js';
import { readWorkingLogTail, workingLogPath } from '../session/working-log.js';

export async function createFullAssembledLoop(
  input: CreateAssembledLoopInput = {}
): Promise<AssembledLoop> {
  const assembled = createNormalAssembledLoop({ ...input, preset: 'normal' });
  const io = input.io ?? {};
  const loaded = new Set(moduleIdsForPreset('full'));

  // EventLog saga store: the session store, optionally mirrored into sqlite so
  // the log (and the checkpoints written by the same stepTx) survive an
  // in-memory store restart.
  let sagaStore = assembled.store;
  let closeSqlite: (() => void) | undefined;
  loaded.delete('event-log-sqlite');
  if (io.sqlite) {
    const sqliteMod = await import('../session/event-log-sqlite.js');
    const handle = await sqliteMod.openSqliteEventLog(io.sqlite);
    if (handle) {
      sagaStore = sqliteMod.createSqliteEventLogStore(assembled.store, handle);
      closeSqlite = handle.close;
      loaded.add('event-log-sqlite');
    }
  }

  if (!io.stepTx) {
    assembled.host.stepTx = createEventLogStepTx(sagaStore);
  }

  if (!io.readWorkingLogAppendix && io.stateDir !== undefined) {
    assembled.host.readWorkingLogAppendix = (sessionId) =>
      readWorkingLogTail(workingLogPath(assembled.host.stateDir, sessionId));
  }

  if (!io.prepareMessagesForModel) {
    assembled.host.prepareMessagesForModel = async (session, messages) =>
      prepareRichView(session, messages, {
        getImageAsset: io.getImageAsset,
        annotateRetired: io.annotateRetired,
        refusalPreservation: input.config?.refusalPreservation,
        emitTrace: (sessionId, event) => {
          assembled.host.emitTrace(sessionId, {
            kind: event.kind as Parameters<AssembledLoop['host']['emitTrace']>[1]['kind'],
            data: (event.payload as Record<string, unknown> | undefined) ?? {},
          });
        },
      });
  }

  if (!io.applyFoldBudget) {
    assembled.host.applyFoldBudget = (session, folded) =>
      applyOptionalFoldBudget(session, folded, {
        selectEpisodic: io.selectEpisodic,
        maxVisibleMessages: input.config?.maxVisibleMessages,
        emitTrace: (sessionId, event) => {
          assembled.host.emitTrace(sessionId, {
            kind: event.kind as Parameters<AssembledLoop['host']['emitTrace']>[1]['kind'],
            data: (event.payload as Record<string, unknown> | undefined) ?? {},
          });
        },
      });
  }

  if (io.recallContextSources && !io.promptBuilder) {
    const inner = assembled.host.promptBuilder;
    assembled.host.promptBuilder = {
      buildSystemPrompt: (ctx, messages) => inner.buildSystemPrompt(ctx, messages),
      ...(inner.buildSystemPromptParts
        ? {
            buildSystemPromptParts: (ctx: Parameters<typeof inner.buildSystemPrompt>[0], messages: Parameters<typeof inner.buildSystemPrompt>[1]) =>
              inner.buildSystemPromptParts!(ctx, messages)
          }
        : {}),
      buildMemoryAppendix: (ctx, opts) => {
        const query = opts?.query ?? '';
        const sources = io.recallContextSources!({
          session: ctx.session,
          query,
          stateDir: opts?.stateDir ?? assembled.host.stateDir,
        });
        return compileAppendixFromSources(sources, query) || inner.buildMemoryAppendix(ctx, opts);
      },
    };
  }

  if (!io.resolveRunProfile) {
    assembled.host.resolveRunProfile = (session) => runProfileFromSession(session);
  }

  if (io.resolveWorkspacePath) {
    try {
      const fileComp = await import('../session/file-compensation.js');
      assembled.host.tools = fileComp.attachFileCompensation(
        assembled.host.tools as never,
        io.resolveWorkspacePath ?? fileComp.defaultResolveWorkspacePath
      ) as typeof assembled.host.tools;
    } catch {
      loaded.delete('file-compensation');
    }
  }

  const createHandle = (sessionId: string): AgentLoopHandle => {
    const loopHost = createAgentLoopFromKernelHost(
      {
        store: assembled.host.store,
        sessionAbortControllers: assembled.host.sessionAbortControllers,
      },
      (sid, latch, options) =>
        assembled.run(sid, { latch, ...options })
    );
    return createAgentLoop(loopHost, sessionId);
  };

  return {
    ...assembled,
    preset: 'full',
    loadedModules: [...loaded],
    createHandle,
    close: async () => {
      closeSqlite?.();
      await assembled.close?.();
    },
  };
}
