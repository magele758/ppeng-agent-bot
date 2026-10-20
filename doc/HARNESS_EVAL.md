# Harness 与 Eval 基线规划

Harness 的目标是让 Agent 能力可重复评测，而不是只凭一次会话感觉判断。它是 DeepResearch、Teams Swarm、自我进化、发布 gate 的共同质量底座。

## 目标

1. 固定一批 fast eval，进入本地和 CI。
2. 固定一批 nightly eval，允许真实模型、更长任务、更复杂工具链。
3. 支持 deterministic checks、期望工具序列、结构化输出校验、可选 LLM judge。
4. 失败样本能回流到 Skills、prompts、`AGENTS.md`、Evolution 研究门控。

## Harness 工件

继续沿用现有 `harness_write_spec` 思路，建议统一工件目录：

```text
.raw-agent-harness/
  product_spec.md
  requirements_backlog.md
  sprint_contract.md
  evaluator_feedback.md
  eval_result.json
```

新增 eval case 目录：

```text
scripts/agent-eval/
  cases/
    fast/
    nightly/
  fixtures/
  judges/
  README.md
```

每个 case 建议结构：

```json
{
  "id": "skill-routing-basic",
  "capability": "skills",
  "mode": "fast",
  "agentId": "general",
  "input": "Use the a2ui skill to explain available widgets.",
  "expected": {
    "mustMention": ["a2ui"],
    "toolSequence": ["load_skill"],
    "maxTurns": 4
  }
}
```

## 第一批 fast eval cases

| ID | 能力 | 目标 | 检查方式 |
|----|------|------|----------|
| `session-basic-chat` | 多用户有状态对话基础 | 创建 session，追加消息，完成一轮 heuristic 对话 | deterministic |
| `tool-read-file` | 工具调用 | Agent 能读指定文件并摘要 | expected tool |
| `skill-routing-basic` | Skill | 触发 skill router，加载相关 skill | expected tool / text |
| `memory-scratch-copy` | Memory / SubAgent | parent scratch memory 可复制到 subagent | deterministic |
| `spawn-subagent-review` | SubAgent | `spawn_subagent(role=review)` 返回独立总结 | deterministic + text |
| `spawn-teammate-mailbox` | Teams | teammate session 创建并可通过 mailbox 交接 | deterministic |
| `a2ui-surface-smoke` | A2UI | surface update 可进入消息/stream | schema check |
| `domain-sre-missing-env` | Domain Agent | SRE tool 缺 env 返回清晰错误而不是 crash | deterministic |
| `evolution-research-skip` | Evolution | 明显无关条目被 research gate SKIP | deterministic |
| `release-health-smoke` | Deployment | `/api/health` 可用，trace/status 可读 | HTTP check |

## 第一批 nightly eval cases

| ID | 能力 | 目标 | 检查方式 |
|----|------|------|----------|
| `deepresearch-grounded-report` | DeepResearch | 生成带引用与证据片段的研究报告 | LLM judge + schema |
| `swarm-implementation-loop` | Teams Swarm | planner/researcher/implementer/reviewer 分工完成小任务 | trace + judge |
| `evolution-run-day-one-item` | Self-Evolution | 单条 inbox 完成 research -> test -> result doc | artifact check |
| `self-heal-unit-failure` | Self-heal | 构造失败测试，自愈生成修复分支 | deterministic + logs |
| `memory-long-recall` | Memory | 跨会话检索长期偏好 | embedding/FTS check |
| `contract-sse-chunks` | 契约 | SSE chunk 类型不破坏 | golden snapshot |
| `a2ui-action-roundtrip` | A2UI | 用户 action 回流成用户消息并触发 Agent | e2e |
| `domain-stock-provider-switch` | Domain Agent | mock/yahoo/alphavantage provider 切换行为正确 | mocked fetch |
| `deploy-smoke-compose` | Deployment | compose/staging 启动并跑健康检查 | shell/HTTP |
| `cost-budget-enforced` | 成本容量 | 超预算时任务停止或降级 | deterministic |

## 评分方式

建议分层：

1. **Hard checks**：退出码、schema、工具序列、文件存在、HTTP status。
2. **Soft checks**：文本包含、结构完整、引用完整度。
3. **LLM judge**：只用于 nightly 或无法 deterministic 的质量判断。
4. **Human review**：高风险能力（安全、部署、数据删除）需要人工确认。

结果统一字段：

```text
case_id
capability
mode
agent
model
status
duration_ms
tool_sequence
artifacts
failure_type
judge_score
next_action
```

## 失败回流

失败样本应进入三处：

- `doc/eval-failures/`：人类可读报告。
- `doc/evolution/failure-patterns.md`：高频模式归纳。
- Skills / prompts / `AGENTS.md`：只有当模式稳定且可复用时才沉淀。

回流规则：

| 失败类型 | 下一跳 |
|----------|--------|
| tool schema mismatch | G 契约回路 |
| wrong tool sequence | H 人机质量回路 |
| missing env crash | C/E 运维或安全回路 |
| hallucinated citation | DeepResearch eval 更新 |
| flaky network/model | F 成本容量或 infra retry |

## 脚本入口建议

```bash
pnpm run agent:eval --mode fast
pnpm run agent:eval --mode nightly
pnpm run agent:eval --case skill-routing-basic
```

CI 只跑 fast；nightly 可由本机或自建 runner 跑真实模型。

## fast eval 模型策略

fast eval 全部使用 `heuristic` provider（无密钥），只验证框架行为：session 创建、工具调度、memory 复制、mailbox 传递、HTTP 端点可达。需要真实模型才能验证的（如 skill-routing 文本质量、subagent 总结内容），归入 nightly。

## eval 结果存储

- 成功与失败统一写 `doc/eval-results/YYYY-MM-DD.jsonl`，每行一个 case 结果。
- 失败样本额外写 `doc/eval-failures/`（人类可读 Markdown）。
- CI 只检查退出码；nightly 额外比对 baseline。

## baseline 与阈值

首次跑出的 fast eval 结果作为 baseline snapshot（`doc/eval-results/baseline.json`）。后续 CI 检查 no-regression：新结果不允许比 baseline 更差（通过数 >= baseline 通过数）。baseline 手动更新：只有在有意改变行为时才刷新。

