# Domain Agent bundles

A **domain bundle** packages a domain-specific persona stack (agents + tools + optional skills) on top of the core runtime. The daemon runs a single process that hosts the core agents *and* any mounted domain bundles; users switch personas in the Agent Lab dropdown, and the runtime scopes each persona's tool list via `AgentSpec.allowedTools`.

This project ships two reference bundles:

| Bundle | Package | Personas | Tools |
| --- | --- | --- | --- |
| SRE | `@ppeng/agent-sre` | `sre-oncall`, `sre-postmortem` | `prom_query`, `loki_query`, `k8s_get`, `pagerduty_list` (all read-only) |
| Stock | `@ppeng/agent-stock` | `stock-analyst`, `stock-screener` | `quote_get`, `fundamentals_get`, `news_search` (multi-provider) |

## Quick start

```
# .env
RAW_AGENT_DOMAINS=sre,stock

# SRE config
SRE_PROM_URL=http://prometheus:9090
SRE_LOKI_URL=http://loki:3100
SRE_KUBECONFIG=/Users/me/.kube/config
SRE_PAGERDUTY_TOKEN=...

# Stock config (mock works without any keys for local / CI)
STOCK_QUOTE_PROVIDER=yahoo  # yahoo | alphavantage | mock
STOCK_API_KEY=...           # required when provider=alphavantage
```

Restart the daemon. New personas appear under their domain group in the Agent Lab agent selector.

## Architecture

```
RawAgentRuntime (core)
  ├── builtinAgents  (general / main / planner / ...)
  ├── builtin tools  (read_file / bash / web_fetch / ...)
  ├── extraAgents    ← merged from mounted bundles
  ├── extraTools     ← merged from mounted bundles
  └── extraSkills    ← merged from mounted bundles

apps/daemon
  └── domain-loader.ts
        ├─ reads RAW_AGENT_DOMAINS=sre,stock
        ├─ static-imports each bundle
        └─ mergeDomainBundles() → extraAgents/extraTools/extraSkills
```

Per-turn tool filtering happens inside `RawAgentRuntime._runSessionInner`:

```ts
const turnTools = agent.allowedTools && agent.allowedTools.length > 0
  ? externallyGated.filter((t) => agent.allowedTools!.includes(t.name))
  : externallyGated;
```

So `sre-oncall` only sees SRE + safe-read tools, never the stock tools and never `bash`.

## Writing a new domain bundle (5 steps)

1. **Create the package**
   ```
   packages/agent-<id>/
     package.json            # peerDep @ppeng/agent-core
     tsconfig.json           # extends ../../tsconfig.base.json, references ../core
     src/
       index.ts              # export const <id>Bundle: DomainBundle
       agents.ts             # AgentSpec[]
       skills.ts             # SkillSpec[] with content body
       tools/
         <each>.ts           # ToolContract<Args>
   ```

2. **Define personas (`agents.ts`)** — set `domainId: '<id>'` and an explicit `allowedTools` list so the persona is correctly scoped.

3. **Implement tools (`tools/<name>.ts`)** — each is a `ToolContract<Args>`. Read env at execute time; return `{ ok: false, content: '<VAR> is not configured' }` rather than throwing when env is missing. Use `approvalMode: 'never'` for read-only ops; `approvalMode: 'always'` for mutating ops.

4. **Optional skill (`skills.ts`)** — embed the runbook/playbook as a string literal so it ships with the bundle (no filesystem dependency). Include `triggerWords` so the skill router auto-suggests it.

5. **Wire into the shared domain manifest + daemon loader**:
   - Add an entry to repo-root [`domains.manifest.json`](../domains.manifest.json) (`id` / `npmName` / `path` / `bundleExport`).
   - Static-import the bundle in `apps/daemon/src/domain-loader.ts` and add it to `REGISTRY` (keys must match the manifest; drift throws at load).
   - Add the package to `apps/daemon/package.json` dependencies and `apps/daemon/tsconfig.json` references, plus root `test:unit` globs.

   Root `pnpm run build`, Docker daemon image, and `scripts/prepare-desktop-server.mjs` all read the same manifest — do not hardcode domain package lists elsewhere.

That's it — the runtime mounts the bundle, the agent selector groups it, and the skill router routes its skills.

## Reference: bundle interface

```ts
import type { AgentSpec, SkillSpec, ToolContract } from '@ppeng/agent-core';

export interface DomainBundle {
  id: string;                       // 'sre' | 'stock' | ...
  label: string;                    // 'SRE Agent'
  agents: AgentSpec[];
  tools: ToolContract<any>[];
  skills?: SkillSpec[];
}
```

`mergeDomainBundles(bundles)` deduplicates by `agent.id` / `tool.name` / `skill.name` (first wins), and stamps `agent.domainId` from `bundle.id` when not explicitly set by the author.

## Operational notes

- **Env-missing tools return `ok: false` with a clear message** — agents see `"SRE_PROM_URL is not configured."` rather than a network error, so they can ask the user instead of looping.
- **Mutating ops require explicit approval** — when adding `k8s_apply` / `pagerduty_ack` / `place_order` style tools later, set `approvalMode: 'always'`. The core approval flow + Agent Lab UI take care of the rest.
- **Provider switch for stock** — `STOCK_QUOTE_PROVIDER=mock` makes the stock tools deterministic and offline-safe (used by CI).
- **Per-agent budget** — `AgentSpec.allowedTools` is the cleanest place to enforce least-privilege; restrict heavy/risky tools (e.g. `bash`, `write_file`) for personas that don't need them.

## Testing checklist

- Unit: every tool has at least one mocked-fetch test (URL shape + headers) and one missing-env test.
- Domain loader: `loadDomainBundles({ RAW_AGENT_DOMAINS: '...' })` returns the expected `ids` / `unknown` / `merged.agents` shape.
- Smoke: `RAW_AGENT_DOMAINS=<id>` daemon → `GET /api/agents` exposes the new personas with `domainId` set.
