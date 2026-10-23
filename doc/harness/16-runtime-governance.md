# 16 — 运行时治理叠层（agent-loop）

> **一句话**：本切片讲「自建 turn loop 上叠了哪些治理层、各自正交在哪、何时介入、靠哪些 env」。  
> 工具管线细节见 [03](03-tool-execution.md)；四级兜底叙事见 [05](05-safety-and-recovery.md)；Goal Gate 决策矩阵见 [06](06-goal-gate.md)。本章补的是**叠层顺序与接线事实**。

---

## Jev：可选的宿主语义决策

新增的 Jev 接入见 [Jev 接入指南](../JEV_INTEGRATION.md)：覆盖 Lab 设置、profile 与 Loop assemblyPreset 的区别、12 个切入点的实际接线、PTC、失败回退和 `jev_call` / Langfuse 观测。

Jev 客户端留在 core 产品宿主，默认关闭，不是 SDK 的静态依赖，也不替代现有审批、沙箱或 LoopGuard。`goalGate`、`route`、`preTurn` 的完成判断有互斥规则；`toolGate` 网络失败时继续原管线，不能当作 fail-closed 授权门。`sagaGate` 目前仅有辅助函数，尚未接入产品编排器。

当前默认链路是 core `runSession` → agent-loop SDK（max）→ turn kernel；宿主接线见 `packages/core/src/runtime/l5-bindings.ts`。下文保留历史治理切片，旧路径与简化时序需对照 [当前源码入口](README.md#当前源码入口)，不能把 `_runSessionInner` 当作现行入口。

## 1. 与 LoopGuard 正交：先分清「轮内」vs「跨轮」

| 层 | 作用域 | 看什么 | 默认行为 | 代码 |
|----|--------|--------|----------|------|
| **复读 watchdog** | **单轮流内** | text/reasoning delta 尾窗退化 | abort 流 → **干净重答 1 次** → 再命中则 `idle` | `streaming/repetition-watchdog.ts` + `runtime/tool-loop.ts` `runTurnWithRetries` |
| **空转 watchdog** | **跨轮、非工具中心** | 连续 N 轮仅 reasoning/空 | **不重试**，落盘后 `idle` | `streaming/reasoning-spin-watchdog.ts` |
| **SessionLoopGuard** | **跨轮、工具/指纹** | 工具连败、相同调用内容 streak、assistant 指纹重复 | Grace 宽限 → advise 或 abort | `recovery/session-loop-guard.ts` |
| **RiskEngine** | **跨轮、多信号软提示** | 错误 streak / 近 turn 上限 / token 预算比 | 入队 → 后续 append system（**不终止**） | `recovery/risk-engine.ts` |
| **Goal soft-gate** | **完成路径否决** | `metadata.goalCondition` + judge | fail-open；不满足则 continue | `goal/goal-gate.ts` |

**为何强调正交**：

- LoopGuard 的内容指纹是**整轮** sha256；流内 `覆盖覆盖…` 在 turn 结束前已烧 token，Guard 看不见。
- 空转时每段 reasoning **文本不同** → 指纹永不重复 → Guard 不触发；空转 watchdog 专补这条盲区。
- RiskEngine **零 LLM**、只 advisory；与 Guard 的硬 abort 路径分开。
- Goal Gate 只在 `stopReason !== 'tool_use'` 的正常完成路径上否决，**不替代** recovery abort。

---

## 2. 单轮时间线（接线顺序）

以下为历史治理职责的简化示意，不是当前默认 SDK 内核的逐行时序；当前接线从上述宿主入口核对：

```
turn 开始
  ├─ visibleMessages / appendix 先完成
  ├─ advisoryQueue.drainCombined() → 若有则 append system（不会进入本轮已构造的 visibleMessages）
  ├─ buildSystemPrompt / prepare messages
  ├─ runTurnWithRetries
  │     └─ 流式：RepetitionStreamGuard（text + reasoning 双 guard）
  │           命中 → RepetitionLoopAbortError
  │           runtime：干净重答一次；二次命中 → idle + repetition_abort
  │     └─ 传输失败：RAW_AGENT_MODEL_MAX_RETRIES 退避
  │           （复读 abort 对「通用退避重试」豁免——见 tool-loop）
  ├─ turn_end trace（usage / finishReason / truncated / requestId / costUsd /
  │                   stableSystemVersion）
  ├─ ReasoningSpinWatchdog.noteParts → 命中则落盘 + idle
  ├─ LoopGuard.checkAssistantRepetition → AdvisoryGrace
  │     advise：先记 pending，仍落库 assistant（保证 tool_use 可配对）
  │     abort：idle + recovery_abort
  ├─ stopReason !== tool_use
  │     → stop hook / extension
  │     → GoalGate.evaluate（completeText + jsonMode；无则 fail-open）
  │     → handleTurnCompletion
  └─ stopReason === tool_use
        → filterValidToolCalls（目前主要挡 external 未开）
        → checkToolApprovals → waiting_approval | skip | proceed
        → executeToolCalls（partitionForParallel + Promise.all）
        │     未知工具 → buildUnknownToolResultContent（did_you_mean…）
        → processToolResults（脱敏已在 execute 内对 shell-like 做过）
        → RiskEngine.observeTool + tick → 可 enqueue AdvisoryQueue
        → LoopGuard.afterToolRound → Grace → advise(continue) / abort(idle)
```

---

## 3. 工具边（与治理的交界）

### 3.1 未知工具结构化自愈

**位置**：`executeSingleTool`（`runtime/tool-loop.ts`），不是 `filterValidToolCalls`。  
`filterValidToolCalls` 当前主要处理「external 工具未开」；未知名仍进执行路径，由 `buildUnknownToolResultContent` 合成 **仍带同一 `toolCallId` 的** `tool_result`。

载荷（JSON 字符串进 `content`）：

| 字段 | 含义 |
|------|------|
| `error_code` | 固定 `UNKNOWN_TOOL` |
| `did_you_mean` | normalize + Levenshtein；超阈值则为 `null`（`find-similar-tool-name.ts`） |
| `available_tools_sample` | 最多 20 个已注册名 |
| `hint` | 提醒可能是配置关闭，勿静默换工具 |

效果：协议配对不破；模型下一轮可按建议改名。近似阈值：`max(3, floor(len*0.4))`。

### 3.2 并行分块

`partitionForParallel(calls, maxParallelToolCalls)`：按 `RAW_AGENT_MAX_PARALLEL_TOOLS`（默认 8）切片；**块内** `Promise.all`，**块间**串行。  
无「顺序敏感工具强制串行」分区——依赖模型/调用方控制依赖顺序。

### 3.3 审批与配对

任一次 `waiting_approval` **结束本次** `runSession` dispatch；批准后再次 `runSession` 续跑。  
Idempotency：同工具名+参数 hash 的已批准记录可复用（见 [03](03-tool-execution.md)）。

---

## 4. LoopGuard + AdvisoryGrace

### 信号（`SessionLoopGuard`）

| 信号 | 默认阈值 | env |
|------|----------|-----|
| 同工具连续失败 | 3 | `RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK` |
| 相同调用反复出现且没有新成功结果（包括交替调用；剔除明确观测噪声） | 5 | `RAW_AGENT_RECOVERY_SAME_TOOL_STREAK` |
| 无工具调用的助手内容指纹重复比（工具轮在结果后判断） | window=8，ratio≥0.75，且 n≥4 | `RAW_AGENT_RECOVERY_REPEAT_*` |

总开关：`RAW_AGENT_RECOVERY_POLICY`（默认开）。

### Grace

- `RAW_AGENT_RECOVERY_ADVISORY_GRACE`（默认开）+ `RAW_AGENT_RECOVERY_ADVISORY_GRACE_BUDGET`（默认 1，上限 5）。
- abort 且预算>0 → 注入 `[recovery-advisory] …`（`formatRecoveryAdvisory`），**当轮/下步继续**。
- **接线事实**：Grace 的 advise **直接 append system**，**不**走 `AdvisoryQueue`（与 Risk 不同）。

---

## 5. RiskEngine + AdvisoryQueue

### RiskEngine（零 LLM）

`tick` 可识别信号类型：`tool_repeat` | `output_repeat` | `tool_error_streak` | `iteration_near_limit` | `budget_high`。

**当前 runtime 实际喂入**：

| 信号 | 是否接线 | 来源 |
|------|----------|------|
| `tool_error_streak` | ✅ | `observeTool`（工具结果） |
| `iteration_near_limit` | ✅ | `turn` vs `RAW_AGENT_MAX_TURNS` |
| `budget_high` | ✅（需预算>0） | `usageTotals` vs `RAW_AGENT_TOKEN_BUDGET` |
| `tool_repeat` / `output_repeat` | API 有，**runtime 未传 streak/ratio** | — |

抑制：用户安静窗 / coach 冷却 / `maxCoachPerSession`（env 见下）。命中 advise 时 `advisoryQueue.enqueue(..., 'risk')`。下一轮会 drain 并持久化，但因为该轮的 `visibleMessages` 已先构造，新 system message 通常从再下一次 model turn 才可见。这是当前 `runtime.ts` 的接线顺序。

### AdvisoryQueue

类型上 source 可为 `risk | recovery | evolving | goal`；**生产路径目前仅 Risk enqueue**。  
Grace / Goal 否决文案走直接 system message。

---

## 6. Goal soft-gate（完成路径）

| 项 | 事实 |
|----|------|
| 环境总开关 | `RAW_AGENT_GOAL_GATE`（默认开） |
| 激活条件 | 会话 `metadata.goalCondition` 为**非空字符串**；仅有 `goalEnabled` **不会**建 gate（见 `resolveGoalCondition`） |
| 判官 | `ModelAdapter.completeText` + `jsonMode: true`；无方法 → `{met:true}` fail-open |
| 上限 | `RAW_AGENT_GOAL_MAX_TURNS`（默认 25）或 metadata `goalMaxTurns` |
| 决策矩阵 | 见 [06-goal-gate](06-goal-gate.md) |

---

## 7. 轮内 watchdog 细节与 env

### 复读（`RAW_AGENT_STREAM_WATCHDOG`，默认开）

| env | 默认 |
|-----|------|
| `RAW_AGENT_STREAM_WATCHDOG_WINDOW` | 256 |
| `RAW_AGENT_STREAM_WATCHDOG_MIN_LEN` | 80 |
| `RAW_AGENT_STREAM_WATCHDOG_CHAR_RUN` | 50 |
| `RAW_AGENT_STREAM_WATCHDOG_MAX_NGRAM` | 12 |
| `RAW_AGENT_STREAM_WATCHDOG_NGRAM_RATIO` | 0.8 |
| `RAW_AGENT_STREAM_WATCHDOG_NGRAM_MIN_REPEATS` | 3 |

挂在 **adapter 外** 的 `runTurnWithRetries` → 覆盖 chat / responses / hybrid。命中时 abort **HTTP 流**（尽快停计费）。污染半截**不落库**。

### 空转（`RAW_AGENT_REASONING_SPIN_WATCHDOG`，默认开）

| env | 默认 |
|-----|------|
| `RAW_AGENT_REASONING_SPIN_MAX` | 3 |

分类：`tool` / `message` / `reasoning_only` / `empty`；后两者累加 streak。

---

## 8. 观测：`turn_end` 与 `STABLE_SYSTEM_VERSION`

每轮成功拿到 `ModelTurnResult` 后发 `turn_end`，payload 常见字段：

- 控制相关：`stopReason`
- 观测：`finishReason`、`usage`、`truncated`、`requestId`、`costUsd` / `costModel`
- **指纹**：`stableSystemVersion` ← `prompt-builder.ts` 的 `STABLE_SYSTEM_VERSION`

约定（与 `packages/core/src/model/AGENTS.md` 一致）：

- **不进** prompt、**不进** prompt-cache key；只进 trace。
- 改动会进入 stable prefix 的文案时须 **bump** 该常量，便于归因「哪版 system 在跑」。
- `truncated` **不改** `stopReason` / 循环控制；另发 `turn_truncated`。

治理相关 kind：`repetition_abort`、`reasoning_spin_abort`、`recovery_advisory` / `recovery_abort`、`risk_advisory`、`goal_eval`。详见 [15-observability](15-observability.md)。

---

## 9. 开关一览（默认多为开）

| 能力 | 主开关 | 备注 |
|------|--------|------|
| LoopGuard | `RAW_AGENT_RECOVERY_POLICY` | 关则无 Guard/无 Grace 实例 |
| AdvisoryGrace | `RAW_AGENT_RECOVERY_ADVISORY_GRACE` | 需有 Guard |
| RiskEngine | `RAW_AGENT_RISK_ENGINE` | 零 LLM |
| 复读 watchdog | `RAW_AGENT_STREAM_WATCHDOG` | 轮内 |
| 空转 watchdog | `RAW_AGENT_REASONING_SPIN_WATCHDOG` | 跨轮 |
| Goal Gate | `RAW_AGENT_GOAL_GATE` | 另需 `goalCondition` |
| 并行工具 | `RAW_AGENT_MAX_PARALLEL_TOOLS` | 默认 8 |
| Token 预算信号 | `RAW_AGENT_TOKEN_BUDGET` | 0=不启用 budget_high |

Risk 细项：`RAW_AGENT_RISK_TOOL_ERROR_STREAK`、`RAW_AGENT_RISK_ITERATION_NEAR_GAP`、`RAW_AGENT_RISK_BUDGET_HIGH_RATIO`、`RAW_AGENT_RISK_MAX_COACH`、`RAW_AGENT_RISK_COACH_COOLDOWN`、`RAW_AGENT_RISK_USER_QUIET`。

---

## 10. 边界（避免误读）

1. **不是 SDK Runner 钩子**——全在自建 `_runSessionInner` / `tool-loop` 里。  
2. **fail-open 优先**：Goal judge 挂了放行；治理自身 bug 不应锁死用户。  
3. **分层可关**：关某一层即退化为更「裸」的循环，其它层仍独立。  
4. **效果数字**：README/旧章中的恢复率等为内部粗估，**不是**本仓库 CI 硬指标；以 trace kind 与 eval case 为准做验证。

---

## 关联文件

| 路径 | 说明 |
|------|------|
| `packages/core/src/runtime.ts` | 叠层编排 |
| `packages/core/src/runtime/tool-loop.ts` | 审批/执行/复读流守卫/`runTurnWithRetries` |
| `packages/core/src/streaming/*-watchdog.ts` | 轮内/空转 |
| `packages/core/src/recovery/*` | Guard / Grace / Risk / Queue / unknown-tool |
| `packages/core/src/goal/*` | soft-gate |
| `packages/core/src/model/prompt-builder.ts` | `STABLE_SYSTEM_VERSION` |
| `.env.example` | 上表 env 注释块 |

**from-zero 入口**：[from-zero/07-sandbox-and-safety.md](from-zero/07-sandbox-and-safety.md)（叠层速查）→ 本章深读。
