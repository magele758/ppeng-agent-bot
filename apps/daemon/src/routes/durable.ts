/**
 * Durable control-plane settings & session durability inspection routes.
 * Settings live in daemon_control KV (`durable_settings`) and take effect immediately.
 */

import {
  defaultDurableSettings,
  NotFoundError,
  ValidationError,
  readDurableSettings,
  rollbackSessionToStep,
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

function sessionDurablePayload(runtime: RawAgentRuntime, sessionId: string) {
  const session = runtime.store.getSession(sessionId);
  if (!session) throw new NotFoundError('Session');
  const runs = runtime.store.durableJournal.listRunsForSession(sessionId, 20);
  const latestRun = runs[0] ?? null;
  const steps = latestRun ? runtime.store.durableJournal.listSteps(latestRun.runId) : [];
  const signals = latestRun ? runtime.store.durableJournal.listSignals(latestRun.runId) : [];
  return {
    sessionId,
    settings: readDurableSettings(runtime.store),
    latestRun,
    runs,
    steps,
    signals,
  };
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
        if (!runtime.store.getSession(sessionId)) throw new NotFoundError('Session');
        const body = ((await ctx.readBody()) ?? {}) as { stepId?: string; force?: boolean; reason?: string };
        const result = await rollbackSessionToStep(runtime.store, runtime.workspaceTx, {
          sessionId,
          stepId: typeof body.stepId === 'string' ? body.stepId : undefined,
          force: body.force === true,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
        json(ctx.response, result.blockedByPivot ? 409 : 200, result);
      },
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/durable/fork',
      handler: async (ctx) => {
        const sessionId = ctx.requireParam('id');
        if (!runtime.store.getSession(sessionId)) throw new NotFoundError('Session');
        const body = ((await ctx.readBody()) ?? {}) as { stepId?: string; title?: string };
        const boundarySeq = resolveForkBoundarySeq(runtime, sessionId, body.stepId);
        const result = runtime.forkSession(sessionId, {
          boundarySeq,
          title: typeof body.title === 'string' ? body.title : undefined,
        });
        json(ctx.response, 201, result);
      },
    },
  ];
}

function resolveForkBoundarySeq(runtime: RawAgentRuntime, sessionId: string, stepId: unknown): number | undefined {
  if (typeof stepId !== 'string' || !stepId) return undefined;
  const step = runtime.store.durableJournal.getStep(stepId);
  if (!step || step.sessionId !== sessionId) return undefined;
  return step.messageSeq;
}
