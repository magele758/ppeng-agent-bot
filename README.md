# Raw Agent

**English** | [简体中文](README.zh.md)

> **"You own the goal. Your Bot works around the clock."**
>
> Start with a persistent AI Bot that learns how you work, manages incoming context, turns one-off wins into ongoing routines, and pauses only when human judgment is needed—powered underneath by a self-built, zero-wrapper **Agent Loop SDK (`@mage-ai-lab/agent-loop`)** and **Multi-Agent Host Runtime (`@ppeng/agent-core`)**.

`Node.js >= 22` · `pnpm 10.29.2` · `SDK: @mage-ai-lab/agent-loop` · `481 Shipped Specs / 2,347 Gated Criteria` · `Web · Desktop · CLI · Embeddable SDK`

---

## Why Raw Agent?

Most agent frameworks hand you raw plumbing—sessions, skills, MCP servers, subagent graphs—and force *you* to act as the systems integrator every single time you want work done. **Raw Agent internalizes the orchestration tax for everyday users while keeping every gear inspectable and embeddable for engineers:**

1. **Bot-First Workspace, Zero Orchestration Tax**: Every Bot has a persistent identity, expressive live avatar, per-Bot model & thinking-effort pin, private memory, scoped skills, and one canonical conversation thread. Your built-in **Super Bot** inspects the roster, delegates tasks to specialist Bots under *their* own permissions, and synthesizes outcomes—no workflow wiring required to get started.
2. **Conversation · Goal · Execution Separation (Never "Trust Me, I'm Done")**: Finishing a model turn is *not* goal completion. Goals move through an 8-state lifecycle (`queued / running / waiting / blocked / paused / completed / failed / cancelled`), deliverables are versioned as immutable snapshots, and completion requires independent verification against files, builds, or real connector receipts.
3. **One Verified Deliverable → Ongoing Routine**: Turn any finished task into a cron or event-driven **Routine** in one click—complete with **"notify only on diff"**, missed-run catch-up, and optional pre-send human approval so recurring briefings and checks run without daily re-prompting or empty notification noise.
4. **Multi-Bot Rooms Without the Chatter**: Group Rooms use **Agentic Sparse-MoE** selection so only relevant specialists speak (including zero-reply when none clear the bar), or switch seamlessly into **Task Collaboration Mode** (lead coordinator + public evidence rollup) and **Structured Debate Mode** (multi-round rebuttals + judge verdict).
5. **Two Products in One Monorepo: Local-First Workspace + 4-Preset Embeddable SDK**: Run the full **Agent Lab** (Next.js 15 + SQLite + Native Electron Desktop) out of the box, *or* install **`@mage-ai-lab/agent-loop`** from npm (`mini / normal / full / max`, where `/mini` has zero Node built-in imports for browsers and extensions) to power your own product.

---

## Choose Your Path

| I want to… | Start here | Go deeper |
|------------|------------|-----------|
| **Run the workspace (Web / Desktop)** | [Quick start](#quick-start) | [Capabilities tour](#what-you-can-do-today-shipped) · [Desktop client](apps/desktop/README.md) |
| **Review product specs & feature status** | [Bot Functional Guide (ZH)](doc/bot/00-functional-guide.md) | [PRD Catalog](doc/prd/README.md) · Run `pnpm feature-map <query>` |
| **Embed just the Agent Loop (Browser / Node)** | [`@mage-ai-lab/agent-loop`](packages/agent-loop/README.md) | [Loop SDK contract & 4 presets](skills/agent-loop/SKILL.md) |
| **Embed the full Multi-Agent Host Runtime** | [`@ppeng/agent-core`](packages/core/README.md) | [Core SDK stability & embedding guide](doc/EMBEDDING_SDK.md) |
| **Learn how an industrial Agent Harness works** | [Harness Guide](doc/harness/README.md) | [From-Zero Tutorial](doc/harness/from-zero/README.md) · [8-Zone Architecture Map](doc/architecture/README.md) |
| **Contribute or run AI coding agents** | [`AGENTS.md`](AGENTS.md) | [Architecture](doc/ARCHITECTURE.md) · [Acceptance Gate](doc/ACCEPTANCE_GATE.md) · [Testing](doc/TESTING.md) |

> Note: Product narrative books (`doc/bot/`, `doc/prd/`) and the 20-chapter Harness tutorial are maintained primarily in Chinese; [`doc/README.md`](doc/README.md) provides a bilingual index of the entire handbook.

---

## Quick start

Prerequisites: **Node.js 22+** (with built-in `node:sqlite` FTS5 support) and **pnpm 10.29.2**.

### 1. Launch Agent Lab in 60 Seconds (UI-First, Zero `.env` Required)

```bash
corepack enable
corepack prepare pnpm@10.29.2 --activate
pnpm install
pnpm run build
pnpm run dev
```

1. Open the **Agent Lab URL printed in your terminal** (prefers `23000` for Lab and `27070` for Daemon, probing upward automatically on port conflicts and writing actual bindings to `.agent-state/dev-lab.ports.json`).
2. You land directly in the **Bot Workspace**. Click **Configure Model** in the chat composer, enter any OpenAI- or Anthropic-compatible Base URL and API Key, auto-discover models, and send your first goal—**no `.env` file copy needed** (demo clip: [doc/lab/lab-model-setup-autodiscover.mp4](doc/lab/lab-model-setup-autodiscover.mp4)).
3. On macOS/Linux, stopping `pnpm run dev` (`Ctrl+C`, `SIGTERM`, `SIGHUP`) cleanly tears down compiler, daemon, and Next process groups so restarts immediately reuse the same ports.

Want a zero-API-key capability check right after building? Run the isolated heuristic smoke eval:

```bash
pnpm run agent:eval:fast --exit-on-fail
```

### 2. Native Desktop Client (macOS Apple Silicon & Linux)

Pack the standalone Electron app bundling Daemon + Agent Lab + OS tray + **transactional backup-and-rollback local client updates** (`Raw Agent → Update client…`):

```bash
pnpm run build:desktop
# Output: apps/desktop/release/RawAgent-<version>-<os>-<arch>.{dmg,AppImage}
```

Supported targets: **macOS arm64 (`.dmg`)** and **Linux x64 / arm64 (`.AppImage`)** (Windows and Intel Mac are intentionally not built; see Gatekeeper & updater notes in [`apps/desktop/README.md`](apps/desktop/README.md) and [`doc/CI.md`](doc/CI.md)).

---

## What You Can Do Today (Shipped)

> Every capability below is backed by `implemented` specs in [`acceptance/*.yaml`](acceptance). Explore the live catalog anytime via `pnpm feature-map` or [`doc/prd/README.md`](doc/prd/README.md).

### 1. Bot Workspace & High-Craft Conversational UX
- **Persistent Roster & Organization**: Default **Super Bot** coordinator + built-in **Mock Interviewer** + custom specialist Bots; pinned items, collapsible functional groups with drag-and-drop, sage-green light/dark glass UI, and hot-switched `en` / `zh` localization.
- **Canonical Thread & Slash Commands**: Compaction, stopping, and model switching never fracture a Bot's main thread. `/new` runs two-tier incremental structured summarization at **50% and 85%** of the real model context window (preserving tool-call/result pairing and searchable raw history); `/stop` halts the active turn; `/model` pins a provider/model; each Bot can also pin its own **Thinking Effort** (`off / low / medium / high`).
- **Live Mid-Turn Steering, Away Recap & Ghost Suggestions**: Send follow-ups while a Bot is busy to steer the next step immediately (cancelling conflicting queued tool calls before launch); return after 3+ minutes away for a 1-line **Session Recap** (or run `/recap` anytime); press `Tab` on an empty composer to adopt context-aware next-step suggestions.
- **Inline Sidechat & Multimodal Drafts**: Highlight any phrase in a finished reply to open a right-rail **Sidechat** for plain-language explanations, analogies, 1-line takeaways, and cross-session annotation search; drag-and-drop files and images with per-Bot draft preservation and optional browser desktop notifications.

### 2. Multi-Goal Execution & Multi-Bot Collaboration
- **Autonomous Goal Engine & Finish Follow-Up**: Automatically distinguishes new goals, constraint updates, status checks, and casual chat; surfaces a **Goals & Progress** panel when 2+ goals are active; includes **Finish Check & Scheduled Wakeups** so Bots don't stop prematurely after promising follow-up work, plus crash-safe lock release and missed-notification recovery across restarts.
- **Multi-Granularity Collaboration**: Direct `bot_delegate` (strictly enforcing the *target* Bot's permissions—never escalating via caller identity), **Sparse-MoE Rooms**, **Room Task Collaboration**, **Room Debate Mode**, **Team DAG**, **Swarm (`pipeline`)** (requiring both an independent reviewer pass and real test execution before completion), and **Orchestrator**.
- **Interactive Collaboration Graph**: `Tasks → Workflow` renders a live multi-Bot handoff canvas—inspect receipts, token cost, latency, and replay recent cross-Bot handoffs visually.

### 3. Five-Layer Memory, Daydream, Coaching & Obsidian Sync
- **Provenance-Backed 5-Layer Memory (`AgentMemoryStore`)**: Scoped across `session.scratch`, `session.long`, `user`, `team`, and `project` with strict private-memory isolation between Bots; tracks message/file provenance and replacement history, filters out temporary one-off instructions, and replaces contradicted facts cleanly.
- **Daily Daydream & Conversational Skill Capture**: Resumable background daily reflection (`daydream`); one-confirmation conversational **Skill Capture** ([`doc/SKILL_CAPTURE.md`](doc/SKILL_CAPTURE.md)); merges repo `skills/` + `~/.agents/` with read-only cross-Bot skill sharing and group-scoped shared instructions.
- **Bot Coaching & Experience Governance**: Persist role contracts and pinned workflow skills; govern operational lessons through a **`candidate → verified → retired`** ledger so only verified experiences enter execution prompts ([`doc/bot/BOT_COACHING_PLAYBOOK.md`](doc/bot/BOT_COACHING_PLAYBOOK.md)).
- **Local Library Indexing & Obsidian Vault Graph**: Non-blocking background folder indexing; one-click **Bookmark Reply** writes clean Markdown straight into your local **Obsidian Vault** with an in-app Topic Graph; optional local Grok desktop cache reader in the browser.

### 4. Model Routing, Built-in Tools, Connectors & Messaging Channels
- **Multi-Provider Models & Rich Tool Suite**: Native adapters for `openai-compatible` (Chat Completions & Responses), `anthropic-compatible`, and keyless `heuristic`, plus optional **Hybrid VL Routing** + `vision_analyze` (`RAW_AGENT_USE_JSON_MODE=0` supported for strict-JSON-incompatible providers). Built-in tools span file read/write/edit, `bash`, `bg_run`, `glob`, `web_fetch`, and LSP, alongside approval-gated external coding CLIs (`claude_code` / `codex_exec` / `cursor_agent`, see [`doc/EXTERNAL_AI_CLI.md`](doc/EXTERNAL_AI_CLI.md)) and gated local desktop control ([`doc/LCU_COMPUTER_USE.md`](doc/LCU_COMPUTER_USE.md)).
- **Software Connectors & External Agent Handoff**: Configure HTTP, OpenAPI (with read-only operation filtering), and **MCP (`stdio` & connectors)** backed by write-only secret references; authorize external apps or remote agents to submit isolated tasks to specific Bots ([`doc/EXTERNAL_AGENT_HANDOFF.md`](doc/EXTERNAL_AGENT_HANDOFF.md)).
- **IM & Webhook Channels**: Bidirectional **Feishu (Lark)** integration with durable outbox replay, **WeCom** bridge/webhook, **Slack** inbound event wakeups, and generic Webhooks ([`doc/IM_AGENT_INTEGRATION.md`](doc/IM_AGENT_INTEGRATION.md)).
- **In-Chat Interactive Cards (A2UI v0.9) & Domain Bundles**: Stream interactive forms and buttons inside chat bubbles that feed user actions back as structured turns ([`doc/A2UI.md`](doc/A2UI.md)); hot-toggle built-in Domain Bundles (`@ppeng/agent-sre` read-only on-call tools & `@ppeng/agent-stock` market/fundamentals with mock fallback), plus workspace packages `agent-homeiot` and `agent-erp`.
- **PTC Dynamic Workflows & Dynamic Tool Factory**: Let models compose async JavaScript over read-only tools and subagents via `ptc_exec`, and harvest recurring cells into session-sticky named tools ([`doc/PTC_DYNAMIC_WORKFLOW.md`](doc/PTC_DYNAMIC_WORKFLOW.md), [`doc/DYNAMIC_TOOLS.md`](doc/DYNAMIC_TOOLS.md)).

### 5. Defense-in-Depth Security, Sandboxing & Cache Economics
- **Granular Permissions & Session-Scoped Allowances**: Per-Bot permission tiers (`plan`, `auto`, double-confirmed full bypass); approval cards support **"Always allow in this session"** bound strictly to `session × tool × sandbox mode` (revocable anytime; unanswered approvals expire safely as failures after 10 minutes).
- **OS Sandboxing & Zero-Leak User Vault**: Every subprocess strips injection vectors via `sanitizeSpawnEnv()`; macOS `sandbox-exec` (Seatbelt) and Linux `bwrap` block `~/.ssh`, `~/.aws`, and `~/.gnupg`; tool outputs auto-redact secrets; **User Vault (`uvref:`)** fills passwords, cards, and OTPs inside runtime forms without ever exposing plaintext secrets to LLM prompts or traces.
- **In-Turn Watchdogs & Magpie Cache Telemetry**: Streaming repetition watchdog (aborts & cleanly retries once) + reasoning-spin watchdog + cross-turn `LoopGuard` / `RiskEngine`; follow-up turns preserve byte-identical leading prompt prefixes for upstream KV caching, monitored continuously by **Magpie** in `Settings → Ops → Health`.

---

## Embed in 5 Minutes (Dual SDKs)

Building your own AI product, CLI, or browser extension? Use the exact engine that powers Raw Agent—without adopting the UI or daemon.

### Option A: Lightweight Turn Kernel — `@mage-ai-lab/agent-loop`

Published on npm ([`@mage-ai-lab/agent-loop`](packages/agent-loop/README.md) + `@mage-ai-lab/api-types`, self-built—not a wrapper around `@openai/agents`). Offers `mini / normal / full / max` presets, `step() / run() / for await / steer() / abort() / fold()`, and native image/audio/video `MediaPart` input (`openai`, `qwen-omni`, `anthropic`):

```bash
pnpm add @mage-ai-lab/agent-loop
```

```ts
import { createAssembledLoop, OpenAiChatAdapter } from '@mage-ai-lab/agent-loop';
import { createDefaultMemoryStore, DEFAULT_EMBED_AGENT } from '@mage-ai-lab/agent-loop/mini';

const { store, surface } = createDefaultMemoryStore({ agent: DEFAULT_EMBED_AGENT });
const session = surface.createSession({ title: 'weather', mode: 'chat', agentId: DEFAULT_EMBED_AGENT.id });
surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'What is the weather in Shanghai?' }]);

const loop = await createAssembledLoop({
  preset: 'full', // 'mini' (zero Node built-ins for browsers/extensions) | 'normal' | 'full' | 'max'
  io: {
    store,
    model: new OpenAiChatAdapter({
      apiKey: process.env.OPENAI_API_KEY!,
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: 'gpt-4o',
      useJsonMode: false,
    }),
    tools: [{
      name: 'fetch_weather',
      description: 'Query current weather for a city',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async (_ctx, args) => ({ ok: true, content: `${String(args.city)}: Sunny, 22°C` }),
    }],
  },
});

const handle = loop.createHandle!(session.id);
await handle.run();
console.log(await handle.fold());
```

### Option B: Full Multi-Agent Host — `@ppeng/agent-core`

Instantiate `RawAgentRuntime` directly in Node.js for SQLite persistence, isolated workspaces (`git worktree` or copy), approvals, skills, and domain bundles (see [`doc/EMBEDDING_SDK.md`](doc/EMBEDDING_SDK.md); run `pnpm run test:examples` to execute all keyless examples `01`–`07`):

```ts
import { RawAgentRuntime, HeuristicModelAdapter } from '@ppeng/agent-core';

const runtime = new RawAgentRuntime({
  repoRoot: process.cwd(),
  stateDir: './.my-agent-state',
  modelAdapter: new HeuristicModelAdapter(), // or createModelAdapterFromEnv(process.env)
});

const session = runtime.createChatSession({ message: 'Summarize this repository.' });
await runtime.runSession(session.id);
console.log(runtime.getLatestAssistantText(session.id));
```

---

## Architecture & Monorepo Layout

![Architecture Overview](doc/architecture/01.svg)

> Browse all 8 vector architecture zones and the editable `.excalidraw` source (with source-path links on every module box) in [`doc/architecture/README.md`](doc/architecture/README.md).

```text
Agent Lab (Next.js 15) / Desktop (Electron) / CLI / IM & Connectors
                                ↓  HTTP / SSE / Same-Origin Bearer Proxy
                 apps/daemon (Auth · Routing · Schedulers · Readiness)
                                ↓
         packages/core · RawAgentRuntime (Bots / Goals / Memory / Sandbox / Vault)
                                ↓  Injected model / tools / storage / hooks
     packages/agent-loop · createAssembledLoop (default: kernel=agent-loop, preset=max)
                                ↓
         Turn Kernel → Context Assembly → Streaming Model → Tool Wave & Approvals → Verify
```

### Packages & Applications

| Path | Package | Role |
|------|---------|------|
| `packages/agent-loop` | `@ppeng/agent-loop` (npm: `@mage-ai-lab/agent-loop`) | Embeddable turn kernel, 4 assembly presets, model adapters, watchdogs & session control |
| `packages/api-types` | `@ppeng/api-types` (npm: `@mage-ai-lab/api-types`) | Shared HTTP view types & browser-safe session query helpers |
| `packages/core` | `@ppeng/agent-core` | Host runtime: Bots, Goals, 5-layer memory, sandboxing, Vault, tools, Swarm, Orchestrator & SQLite |
| `packages/daemon-client` | `@ppeng/daemon-client` | Typed HTTP/SSE client shared by CLI and external integrations |
| `packages/capability-gateway` | `@ppeng/agent-capability-gateway` | IM channel bridges (Feishu / WeCom / Slack / Webhook) & feed gateway |
| `packages/agent-sre` · `agent-stock` · `agent-homeiot` · `agent-erp` | `@ppeng/agent-*` | Pluggable Domain Bundles (SRE read-only on-call & Stock analysis enabled as built-in reference bundles) |
| `apps/web-console` | `@ppeng/agent-lab-web` | **Agent Lab**: Next.js 15 App Router web console (`/api/*` proxied server-side to Daemon) |
| `apps/daemon` | `@ppeng/agent-daemon` | Local HTTP/SSE server, goal/routine schedulers, `/api/readiness` probe (`/` serves stub only) |
| `apps/desktop` | `@ppeng/agent-desktop` | **Raw Agent Desktop**: Electron shell for Apple Silicon macOS & Linux (`x64` / `arm64`) |
| `apps/cli` | `@ppeng/agent-cli` | Terminal client for chat, tasks, approvals, `self-heal`, and daemon restart handshakes |

---

## Engineering Rigor & Quality Gates

Every change to `main` is guarded by automated, deterministic verification rather than ad-hoc demo runs:

- **Executable Acceptance Gate (`pnpm run test:acceptance`)**: `481` implemented specs and `2,347` `Given / When / Then` criteria traced directly to `[AC:<id>#<AC-n>]` test tags across `1,165+` runnable test files ([`doc/ACCEPTANCE_GATE.md`](doc/ACCEPTANCE_GATE.md)).
- **Executable Formal Invariants (`pnpm run test:formal`)**: Property-based and state-machine verification for tool-call pairing, session lifecycles, restart recovery, and concurrent writers ([`doc/formal/README.md`](doc/formal/README.md)).
- **CRAP Complexity × Coverage Ratchet (`pnpm run test:crap`) & Mutation Testing (`pnpm run test:mutation`)**: Blocks cyclomatic complexity regressions on uncovered paths ([`doc/CRAP_GATE.md`](doc/CRAP_GATE.md)).
- **Measured Lab Performance & Cache Gate (`pnpm run bench:lab`)**: Guards startup request budgets, homepage latency, and prompt-cache prefix stability on real request paths.
- **Instant Feature Traceability (`pnpm feature-map`)**: Query any user-facing concept (`pnpm feature-map sidechat` or `--json`) to locate its UI route, source files, acceptance spec, and targeted regression suite.

---

## Vision & Honest Delivery Boundaries

Our commercial trajectory scales naturally: **Personal Bot → Specialist Virtual Employee Team → Digital "Lights-Out Software Factory"** (*intake → Super Bot decomposition → specialist execution → automated tests & independent verification → deliverable rollup & routine capture*).

To keep expectations crystal-clear for evaluators, embedders, and operators, we explicitly separate **shipped software** from **commercial north-star & active validation milestones**:

- **Commercial North Star vs. Turnkey SLA**: "24/7 Virtual Employees" and "Lights-Out Software Factory" describe commercial deployment patterns built on top of our shipped Bot, Goal, Routine, and Room primitives—not pre-packaged job SKUs, guaranteed 7×24 uptime SLAs, or zero-human-oversight promises.
- **Multi-Machine Factory & Platform Slices**: Super Bot SSH machine registration, repo discovery, and **read-only pilot runs** (`superbot-factory-setup`) are shipped; cross-machine continuous supervision and end-to-end unattended production release remain gated on field certification ([`doc/SINGLE_HOST_COMPLETION.md`](doc/SINGLE_HOST_COMPLETION.md)). DeepResearch is currently a pipeline task MVP; `container` sandboxing is unimplemented (refuses cleanly rather than falling back silently); SQLite remains the primary state store while multi-Pod K8s session failover is not yet certified.
- **Self-Heal & Legacy Evolution Pipeline**: `pnpm run start:cli self-heal start` (`pnpm run self-heal:flow`) is an operator CLI/API maintenance workflow running whitelist tests in isolated worktrees—not an end-user Bot chat button. The legacy self-evolution pipeline (`evolution:*` / `scripts/evolution*`) has been **deprecated and frozen since 2026-10-16** and is retained only for historical reference (see [`scripts/evolution/DEPRECATED.md`](scripts/evolution/DEPRECATED.md)).

---

## Essential Commands

| Command | Description |
|---------|-------------|
| `pnpm run dev` (or `pnpm run dev:lab`) | Launch Daemon + Agent Lab in parallel with automatic port & proxy wiring |
| `pnpm run build` | Build all TypeScript workspace packages + Next.js production bundle |
| `pnpm run test:unit` | Run workspace unit tests (`node:test`) |
| `pnpm --filter @ppeng/agent-loop run test` | Run `@ppeng/agent-loop` Vitest suite |
| `pnpm run test:acceptance` | Fast static traceability check across `acceptance/*.yaml` and test tags |
| `pnpm run test:formal` | Run formal pairing, lifecycle, restart, and concurrency verifications |
| `pnpm run test:e2e` | Boot isolated temp Daemon + Lab with shared random auth token & run Playwright |
| `pnpm run ci` | Full local gate (build + perf + unit + soak + acceptance + formal + fast eval + package + CRAP + regression + integration + e2e) |
| `pnpm feature-map [query]` | Map user-facing features to specs, source files, and regression tests (`--json`, `--core`) |
| `pnpm run start:daemon` / `pnpm run pm2:start` | Run standalone Daemon or PM2-supervised Daemon (`ecosystem.config.cjs`) |
| `pnpm run start:cli` | Run CLI (`chat`, `send`, tasks, approvals, `self-heal`, restart ack) |
| `pnpm run build:desktop` | Package native Electron desktop artifact for host OS/arch |
| `pnpm run doctor` / `pnpm run ai:tools` | Run local environment diagnostics / check external CLIs (`claude`, `codex`, `cursor`) |

---

## Configuration, Security & Privacy

- **UI-First Hot Settings, Minimal Env Vars**: Model providers, loop presets (`GET/PATCH /api/loop/settings`), sandbox isolation mode, skill routing, finish-check behavior, A2UI, and Domain Bundles are configured in **Agent Lab + persisted SQLite settings** and take effect without editing `.env` or restarting processes.
- **Focused Environment Variables**: Reserve `.env` for upstream secrets/endpoints (`RAW_AGENT_API_KEY`, `RAW_AGENT_BASE_URL`, `RAW_AGENT_MODEL_NAME`, optional vision `RAW_AGENT_VL_*`), process bootstrap (ports, `RAW_AGENT_AUTH_TOKEN`, optional OAuth `RAW_AGENT_OAUTH_*`), and CI fallbacks. See [`.env.example`](.env.example) and [`doc/ENV_REFERENCE.md`](doc/ENV_REFERENCE.md).
- **Security Hygiene**:
  - **Never commit `.env` or `gateway.config.json`** — use `.env.example` and `gateway.config.example.json` as templates only, and rotate any key immediately if exposed.
  - **Same-Origin Proxy & Auth**: Set `RAW_AGENT_AUTH_TOKEN` in non-local deployments (Next middleware injects `Authorization: Bearer` server-side without exposing tokens to the browser) and restrict `RAW_AGENT_CORS_ORIGIN`. Never expose an unauthenticated Daemon to untrusted networks.

---

## Guidance for AI Coding Agents

If you are an automated coding agent (**Cursor, Claude Code, Codex, Antigravity**) working in this repository:

1. **Read [`AGENTS.md`](AGENTS.md) first** — covers UI-first configuration rules, mandatory frontend i18n (`useI18n` with matching `zh`/`en` keys), Web Console 0%-coverage CRAP ratchet rules, and review-before-merge workflow.
2. **Locate features via `pnpm feature-map <term>`** — when changing user-visible behavior or skills, sync [`doc/prd/`](doc/prd/README.md) per [`skills/product-prd/SKILL.md`](skills/product-prd/SKILL.md) and regenerate with `node scripts/prd/build-catalog.mjs`.
3. **Follow Acceptance-First** — for new features or behavior changes, write `acceptance/<id>.yaml` and `[AC:<id>#<AC-n>]`-tagged tests in the same turn per [`skills/acceptance-first/SKILL.md`](skills/acceptance-first/SKILL.md), then verify with `pnpm run test:acceptance`.
4. **Keep Loop SDK & Skill in sync** — any contract or preset change in `packages/agent-loop` must update [`skills/agent-loop/SKILL.md`](skills/agent-loop/SKILL.md) and pass both `pnpm --filter @ppeng/agent-loop run test` and `pnpm --filter @ppeng/agent-loop run build` (`/mini` must remain free of static Node built-ins).
5. **Subprocess safety** — always spawn through `sanitizeSpawnEnv()` or `SandboxManager` (`packages/core/src/sandbox/`), never raw `spawn` with unsanitized parent `process.env`.

---

## Documentation Index

Full bilingual catalog: **[`doc/README.md`](doc/README.md)**

- **Product & Specs**: [Bot Functional Guide](doc/bot/00-functional-guide.md) · [Bot Chapters 01–10](doc/bot/README.md) · [PRD Catalog](doc/prd/README.md) · [Bot Coaching Playbook](doc/bot/BOT_COACHING_PLAYBOOK.md)
- **Architecture & Harness Deep-Dives**: [8-Zone Excalidraw Architecture Map](doc/architecture/README.md) · [Harness Vertical Slices 00–20](doc/harness/README.md) · [From-Zero Tutorial](doc/harness/from-zero/README.md) · [Architecture Reference](doc/ARCHITECTURE.md)
- **SDKs & Extensibility**: [Agent Loop SDK Guide](skills/agent-loop/SKILL.md) · [Core Embedding Guide](doc/EMBEDDING_SDK.md) · [Domain Agents](doc/DOMAIN_AGENTS.md) · [A2UI Surfaces](doc/A2UI.md) · [External Agent Handoff](doc/EXTERNAL_AGENT_HANDOFF.md)
- **Quality, Ops & Roadmap**: [Testing Matrix](doc/TESTING.md) · [CI & Release Gates](doc/CI.md) · [Docker / Compose / Helm Deployment](doc/DEPLOYMENT.md) · [npm OIDC Publishing](doc/NPM_PUBLISH.md) · [Roadmap](doc/ROADMAP.md)

---

## License

The workspace root is marked **private** (`package.json`); public npm packages (`@mage-ai-lab/agent-loop`, `@mage-ai-lab/api-types`) are published under their package manifests via GitHub OIDC Trusted Publishing (see [`doc/NPM_PUBLISH.md`](doc/NPM_PUBLISH.md)).
