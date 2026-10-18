import { resolveBotPrincipal, type RawAgentRuntime } from "@ppeng/agent-core";
import type { RouteSpec, RouteContext } from "../routing.js";
import { json } from "../http-utils.js";
export function factoryRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  const principal = (ctx: RouteContext) =>
    resolveBotPrincipal(
      runtime.store,
      ctx.auth.user
        ? { userId: ctx.auth.user.id, tenantId: ctx.auth.user.tenantId }
        : undefined,
    );
  const wake = () => {
    void runtime.factory.tick().catch(() => {});
  };
  return [
    {
      method: "GET",
      pattern: "/api/factory/settings",
      handler: (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.settings(principal(ctx)),
        }),
    },
    {
      method: "PATCH",
      pattern: "/api/factory/settings",
      handler: async (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.saveSettings(
            principal(ctx),
            await ctx.readBody(),
          ),
        }),
    },
    {
      method: "GET",
      pattern: "/api/factory/board",
      handler: (ctx) => {
        ctx.response.setHeader("cache-control", "no-store");
        json(ctx.response, 200, runtime.factory.board(principal(ctx)));
      },
    },
    {
      method: "POST",
      pattern: "/api/factory/machines/:id/probe",
      handler: async (ctx) =>
        json(
          ctx.response,
          200,
          await runtime.factory.probe(principal(ctx), ctx.requireParam("id")),
        ),
    },
    {
      method: "POST",
      pattern: "/api/factory/tasks",
      handler: async (ctx) => {
        const task = runtime.factory.submit(
          principal(ctx),
          await ctx.readBody(),
        );
        json(ctx.response, 202, { task });
        wake();
      },
    },
    {
      method: "GET",
      pattern: "/api/factory/tasks/:id",
      handler: (ctx) =>
        json(ctx.response, 200, {
          task: runtime.factory.get(principal(ctx), ctx.requireParam("id")),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/tasks/:id/cancel",
      handler: (ctx) =>
        json(ctx.response, 200, {
          task: runtime.factory.cancel(principal(ctx), ctx.requireParam("id")),
        }),
    },
    {
      method: "GET",
      pattern: "/api/factory/patrol",
      handler: (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.settings(principal(ctx)).patrol,
          state: runtime.factory.patrolState(principal(ctx)),
        }),
    },
    {
      method: "PATCH",
      pattern: "/api/factory/patrol",
      handler: async (ctx) => {
        const body = (await ctx.readBody()) as { enabled: boolean };
        json(ctx.response, 200, {
          settings: runtime.factory.setPatrol(principal(ctx), body.enabled),
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/factory/patrol/run",
      handler: async (ctx) =>
        json(ctx.response, 200, {
          state: await runtime.factory.patrol(principal(ctx)),
        }),
    },
    {
      method: "GET",
      pattern: "/api/factory/evidence",
      handler: (ctx) =>
        json(ctx.response, 200, runtime.factory.pilotEvidence(principal(ctx))),
    },
  ];
}
