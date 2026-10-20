# 20 — Orchestrator / Swarm / DeepResearch / Self-heal / Evolution / Eval

> **定位**：这些能力位于自建 turn loop 之上，不替代 `RawAgentRuntime`。本章只列入口、持久状态、HTTP API 和与 session 执行的接缝。Self-Heal 与 Swarm 的概念说明分别见 [10](10-self-heal.md) 和 [11](11-subagents-and-swarm.md)。

---

## 0. 能力地图（相对现有 harness）

| 能力 | 实现主路径 | harness 原状 | 本章补什么 |
|------|------------|--------------|------------|
| Agent Orchestrator | `packages/core/src/orchestrator/` + `/api/orchestration/*` | README 架构图点名；无专章 | runs/steps/events、引擎 tick、与 Swarm/Research 接缝 |
| Teams Swarm | `swarm/` + `/api/swarm/*` | [11](11-subagents-and-swarm.md) 概念足 | HTTP 面、超时实现名、pipeline MVP、挂 Orchestration |
| DeepResearch | `deepresearch/` + `/api/research/*` | 几乎空白 | task→source→evidence→claim 管线与 API |
| Self-heal | `self-heal/` + flow/supervisor | [10](10-self-heal.md) 流程足 | restart-request 握手、API/CLI、flow 参数 |
| Evolution / 2.0 / A/B | `scripts/evolution*` | from-zero/11 一行 | **入口索引 + 链到专题**（不复述管线全文） |
| Harness eval | `scripts/agent-eval/` | from-zero/10 极简 | runner、cases、`--exit-on-fail`、jsonl |
| E2E Lab | `scripts/e2e-run.mjs` | from-zero/09 一句 | 临时 daemon+Next、auth 隔离 |

专题深读（勿在 harness 重复长文）：

| 主题 | 文档 |
|------|------|
| Orchestrator | [`../AGENT_ORCHESTRATOR.md`](../AGENT_ORCHESTRATOR.md) |
| Swarm | [`../TEAMS_SWARM.md`](../TEAMS_SWARM.md) |
| DeepResearch | [`../DEEP_RESEARCH.md`](../DEEP_RESEARCH.md) |
| Eval 基线规划 | [`../HARNESS_EVAL.md`](../HARNESS_EVAL.md) + [`../../scripts/agent-eval/README.md`](../../scripts/agent-eval/README.md) |
| Evolution | [`../evolution/README.md`](../evolution/README.md)、[`../SELF_EVOLUTION_V2.md`](../SELF_EVOLUTION_V2.md) |
| A/B Release | [`../SELF_EVOLUTION_AB_RELEASE.md`](../SELF_EVOLUTION_AB_RELEASE.md) |
| Self-heal 架构摘要 | [`../ARCHITECTURE.md`](../ARCHITECTURE.md)（Self-heal 小节） |

---

## 1. Agent Orchestrator

### 1.1 在栈里的位置

```
信号（用户 / Evolution / eval 失败 …）
        │
        ▼
 OrchestrationRun  (SQLite: orchestration_runs)
        │  tick → bootstrap steps
        ▼
 steps: classify → research → implement → review → test
        │              │            │
        │              ▼            ▼
        │       ResearchPipeline   SwarmExecutor (strategy=pipeline)
        │              │            │
        └──────── events append-only (orchestration_events)
```

- **Store**：`OrchestratorStore`（`orchestrator/store.ts`）— runs / steps / events CRUD。  
- **Engine**：`OrchestrationEngine.tick()`（`orchestrator/engine.ts`）— 由 daemon scheduler 周期驱动；**不是**替代 turn loop，而是调度「下一阶段谁干活」。  
- **Bootstrap stages**（空 steps 时写入）：`classify` → `research` → `implement` → `review` → `test`。  
  - `classify`：标题/tags 规则打 `riskLevel`（无 LLM）。  
  - `research`：可选 `runResearch` → DeepResearch。  
  - `implement`：`startSwarmForRun` + 同 tick 内观察 Swarm 终态。  
  - `review` / `test`：注入的 sync 执行器（常为 subagent）。

类型要点：`FlywheelType` A–H、`CapabilityTag`、`OrchestrationBudget`、`RiskLevel` — 见 `orchestrator/types.ts`。

### 1.2 HTTP API（daemon）

路由：`apps/daemon/src/routes/orchestration.ts`。

| 方法 | 路径 | 作用 |
|------|------|------|
| GET/POST | `/api/orchestration/runs` | 列表 / 创建（title、sourceType/Ref、flywheels、capabilityTags、riskLevel、budget） |
| GET | `/api/orchestration/runs/:id` | run + steps + events |
| PATCH | `/api/orchestration/runs/:id/status` | 改 run 状态 |
| GET/POST | `/api/orchestration/runs/:id/steps` | 步骤列表 / 追加 |
| GET/POST | `/api/orchestration/runs/:id/events` | 事件流 / 追加 |

Evolution 可选记账：`EVOLUTION_USE_ORCHESTRATOR=1` → `scripts/evolution/evolution-orchestrator-bridge.mjs` 写 run 状态（详见 [`../AGENT_ORCHESTRATOR.md`](../AGENT_ORCHESTRATOR.md)）。

### 1.3 亮点（相对「只开 session」）

1. **阶段工件化**：step 有 `inputArtifact` / `outputArtifact` / `failureType` / `nextAction`，失败可导航。  
2. **风险先分类再实现**：高风险标签在 implement 前可见。  
3. **与 Swarm / Research 同进程组合**，但仍各自 SQLite 表，查询边界清晰。

---

## 2. Teams Swarm（加深 [11](11-subagents-and-swarm.md)）

概念、三种粒度、信箱见切片 11。此处补 **API + 超时真源 + 与 Orchestrator 挂钩**。

### 2.1 HTTP

`apps/daemon/src/routes/swarm.ts`：

| 方法 | 路径 | 作用 |
|------|------|------|
| GET/POST | `/api/swarm/runs` | 列表 / 创建（goal、strategy、budget、`orchestrationRunId?`） |
| GET | `/api/swarm/runs/:id` | run 详情 |
| POST | `/api/swarm/runs/:id/start` | `SwarmExecutor.startRun`（可 seed tasks） |
| PATCH | `/api/swarm/runs/:id/status` | 改状态 |
| GET/POST | `/api/swarm/runs/:id/tasks` | 任务 |
| PATCH | `/api/swarm/tasks/:taskId/status` | 任务状态 |
| POST | `/api/swarm/tasks/:taskId/claim` | claim |
| GET/POST | `/api/swarm/runs/:id/reviews` | review / 仲裁记录 |

### 2.2 超时（文档名 vs 代码）

切片 11 写的 `checkTimeout` 对应实现是：

- `SwarmStore.getTimedOutRuns(nowMs)`：`createdAt + budget.maxDurationMs < now`  
- `SwarmExecutor.tick()` 开头把超时 run 标 `failed`

默认 `maxDurationMs` 见 store（600_000）。策略：**仅 `pipeline` MVP**；其他 strategy fail-closed 并写一条 system review（见 [`../TEAMS_SWARM.md`](../TEAMS_SWARM.md) Implementation status）。

### 2.3 与 Orchestrator

`SwarmRun.orchestrationRunId` 可选；引擎 `implement` step 通过 deps 拉起并等待 Swarm 终态（`completed|failed|cancelled`）。

---

## 3. DeepResearch

### 3.1 数据模型（四层）

```
ResearchTask
  └─ ResearchSource[]   (kind: web|rss|github|arxiv|…, trustLevel)
       └─ ResearchEvidence[]  (quote, relevance)
  └─ ResearchClaim[]    (confidence, evidenceIds[], caveats?)
```

管线：`ResearchPipeline`（`deepresearch/pipeline.ts`）— search（`RAW_AGENT_WEB_SEARCH_URL` / 注入）→ 解析 hits → fetch 正文片段 → evidence → synthesize claims → 可选写 markdown `reportPath`（`stateDir`）。

状态：`pending → searching → extracting → synthesizing → critiquing → completed|failed`。

### 3.2 HTTP

`apps/daemon/src/routes/research.ts`：

| 方法 | 路径 |
|------|------|
| GET/POST | `/api/research/tasks` |
| GET | `/api/research/tasks/:id`、`.../status` |
| POST | `/api/research/tasks/:id/run` |
| GET/POST | `/api/research/tasks/:id/sources` |
| GET/POST | `/api/research/tasks/:id/evidence` |
| GET/POST | `/api/research/tasks/:id/claims` |

CLI：`apps/cli` 有 `research` 子命令包装上述 API。Builtin 工具层未单独暴露 `research_*` 时，优先 HTTP / 引擎注入的 `runResearch`（见 [`../DEEP_RESEARCH.md`](../DEEP_RESEARCH.md)）。

### 3.3 为何算 harness 能力

Evolution / Orchestrator 的「值不值得改代码」依赖**可引用结论**；claim↔evidence 比裸 LLM 摘要更可评测（fast case 已有 `research-tasks.json`）。

---

## 4. Self-heal（加深 [10](10-self-heal.md)）

流程、worktree、白名单 preset 见切片 10。补 **运维接缝**。

### 4.1 状态机（代码注释）

```
pending → running_tests → fixing → tests_passed → merging
       → restart_pending → completed
旁路：blocked | stopped | failed | merge_conflict
```

调度器：`SelfHealScheduler`（`self-heal/self-heal-scheduler.ts`）；测试/git：`self-heal-executors.ts`；policy→npm script：`self-heal-policy.ts`。

### 4.2 HTTP / CLI

| 入口 | 说明 |
|------|------|
| `POST /api/self-heal/start` | 开跑（body 可带 policy 片段） |
| status / runs / events / stop / resume | 见 CLI `self-heal *` |
| `GET /api/daemon/restart-request` | 读 `daemon_control.restart_request` |
| `POST /api/daemon/restart-request/ack` | supervisor ACK → run `restart_pending`→`completed` |

### 4.3 supervisor 握手

`scripts/supervisor.mjs`（`pnpm run start:supervised`）：

1. 拉起 daemon 子进程，等 `/api/health`  
2. 轮询 `restart-request`（`SUPERVISOR_POLL_MS`，默认 3s）  
3. 发现请求 → **先 ACK** → 停旧进程 → 再起新进程（含 crash-loop 保护）

合并后可选推远端：`RAW_AGENT_SELF_HEAL_GIT_PUSH`；spawn 找不到 npm/git：`RAW_AGENT_NPM_BIN` / `RAW_AGENT_GIT_BIN`。

### 4.4 flow 脚本

`pnpm run self-heal:flow` → `scripts/self-heal-flow.sh`：

- 默认：脏工作区则 stash → 调 daemon → 轮询终态 → stash pop  
- `sheal_*`：只 resume 指定 run  
- `--new`：强制新开  
- `SELF_HEAL_FLOW_NO_STASH=1` 或 `--no-stash`：不 stash（要求主仓干净）

临时/黑盒脚本应设 `RAW_AGENT_SELF_HEAL_AUTO_START=0`，避免与本机 `.env` 自愈冲突（eval/e2e/regression 已做）。

---

## 5. Evolution（入口索引，不复述管线）

| 入口 | 作用 |
|------|------|
| `pnpm run evolution [opts]` | 统一 CLI（`scripts/evolution-cli.mjs`）；`--help` |
| `evolution:learn` / `evolution:run-day` / `evolution:pipeline` | 底层分步 |
| `--learn` / `--agent` / `--review` / `--merge` / `--pipeline-build` | 常用开关；见根 `.env.example` `EVOLUTION_*` |

**2.0 质量层**（[`../SELF_EVOLUTION_V2.md`](../SELF_EVOLUTION_V2.md)）：

| 开关 / 脚本 | 作用 |
|-------------|------|
| `scripts/evolution/capability-tagger.mjs`（`pnpm run evolution:tag`） | 能力打标 |
| `scripts/evolution/source-score-report.mjs` | 来源评分 |
| run-day → `doc/evolution/runs/YYYY-MM-DD.jsonl` | 运行事件 |
| `EVOLUTION_MERGE_RISK_CHECK=1` | `merge-gate.mjs`：low 自动 / medium 警告 / high → `doc/evolution/backlog/` |
| `EVOLUTION_HARNESS_GATE=1` | 合并前 `agent:eval --mode fast --exit-on-fail` |
| `EVOLUTION_USE_ORCHESTRATOR=1` | 记账到 Orchestrator |

**A/B Release**：`pnpm run release`（`scripts/release-orchestrator.mjs`）；Compose `stable|candidate` / Helm `values-candidate.yaml`；报告 `doc/evolution/reports/<release_run_id>.json` — 见 [`../SELF_EVOLUTION_AB_RELEASE.md`](../SELF_EVOLUTION_AB_RELEASE.md)。

观测：daemon `GET /api/evolution/overview|results|result/:id`（Lab `/evolution`）。

---

## 6. Harness eval

> from-zero [10](from-zero/10-eval-harness.md) 是「挂在循环外的质量门」一句话；此处对齐**真实 runner 行为**。规划愿景仍以 [`../HARNESS_EVAL.md`](../HARNESS_EVAL.md) 为准。

### 6.1 入口

```bash
pnpm run agent:eval                 # 默认 fast
pnpm run agent:eval:fast            # 同上 --mode fast
pnpm run agent:eval --mode nightly
pnpm run agent:eval --case session-create
pnpm run agent:eval --mode fast --exit-on-fail
```

- Runner：`scripts/agent-eval/runner.mjs`  
- Cases：`scripts/agent-eval/cases/fast/`（及 nightly）  
- 需先有 `apps/daemon/dist`（缺则 exit 2）

### 6.2 运行模型

1. `envForEphemeralDaemon()`：**剥离宿主 `RAW_AGENT_AUTH_TOKEN`** + sandbox 注入 env（`scripts/spawn-utils.mjs`）  
2. 随机端口 + 临时 `RAW_AGENT_STATE_DIR`；`RAW_AGENT_SELF_HEAL_AUTO_START=0`、`RAW_AGENT_E2E_ISOLATE=1`  
3. 等 `/api/health` → 逐 case（多为 HTTP/行为断言；fast 侧偏 heuristic / 端点可达）  
4. 结果 append：`doc/eval-results/YYYY-MM-DD.jsonl`（每行一 case）  
5. **退出码**：默认**始终 0**（打印失败也 0）；仅 `--exit-on-fail` 时 fail/daemon 挂 → exit 1  

CI / merge-gate / release gates 均带 `--exit-on-fail`（见 `doc/CI.md`、`scripts/evolution/merge-gate.mjs`、`scripts/release/gates.mjs`）。

### 6.3 与编排能力相关的 fast cases（示例）

已存在：`orchestration-runs.json`、`swarm-runs.json`、`research-tasks.json`、`evolution-overview.json` 等——验证 API 面可达，而非完整多 agent 故事（完整故事属 nightly 规划）。

---

## 7. E2E（Lab + auth 隔离）

| 项 | 说明 |
|----|------|
| 入口 | `pnpm run test:e2e` → `scripts/e2e-run.mjs` |
| 自管栈 | 临时 daemon + Next `start`（随机端口）；注入**同一**随机 `RAW_AGENT_AUTH_TOKEN`；Next middleware 出站补 Bearer |
| 断言 | Playwright 可经 `PLAYWRIGHT_AUTH_PROBE_DAEMON_ORIGIN` 验「直连 daemon 401 / 经 Lab 200」 |
| 外置栈 | 设 `PLAYWRIGHT_BASE_URL` 指向已有控制台时，不自拉进程，也无上述 auth 双端断言 |
| 隔离 | 同样走 `envForEphemeralDaemon()` 基线，再**显式设**脚本生成的 token；`SELF_HEAL_AUTO_START=0` |

Lab 代理细节见 from-zero [09-web-console](from-zero/09-web-console.md)。回归/integration 临时 daemon **不继承**宿主 token，原因与 eval 相同：黑盒脚本默认不带 Bearer。

---

## 8. 端到端拼图（一张图）

```
            Evolution learn/run-day          agent:eval / test:e2e
                     │                              │
                     │  (可选 bridge / harness gate) │
                     ▼                              ▼
              OrchestrationRun  ←—————— 质量信号 / 失败回流
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
   DeepResearch   Swarm(pipeline)  review/test subagent
         │           │
         └───── SQLite + HTTP 可查 ─────┘
                     │
              Self-heal (worktree) ──restart-request──► supervisor
```

---

## 关键文件（速查）

| 路径 | 说明 |
|------|------|
| `packages/core/src/orchestrator/{engine,store,types}.ts` | 编排引擎 |
| `packages/core/src/swarm/{executor,store,types}.ts` | Swarm |
| `packages/core/src/deepresearch/{pipeline,store,types}.ts` | Research |
| `packages/core/src/self-heal/*` | Self-heal |
| `apps/daemon/src/routes/{orchestration,swarm,research}.ts` | HTTP |
| `apps/daemon/src/routes/misc.ts` | restart-request |
| `scripts/supervisor.mjs` / `scripts/self-heal-flow.sh` | 运维 |
| `scripts/evolution-cli.mjs` / `scripts/evolution/*` | Evolution |
| `scripts/agent-eval/runner.mjs` | Eval |
| `scripts/e2e-run.mjs` / `scripts/spawn-utils.mjs` | E2E / auth 隔离 |
| `scripts/release-orchestrator.mjs` | A/B release |

---

## 与 from-zero 的分工

| 读者目标 | 读 |
|----------|-----|
| 「eval / evolution 挂在循环外」一句话 | from-zero [10](from-zero/10-eval-harness.md) / [11](from-zero/11-evolution-and-self-heal.md) |
| Self-heal / Swarm 设计叙事 | [10](10-self-heal.md) / [11](11-subagents-and-swarm.md) |
| **API、门禁、接缝、评测退出码** | **本章** |
| 产品规划长文 | 上表「专题深读」 |
