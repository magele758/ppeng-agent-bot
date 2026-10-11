# Documentation index / 文档目录

本页为专题检索入口。项目介绍与启动步骤见 [English README](../README.md) / [中文 README](../README.zh.md)；代码约定见 [`AGENTS.md`](../AGENTS.md)。

## Reading routes / 按目标选路线

| 目标 / Goal | 推荐顺序 / Route |
|-------------|------------------|
| 第一次使用 / Run locally | [README 快速开始](../README.zh.md#快速开始) → [Lab 接入](harness/from-zero/09-web-console.md) → [测试与排障](TESTING.md) |
| 学习 Agent 原理 / Learn the runtime | [Harness 地图](harness/README.md) → [从零教程](harness/from-zero/README.md) → 按问题查 00–20 专题 |
| 嵌入循环 / Embed the loop | [Agent Loop 包](../packages/agent-loop/README.md) → [SDK 指南](../skills/agent-loop/SKILL.md) → [装配模块与端口](../skills/agent-loop/references/modules-and-ports.md) |
| 接入完整运行时 / Embed the product host | [Core SDK](../packages/core/README.md) → [嵌入指南](EMBEDDING_SDK.md) |
| 修改代码 / Contribute | [AGENTS.md](../AGENTS.md) → [分层](MONOREPO_LAYERING.md) → [架构](ARCHITECTURE.md) → [测试](TESTING.md) |
| 部署与自动化 / Operate | [部署](DEPLOYMENT.md) → [CI](CI.md) → [Evolution](evolution/README.md) |

当前默认执行链是 **daemon → core 产品宿主 → agent-loop SDK（max）→ turn kernel**。SDK 接入以契约与类型为准；计划文档用于解释设计背景，不等同于已实现能力。Harness 专题仍有旧路径/配置说明时，先按其[当前源码入口](harness/README.md#当前源码入口)定位，再核对行为。

---

## Start here / 从这里读

| Document | 中文说明 |
|----------|----------|
| [`harness/README.md`](harness/README.md) · [`harness/from-zero/README.md`](harness/from-zero/README.md) | 原理地图与逐步教程；从 HTTP 请求追到循环、工具和状态 |
| [`../skills/agent-loop/SKILL.md`](../skills/agent-loop/SKILL.md) | 当前 SDK 开发与调用契约，四档装配；不是历史分层计划 |
| [`MONOREPO_LAYERING.md`](MONOREPO_LAYERING.md) | 官方分层：`apps` / `packages` / `scripts` / `skills` / `doc`；何时新建包 vs 进 core 目录 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 模块划分、数据模型、HTTP API、调度器、内置工具（与 `scripts/doc-sync-tools.mjs` 对齐） |
| [`ENV_REFERENCE.md`](ENV_REFERENCE.md) | 环境变量索引（与 `.env.example` 对照） |
| [`TESTING.md`](TESTING.md) | 单测 / 回归 / E2E / 远程冒烟矩阵 |
| [`RELEASE_RELIABILITY_PLAN.md`](RELEASE_RELIABILITY_PLAN.md) | 减少人工发布验证：已落地的确定性测试/强制门禁，以及产物验证、候选观测与回滚计划 |
| [`HARNESS_EVALUATION.md`](HARNESS_EVALUATION.md) | 新功能与系统提示词的配对评估、消融、质量/成本门禁、真实模型回归边界 |
| [`formal/README.md`](formal/README.md) | 可执行不变量 / PBT / MockLLM；TLA 草稿非 TLC 证明 |
| [`CI.md`](CI.md) | GitHub Actions、本地 `npm run ci` 对齐、main 发布卡点（Release gate，默认卡 npm / Docker 发布）、flaky 单测重试策略、门禁健康报告、启用分支保护步骤 |
| [`NPM_PUBLISH.md`](NPM_PUBLISH.md) | 公开包自动发布：OIDC、触发方式、维护者要在 npm 上完成的 Trusted Publisher 设置 |
| [`CRAP_GATE.md`](CRAP_GATE.md) | CRAP（复杂度 × 覆盖率）门禁：公式、数据来源、棘轮基线、失败处理 |
| [`ACCEPTANCE_GATE.md`](ACCEPTANCE_GATE.md) | 验收标准门禁：`acceptance/*.yaml`（Given/When/Then）↔ `[AC:id#AC-n]` 测试标签、draft/approved/implemented 语义、JUnit 结果采集；工作流见 [`acceptance-first`](../skills/acceptance-first/SKILL.md) |
| [`MUTATION_TESTING.md`](MUTATION_TESTING.md) | 关键模块变异测试门禁：变异算子、内存注入、分数棘轮、CI（只观察）与存活变异体处理 |
| [`ROADMAP.md`](ROADMAP.md) | 长期路线（P0–P4）；与实现以代码为准 |
| [`CAPABILITY_DISCOVERY_PLAN.md`](CAPABILITY_DISCOVERY_PLAN.md) | 自主探针 / Capability Discovery（含 Tailscale 设备池）开发计划（Draft） |
| [`BOT_CAPABILITY_PLAN.md`](BOT_CAPABILITY_PLAN.md) | Bot 名册 + canonical 对话；`/new` 压缩、`/stop`、`/model` |
| [`EMBEDDING_SDK.md`](EMBEDDING_SDK.md) | `@ppeng/agent-core` 作为可嵌入 SDK：稳定 API 面、embed env 最小契约、examples 验收 |
| [`AGENT_LOOP_LAYERING_PLAN.md`](AGENT_LOOP_LAYERING_PLAN.md) | Agent Loop 分层重构计划（L0–L6；保留 step/steer/fold；其他项目可从任意层接入） |
| [`AGENTS.md`](../AGENTS.md)（前端 i18n） | Lab 用户可见文案：`useI18n` / zh+en 同 key / `localStorage['lab.locale']`，禁止语言 env |

---

## Runtime capabilities / 运行时能力

| Document | Status | 中文说明 |
|----------|--------|----------|
| [`JEV_INTEGRATION.md`](JEV_INTEGRATION.md) | Optional host integration; sagaGate helper only | Lab 配置、独立 profile、12 个切入点及接线状态、PTC noul/choice、回退与 Langfuse |
| [`MEMORY_MULTIUSER.md`](MEMORY_MULTIUSER.md) | Implemented (agent backend) | 五层 `agent_memory`、HTTP `/api/memory`、对话回路经 bridge |
| [`TEAMS_SWARM.md`](TEAMS_SWARM.md) | Pipeline MVP | `SwarmExecutor` + `/api/swarm/*` + Lab Ops 面板 |
| [`AGENT_ORCHESTRATOR.md`](AGENT_ORCHESTRATOR.md) | Engine + CRUD | `OrchestrationEngine.tick`、Evolution 可选记账 |
| [`PTC_DYNAMIC_WORKFLOW.md`](PTC_DYNAMIC_WORKFLOW.md) | Dynamic workflow | 模型生成 async JavaScript，通过 `ptc_exec` 编排 Agent 与只读工具 |
| [`DYNAMIC_TOOLS.md`](DYNAMIC_TOOLS.md) | Implemented (L1 factory) | PTC cell 收割为具名工具、会话粘滞、Lab 开关与晋升 |
| [`../docs/plans/2026-09-09-ptc-variable-control.md`](../docs/plans/2026-09-09-ptc-variable-control.md) | Plan | PTC 中间变量：可见性 / 配额 / 子 Agent 继承 / return 外溢 / replay 对齐 |
| [`../docs/plans/2026-09-14-dynamic-tool-factory.md`](../docs/plans/2026-09-14-dynamic-tool-factory.md) | Plan | 动态工具厂：PTC cell 收割为具名工具、会话粘滞、memory 晋升 |
| [`WORKSPACE_PROJECT.md`](WORKSPACE_PROJECT.md) | Lab UI + API | 多根 Project / 云端 Folder；会话 write-once 绑定，根不可用禁止回退 |
| [`DEEP_RESEARCH.md`](DEEP_RESEARCH.md) | Pipeline MVP | `ResearchPipeline`、`POST .../tasks/:id/run` |
| [`DOMAIN_AGENTS.md`](DOMAIN_AGENTS.md) | Implemented | 领域包挂载（SRE / Stock 等） |
| [`A2UI.md`](A2UI.md) | Implemented | 对话内结构化 UI surface |
| [`AGENTIC_SAFETY_RUNTIME.md`](AGENTIC_SAFETY_RUNTIME.md) | Optional appendix | 失范治理与运行时控件映射 |
| [`PROMPT_CACHE.md`](PROMPT_CACHE.md) | Implemented | 稳定/动态 system 前缀与 KV 缓存 |
| [`CONTEXT_COMPILER.md`](CONTEXT_COMPILER.md) | 结论已定；未实现 | 每轮动态组上下文：编包优于硬切；对照 Codex TokenBudget 与论文 |
| [`TOOL_RESULT_STUB_PLAN.md`](TOOL_RESULT_STUB_PLAN.md) | #19 已合入；页面真测未完 | 工具结果占位进度 + 分 Agent 计划（送模视图 / A/B 种子 / 可寻址存根） |
| [`EXTERNAL_AI_CLI.md`](EXTERNAL_AI_CLI.md) | Optional | `claude_code` / `codex_exec` / `cursor_agent` |
| [`skill-router-baseline.md`](skill-router-baseline.md) | Implemented | Skills 路由 baseline（legacy / hybrid） |

沙箱实现见 [`ARCHITECTURE.md`](ARCHITECTURE.md) § `packages/core/src/sandbox/`（`RAW_AGENT_SANDBOX_MODE`），不再维护独立调研稿。

---

## Harness 纵向切片 / Vertical slice deep-dives

> **从入口到存储的完整路径**，每条切片讲一个完整故事，而非按代码目录罗列。入口 → [`harness/README.md`](harness/README.md)

**实现路径**：自建循环已抽取到 `packages/agent-loop`，默认由 `packages/core` 注入产品 I/O 后运行，不使用 `@openai/agents`。专章 → [`harness/00-self-built-agent-loop.md`](harness/00-self-built-agent-loop.md)；循序学习 → [`harness/from-zero/`](harness/from-zero/README.md)。

| # | Document | 中文摘要 |
|---|----------|----------|
| 0 | [`harness/00-self-built-agent-loop.md`](harness/00-self-built-agent-loop.md) | 产品宿主与 SDK 边界；默认执行路径 / turn / tool 配对 / 停止条件 |
| — | [`harness/from-zero/`](harness/from-zero/README.md) | 从 0 学习序（02 = 循环核心章） |
| 1 | [`harness/01-request-lifecycle.md`](harness/01-request-lifecycle.md) | HTTP → session → turn loop → stream/SSE |
| 2 | [`harness/02-prompt-assembly.md`](harness/02-prompt-assembly.md) | System prompt 四段：stable / dynamic / advisory / user appendix |
| 3 | [`harness/03-tool-execution.md`](harness/03-tool-execution.md) | filter → approve → execute → redact → persist |
| 4 | [`harness/04-context-economics.md`](harness/04-context-economics.md) | micro-compact / episodic / autoCompact / budget / working log |
| 5 | [`harness/05-safety-and-recovery.md`](harness/05-safety-and-recovery.md) | LoopGuard / RiskEngine / AdvisoryGrace / watchdog |
| 6 | [`harness/06-goal-gate.md`](harness/06-goal-gate.md) | soft-completion gate + ledger + stalled/exhausted |
| 7 | [`harness/07-skills-and-routing.md`](harness/07-skills-and-routing.md) | discovery → lexical/hybrid routing → load_skill |
| 8 | [`harness/08-memory-and-evolving.md`](harness/08-memory-and-evolving.md) | 五层记忆 + ShadowCoach + CaseGovernance |
| 9 | [`harness/09-model-adapters.md`](harness/09-model-adapters.md) | OpenAI / Anthropic / Hybrid + usage / cost / truncation |
| 10 | [`harness/10-self-heal.md`](harness/10-self-heal.md) | worktree → test → fix → merge |
| 11 | [`harness/11-subagents-and-swarm.md`](harness/11-subagents-and-swarm.md) | spawn_subagent / Swarm / send_message |
| 12 | [`harness/12-sandbox-and-execution.md`](harness/12-sandbox-and-execution.md) | OS / native / remote-VM / microservice |
| 13 | [`harness/13-storage-and-state.md`](harness/13-storage-and-state.md) | SQLite + disk assets + cloud tiered + migrations |
| 14 | [`harness/14-hooks-extensions-plugins.md`](harness/14-hooks-extensions-plugins.md) | lifecycle hooks + extensions + plugins |
| 15 | [`harness/15-observability.md`](harness/15-observability.md) | trace / OTEL / LLM debug / doctor |
| 16 | [`harness/16-runtime-governance.md`](harness/16-runtime-governance.md) | 运行时治理叠层（watchdog / LoopGuard / Risk / Goal 接线） |
| 17 | [`harness/17-context-memory-compaction.md`](harness/17-context-memory-compaction.md) | 上下文 / 压缩 / Memory / 预算与用量归一 |
| 18 | [`harness/18-model-tools-sandbox.md`](harness/18-model-tools-sandbox.md) | 模型适配 · 工具面 · 沙箱安全合章 |
| 19 | [`harness/19-surfaces-a2ui-domains.md`](harness/19-surfaces-a2ui-domains.md) | Daemon / Lab / A2UI / Domain Agents |
| 20 | [`harness/20-orchestration-evolution-eval.md`](harness/20-orchestration-evolution-eval.md) | Orchestrator / Swarm / Research / Eval / Evolution |

---

## Evolution / 自我进化

| Document | 中文说明 |
|----------|----------|
| [`evolution/README.md`](evolution/README.md) | learn → run-day → 展示站 固定三步 |
| [`SELF_EVOLUTION_V2.md`](SELF_EVOLUTION_V2.md) | 能力打标、merge gate、harness、orchestrator 桥接 |
| [`evolution-flywheel-review.md`](evolution-flywheel-review.md) | 八飞轮能力矩阵与勾选状态 |
| [`product-development-flywheels.md`](product-development-flywheels.md) | 产品研发飞轮概念稿（策略层） |

**产物目录（非手册）**：`doc/evolution/inbox/`、`success/`、`failure/`、`runs/` 等为流水线输出，勿当架构文档编辑。

---

## Deploy & platform / 部署与平台

| Document | 中文说明 |
|----------|----------|
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Docker / Compose / Helm、发布冒烟 |
| [`K8S_CLOUD_RUNTIME.md`](K8S_CLOUD_RUNTIME.md) | K8s / 云上运行时规划 |
| [`HARNESS_EVAL.md`](HARNESS_EVAL.md) | `npm run agent:eval`、fast/nightly cases |
| [`IM_AGENT_INTEGRATION.md`](IM_AGENT_INTEGRATION.md) | 飞书 / 企微 / Webhook、静默回复、投递账本、例行预检 |

---

## Removed / 已移除

| Former path | Reason |
|-------------|--------|
| `doc/PROJECT_REVIEW.md` | 2026-04 快照，数据过时；以 ARCHITECTURE + 测试为准 |
| `doc/sandbox-research.md` | 沙箱已落地，内容与新实现矛盾 |

---

## Contributing to docs / 维护文档

- 改工具数量：运行 `node scripts/doc-sync-tools.mjs`，并更新 [`ARCHITECTURE.md`](ARCHITECTURE.md) §7。
- 改 env：同步 [`.env.example`](../.env.example) 与 [`ENV_REFERENCE.md`](ENV_REFERENCE.md)。
- 新能力：在对应专题文档顶部增加 **Implementation status** 表，并回本目录一行。
- 改默认调用链或包边界：同步根目录中英文 README、Harness 入口与 from-zero 入门路径；专题细节留在对应章节，避免在各索引重复维护。
- 改 SDK 契约：同步 `skills/agent-loop/SKILL.md`；以源码、类型与对应测试核验，不能把计划中的功能直接标为已实现。
