# Raw Agent SDK

[English README](README.md) | **中文**

类 Claude Code 风格的 **Node.js 多智能体运行时**：本地 **Daemon**（HTTP API）、**CLI**、**Agent Lab**（Next.js 调试台）、**SQLite** 状态、任务/工作区隔离、审批、**Teams 编排**、**自愈（Self-heal）**、**Evolution**（RSS → inbox → worktree → 测试 → 可选合并），以及可选的 **视觉路由**、**MCP（stdio）**、**能力网关** 等集成。

你可以把它作为本地 Agent 工作台使用，把循环内核嵌入自己的应用，也可以沿源码学习一套 Agent Harness 如何工作。可复用内核位于 `packages/agent-loop`，`packages/core` 负责接入产品存储、工具、策略与服务。

## 按你的目标开始

| 你想做什么 | 第一站 | 下一步 |
|------------|--------|--------|
| 先把产品跑起来 | [快速开始](#快速开始) | [Agent Lab](#agent-labweb-调试台) |
| 理解 Agent 的运行原理 | [Harness 实现指南](doc/harness/README.md) | [从零教程](doc/harness/from-zero/README.md)，再按问题查专题 |
| 只嵌入循环内核 | [Agent Loop 包说明](packages/agent-loop/README.md) | [SDK 指南：装配档位、宿主端口、生命周期](skills/agent-loop/SKILL.md) |
| 嵌入完整产品运行时 | [Core SDK](packages/core/README.md) | [嵌入指南](doc/EMBEDDING_SDK.md) |
| 改代码或定位问题 | [AGENTS.md](AGENTS.md) | [架构](doc/ARCHITECTURE.md) · [测试](doc/TESTING.md) |
| 部署或了解进阶能力 | [文档总目录](doc/README.md) | [部署](doc/DEPLOYMENT.md) · [Evolution](doc/evolution/README.md) |

README 负责项目概览与上手；Harness 负责原理和代码导读；[文档总目录](doc/README.md) 负责专题检索，不必从头读完所有文档。

## 代码如何串起来

```text
Agent Lab / CLI → daemon HTTP / SSE
                       ↓
          RawAgentRuntime（产品宿主，packages/core）
                       ↓  注入 model / tools / storage / hooks
          createAssembledLoop（packages/agent-loop，默认 mini）
                       ↓
          turn kernel → 组装上下文 → 模型 → 工具 → 下一轮
```

这是自建并抽取为 SDK 的循环，不是 `@openai/agents` 的封装。产品默认使用 `kernelVariant=agent-loop`、`assemblyPreset=max`；本地 `ppeng` 内核保留为显式选择的参考路径。选择通过 Lab 设置持久化（`GET/PATCH /api/loop/settings`）。详见[执行路径导读](doc/harness/00-self-built-agent-loop.md)。

SDK 提供 `mini / normal / full / max` 四档装配。浏览器和扩展宿主应使用 `/mini` 入口，不能引入面向 Node 的根入口/full/max。仓库内包名为 `@ppeng/agent-loop`，公开发布名为 `@mage-ai-lab/agent-loop`。

---

## 能力一览

| 领域 | 说明 |
|------|------|
| **运行时** | `RawAgentRuntime`：会话、任务、工具、审批、工作区（`git worktree` 或目录复制）、后台任务、Mailbox（Teammate）、Trace、为 **KV 缓存** 优化的稳定/动态 system 前缀 |
| **模型** | `heuristic`（无密钥）、`openai-compatible`、`anthropic-compatible`；可选 **混合 VL 路由** + `vision_analyze`；不兼容 `response_format` 时可设 `RAW_AGENT_USE_JSON_MODE=0` |
| **工具** | 读写/编辑文件、`bash`、Todo、harness 规格、子 Agent/Teammate、Mailbox、`bg_run`、Skills；可选 **glob** / **web_fetch** / **MCP stdio** / **工具钩子** / **LSP** / **OpenTelemetry** 等 |
| **Skills** | 仓库 `skills/**/SKILL.md` + 可选 `~/.agents/**/SKILL.md` 合并；**技能路由**（`legacy` / `hybrid`） |
| **自愈** | 隔离 worktree、白名单测试、可选合并与 **daemon 重启握手** |
| **Evolution** | `evolution:learn`（RSS → inbox + 摘要技能）+ `evolution:run-day`（研究 → Agent → 构建 → 测试；`AUTO_MERGE=1` 时主仓 **merge 串行互斥**） |
| **Web** | Next.js 15 App Router：Playground、Teams、Trace、审批；Ops **Swarm**；「更多」**Orchestration / Memory**；`/api/*` 代理 Daemon |
| **2.0 切片** | **五层记忆**、**Swarm**（pipeline 执行器）、**Orchestration** 引擎、**DeepResearch** 管线 MVP；可选 `RAW_AGENT_AUTH_TOKEN` |

---

## 包与应用

| 路径 | 职责 |
|------|------|
| `packages/agent-loop`（`@ppeng/agent-loop`） | 可嵌入的 turn 内核、装配档位、模型/工具循环与会话控制；见 [SDK 指南](skills/agent-loop/SKILL.md) |
| `packages/api-types` | 共享 API 类型 |
| `packages/core`（`@ppeng/agent-core`） | 运行时、存储、适配器、工具、工作区、自愈策略、Trace、Skills；作为**可嵌入 SDK** 独立使用见 [`packages/core/README.md`](packages/core/README.md) / [`doc/EMBEDDING_SDK.md`](doc/EMBEDDING_SDK.md) |
| `packages/capability-gateway` | 可选网关/桥接（如 IM、配置）；`evolution:learn` 拉 feed 会用到 |
| `apps/daemon` | HTTP API、调度器、`/` 仅 stub；**日常 UI 请用 Next** |
| `apps/cli` | `chat`、`send`、任务、审批、**self-heal**、daemon 重启确认 |
| `apps/web-console` | Agent Lab（Next.js） |

---

## 快速开始

前置条件：Node.js 22+（SQLite 需支持 FTS5）与 npm。在仓库根目录执行：

```bash
npm install
npm run build
npm run dev
```

打开**终端打印的 Agent Lab 地址**，在对话区「配置模型」填写服务商 Base URL / API Key，发现模型并选择后发送消息。采用界面配置时，不需要先复制 `.env`。

开发启动器会选择可用端口并自动连接代理，实际地址也写入 `.agent-state/dev-lab.ports.json`。没有覆盖配置时，首选端口是 Lab 23000、daemon 27070；冲突时自动后移，不要照搬旧示例的固定端口。

不接真实模型也可以在构建后验证 HTTP 能力：

```bash
npm run agent:eval:fast -- --exit-on-fail
```

该命令使用隔离的 heuristic daemon，不代表真实模型回答质量。CLI/HTTP 的进一步操作见[从零教程](doc/harness/from-zero/README.md)。单独启动 Next 时，将 `DAEMON_PROXY_TARGET` 指向实际 daemon 地址；生产 UI 使用 `npm run build:web-console` 与 `npm run start:web-console`。

---

## 给 AI 编码 Agent 的指引

若你是 **自动化编码 Agent**（Cursor、Codex、Claude Code 等）在本仓库中改代码：

1. **先读 [`AGENTS.md`](AGENTS.md)** — 工作区约定、环境变量、Evolution/自愈/前端行为与常见坑。
2. **代码位置**：循环 SDK → `packages/agent-loop`；产品宿主与集成 → `packages/core`；HTTP API → `apps/daemon`；Agent Lab → `apps/web-console`；Evolution → `scripts/evolution*`。
3. **改完怎么验**：逻辑改动跑 `npm run test:unit`；全量 TS 编译用 `npm run build`。界面/E2E 见 [`doc/TESTING.md`](doc/TESTING.md)、必要时 `npm run test:e2e`。
4. **配置与密钥**：支持的功能优先使用 Lab UI 与持久化 settings API，避免新增功能开关 env。必要的连接、进程引导或 CI 回退配置参考 [`.env.example`](.env.example)；**切勿提交 `.env`**。env 修改需重启进程；界面设置的生效范围以各 API 为准。
5. **Evolution**：`npm run evolution -- --help` 查看参数（`--learn`、`--agent`、`--review`、`--until-empty`、`--research`、`--test-agent` 等）。一键 drain + 展示站：`npm run evolution:drain-showcase -- --help`。`run-day` 默认只处理 inbox **「今日新条目」** 分段（下文 Evolution 一节）。
6. **子进程 / 沙箱**：新增 `spawn` 须走 `sanitizeSpawnEnv()` 与现有沙箱封装（`packages/core/src/sandbox/env-sanitizer.ts`、`packages/core/src/sandbox/os-sandbox.ts`、`SandboxManager`），勿在完整父进程环境下裸调 `spawn`。
7. **Skills**：仓库内 `skills/**/SKILL.md`；可与 `~/.agents/**/SKILL.md` 合并（见 `AGENTS.md`）。
8. **循环 SDK 改动**：契约变化须同步 [`skills/agent-loop/SKILL.md`](skills/agent-loop/SKILL.md)，并执行 `npm run test --workspace=@ppeng/agent-loop` 与 `npm run build --workspace=@ppeng/agent-loop`；根目录 `test:unit` 不能代替 SDK 的 Vitest 测试。

架构与 API 全貌：[`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md)。

---

## npm 脚本（参考）

| 命令 | 说明 |
|------|------|
| `npm run build` | TypeScript 工作区编译 + Next 生产构建 |
| `npm run test` | build + 单测 |
| `npm run test:unit` | 仅单测 |
| `npm run test:regression` | 临时 daemon HTTP 回归 |
| `npm run test:e2e` | 临时 daemon + Playwright |
| `npm run test:e2e:install` | 安装 Playwright Chromium |
| `npm run test:remote` | 真模型冒烟（需环境变量） |
| `npm run agent:eval:fast -- --exit-on-fail` | 隔离 heuristic daemon 的 HTTP 能力检查，失败返回非零 |
| `npm run test --workspace=@ppeng/agent-loop` | 循环 SDK 的 Vitest 测试 |
| `npm run ci` | build + unit + formal + fast eval + 评估引擎 simulation + 包产物自检 + CRAP + regression + integration + e2e |
| `npm run start:daemon` / `start:supervised` | 守护进程 / 监督拉起 |
| `npm run start:cli` | CLI（含 `self-heal`、`chat` 等） |
| `npm run dev:lab` | 开发辅助（Next + 代理） |
| `npm run evolution -- --help` | 统一进化入口，查看全部参数 |
| `npm run evolution -- --learn --agent cursor --review codex` | learn + cursor 开发 + codex review |
| `npm run evolution -- --learn-only` | 仅拉 RSS → inbox |
| `npm run evolution:pipeline` | learn → run-day → 可选合并后重载（一键） |
| `npm run ai:tools` | 检测本机 `claude` / `codex` 等 CLI |

详见 [`doc/TESTING.md`](doc/TESTING.md)、[`doc/CI.md`](doc/CI.md)、[`.env.example`](.env.example)。

---

## Agent Lab（Web 调试台）

- **Jev 接入**：可选的宿主语义判断、独立档位、PTC 辅助与调用观测。见 [Jev 接入指南](doc/JEV_INTEGRATION.md)；默认关闭，在「更多 → Jev」中配置。
- **模型配置**：对话区「配置模型」填 Base URL / API Key，自动发现模型名。演示：[doc/lab/lab-model-setup-autodiscover.mp4](doc/lab/lab-model-setup-autodiscover.mp4)
- **Playground**：流式（SSE）、thinking、工具结果、Markdown
- **会话 / 任务 / Teams**：Mailbox 有向图、邮件流
- **Trace**：读 `stateDir/traces/.../events.jsonl`
- **审批 / 后台任务 / 工作区**

Daemon API 示例：`GET /api/version`、`GET /api/health`、`GET /api/traces?sessionId=...` — 完整列表见 `apps/daemon/src/server.ts`。

---

## Evolution（持续学习）

统一入口：`npm run evolution -- [options]`（`--help` 查看全部参数）。

**分步固定流程**（learn → run-day → 展示站）：[`doc/evolution/README.md`](doc/evolution/README.md)。

**飞轮与能力矩阵**：[`doc/evolution-flywheel-review.md`](doc/evolution-flywheel-review.md)。

**常用组合：**

| 命令 | 说明 |
|------|------|
| `npm run evolution -- --learn-only` | 仅拉 RSS → inbox，不跑开发 |
| `npm run evolution -- --learn --agent claude` | learn + Claude 实现（默认） |
| `npm run evolution -- --learn --agent cursor` | learn + Cursor composer-2-fast 实现 |
| `npm run evolution -- --learn --agent cursor --review codex` | learn + Cursor 实现 + Codex review |
| `npm run evolution -- --learn --agent cursor --review cursor` | learn + Cursor 全链路 |
| `npm run evolution -- --learn --agent cursor --model claude-opus-4-7-thinking-max --review cursor` | learn + Cursor Opus-Max 实现与 review |
| `npm run evolution -- --learn --agent full` | learn + 研究→多CLI路由实现（自动按难度分配） |
| `npm run evolution -- --learn --agent cursor --review codex --concurrency 5 --merge` | 5 路并发 + 自动合并 |
| `npm run evolution -- --pipeline-build --learn --agent cursor --review codex` | 先编译 gateway + learn + 开发 |

**部分常用参数**（完整列表与当前默认值以 `--help` 为准）：

```
--learn                  先拉 RSS → inbox
--learn-only             仅 learn，不跑开发
--pipeline-build         learn 前先编译 capability-gateway
--agent cursor|claude|codex|full|multi   实现 agent（默认 claude）
--model <name>           cursor agent 模型（默认 composer-2-fast）
--review cursor|codex|none   review agent（默认 none）
--review-model <name>    review 用模型（默认同 --model）
--concurrency <n>        并发 worktree 数（上限见 --help）
--items <n>              最多处理条目数
--merge                  测试通过后自动合并
--target-branch <b>      合并目标分支（默认 main）
--skip-rebase            跳过 rebase 步骤
```

**运行规则与排障：**

- `run-day` 默认只执行 inbox 里的 **“今日新条目”** 分段；“近期滚动（参考）”仅展示，不重复调度，避免同一链接在高并发下共用 worktree。
- 选择 Cursor 时，CLI 会先执行 `agent --list-models` 预检；若模型不可用会在开跑前直接报错，而不是跑到 research 阶段才失败。
- research 阶段现在更保守：正文抓取为空、模型不可用、或输出里明确出现 `SKIP:` 时，会直接跳过，不再默认 `PROCEED`。
- review / rebase / merge 等失败时，实验分支会尽量保留，便于人工接管；可在 `doc/evolution/failure/` 中查看对应条目，再到本地 `exp/evolution-*` 分支检查。
- `evolution:learn` 若大量 RSS 失败，优先检查代理 / DNS / TLS；`news.ycombinator.com` 证书异常通常是本机网络或代理链路问题，不是仓库代码问题。

底层仍可直接使用 `npm run evolution:pipeline`（bash 一键：build→learn→run-day→可选重载），或 `npm run evolution:learn` / `npm run evolution:run-day` 单独执行。高级细粒度调参（plan、test-agent、review rounds 等）见 `scripts/evolution-quality-pipeline.env.example` 与 `.env.example`。

> **已停止维护（2026-10-16）：** 自进化流水线（`evolution:*` 脚本、`scripts/evolution*`）不再维护，请勿扩展，后续可能移除。详见 `scripts/evolution/DEPRECATED.md`。

---

## 自愈（Self-heal）

`npm run start:daemon`（或 supervised）后：

```bash
npm run start:cli -- self-heal start '{"testPreset":"unit","autoMerge":false}'
```

调度器在隔离 worktree 跑白名单测试；失败可驱动 **self-healer** 会话。可选 `autoMerge` / `autoRestartDaemon`，配合 `GET /api/daemon/restart-request` 与 `POST .../ack`。详见 [`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md)。

---

## 核心能力（摘要）

- SQLite：agents、sessions、messages、tasks、events、approvals、workspaces、mailbox、background_jobs、self_heal_*、daemon 控制等
- 团队模型：main / planner / researcher / implementer / reviewer / **self-healer** + 可spawn 的 Teammate
- **稳定 / 动态 system 提示** 拆分以利于 KV 缓存（见 `doc/PROMPT_CACHE.md`）
- **图片资产**：热/温/冷、contact sheet、`vision_analyze`
- **可选外部 AI 工具**（`RAW_AGENT_EXTERNAL_AI_TOOLS=1`）：`claude_code`、`codex_exec`、`cursor_agent`（默认需审批）— 见 [`doc/EXTERNAL_AI_CLI.md`](doc/EXTERNAL_AI_CLI.md)

---

## 配置方式

模型服务商与已支持的运行策略优先走 **Lab UI + 持久化设置**。例如循环内核和插话策略通过 `GET/PATCH /api/loop/settings` 管理。配置优先级、持久化位置及下一次请求/运行何时采用新设置，应分别查对应 API，不能套用一条全局 env 优先规则。

环境变量用于密钥与上游连接、进程引导，以及受支持的 CI/eval 回退。下面是查阅入口，不是首次运行必须填写的开关清单：

- **核心**：`RAW_AGENT_STATE_DIR`、`RAW_AGENT_DAEMON_*`、`RAW_AGENT_MODEL_*`、`RAW_AGENT_API_KEY`、`RAW_AGENT_BASE_URL`、`RAW_AGENT_ANTHROPIC_URL`、`RAW_AGENT_USE_JSON_MODE`、`RAW_AGENT_MEMORY_BACKEND`、可选 `RAW_AGENT_AUTH_TOKEN`、可选 Lab 账号 `RAW_AGENT_OAUTH_*`（Google / GitHub）
- **视觉**：`RAW_AGENT_VL_*`、图片上限等 — 见 `doc/ARCHITECTURE.md` 与 `.env.example`
- **Evolution / 自愈 / Skills / 网关**：见 `AGENTS.md` 与 `.env.example`

---

## 文档索引

**完整目录：** [`doc/README.md`](doc/README.md)（中英对照、含已移除文档说明）。

| 文档 | 内容 |
|------|------|
| [Harness 实现指南](doc/harness/README.md) · [从零教程](doc/harness/from-zero/README.md) | 请求 → 循环 → 模型/工具 → 状态 → 验证的学习路线 |
| [Agent Loop SDK 指南](skills/agent-loop/SKILL.md) | 装配档位、宿主契约、step/run/steer/fold 与 SDK 开发 |
| [Jev 接入指南](doc/JEV_INTEGRATION.md) | Lab 配置、档位、12 个切入点及接线状态、PTC、回退与 trace |
| [`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md) | 模块、调度器、API、工具（`doc-sync-tools`） |
| [`doc/ENV_REFERENCE.md`](doc/ENV_REFERENCE.md) | 环境变量索引 |
| [`doc/TESTING.md`](doc/TESTING.md) · [`doc/CI.md`](doc/CI.md) | 测试矩阵 · GitHub Actions |
| [`doc/MEMORY_MULTIUSER.md`](doc/MEMORY_MULTIUSER.md) | 五层记忆、`RAW_AGENT_MEMORY_BACKEND` |
| [`doc/TEAMS_SWARM.md`](doc/TEAMS_SWARM.md) | Swarm 执行器、API、Lab Ops 面板 |
| [`doc/AGENT_ORCHESTRATOR.md`](doc/AGENT_ORCHESTRATOR.md) | 编排 run/step/event、引擎 tick |
| [`doc/DEEP_RESEARCH.md`](doc/DEEP_RESEARCH.md) | 研究任务、管线、HTTP 触发 |
| [`doc/DOMAIN_AGENTS.md`](doc/DOMAIN_AGENTS.md) · [`doc/A2UI.md`](doc/A2UI.md) | 领域 Agent · A2UI |
| [`doc/SELF_EVOLUTION_V2.md`](doc/SELF_EVOLUTION_V2.md) · [`doc/evolution/README.md`](doc/evolution/README.md) | Evolution 2.0 · 固定三步 |
| [`doc/DEPLOYMENT.md`](doc/DEPLOYMENT.md) · [`doc/HARNESS_EVAL.md`](doc/HARNESS_EVAL.md) | 部署 · agent-eval |
| [`doc/ROADMAP.md`](doc/ROADMAP.md) | 长期路线 P0–P4 |
| [`AGENTS.md`](AGENTS.md) | 本仓库编码 Agent 约定 |

---

## CI

`npm run ci` 执行构建、单测、formal、fast 契约 eval、评估引擎 simulation、tarball 安装自检、CRAP、HTTP 回归、integration 与 E2E。命令见 [`package.json`](package.json)，流程见 [CI](doc/CI.md)。npm 与 Docker 必须先通过门禁并验证实际产物才发布；部署边界见[发布可靠性计划](doc/RELEASE_RELIABILITY_PLAN.md)，新功能/提示词的真实模型配对回归见 [Harness 评估](doc/HARNESS_EVALUATION.md)。simulation 不代表能力提升。可选真模型冒烟需要凭证；fork PR 无法读取上游 Secret。

---

## 安全与隐私

- **`.env` 已在 `.gitignore` 中** — 勿将 API Key、飞书 Secret、网关 token 等提交到 Git；仅以 `.env.example` 为模板。
- 若密钥曾误提交、贴在 Issue 或打进日志，请 **轮换密钥**。
- **网关**（`gateway.config.json`）：`bridgeSecret` 与各通道凭证勿入库；可参考 `gateway.config.example.json`。
- **CI**：fork PR 无 Secret，设计为无法窃取上游密钥。
- **Daemon**：跨域请配置 `RAW_AGENT_CORS_ORIGIN`；生产环境建议设置 `RAW_AGENT_AUTH_TOKEN`（Bearer）；勿把未鉴权 Daemon 暴露到不可信网络。Lab 多人隔离可配 `RAW_AGENT_OAUTH_GOOGLE_*` / `RAW_AGENT_OAUTH_GITHUB_*`（见 `.env.example`）。

---

## 许可证

`package.json` 标记为 **private**。若日后开源请补充 SPDX 许可证文件。
