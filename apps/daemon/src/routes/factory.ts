import {
  ValidationError,
  resolveBotPrincipal,
  type RawAgentRuntime,
} from "@ppeng/agent-core";
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
      pattern: "/api/factory/production/settings",
      handler: (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.production.settings(principal(ctx)),
        }),
    },
    {
      method: "PATCH",
      pattern: "/api/factory/production/settings",
      handler: async (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.production.save(
            principal(ctx),
            await ctx.readBody(),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/production/preflight",
      handler: async (ctx) => {
        const body = await ctx.readBody();
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
          throw new ValidationError("Preflight accepts no overrides");
        json(
          ctx.response,
          200,
          runtime.factory.production.preflight(principal(ctx)),
        );
      },
    },
    {
      method: "GET",
      pattern: "/api/factory/production/runs",
      handler: (ctx) =>
        json(ctx.response, 200, {
          runs: runtime.factory.production.list(principal(ctx)),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/production/runs",
      handler: async (ctx) =>
        json(ctx.response, 201, {
          run: runtime.factory.production.create(
            principal(ctx),
            await ctx.readBody(),
          ),
        }),
    },
    {
      method: "GET",
      pattern: "/api/factory/production/runs/:id",
      handler: (ctx) =>
        json(ctx.response, 200, {
          run: runtime.factory.production.get(
            principal(ctx),
            ctx.requireParam("id"),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/production/runs/:id/assess",
      handler: async (ctx) =>
        json(
          ctx.response,
          200,
          runtime.factory.production.assess(
            principal(ctx),
            ctx.requireParam("id"),
            await ctx.readBody(),
          ),
        ),
    },
    {
      method: "GET",
      pattern: "/api/factory/delivery/tasks/:id/evidence/:digest",
      handler: (ctx) =>
        json(
          ctx.response,
          200,
          runtime.factory.delivery.evidence(
            principal(ctx),
            ctx.requireParam("id"),
            ctx.requireParam("digest"),
            Number(ctx.url.searchParams.get("offset") ?? 0),
          ),
        ),
    },
    {
      method: "GET",
      pattern: "/api/factory/delivery/queue",
      handler: (ctx) =>
        json(ctx.response, 200, {
          queue: runtime.factory.delivery.queue(principal(ctx)),
        }),
    },
    {
      method: "GET",
      pattern: "/api/factory/delivery/tasks/:id",
      handler: async (ctx) =>
        json(ctx.response, 200, {
          delivery: runtime.factory.delivery.current(
            principal(ctx),
            ctx.requireParam("id"),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/delivery/tasks/:id/verify",
      handler: async (ctx) =>
        json(ctx.response, 200, {
          delivery: await runtime.factory.delivery.verifyRemote(
            principal(ctx),
            ctx.requireParam("id"),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/delivery/tasks/:id/grant",
      handler: async (ctx) => {
        const delivery = runtime.factory.delivery.grant(
          principal(ctx),
          ctx.requireParam("id"),
          await ctx.readBody(),
        );
        json(ctx.response, 202, { delivery });
        wake();
      },
    },
    {
      method: "POST",
      pattern: "/api/factory/delivery/tasks/:id/control",
      handler: async (ctx) => {
        const body = (await ctx.readBody()) as { action: string };
        json(ctx.response, 200, {
          delivery: runtime.factory.delivery.control(
            principal(ctx),
            ctx.requireParam("id"),
            body.action,
          ),
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/factory/delivery/tasks/:id/decision",
      handler: async (ctx) => {
        const delivery = runtime.factory.delivery.decide(
          principal(ctx),
          ctx.requireParam("id"),
          await ctx.readBody(),
        );
        json(ctx.response, 202, { delivery });
        wake();
      },
    },
    {
      method: "GET",
      pattern: "/api/factory/delivery/:machine/:repository",
      handler: async (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.delivery.settings(
            principal(ctx),
            ctx.requireParam("machine"),
            ctx.requireParam("repository"),
          ),
        }),
    },
    {
      method: "PATCH",
      pattern: "/api/factory/delivery/:machine/:repository",
      handler: async (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.delivery.save(
            principal(ctx),
            ctx.requireParam("machine"),
            ctx.requireParam("repository"),
            await ctx.readBody(),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/delivery/:machine/:repository/preflight",
      handler: async (ctx) =>
        json(
          ctx.response,
          200,
          await runtime.factory.delivery.preflight(
            principal(ctx),
            ctx.requireParam("machine"),
            ctx.requireParam("repository"),
          ),
        ),
    },
    {
      method: "PATCH",
      pattern: "/api/factory/development/:machine/:repository",
      handler: async (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.development.save(
            principal(ctx),
            ctx.requireParam("machine"),
            ctx.requireParam("repository"),
            await ctx.readBody(),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/development/:machine/:repository/preflight",
      handler: async (ctx) => {
        const input = (await ctx.readBody()) as { baseline: string };
        json(
          ctx.response,
          200,
          await runtime.factory.development.preflight(
            principal(ctx),
            ctx.requireParam("machine"),
            ctx.requireParam("repository"),
            input.baseline,
          ),
        );
      },
    },
    {
      method: "POST",
      pattern: "/api/factory/development/tasks",
      handler: async (ctx) => {
        const task = runtime.factory.development.submit(
          principal(ctx),
          await ctx.readBody(),
        );
        json(ctx.response, 202, { task });
        wake();
      },
    },
    {
      method: "GET",
      pattern: "/api/factory/development/decisions",
      handler: (ctx) =>
        json(ctx.response, 200, {
          tasks: runtime.factory.development.decisions(principal(ctx)),
        }),
    },
    {
      method: "GET",
      pattern: "/api/factory/development/tasks/:id",
      handler: (ctx) =>
        json(ctx.response, 200, {
          task: runtime.factory.development.current(
            principal(ctx),
            ctx.requireParam("id"),
          ),
        }),
    },
    {
      method: "POST",
      pattern: "/api/factory/development/tasks/:id/control",
      handler: async (ctx) => {
        const input = (await ctx.readBody()) as { action: string };
        json(ctx.response, 200, {
          task: await runtime.factory.development.control(
            principal(ctx),
            ctx.requireParam("id"),
            input.action,
          ),
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/factory/development/tasks/:id/decision",
      handler: async (ctx) => {
        const task = runtime.factory.development.decide(
          principal(ctx),
          ctx.requireParam("id"),
          await ctx.readBody(),
        );
        json(ctx.response, 202, { task });
        wake();
      },
    },
    {
      method: "GET",
      pattern: "/api/factory/development/:machine/:repository",
      handler: (ctx) =>
        json(ctx.response, 200, {
          settings: runtime.factory.development.settings(
            principal(ctx),
            ctx.requireParam("machine"),
            ctx.requireParam("repository"),
          ),
        }),
    },
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
