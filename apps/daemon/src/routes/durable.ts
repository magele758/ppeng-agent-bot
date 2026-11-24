/**
 * Durable control-plane settings, inspection, rollback, fork, signal delivery,
 * and operator reconcile routes.
 * Settings live in daemon_control KV (`durable_settings`) and take effect immediately.
 */

import {
  buildSyntheticStepContext,
  defaultDurableSettings,
  NotFoundError,
  ValidationError,
  readDurableSettings,
  reconcileSessionUnknownSteps,
  resolveDurableStepManually,
  rollbackSessionToStep,
  wakeReadyParkedRun,
  writeDurableSettings,
  type DurableSettingsPatch,
  type RawAgentRuntime,
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

function settingsPayload(runtime: RawAgentRuntime) {
  return {
    settings: readDurableSettings(runtime.store),
    defaults: defaultDurableSettings(),
  };
}

function latestRunArtifacts(runtime: RawAgentRuntime, latestRun: { runId: string } | null) {
  if (!latestRun) return { steps: [], signals: [], childRuns: [] };
  const journal = runtime.store.durableJournal;
  return {
    steps: journal.listSteps(latestRun.runId),
    signals: journal.listSignals(latestRun.runId),
    childRuns: journal.listChildRuns(latestRun.runId),
  };
}

function sessionDurablePayload(runtime: RawAgentRuntime, sessionId: string) {
  const session = runtime.store.getSession(sessionId);
  if (!session) throw new NotFoundError('Session');
  const runs = runtime.store.durableJournal.listRunsForSession(sessionId, 20);
  const latestRun = runs[0] ?? null;
  const { steps, signals, childRuns } = latestRunArtifacts(runtime, latestRun);
  return {
    sessionId,
    settings: readDurableSettings(runtime.store),
    latestRun,
    runs,
    steps,
    signals,
    childRuns,
  };
}

function resolveForkBoundarySeq(runtime: RawAgentRuntime, sessionId: string, stepId: unknown): number | undefined {
  if (typeof stepId !== 'string' || !stepId) return undefined;
  const step = runtime.store.durableJournal.getStep(stepId);
  if (!step || step.sessionId !== sessionId) return undefined;
  return step.messageSeq;
}

function requireExistingSession(runtime: RawAgentRuntime, sessionId: string): void {
  if (!runtime.store.getSession(sessionId)) throw new NotFoundError('Session');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseRollbackBody(body: unknown): { stepId?: string; force: boolean; reason?: string } {
  const rec = (body ?? {}) as Record<string, unknown>;
  return {
    stepId: optionalString(rec.stepId),
    force: rec.force === true,
    reason: optionalString(rec.reason),
  };
}

function resolveSignalRunId(
  runtime: RawAgentRuntime,
  sessionId: string,
  explicit: unknown
): string | undefined {
  return optionalString(explicit) ?? runtime.store.durableJournal.getLatestRunForSession(sessionId)?.runId;
}

function parseSignalBody(
  runtime: RawAgentRuntime,
  sessionId: string,
  body: unknown
): { runId: string; stepId: string; signalName: string; signalKey: string; payload: unknown } {
  const rec = (body ?? {}) as Record<string, unknown>;
  const runId = resolveSignalRunId(runtime, sessionId, rec.runId);
  const stepId = optionalString(rec.stepId);
  const signalName = optionalString(rec.signalName);
  const signalKey = optionalString(rec.signalKey);
  if (![runId, stepId, signalName, signalKey].every(Boolean)) {
    throw new ValidationError('runId/latestRun, stepId, signalName, and signalKey are required');
  }
  return {
    runId: runId!,
    stepId: stepId!,
    signalName: signalName!,
    signalKey: signalKey!,
    payload: rec.payload ?? null,
  };
}

function parseResolveBody(body: unknown): { decision: 'committed' | 'not_applied'; note?: string } {
  const rec = (body ?? {}) as Record<string, unknown>;
  if (rec.decision !== 'committed' && rec.decision !== 'not_applied') {
    throw new ValidationError('decision must be committed or not_applied');
  }
  return { decision: rec.decision, note: optionalString(rec.note) };
}

export function durableRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/durable/settings',
      handler: ({ response }) => {
        json(response, 200, settingsPayload(runtime));
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/durable/settings',
      handler: async (ctx) => {
        const patch = (await ctx.readBody()) as DurableSettingsPatch | undefined;
        try {
          writeDurableSettings(runtime.store, patch ?? {});
        } catch (error) {
          throw new ValidationError(error instanceof Error ? error.message : String(error));
        }
        json(ctx.response, 200, settingsPayload(runtime));
      },
    },
    {
      method: 'GET',
      pattern: '/api/sessions/:id/durable',
      handler: (ctx) => {
        const sessionId = ctx.requireParam('id');
        json(ctx.response, 200, sessionDurablePayload(runtime, sessionId));
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/durable/rollback',
      handler: async (ctx) => {
        const sessionId = ctx.requireParam('id');
        requireExistingSession(runtime, sessionId);
        const parsed = parseRollbackBody(await ctx.readBody());
        const result = await rollbackSessionToStep(runtime.store, runtime.workspaceTx, {
          sessionId,
          stepId: parsed.stepId,
          force: parsed.force,
          reason: parsed.reason,
          tools: runtime.tools,
          buildContext: (step) =>
            buildSyntheticStepContext({
              store: runtime.store,
              sessionId,
              repoRoot: runtime.repoRoot,
              stateDir: runtime.stateDir,
              step,
            }),
        });
        json(ctx.response, result.blockedByPivot ? 409 : 200, result);
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/durable/fork',
      handler: async (ctx) => {
        const sessionId = ctx.requireParam('id');
        requireExistingSession(runtime, sessionId);
        const body = ((await ctx.readBody()) ?? {}) as { stepId?: string; title?: string };
        const boundarySeq = resolveForkBoundarySeq(runtime, sessionId, body.stepId);
        const result = runtime.forkSession(sessionId, {
          boundarySeq,
          title: optionalString(body.title),
        });
        json(ctx.response, 201, result);
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/durable/signals',
      handler: async (ctx) => {
        const sessionId = ctx.requireParam('id');
        requireExistingSession(runtime, sessionId);
        const input = parseSignalBody(runtime, sessionId, await ctx.readBody());
        const delivery = runtime.store.durableJournal.deliverSignal(input);
        const woke = wakeReadyParkedRun(runtime.store.durableJournal, input.runId);
        json(ctx.response, 200, { ...delivery, woke: woke.woke, wokeStepIds: woke.wokeStepIds });
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/durable/reconcile',
      handler: async (ctx) => {
        const sessionId = ctx.requireParam('id');
        requireExistingSession(runtime, sessionId);
        const result = await reconcileSessionUnknownSteps({
          store: runtime.store,
          sessionId,
          repoRoot: runtime.repoRoot,
          stateDir: runtime.stateDir,
          tools: runtime.tools,
        });
        json(ctx.response, 200, result);
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/durable/steps/:stepId/resolve',
      handler: async (ctx) => {
        const sessionId = ctx.requireParam('id');
        const stepId = ctx.requireParam('stepId');
        requireExistingSession(runtime, sessionId);
        const parsed = parseResolveBody(await ctx.readBody());
        const result = resolveDurableStepManually(runtime.store, {
          sessionId,
          stepId,
          decision: parsed.decision,
          note: parsed.note,
        });
        json(ctx.response, result.ok ? 200 : 404, result);
      },
    },
  ];
}
