# 能力吸收计划：从 ai-agent-node 借鉴并补强 ppeng-agent-core

> 状态：轮次 1–5 已全部落地。

## 已落地

| 轮次 | 能力 | 落点 |
|---|---|---|
| 1 | LLM usage / truncation | `model/usage.ts` |
| 2 | upstream request-id / optional groups 并集 / `STABLE_SYSTEM_VERSION` | `upstream-request-id` / `optional-tool-groups` / `prompt-builder` |
| 3 | tool-result 回流脱敏 / unknown-tool 自愈 / AdvisoryGrace | `result-redaction` / `unknown-tool-result` / `advisory-grace` |
| 4 | Goal soft-gate | `goal/` + runtime soft-complete |
| 4 | RiskEngine + AdvisoryQueue | `recovery/risk-engine` + `advisory-queue` |
| 4 | Case governance | `evolving/case-governance` + migration v10 |
| 4 | Memory → user appendix | `PromptBuilder.buildMemoryAppendix` |
| 4 | Token→$ 成本估算 | `model/token-cost.ts` → `usageCostUsd` / `turn_end.costUsd` |
| 5 | **轮内复读 watchdog** | `streaming/repetition-watchdog.ts` + `runtime/tool-loop.ts` 流包装 |
| 5 | **思考空转 watchdog** | `streaming/reasoning-spin-watchdog.ts` + runner 轮末分类 |
| 5 | **每轮微压缩** | `session/micro-compact.ts` → `prepareMessagesForModel` |
| 5 | **上下文预算推导** | `session/session-budget.ts` → 压缩阈值 / episodic 预算 |
| 5 | **Session working log** | `session/working-log.ts` → 压缩锚点 + 步骤结论，尾部 user 侧注入 |
| 5 | **累计 prompt token 拆分** | `model/usage.ts:splitCumulativePromptTokens` |
| 6 | **错误停止信号（DSML / 伪工具调用）** | `model/stop-reason.ts` + `turn/turn-recovery.ts`：有结构化 tool_calls 则无视 `finish_reason=stop`；正文/思考泄漏 DSML/XML 不当 end |

## 轮次 5 说明（为什么这五项值得吸）

原有三层防护（LoopGuard / RiskEngine / AdvisoryGrace）**全是跨轮 + 工具中心**，
对「轮内退化」与「上下文预算」两个盲区零覆盖。轮次 5 补的正是这两块：

- **轮内复读**（`RAW_AGENT_STREAM_WATCHDOG`）：单条 assistant 输出里 token 退化刷屏。
  流式消费层按字符 run-length / 短 n-gram 占窗口比例检测，命中即 abort HTTP 流
  （provider 立刻停止计费）→ **干净重答一次**；第二次仍命中不再重试、优雅收尾。
  包在 `runTurnWithRetries` 而非各 adapter 内，chat / responses / hybrid 一条路全覆盖。
- **思考空转**（`RAW_AGENT_REASONING_SPIN_WATCHDOG`）：连续多轮只有 reasoning、
  无工具无正文，每轮重送整套 system+tools。LoopGuard 抓不到——每段 reasoning 文本
  都不同，指纹永不重复。**刻意不重试**：再问一次只是重送整套 schema 换同一份非答案。
- **微压缩**（`RAW_AGENT_MICRO_COMPACT`）：`autoCompact` 只在整体过阈值时跑一次 LLM 摘要，
  而真正的膨胀源是几条巨型 `tool_result` 每轮原样重送。微压缩每轮跑、只碰 tool result、
  纯函数、**只改送给模型的视图**，落库 transcript 仍全量（后续 re-read 不受影响）。
- **上下文预算**：原先压缩阈值与 episodic 预算都硬编码 24k，与模型窗口脱钩——
  1M 窗口浪费九成，32k 窗口又不留 system+tools+输出的余量。改为按窗口推导
  （窗口 − system prompt − 工具 schema − 输出预留 − 安全余量，下限 8000），
  显式 env 仍优先。`turnShapeBySession` 拿上一轮实际 prompt 形状喂下一轮推导。
- **Working log**：压缩天然有损，摘要丢掉的东西从模型视野里永久消失。
  working log 是廉价外存：append-only markdown，只记高信号（压缩锚点 + 归档
  transcript 路径、步骤结论），尾部随 memory appendix 走 **user 侧**注入
  （不进 system → 不破坏 prompt cache）。文件缺失即降级为空串，绝不阻断本轮。
- **累计 prompt token 拆分**：部分网关把 `prompt_tokens` 报成会话累计值，
  直接累加会让 totals 与成本二次增长（node 侧「输入 433k」故障）。
  **检测必须两段式**：首次靠大跳变（≥ +40% 且 ≥ +1000），之后**粘滞**。
  ⚠️ 移植时实测发现的缺陷：累计值越大，每轮增量占它的比例越小，
  纯相对门槛会在后段静默失效（本仓 `model-usage.test.js` 有回归用例覆盖此序列）。
  node 原版只在单次 `run()` 内使用故未暴露该问题。报数下降说明是本请求值
  （如压缩后 prompt 变小），此时粘滞让位，避免算出负增量。

## 用法摘要

- **Goal**：会话 `metadata.goalCondition`（或 `goalEnabled`+条件）+ 可选 `goalMaxTurns`；软完成时判官 `completeText` JSON；fail-open。
- **Risk**：`RAW_AGENT_RISK_ENGINE=1`（默认开）；多信号 → `AdvisoryQueue` → 下轮 system。
- **Case governance**：`runCaseGovernance` 在每次 `runSession` 入口 fail-soft 执行；`status`/`half_life_days`/`expires_at`。
- **Memory appendix**：不进 system dynamic；拼到最近一条 user 消息前（working log 尾部同路）。
- **成本**：`session.metadata.usageCostUsd`；定价表可被 `RAW_AGENT_TOKEN_PRICE_JSON` 覆盖。
- **换模型**：只改 `RAW_AGENT_MODEL_CONTEXT_TOKENS`，别再手调压缩阈值 / episodic 预算。
- 轮次 5 全部开关默认开、可单独 env 关；env 全表见 `.env.example`。

## 新增 trace kind（`stores/trace.ts`）

`repetition_abort`、`reasoning_spin_abort`、`micro_compact`、`usage_cumulative_split`、`working_log_append`。

## 仍可选深化（非阻塞）

- Goal 完整实体 store / teams 续轮 / steer 插话（node 全量）
- RiskEngine 与 LoopGuard 信号完全合流（same-tool streak 透传）
- Case supersede 冲突检测 / cron 周期治理
- 前端展示 `usageCostUsd` / goal 状态 / working log
- **`RunOutcome` 单一终态真值**（node `observability/run-outcome.ts`）：ppeng 终态目前散在
  各处 `updateSession(status)`，且无 `failureStage` 归因维度——完成率会系统性虚高
- node 五阶段 ingestion 管线（附件输入）仍可选；大结果已由 DurableArtifactPort 落盘并按页引用（`acceptance/durable-artifact-port.yaml`）
- 语义记忆 gate / curator / dreamer（node `memory/` 约 7.7k 行；ppeng 目前是五层 KV store）
