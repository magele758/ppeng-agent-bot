# Evolution 飞轮审查与能力规划

本文按 `doc/product-development-flywheels.md` 的 8 个飞轮审查当前项目的进化方向，并把后续演进模式整理成可执行框架。

## 实施状态（2026-05）

依据仓库文件与 `@ppeng/agent-core` 根导出（`packages/core/src/index.ts`）核对：

**已完成（Schema + HTTP + 单测，执行引擎见各模块 `*Engine`/`*Executor`）**

- [x] **Orchestrator**：`OrchestrationStore` + `/api/orchestration/*`；执行引擎 `orchestrator/engine.ts`（`runScheduler`）。
- [x] **DeepResearch**：表 + `ResearchStore` + `/api/research/*`；管线 `deepresearch/pipeline.ts`。
- [x] **Memory**：`AgentMemoryStore` 五层 + 对话回路统一；migration v9 自 `session_memory` 迁移。
- [x] **Swarm**：`SwarmStore` + `/api/swarm/*`；执行器 `swarm/executor.ts`（`runScheduler`）。
- [x] **Schema 迁移**：上述能力均落在同一套 SQLite migration 管线（非独立 `.sql` 目录）。
- [x] **Daemon readiness**：`GET /api/readiness`（`apps/daemon/src/routes/misc.ts`）。
- [x] **部署脚手架**：`deploy/docker/`、`deploy/compose/`、`deploy/helm/`。
- [x] **Harness / agent-eval**：`scripts/agent-eval/`（含 `runner.mjs`、`cases/fast/*`）；根 `package.json` 脚本 `agent-eval`、`agent:eval`、`agent:eval:fast`。
- [x] **Evolution 脚本**：`scripts/evolution/capability-tagger.mjs`、`source-score-report.mjs`、`merge-gate.mjs`（对接 fast eval）；`evolution:tag`、`evolution:source-scores`。

**下一阶段**

- [ ] 统一 B 飞轮事件字段与产品级漏斗（trace / run-day 聚合规范落地）。
- [ ] 多租户鉴权与 RBAC 在 HTTP/API 层的完整闭环（表结构已有不等于对外产品路径完备）。
- [ ] Swarm 任务市场、仲裁策略与预算治理与 orchestrator 的深度编排。
- [ ] 生产 SLO/告警、release gate 与自愈闭环的运维级自动化（脚手架之上）。

## 总体判断

当前项目的 Evolution 更像「外部知识源驱动的自动实验流水线」：`learn -> research -> worktree -> agent -> build/test -> review/refine -> rebase/merge -> result doc/showcase`。它已经能支撑 **A 知识反馈** 与 **D 主源头输入**，并具备 **C 开发期修复** 的雏形，但还没有完整覆盖产品级观测、成本容量、契约、安全与人机评测。

目标应从「抓到文章后随机找机会」升级为：

1. 先用能力地图判断本轮要补哪里。
2. 当前 Agent 作为调度器，按飞轮选择合适的 CLI-Agent / 脚本。
3. 所有实验都写结构化结果，反哺信息源、提示词、约束、eval 和发布门。
4. 上线前必须经过完整回归卡点，避免发布后无法自我闭环。

```
source inputs
  -> capability map gate
  -> current agent scheduler
  -> cli agents / scripts / domain tools
  -> full regression and redeploy gate
  -> merge / PR / reject / backlog
  -> feedback store
  -> source inputs
```

## 8 个飞轮审查

| 飞轮 | 当前覆盖 | 主要缺口 | 调整方向 |
|------|----------|----------|----------|
| A 知识反馈 | `scripts/evolution-learn.mjs`、`doc/evolution/*`、Skills、`AGENTS.md` 能沉淀知识 | 成功/失败经验没有稳定反哺 feed、研究提示词、能力地图 | 从结果文档抽取 source score、failure patterns、agent constraints |
| B 数据观测 | `/evolution` 页面、trace API、`latest-run-day.md` | 缺产品漏斗、关键路径耗时、工具失败率、源质量、断链矩阵 | 定义统一 event / metrics 字段，按 capability 聚合 |
| C SRE 修复 | Self-heal、review/refine、`@ppeng/agent-sre` 只读工具 | 缺生产 SLO/SLI、告警到任务/自愈闭环、K8s/Helm 部署方案 | 先做运维手册和 redeploy smoke gate，再补 K8s/Helm |
| D 主源头输入 | RSS、本地源、归档、研究门控 | 缺用户反馈、线上 trace、GitHub issue/PR、安全公告输入 | learn 输入扩展成多源 inbox，并按能力维度打 tag |
| E 安全合规 | 沙箱、审批、env 白名单、spawn env 清洗 | 缺 secret scan、依赖安全门、RBAC/auth 审计、部署侧 NetworkPolicy | 安全 flywheel 做成 CI/release gate 的必选项 |
| F 成本容量 | `--concurrency`、`--items`、压缩阈值、模型配置 | 缺 token/cost/latency/CI 分钟/并发 ROI 统计 | 为 run-day 与 daemon trace 增加成本容量字段与预算阈值 |
| G 契约集成 | HTTP API、SSE、A2UI、MCP、domain bundle | 缺 OpenAPI/schema 快照、SSE/A2UI/MCP 契约测试、破坏性变更检查 | 建契约测试清单，PR/release gate 强制跑 |
| H 人机质量 | review/refine、test-agent 原型、会话/evolution 轨迹 | 缺固定 eval 集、期望工具序列、人工反馈回流 | 建 `agent-eval` 用例库，失败样本反哺 prompts / Skills / `AGENTS.md` |

## 能力地图

后续每条 inbox、issue、trace、告警都应先归入一个或多个能力维度，再决定是否进入研发。

| 能力维度 | 说明 | 当前信号来源 | 推荐产出 |
|----------|------|--------------|----------|
| `runtime` | 会话、工具调用、审批、MCP、调度 | trace、issues、A/D feed | runtime patch、工具行为改进 |
| `web-console` | Next 控制台、聊天体验、A2UI、观测页 | UI feedback、e2e、trace | UX patch、组件改进、e2e case |
| `evolution` | learn/run-day/research/review/showcase | `doc/evolution/*`、RSS、本地源 | feed 调整、研究门控、run-day 指标 |
| `domain-agents` | SRE、stock、未来 K8s/安全/数据域 | domain docs、用户任务、告警 | domain bundle、只读/审批工具 |
| `security` | 沙箱、权限、secret、依赖、安全策略 | audit、security feed、review | security gate、策略测试、威胁模型 |
| `cost-capacity` | token、模型、并发、缓存、CI 分钟 | trace、billing、run-day 耗时 | budget、限流、降级、缓存 |
| `contracts` | HTTP/SSE/A2UI/MCP/domain schema | API change、CI、集成反馈 | contract tests、schema snapshots |
| `deployment` | daemon/web/PM2/K8s/Helm/rollback | SRE、ops、deploy logs | deployment docs、smoke tests |
| `agent-quality` | eval、人审、工具序列、失败样本 | sessions、eval、review comments | eval cases、prompt/skill 更新 |

## 目标能力矩阵

| 目标能力 | MVP / 现状 | 规划文档 | 下一阶段 |
|----------|------------|----------|----------|
| K8s/生产部署 | MVP：`deploy/docker`、`compose`、Helm chart | `doc/DEPLOYMENT.md` | 生产 SLO、告警、镜像扫描与滚动升级 playbook |
| Agent loop 调度器 | MVP：`OrchestrationRun`/Step/Event + SQLite store | `doc/AGENT_ORCHESTRATOR.md` | 与 Evolution/Swarm 统一的调度策略与 UI/观测 |
| DeepResearch | MVP：`ResearchStore` + tasks/sources/evidence/claims 表 | `doc/DEEP_RESEARCH.md` | 报告管线、质量门禁与对外 API 契约固化 |
| Harness/Eval | MVP：`scripts/agent-eval` fast cases + runner | `doc/HARNESS_EVAL.md` | nightly、失败样本回流 prompts/Skills |
| Teams Swarm | MVP：`SwarmStore` + 迁移表 | `doc/TEAMS_SWARM.md` | 任务市场、仲裁、预算与多角色编排 |
| SubAgent | ready（运行时 builtin） | `doc/AGENT_ORCHESTRATOR.md` | 接入调度器作为一等执行者 |
| Skill | ready | `doc/ARCHITECTURE.md` | 与 eval、能力地图字段联动 |
| 多用户有状态对话 | MVP：租户 / `agent_memory` / FTS（迁移层） | `doc/MEMORY_MULTIUSER.md` | Auth、RBAC、会话隔离的产品路径 |
| 记忆 | MVP：`SessionMemoryStore` + `agent_memory` 多层 | `doc/MEMORY_MULTIUSER.md` | team/project 语义检索策略与保留策略 |
| 自我进化 | MVP：tagger、source-score、`merge-gate` 脚本 | `doc/SELF_EVOLUTION_V2.md` | inbox/JSONL 全链路结构化与非 CLI 观测 |

建议给每个实验结果补齐以下字段（先文档约定，后续再结构化落库）：

```text
source_id
source_type
capability_tags
stage
agent
model
failure_type
risk_level
cost_estimate
test_scope
next_action
```

## Agent 调度器模式

当前 Agent 应作为「飞轮调度器」，而不是单一写代码者。它接收输入后先判断所属飞轮与能力维度，再选择合适的执行单元。

| 飞轮 | 调度目标 | 可用执行者 | 必须产出 |
|------|----------|------------|----------|
| A/D | 信息归纳、能力映射、source score | research agent、Cursor、脚本 | inbox tag、source score、候选 backlog |
| B | 观测聚合、断链识别 | 分析 agent、trace API、脚本 | failure funnel、断链矩阵、优先级 |
| C | 告警诊断、修复建议、自愈 | SRE persona、`k8s_get`、Prom/Loki、self-heal | 诊断记录、修复 PR/branch、回滚建议 |
| E | 安全审查、权限边界、secret/依赖检查 | security reviewer、audit 脚本 | threat note、gate result、blocked reason |
| F | 成本容量分析 | metrics 脚本、模型调用统计 | budget report、并发/模型建议 |
| G | 契约验证 | contract reviewer、test scripts | schema diff、breaking change 标记 |
| H | eval、人审反馈、prompt/skill 更新 | eval runner、reviewer、人类反馈整理器 | eval result、失败样本、prompt/skill patch |

调度器必须遵守三条规则：

1. **先判维度，再选 Agent**：不要让所有输入都直接进入代码实现。
2. **先产工件，再合并**：每个飞轮至少产出一个可追踪工件（doc、metric、test、PR、issue）。
3. **失败有下一跳**：网络/TLS 失败、测试失败、契约失败、安全失败、成本超限要进入不同回路，不应都记成普通 failure。

## 重新部署上线回归卡点

发布前需要一个最小 gate，保证代码上线后仍能启动、观测、自愈与继续进化。

```
candidate change
  -> build gate
  -> unit / integration / e2e
  -> contract / security gate
  -> staging redeploy
  -> health / readiness smoke
  -> self-heal / evolution loop smoke
  -> release or rollback
```

最低卡点：

| 卡点 | 必跑内容 | 失败下一跳 |
|------|----------|------------|
| Build | `pnpm run build` | 回到 Coding 修复 |
| Unit | `pnpm run test:unit` | 回到 Coding / H eval |
| Integration | `pnpm run test:integration` | 回到契约/运行时修复 |
| E2E | `pnpm run test:e2e` | 回到 UI/UX 或 API 修复 |
| Contract | HTTP/SSE/A2UI/MCP/domain schema 或 golden tests | 回到 G 契约回路 |
| Security | secret scan、dependency audit、env/sandbox/approval 检查 | 回到 E 安全回路 |
| Deploy smoke | daemon `/api/health`、web `/`、`/evolution`、API proxy、stateDir 可写 | 回到 C SRE 回路 |
| Loop smoke | self-heal start/status、`evolution --learn-only` dry path、showcase build | 回到 C/H/A 回路 |
| Rollback | 保留日志、停止 auto-merge/auto-release | 人工接管或生成修复任务 |

短期不必立即接真实生产；可以先做 staging 或本机 `start:supervised` / `dev:lab` 的 smoke 清单。

## 功能缺失清单

### P0：先补闭环基础

- **产品级观测**：统一事件/指标字段，覆盖用户路径、工具失败、模型耗时、run-day stage。
- **固定 eval 集**：沉淀会话、工具、A2UI、domain agent 的基础用例，作为 H 飞轮入口。
- **发布回归卡点**：把 build/test/e2e/contract/security/deploy smoke 串成 release checklist。
- **Agent 调度器工件规范**：规定每个飞轮输入、执行者、产出、失败下一跳。

### P1：让 Evolution 更定向

- **能力标签**：inbox 与 result doc 增加 capability tags。
- **source score**：按 success/no-op/failure/fetch-fail 反馈调整 feed 权重。
- **failure taxonomy**：区分 infra、model/TLS、test、contract、security、cost、merge conflict。
- **failure patterns 反哺**：将高频失败写回 `agent-constraints`、research prompt 或 eval cases。

### P2：生产化与集成

- **Docker/K8s/Helm 方案**：补最小部署拓扑、Secret、PVC、Ingress、readiness、rollback。
- **SLO/SLI 与告警模板**：定义 daemon/web/evolution 的可用性、延迟、失败率。
- **契约测试层**：HTTP/SSE/A2UI/MCP/domain bundle 的 schema snapshots。
- **安全门禁**：secret scan、dependency audit、API auth/RBAC、镜像扫描。

## 阶段依赖与里程碑

```
Phase 0: capability map (本文档)           ── 无前置
Phase 1: Deployment + Harness              ── 可并行，无互相依赖
Phase 2: Orchestrator                      ── 依赖 Harness 作为 gate
Phase 3: DeepResearch + Memory             ── 可并行，依赖 Orchestrator 做 run 管理
Phase 4: Swarm                             ── 依赖 Orchestrator + Memory
Phase 5: Evolution 2.0                     ── 依赖以上所有作为 gate + feedback
```

各阶段内部可再拆 MVP 与完整版：

- **MVP**：1-2 天可交付的最小可验证切片，用于解锁下一阶段。
- **完整版**：MVP 验收后再补齐全量功能。

所有新增类型（`OrchestrationRun`、`SwarmRun`、`ResearchTask`、memory 扩展字段等）最终统一落到 `packages/core/src/types.ts`，各文档中的定义仅作设计参考。

## 成本模型归口（F 飞轮）

Orchestrator、Swarm、DeepResearch、Evolution 各自都有 budget/cost 字段。为避免漂移，统一约定：

- 预算字段名统一为 `budget: { maxTurns, maxCostUsd, maxDurationMs }`。
- 成本记录字段统一为 `costEstimate`（单次）、`totalCost`（累计）。
- 第一阶段只做**统计与报告**，不做自动限流/降级；待积累数据后再接入熔断。
- 独立的成本仪表盘从 trace 和 JSONL 聚合，不在每个能力内部重复建设。

## 推荐实施顺序

1. 先把本文作为策略基线，与 `doc/product-development-flywheels.md` 和 `README.md` 互链。
2. 下一步补一个轻量 `doc/evolution-capability-map.md` 或在本文件继续维护能力地图。
3. 然后实现结构化 run 事件和 release checklist，优先服务 B/F/H/C。
4. 最后再做 Docker/K8s/Helm 与契约测试自动化。

