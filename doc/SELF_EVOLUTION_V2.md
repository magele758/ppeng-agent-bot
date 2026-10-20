# Self-Evolution 2.0 规划

当前 Evolution 已能从 RSS / 本地源学习，筛选条目，创建 worktree，让 Agent 修改代码并测试。Self-Evolution 2.0 的目标是把它升级为能力地图驱动、可观测、可回滚、可评测的长期进化系统。

## 目标

1. 每次进化都能说明“补哪个能力缺口”。
2. 来源、Agent、模型、测试、成本都有结构化记录。
3. 自动合并前必须经过 Harness 与 release gate。
4. 成功/失败/no-op 都反哺 source score、prompt、constraints、eval。

## 当前流水线

```text
learn
  -> inbox
  -> research gate
  -> worktree
  -> agent implement
  -> build/test
  -> review/refine
  -> rebase/merge
  -> result docs/showcase
```

问题：

- capability tags / source score **脚本已有**（`pnpm run evolution:tag`、`pnpm run evolution:source-scores`），缺 inbox/结果文档全链路默认写入与观测聚合。
- failure 类型过粗。
- 成本/耗时没有结构化聚合。
- 自动合并未统一接 Harness / release smoke。
- no-op 结果没有持续优化 feed 策略。

## 目标流水线

```text
learn
  -> source normalization
  -> capability tagging
  -> source scoring
  -> research gate
  -> orchestration run
  -> worktree / swarm / cli-agent
  -> harness gate
  -> release smoke gate
  -> merge / PR / backlog / reject
  -> feedback store
```

## Capability tagging

每个 inbox item 应自动或半自动打 tag：

```text
runtime
web-console
evolution
domain-agents
deployment
security
cost-capacity
contracts
agent-quality
memory
multi-user
deepresearch
swarm
skills
subagent
```

研究门控不只问“有无技术钩子”，还要问：

1. 它补哪个能力缺口？
2. 是否已有同类能力？
3. 变更是否可 bounded？
4. 风险是否需要 PR / 人工批准？

**Capability tagging 实现策略**：第一阶段用**规则匹配**（关键词 + URL 模式 + inbox section），不使用模型打 tag（成本高且不稳定）。例如 URL 含 `arxiv.org/abs/cs.CR` 打 `security`；标题含 `K8s`/`Helm`/`deploy` 打 `deployment`。规则与 CLI 入口：`scripts/evolution/capability-tagger.mjs`（`pnpm run evolution:tag`）。待 Harness eval 验证规则准确度后再考虑模型辅助。

## Source score

给来源维护轻量评分：

```text
source_url_or_feed
items_seen
proceed_count
success_count
failure_count
no_op_count
fetch_fail_count
avg_cost
avg_duration
last_seen_at
score
```

建议初始公式：

```text
score =
  2.0 * success_rate
  + 0.5 * proceed_rate
  - 1.0 * no_op_rate
  - 1.5 * fetch_fail_rate
  - 0.5 * failure_rate
```

使用方式：

- 高分源提高优先级。
- 低分源降低 `maxItemsPerFeed` 或进入复盘。
- fetch_fail 高的源优先修抓取或移除。
- success 高的源可加入主源头白名单。

校准策略：**第一阶段只做统计报告**（`scripts/evolution/source-score-report.mjs`，`pnpm run evolution:source-scores`），不自动调权或移除 feed。待累积 200+ 条处理记录后，再用统计结果人工校准公式权重。

## Failure taxonomy

统一失败类型：

| failure_type | 说明 | 下一跳 |
|--------------|------|--------|
| `no_actionable_signal` | 没有可落地点 | source score 降权 |
| `fetch_failed` | 抓取失败 | 抓取/源维护 |
| `model_tls` | CLI/model TLS 失败 | infra retry / 降并发 |
| `model_unavailable` | 模型不可用 | model fallback |
| `agent_no_change` | Agent 未产出有效改动 | prompt/constraints |
| `build_failed` | 构建失败 | coding/self-heal |
| `test_failed` | 测试失败 | self-heal/Harness |
| `review_rejected` | 审查不通过 | refine/backlog |
| `contract_failed` | 契约破坏 | G 契约回路 |
| `security_blocked` | 安全门拦截 | E 安全回路 |
| `cost_exceeded` | 超预算 | F 成本回路 |
| `merge_conflict` | 合并冲突 | rebase conflict agent |
| `release_smoke_failed` | 上线 smoke 失败 | C 部署回路 |

## 结构化事件

除 Markdown 外，建议写 JSONL：

```text
doc/evolution/runs/YYYY-MM-DD.jsonl
```

事件字段：

```json
{
  "runId": "",
  "itemId": "",
  "stage": "research",
  "capabilityTags": ["deployment"],
  "source": "",
  "agent": "cursor",
  "model": "composer-2-fast",
  "status": "completed",
  "durationMs": 1234,
  "costEstimate": 0,
  "failureType": null,
  "artifacts": [],
  "nextAction": "implement"
}
```

Dashboard 可按这些字段聚合：

- source success rate
- capability coverage
- stage duration
- failure distribution
- model/agent reliability
- cost per success

## 合并门禁

自动合并前必须满足：

1. build 通过。
2. unit/integration 通过。
3. 相关 fast eval 通过。
4. 契约变更检查通过。
5. 安全门通过。
6. release smoke 可选通过（对 deployment/runtime/web-console 必须）。
7. 风险等级为 low；medium/high 转 PR 或人工批准。

风险判断：

| 风险 | 条件 |
|------|------|
| low | docs、测试、小范围低层 bugfix |
| medium | runtime、web-console、domain tools |
| high | security、auth、deployment、data deletion、public contract |

## 与 Showcase 的关系

展示站不只展示 success，还应展示：

- 能力维度分布。
- source score 趋势。
- no-op 原因 Top N。
- failure taxonomy 趋势。
- 自动合并前 gate 结果。
- 每次进化补齐的能力缺口。

## 与 Agent 调度器的关系

Evolution 2.0 应把每个 item 转成 `OrchestrationRun`：

```text
inbox item
  -> capability tags
  -> research result
  -> orchestration run
  -> selected executor
  -> harness/release gate
  -> feedback store
```

这样 Evolution 不再只是脚本，而是**调度器的一个输入 adapter + 执行 mode**。Evolution learn 产出信号，Orchestrator 做分类与调度，Evolution run-day 是 Orchestrator 的一种批量执行路径。两者不应各自维护独立的调度逻辑。

## 第一阶段落地

1. 文档约定 capability tags 与 failure taxonomy。
2. 在 result docs frontmatter 中逐步增加字段。
3. source score：`source-score-report.mjs` 已可用；推进结果路径约定与定期报告接入 CI/nightly。
4. 增加 JSONL run event，不改变现有 Markdown。
5. 自动合并前接入 fast eval：`scripts/evolution/merge-gate.mjs`（可选 release smoke 开关继续补齐）。

## 验收

- 一次 run-day 能输出能力标签与失败类型。
- 可以按 source 统计 success/no-op/failure/fetch-fail。
- 自动合并前能根据风险等级决定 auto-merge 或 PR/backlog。
- Showcase 能展示至少一个能力维度聚合。

