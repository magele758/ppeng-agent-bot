# Teams Swarm

## Implementation status（与代码对齐）

| 能力 | 状态 |
|------|------|
| SQLite `swarm_*` 表 + `SwarmStore` | 已实现 |
| HTTP `/api/swarm/*`、`POST .../runs/:id/start` | 已实现 |
| `SwarmExecutor.tick`（`runScheduler`） | 已实现；**`pipeline` 策略 MVP** |
| Teammate 完成判定 | `in_progress` 任务仅在 session **`completed`**，或 **`idle` 且已有 assistant/tool 消息** 时标 `done`（避免未跑过的 idle 被误判完成） |
| 调度唤醒 | `dispatchTask` 后 `enqueueSchedulerWake(sessionId, 'swarm.task')`，由 `AutonomousScheduler` 在同一 `runScheduler` 周期内 `runSession` |
| 其他 strategy（debate、best-of-n 等） | 规划；非 pipeline 会标记失败或 blocked |
| Web Console | Ops 页 **Swarm** 卡片（创建并启动） |

下文含目标形态与未落地策略的详细设计。

---

当前项目已有 teammate、mailbox、team overview、task 依赖和 `spawn_subagent`。Teams Swarm 把这些基础能力升级为可控的多 Agent 协作：任务拆分、并行执行、仲裁、预算、质量门。

## 目标

1. 一个目标可拆成多个 role / task 并行推进。
2. 每个 teammate 的职责、预算、输出可追踪。
3. 多个 reviewer/evaluator 能仲裁结果。
4. Swarm 有停止条件，避免无限循环或成本失控。

## Swarm run 模型

```ts
interface SwarmRun {
  id: string;
  goal: string;
  status: 'pending' | 'planning' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
  strategy: 'pipeline' | 'parallel-review' | 'best-of-n' | 'debate' | 'research-implement-review';
  budget: {
    maxTeammates: number;
    maxTurnsPerAgent: number;
    maxDurationMs: number;
    maxCostUsd?: number;
  };
  qualityGate: string[];
  createdAt: string;
  updatedAt: string;
}
```

## 角色模板

| Role | 职责 | 默认工具 |
|------|------|----------|
| planner | 拆目标、定义验收标准、排任务依赖 | read/search/task |
| researcher | 查资料、归纳证据、写 research note | read/web/research |
| implementer | 改代码或文档 | read/edit/bash |
| reviewer | 审查 diff、找风险 | read/git diff |
| evaluator | 跑 eval / harness，给结论 | test/harness |
| sre | 部署/监控/故障诊断 | SRE domain tools |
| security | 威胁建模、secret/audit | read/audit |

## 协作协议

默认 pipeline：

```text
planner
  -> researcher
  -> implementer
  -> reviewer
  -> evaluator
  -> final summary
```

并行 review：

```text
implementer
  -> reviewer A
  -> reviewer B
  -> evaluator
  -> arbiter
```

best-of-n：

```text
planner
  -> implementer 1
  -> implementer 2
  -> implementer 3
  -> evaluator selects best
```

## 任务市场

基于现有 `tasks` / `blockedBy` 扩展：

```text
task.status: pending | claimed | in_progress | blocked | review | done | failed
task.ownerAgentId
task.requiredRole
task.capabilityTags
task.acceptanceCriteria
task.artifacts
task.budget
```

行为：

- planner 创建任务和依赖。
- teammate 按 role claim task。
- blocked task 等依赖完成后进入 pending。
- reviewer/evaluator 对 artifact 评分。
- arbiter 汇总最终结果。

## 仲裁机制

| 场景 | 仲裁方式 |
|------|----------|
| 单 reviewer 通过 | 低风险任务可完成 |
| reviewer 分歧 | evaluator 汇总并要求修订 |
| 高风险任务 | 至少 reviewer + evaluator 双通过 |
| best-of-n | evaluator 按测试/评分选最佳 |
| 安全/部署任务 | 必须人工批准或 release gate 通过 |

评分字段：

```text
correctness
test_coverage
risk
maintainability
contract_safety
deployment_safety
cost_impact
```

## 预算控制

Swarm 必须默认有预算：

- max teammates
- max total turns
- max turns per teammate
- max wall-clock time
- max tool calls
- max cost estimate
- allowed tools by role

超预算行为：

1. 停止新 teammate。
2. 要求 planner 汇总当前状态。
3. 标记 `blocked: budget_exceeded`。
4. 等待用户或调度器批准继续。

## Web Console 需求

Teams 视图建议增强：

- Swarm runs 列表。
- DAG：task 依赖、owner、状态。
- Mailbox timeline。
- 每个 teammate 的 artifacts。
- reviewer/evaluator 评分。
- 操作：pause、resume、spawn reviewer、approve merge、cancel。

## 与 Harness 的关系

Swarm 输出不能只靠自然语言总结，必须经过 Harness：

- sprint contract 是否满足。
- 工具序列是否合理。
- 代码是否通过测试。
- evaluator feedback 是否记录。
- 高风险改动是否经过 release gate。

## 第一批 Swarm 场景

| 场景 | 目标 |
|------|------|
| `doc-refactor-swarm` | 多 agent 审查并整理文档结构 |
| `feature-small-pipeline` | planner/researcher/implementer/reviewer/evaluator 完成小功能 |
| `best-of-n-prompt` | 多个 agent 改同一 prompt，eval 选最佳 |
| `sre-incident-swarm` | SRE + reviewer + implementer 处理故障记录 |
| `deepresearch-to-backlog` | researcher 产报告，planner 转 backlog |

## MVP：最小可用 Swarm

第一步不做完整 DAG + arbiter + 预算引擎，只实现：

1. planner spawn 2 个 teammate（implementer + reviewer）。
2. implementer 完成后通过 mailbox 交付给 reviewer。
3. reviewer 审查后写 evaluator_feedback。
4. planner 汇总结果、标记 SwarmRun completed。
5. 超时（默认 10 分钟）自动停止并汇总。

验收：`pnpm run test:unit` 中有一个 heuristic 模式下的 2-agent pipeline case。

## debate 协议

debate 策略下两个 Agent 交替通过 mailbox 辩论：

1. Agent A 提出方案并 `send_message` 给 Agent B。
2. Agent B 收到后提出反驳或改进，`send_message` 回 A。
3. 重复最多 N 轮（默认 3）。
4. evaluator 读取双方所有消息，做最终裁定。

每条 mailbox 消息带 `correlationId` 为 SwarmRun id，方便追踪。

## 可观测性

除了超预算停止，Swarm 还需要：

- **卡住检测**：若某 teammate 超过 `maxTurnsPerAgent` 仍未产出 artifact，planner 收到通知并决定是否替换/终止。
- **中间态报告**：每个 teammate 完成一步后，SwarmRun.status 更新为 `running`，Web Console 可实时看到 DAG 进度。
- **超时告警**：SwarmRun 接近 `maxDurationMs` 的 80% 时写一条 trace event，供仪表盘展示。

## 验收

- 一个中等任务可自动生成任务 DAG。
- 至少 2 个 teammate 可并行工作并通过 mailbox 交接。
- reviewer/evaluator 的结论可追踪。
- 超预算时 Swarm 停止并等待批准。
- 产物能进入 PR、doc、eval result 或 backlog。

