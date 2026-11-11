# Agent 调度器 Loop 规划

## Implementation status（与代码对齐）

| 能力 | 状态 |
|------|------|
| SQLite 表 + `OrchestratorStore` CRUD | 已实现（migration v5，`/api/orchestration/*`） |
| Evolution 记账 | 可选 `EVOLUTION_USE_ORCHESTRATOR=1` → POST/PATCH run 状态 |
| `OrchestrationEngine`（step 生成与分派） | 见 `packages/core/src/orchestrator/engine.ts`；`research`→`ResearchPipeline`，`review`/`test`→同步 subagent，`implement`→Swarm 并等同 tick 内 `swarmExecutor.tick()` |
| Web Console Orchestration 视图 | 见「更多」面板；Swarm 见「会话与任务」 |

下文「规划」章节描述目标形态；已实现部分以代码与上表为准。

---

本文定义“当前 Agent 作为调度器”的目标形态：它不只是完成单次会话，而是把来自用户、RSS、trace、告警、issue 的信号映射到能力地图和 8 个飞轮，再选择合适的 CLI-Agent、SubAgent、Teammate、domain tool 或脚本执行。

## 目标

1. 输入信号先分类，再执行，避免所有事情都直接进入 coding。
2. 每个执行计划都有状态、owner、工件、失败下一跳。
3. 高风险任务默认进入审批、PR 或人工确认。
4. 调度结果可被 Web Console、Evolution、Harness、Self-heal 复用。

## 输入信号

| Signal | 来源 | 例子 | 默认飞轮 |
|--------|------|------|----------|
| `manual_request` | 用户会话 | “实现 K8s 部署能力” | D / B |
| `rss_item` | Evolution learn | arXiv、技术博客 | A / D |
| `trace_event` | daemon trace | tool failure、latency spike | B / F |
| `alert` | SRE / Prom / Loki / PagerDuty | error rate high | C |
| `security_notice` | audit / advisories | CVE、secret leak | E |
| `contract_change` | PR / API diff | SSE chunk 变化 | G |
| `eval_failure` | Harness | wrong tool sequence | H |

## 核心类型

建议先在文档中稳定类型，再落到 `packages/core/src/orchestrator/`。

```ts
type FlywheelType = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

type CapabilityTag =
  | 'runtime'
  | 'web-console'
  | 'evolution'
  | 'domain-agents'
  | 'security'
  | 'cost-capacity'
  | 'contracts'
  | 'deployment'
  | 'agent-quality'
  | 'memory'
  | 'multi-user'
  | 'deepresearch'
  | 'swarm'
  | 'skills'
  | 'subagent';

type OrchestrationStage =
  | 'classify'
  | 'research'
  | 'design'
  | 'implement'
  | 'review'
  | 'test'
  | 'deploy-smoke'
  | 'retrospective'
  | 'done'
  | 'blocked';
```

## 执行计划模型

```ts
interface OrchestrationRun {
  id: string;
  title: string;
  sourceType: string;
  sourceRef: string;
  flywheels: FlywheelType[];
  capabilityTags: CapabilityTag[];
  riskLevel: 'low' | 'medium' | 'high';
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'blocked';
  budget?: {
    maxTurns?: number;
    maxCostUsd?: number;
    maxDurationMs?: number;
  };
  createdAt: string;
  updatedAt: string;
}

interface OrchestrationStep {
  id: string;
  runId: string;
  stage: OrchestrationStage;
  executor: string;
  inputArtifact?: string;
  outputArtifact?: string;
  status: string;
  failureType?: string;
  nextAction?: string;
}
```

## 执行者路由

| 场景 | 首选执行者 | 备用执行者 | 产出 |
|------|------------|------------|------|
| 技术源归纳 | `researcher` subagent | Cursor CLI | source summary、capability tags |
| 设计/方案 | `planner` subagent | Codex / Claude | design note、acceptance criteria |
| 实现 | Cursor CLI / `implementer` | Claude Code | branch、diff、test notes |
| 审查 | `reviewer` / Codex | Kieran/TypeScript reviewer | review report、risk level |
| 测试补强 | Gemini / evaluator | local scripts | test patch、eval result |
| SRE 诊断 | `sre-oncall` | Prom/Loki/K8s tools | incident note、fix candidate |
| 安全 | security reviewer | audit scripts | threat note、blocked reason |
| 契约 | contract reviewer | schema scripts | schema diff、breaking flag |
| 发布 | shell scripts | Helm / kubectl | smoke result、rollback note |

## 状态持久化

**已实现**：SQLite 表（migration v5），见 `packages/core/src/stores/migrations/index.ts`。

建议表（历史规划，已与实现对齐）：

```text
orchestration_runs
orchestration_steps
orchestration_artifacts
orchestration_events
```

事件字段：

```text
run_id
step_id
kind
actor
payload_json
created_at
```

与现有表关系：

- `sessions.parent_session_id` 可关联 subagent/teammate。
- `tasks` 可作为执行项。
- `task_events` 可追加 orchestration metadata。
- `approvals` 用于高风险 step。
- `traces` 用于观测执行行为。

## 调度流程

```
signal received
  -> classify flywheel and capability
  -> create orchestration run
  -> create steps
  -> assign executor
  -> run or wait for approval
  -> collect artifacts
  -> run harness/release gate if needed
  -> mark done / blocked / failed
  -> feed result to Evolution, Memory, Eval
```

## 失败分类

| failure_type | 下一跳 |
|--------------|--------|
| `infra_network` | retry / F 成本容量 |
| `model_unavailable` | model fallback / budget |
| `test_failed` | implementer / self-heal |
| `contract_failed` | G 契约回路 |
| `security_blocked` | E 安全回路 |
| `cost_exceeded` | F 成本回路 |
| `needs_human` | approval / PR |
| `no_actionable_signal` | A/D source score 降权 |

## Web Console 视图

建议新增 “Flywheel / Orchestration” 视图：

- run 列表：状态、能力标签、飞轮、风险、owner。
- step 时间线：stage、executor、artifact、失败类型。
- artifact 面板：设计、diff、eval、release smoke。
- 手动操作：approve、reject、rerun、convert to backlog、spawn reviewer。

## 调度器运行载体

调度器作为 daemon 内的服务运行，不是独立进程。`RawAgentRuntime.runScheduler()` 每 1.5s 顺序为：`selfHeal.processRuns()` → `swarmExecutor.tick()` → **`orchestrationEngine.tick()`** → `processAutonomousSessions()`（消费 `enqueueSchedulerWake`）。`OrchestrationEngine` 在 Swarm tick **之后**、自主调度 **之前** 运行；`implement` 步启动 Swarm 后会在**同一次** `orchestrationEngine.tick` 内再调一次 `swarmExecutor.tick()` 以尽快分派 pipeline 任务。收到 signal 后创建/推进 `OrchestrationRun`，并按 step 分派给 ResearchPipeline、Swarm、同步 subagent（review/test）或 CLI。

## OrchestrationRun 与 SwarmRun 的关系

`SwarmRun` 是 `OrchestrationRun` 的一种**执行策略特化**：当 orchestrator 判断一个 run 需要多 agent 协作时，创建一个 SwarmRun 作为子结构挂在 `OrchestrationStep` 下。一个 OrchestrationRun 可以不包含 Swarm（单 agent 即可完成），也可以包含一到多个 SwarmRun（复杂任务拆多个协作阶段）。

## 并发控制

多个 signal 同时到达时：

- 相同 sourceRef 去重（同一 RSS item / issue 不重复创建 run）。
- 不同 signal 可并行创建 run，但受全局并发上限（类似 `EVOLUTION_CONCURRENCY`）限制。
- 高风险 run 自动降为串行（等待人工批准后再执行下一步）。
- 共享资源（如 git 主分支合并）使用互斥锁，复用现有 `createMergeMutex` 模式。

## 与现有能力的落点

| 已有能力 | 调度器如何复用 |
|----------|----------------|
| `spawn_subagent` | 短任务、隔离上下文研究/审查 |
| `spawn_teammate` | 长任务、后台协作 |
| mailbox | handoff 与异步结果回传 |
| self-heal | test_failed 的自动修复执行器 |
| Evolution | A/D 输入与自进化执行器 |
| Skills | 调度器策略、domain playbook |
| Domain agents | SRE/Stock/未来 K8s 等垂直工具 |


## 审查与测试完成条件（2026-11-11）

review/test 执行器必须返回逐项结构化质量结果。生产接线读取已完成 Swarm 的任务、产物引用、审查结果和实现会话上下文，启动独立检查者。只有全部检查有实际工具证据且通过才完成阶段；自然语言 PASS、空结果、无执行器、异常或失败都使运行失败，并保留失败原因、阶段结果与事件。外部暂停/取消发生在等待期间时，不用迟到结果覆盖新状态。恢复或重跑仍需明确创建或管理新的执行，不宣称自动修复任意失败任务。
