# Raw Agent SDK

**English** | [README 中文](README.zh.md)

Node.js multi-agent runtime in the spirit of Claude Code: **local daemon** (HTTP API), **CLI**, **Agent Lab** (Next.js web console), **SQLite** state, task/workspace isolation, approvals, team orchestration, **self-heal**, **Evolution** (RSS → inbox → worktree → tests → optional merge), and **optional** vision routing, MCP (stdio), and capability gateway integrations.

Use it as a local Agent workspace, embed its loop in your own application, or follow the source to learn how an Agent harness works. The reusable loop lives in `packages/agent-loop`; `packages/core` connects it to product storage, tools, policies, and services.

## Choose your path

| I want to… | Start here | Continue with |
|------------|------------|---------------|
| Run the product | [Quick start](#quick-start) | [Agent Lab](#agent-lab-web-console) |
| Understand how an Agent works | [Harness guide](doc/harness/README.md) | [From-zero tutorial](doc/harness/from-zero/README.md), then topic deep-dives |
| Embed just the loop | [Agent Loop package](packages/agent-loop/README.md) | [SDK guide: presets, host ports, lifecycle](skills/agent-loop/SKILL.md) |
| Embed the product runtime | [Core SDK](packages/core/README.md) | [Embedding guide](doc/EMBEDDING_SDK.md) |
| Change or debug the code | [AGENTS.md](AGENTS.md) | [Architecture](doc/ARCHITECTURE.md) · [Testing](doc/TESTING.md) |
| Deploy or explore advanced features | [Documentation index](doc/README.md) | [Deployment](doc/DEPLOYMENT.md) · [Evolution](doc/evolution/README.md) |

The Harness tutorial is currently in Chinese. This README is the overview; the [documentation index](doc/README.md) is the reference catalog.

## How the pieces fit

```text
Agent Lab / CLI → daemon HTTP / SSE
                       ↓
          RawAgentRuntime (product host, packages/core)
                       ↓  injected model / tools / storage / hooks
          createAssembledLoop (packages/agent-loop, default: max)
                       ↓
          turn kernel → prepare context → model → tools → next turn
```

This is a self-built loop, now extracted into an embeddable SDK—not a wrapper around `@openai/agents`. The product defaults to `kernelVariant=agent-loop` and `assemblyPreset=max`; the local `ppeng` kernel remains an explicit reference option. Selection is persisted through Lab settings (`GET/PATCH /api/loop/settings`). See the [execution-path guide](doc/harness/00-self-built-agent-loop.md).

SDK presets are `mini / normal / full / max`. Browser and extension hosts must use the `/mini` entry, not the Node-oriented root/full/max entries. The workspace package is `@ppeng/agent-loop`; its public package name is `@mage-ai-lab/agent-loop`.

---

## Highlights

| Area | What you get |
|------|----------------|
| **Runtime** | `RawAgentRuntime`: sessions, tasks, tools, approvals, workspaces (`git worktree` or directory copy), background jobs, mailbox (teammates), trace events, prompt-cache–friendly system prefixes |
| **Models** | `heuristic` (no keys), `openai-compatible`, `anthropic-compatible`; optional **hybrid VL router** + `vision_analyze`; optional `RAW_AGENT_USE_JSON_MODE=0` for picky providers |
| **Tools** | File read/write/edit, `bash`, todos, harness specs, subagents/teammates, mailbox, `bg_run`, skills, optional **glob** / **web_fetch** / **MCP stdio** / hooks / LSP / OpenTelemetry hooks |
| **Skills** | Repo `skills/**/SKILL.md` + optional `~/.agents/**/SKILL.md` merge; **skill router** (`legacy` / `hybrid`); **Guided learning** (coaching mode) |
| **Self-heal** | Isolated worktree, whitelist tests, optional merge + daemon restart handshake |
| **Evolution** | `evolution:learn` (RSS → inbox + digest skill) + `evolution:run-day` (research → agent → build → test; merge with mutex when `AUTO_MERGE=1`) |
| **Web** | Next.js 15 App Router: playground (SSE, thinking, tools, Markdown), teams graph, traces, mailbox, approvals; Ops **Swarm**; More **Orchestration / Memory**; `/api/*` proxied to daemon |
| **2.0 slices** | **Agent memory** (five layers), **Swarm** (`pipeline` executor), **Orchestration** engine, **DeepResearch** pipeline MVP; optional `RAW_AGENT_AUTH_TOKEN` |

---

## Packages & apps

| Path | Role |
|------|------|
| `packages/agent-loop` (`@ppeng/agent-loop`) | Embeddable turn kernel, assembly presets, model/tool loop, session control; [SDK guide](skills/agent-loop/SKILL.md) |
| `packages/api-types` | Shared API types |
| `packages/core` (`@ppeng/agent-core`) | Runtime, storage, adapters, tools, workspaces, self-heal policy, traces, skills; usable standalone as an **embeddable SDK** — see [`packages/core/README.md`](packages/core/README.md) / [`doc/EMBEDDING_SDK.md`](doc/EMBEDDING_SDK.md) |
| `packages/capability-gateway` | Optional bridge (e.g. IM channels, config); used by `evolution:learn` feeds |
| `apps/daemon` | HTTP API, scheduler, static stub for `/`; **use Next for UI** |
| `apps/cli` | `chat`, `send`, tasks, approvals, **self-heal**, daemon restart ack |
| `apps/web-console` | Agent Lab (Next.js) |
| `apps/desktop` | **Desktop Client** (Electron; macOS arm64, Windows and Linux × x64 / arm64) |

---

## Quick start

Prerequisites: Node.js 22+ with SQLite FTS5 support, and npm. Run these commands from the repository root:

```bash
npm install
npm run build
npm run dev
```

Open the **Agent Lab URL printed in the terminal**. Configure a provider (Base URL / API Key) in chat's model settings, discover models, then select one and send a message. No `.env` copy is required for this UI-first setup.

The dev launcher selects available ports and wires the proxy automatically; chosen addresses are also saved to `.agent-state/dev-lab.ports.json`. Without overrides, preferred ports are 23000 (Lab) and 27070 (daemon), with fallback on conflicts. Do not assume a fixed port from an older example.

For a no-key smoke check, use the isolated heuristic eval after building:

```bash
npm run agent:eval:fast -- --exit-on-fail
```

This verifies HTTP capabilities, not real-model answer quality. For CLI/HTTP walkthroughs, continue with the [from-zero tutorial](doc/harness/from-zero/README.md). To start Next separately, set `DAEMON_PROXY_TARGET` to the actual daemon address; production UI commands are `npm run build:web-console` and `npm run start:web-console`.

### Desktop Client (macOS / Windows / Linux)

Electron app that bundles daemon + Lab. Local pack matches this machine:

```bash
npm run build:desktop
# Output: apps/desktop/release/RawAgent-<version>-<os>-<arch>.{dmg,exe,AppImage}
```

CI builds five artifacts (macOS arm64, plus Windows and Linux × x64/arm64) daily at 17:00 UTC (01:00 Beijing), via Actions → **Desktop artifacts**, a `desktop-v*` tag (no GitHub Release), or a `v*` tag. Intel Mac (darwin x64) is not built. See [`doc/CI.md`](doc/CI.md) and [`apps/desktop/README.md`](apps/desktop/README.md).

---

## Guidance for AI coding agents

If you are an **automated coding agent** (Cursor, Codex, Claude Code, etc.) working in this repo:

1. **Read [`AGENTS.md`](AGENTS.md) first** — workspace conventions, env vars, Evolution/self-heal/web-console notes, and operational gotchas.
2. **Where code lives**: loop SDK → `packages/agent-loop`; product host & integrations → `packages/core`; HTTP API → `apps/daemon`; Agent Lab → `apps/web-console`; Evolution → `scripts/evolution*`.
3. **After edits**: `npm run test:unit` for logic; `npm run build` for TypeScript across packages. UI/E2E → `doc/TESTING.md`, `npm run test:e2e` when relevant.
4. **Secrets & config**: prefer Lab UI and persisted settings APIs for supported options; avoid adding feature-switch env vars. Use [`.env.example`](.env.example) for necessary connection/bootstrap or CI fallback configuration; **never commit `.env`**. Env changes require process restart; consult each settings API for its effective scope.
5. **Evolution**: `npm run evolution -- --help` for flags (`--learn`, `--agent`, `--review`, `--until-empty`, `--research`, `--test-agent`, …). Optional full drain + showcase: `npm run evolution:drain-showcase -- --help`. Inbox processing defaults to the **「今日新条目」** section (see README Evolution section below).
6. **Spawning / sandbox**: new subprocess code must use `sanitizeSpawnEnv()` and existing sandbox helpers (`packages/core/src/sandbox.ts`, `SandboxManager`) — not raw `spawn` with full parent env.
7. **Skills**: `skills/**/SKILL.md`; optional merge with `~/.agents/**/SKILL.md` (details in `AGENTS.md`).
8. **Loop SDK changes**: update [`skills/agent-loop/SKILL.md`](skills/agent-loop/SKILL.md) alongside SDK contracts, and run both `npm run test --workspace=@ppeng/agent-loop` and `npm run build --workspace=@ppeng/agent-loop`. Root `test:unit` does not replace the SDK's Vitest suite.

Deeper architecture: [`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md).

---

## npm scripts (reference)

| Script | Description |
|--------|-------------|
| `npm run build` | TypeScript workspace build + Next production build |
| `npm run test` | build + unit tests |
| `npm run test:unit` | unit tests only |
| `npm run test:regression` | temp daemon HTTP regression |
| `npm run test:e2e` | temp daemon + Playwright (Agent Lab) |
| `npm run test:e2e:install` | Playwright Chromium |
| `npm run test:remote` | real-model smoke (needs env; skipped if unset) |
| `npm run agent:eval:fast -- --exit-on-fail` | Isolated heuristic daemon; HTTP capability checks, nonzero on failure |
| `npm run test --workspace=@ppeng/agent-loop` | Loop SDK Vitest suite |
| `npm run ci` | build + unit + formal + fast eval + quality-engine simulation + package smoke + CRAP gate + regression + integration + e2e |
| `npm run start:daemon` / `start:supervised` | daemon / supervisor |
| `npm run start:cli` | CLI (`self-heal`, `chat`, …) |
| `npm run dev:lab` | dev helper (Next + daemon proxy) |
| `npm run evolution -- --help` | unified evolution entry, see all options |
| `npm run evolution -- --learn --agent cursor --review codex` | learn + cursor implement + codex review |
| `npm run evolution -- --learn-only` | pull RSS → inbox only |
| `npm run evolution:pipeline` | learn → run-day → optional post-merge reload (one-shot) |
| `npm run ai:tools` | check external CLIs (`claude`, `codex`, …) |

See [`doc/TESTING.md`](doc/TESTING.md), [`doc/CI.md`](doc/CI.md), [`.env.example`](.env.example).

---

## Agent Lab (web console)

- **Jev integration**: optional host-side semantic decisions, independent profiles, PTC helpers, and traces. See the [Jev integration guide](doc/JEV_INTEGRATION.md) (Chinese); off by default, configured in More → Jev.
- **Model setup**: chat 「配置模型」 for Base URL / API Key, then auto-discover model names. Demo: [doc/lab/lab-model-setup-autodiscover.mp4](doc/lab/lab-model-setup-autodiscover.mp4)
- **Playground**: streaming (SSE), thinking blocks, tool results, Markdown
- **Sessions / tasks / teams**: mailbox graph, mail flow
- **Traces**: reads `stateDir/traces/.../events.jsonl`
- **Approvals / background jobs / workspaces**

Daemon API examples: `GET /api/version`, `GET /api/health`, `GET /api/traces?sessionId=...` — full list in `apps/daemon/src/server.ts`.

---

## Evolution (continuous learning)

Unified entry: `npm run evolution -- [options]` (run `--help` for all flags).

**Typical split-command loop** (learn → run-day batch → Pages showcase): fixed three-step sequence in [`doc/evolution/README.md`](doc/evolution/README.md).

**Flywheel planning**: current Evolution direction, capability gaps, Agent scheduler mode, and redeploy regression gate are tracked in [`doc/evolution-flywheel-review.md`](doc/evolution-flywheel-review.md).

**Common combinations:**

| Command | Description |
|---------|-------------|
| `npm run evolution -- --learn-only` | Pull RSS → inbox only, no dev |
| `npm run evolution -- --learn --agent claude` | learn + Claude implement (default) |
| `npm run evolution -- --learn --agent cursor` | learn + Cursor composer-2-fast |
| `npm run evolution -- --learn --agent cursor --review codex` | learn + Cursor implement + Codex review |
| `npm run evolution -- --learn --agent cursor --review cursor` | learn + Cursor full pipeline |
| `npm run evolution -- --learn --agent cursor --model claude-opus-4-7-thinking-max --review cursor` | learn + Cursor Opus-Max implement & review |
| `npm run evolution -- --learn --agent full` | learn + research → multi-CLI routing by difficulty |
| `npm run evolution -- --learn --agent cursor --review codex --concurrency 5 --merge` | 5 parallel worktrees + auto-merge |
| `npm run evolution -- --pipeline-build --learn --agent cursor --review codex` | build gateway + learn + dev |

**Selected flags** (use `--help` for the complete, current list):

```
--learn                  pull RSS → inbox first
--learn-only             learn only, skip dev
--pipeline-build         build capability-gateway before learn
--agent cursor|claude|codex|full|multi   implement agent (default: claude)
--model <name>           cursor agent model (default: composer-2-fast)
--review cursor|codex|none   review agent (default: none)
--review-model <name>    review model (default: same as --model)
--concurrency <n>        parallel worktrees (limits shown by --help)
--items <n>              max inbox items to process
--merge                  auto-merge on passing tests
--target-branch <b>      merge target branch (default: main)
--skip-rebase            skip post-test rebase
```

**Runtime behavior and troubleshooting:**

- `run-day` now executes the **“今日新条目”** section from the inbox by default; the rolling reference section is display-only and is not re-queued, which avoids duplicate links sharing one worktree under high concurrency.
- When Cursor is selected, the CLI runs `agent --list-models` up front; unsupported model IDs fail fast before learn / research starts.
- The research gate is intentionally conservative now: missing excerpts, unsupported Cursor models, or outputs that clearly contain `SKIP:` will be skipped instead of silently defaulting to `PROCEED`.
- Review / rebase / merge failures try to keep the experiment branch around for manual takeover. Check `doc/evolution/failure/` for the matching record, then inspect the local `exp/evolution-*` branch.
- If `evolution:learn` shows widespread RSS failures, check proxy / DNS / TLS first. A `news.ycombinator.com` certificate mismatch usually points to local network or proxy interception rather than repo code.

`npm run evolution:pipeline` (bash one-shot: build→learn→run-day→optional reload) and the low-level `evolution:learn` / `evolution:run-day` scripts are still available. For advanced fine-grained tuning (plan, test-agent, review rounds, etc.) see `scripts/evolution-quality-pipeline.env.example` and `.env.example`.

---

## Self-heal

After `npm run start:daemon` (or supervised flow):

```bash
npm run start:cli -- self-heal start '{"testPreset":"unit","autoMerge":false}'
```

Scheduler runs whitelist tests in an isolated worktree; failures can drive a **self-healer** session. Optional `autoMerge` / `autoRestartDaemon` with `GET /api/daemon/restart-request` + `POST .../ack`. See [`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md).

---

## Core capabilities (summary)

- SQLite persistence: agents, sessions, messages, tasks, events, approvals, workspaces, mailbox, background jobs, self-heal runs, daemon control
- Team model: main / planner / researcher / implementer / reviewer / **self-healer** + spawnable teammates
- **Stable vs dynamic system prompt** split for KV cache (see `doc/PROMPT_CACHE.md`)
- **Image assets**: hot/warm/cold, contact sheet, `vision_analyze`
- **Optional external AI tools** (`RAW_AGENT_EXTERNAL_AI_TOOLS=1`): `claude_code`, `codex_exec`, `cursor_agent` with approval — see [`doc/EXTERNAL_AI_CLI.md`](doc/EXTERNAL_AI_CLI.md)

---

## Configuration

Start with **Lab UI + persisted settings** for model providers and supported runtime policies. For example, loop selection and steering settings use `GET/PATCH /api/loop/settings`. Persistence, override precedence, and whether a change affects the next request or run are defined by each settings API—not by one global env rule.

Environment variables remain useful for secrets/upstream connections, process bootstrap, and CI/eval fallbacks where supported. The list below is a reference, not a checklist of required switches:

- **Core**: `RAW_AGENT_STATE_DIR`, `RAW_AGENT_DAEMON_HOST`, `RAW_AGENT_DAEMON_PORT`, `RAW_AGENT_MODEL_PROVIDER`, `RAW_AGENT_MODEL_NAME`, `RAW_AGENT_API_KEY`, `RAW_AGENT_BASE_URL`, `RAW_AGENT_ANTHROPIC_URL`, `RAW_AGENT_USE_JSON_MODE`, `RAW_AGENT_MEMORY_BACKEND`, optional `RAW_AGENT_AUTH_TOKEN`, optional Lab OAuth `RAW_AGENT_OAUTH_*`
- **Vision**: `RAW_AGENT_VL_*`, image limits — see `doc/ARCHITECTURE.md` and `.env.example`
- **Evolution / self-heal / skills / gateway**: see `AGENTS.md` and `.env.example`

---

## Documentation

**Full index:** [`doc/README.md`](doc/README.md) (bilingual table of all handbook docs).

| Doc | Content |
|-----|---------|
| [Harness guide](doc/harness/README.md) · [From-zero tutorial](doc/harness/from-zero/README.md) | Reading route: request → loop → model/tools → state → validation |
| [Agent Loop SDK guide](skills/agent-loop/SKILL.md) | Presets, host contracts, step/run/steer/fold, SDK development |
| [Jev integration](doc/JEV_INTEGRATION.md) | Lab setup, profiles, 12 insertion-point IDs and wiring status, PTC, fallbacks, traces |
| [`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md) | Modules, scheduler, APIs, tools (see `doc-sync-tools`) |
| [`doc/ENV_REFERENCE.md`](doc/ENV_REFERENCE.md) | Environment variable reference |
| [`doc/TESTING.md`](doc/TESTING.md) · [`doc/CI.md`](doc/CI.md) | Test matrix · GitHub Actions |
| [`doc/MEMORY_MULTIUSER.md`](doc/MEMORY_MULTIUSER.md) | Memory layers, `RAW_AGENT_MEMORY_BACKEND`, `/api/memory` |
| [`doc/TEAMS_SWARM.md`](doc/TEAMS_SWARM.md) | Swarm runs/tasks, `SwarmExecutor`, Lab Ops panel |
| [`doc/AGENT_ORCHESTRATOR.md`](doc/AGENT_ORCHESTRATOR.md) | Orchestration runs/steps/events, engine tick |
| [`doc/DEEP_RESEARCH.md`](doc/DEEP_RESEARCH.md) | Research tasks, pipeline, HTTP run trigger |
| [`doc/DOMAIN_AGENTS.md`](doc/DOMAIN_AGENTS.md) · [`doc/A2UI.md`](doc/A2UI.md) | Domain bundles · A2UI surfaces |
| [`doc/SELF_EVOLUTION_V2.md`](doc/SELF_EVOLUTION_V2.md) · [`doc/evolution/README.md`](doc/evolution/README.md) | Evolution 2.0 · learn/run-day loop |
| [`doc/DEPLOYMENT.md`](doc/DEPLOYMENT.md) · [`doc/HARNESS_EVAL.md`](doc/HARNESS_EVAL.md) | Deploy · `agent:eval` harness |
| [`doc/ROADMAP.md`](doc/ROADMAP.md) | Long-term roadmap (P0–P4) |
| [`AGENTS.md`](AGENTS.md) | Conventions for coding agents in this repo |

---

## CI

`npm run ci` runs build, unit, formal, fast contract eval, quality-engine simulation, tarball installation smoke, CRAP, HTTP regression, integration, and E2E checks. See [`package.json`](package.json) and [CI](doc/CI.md). npm and Docker publication require the release gate and test the actual artifacts before publishing. See the [reliability plan](doc/RELEASE_RELIABILITY_PLAN.md) for deployment boundaries and [harness evaluation](doc/HARNESS_EVALUATION.md) for paired real-model feature/prompt regression. Simulation is not capability evidence. Optional **remote model smoke** requires credentials; fork PRs do not receive upstream secrets.

---

## Security & privacy

- **`.env` is listed in `.gitignore`** — do not commit API keys, tokens, or Feishu secrets. Use `.env.example` as a template only.
- **Rotate keys** if they were ever committed, pasted in issues, or shared in logs.
- **Gateway** (`gateway.config.json`): keep `bridgeSecret` and any channel tokens out of Git; use `gateway.config.example.json` as reference.
- **CI**: fork PRs cannot read upstream secrets; remote smoke is skipped safely.
- **Daemon**: configure `RAW_AGENT_CORS_ORIGIN` for browser clients; set `RAW_AGENT_AUTH_TOKEN` (Bearer) in production; avoid exposing an unauthenticated daemon to untrusted networks. Optional Lab login: `RAW_AGENT_OAUTH_GOOGLE_*` / `RAW_AGENT_OAUTH_GITHUB_*` (see `.env.example`).

---

## License

This project is **private** (`package.json`). Add a SPDX license file if you open-source it later.
