# 05 — 安全与恢复

> 本章处理的是循环退化与资源浪费。审批和沙箱处理的是另一类执行风险；任何一层都不能单独保证安全或“总能优雅结束”。

---

## 为什么需要四级纵深？

单一检测机制必然有盲区：

| 故障模式 | 表现 | 单一方案为什么不够 |
|----------|------|-------------------|
| 轮内复读 | `覆盖覆盖覆盖…` × 200 | 跨轮检测看不到（这是单条输出内的退化） |
| 思考空转 | 连续 3 轮只有 reasoning，无输出 | 复读检测不触发（没有重复文本） |
| 工具死循环 | 反复调同一个工具、每次失败 | 单条正常、整体异常（需跨轮状态） |
| 渐进恶化 | 失败率缓慢上升、上下文暴涨 | 阈值检测不触发（每个单信号都未过线） |

所以我们设计了**四级纵深**，从流内到跨轮、从单信号到多信号：

```
┌─────── 轮内检测 ───────┐   ┌──────── 跨轮检测 ────────┐
│  1. 复读 Watchdog       │   │  3. SessionLoopGuard     │
│  2. 空转 Watchdog       │   │  4. RiskEngine           │
└─────────────────────────┘   └──────────────────────────┘
          ↓                              ↓
     abort + retry once            advise → abort
     (轻量、快速)                  (渐进、有缓冲)
```

---

## Level 1: 流式复读 Watchdog

**检测什么**：单条 assistant 输出里 token 退化——模型陷入了生成相同片段的循环。  
**与 LoopGuard 正交**：Guard 是跨轮 + 工具/整轮指纹；本层在流内看 text **与** reasoning delta。

**检测算法**（默认；均可 env 覆盖，见 §Env）：
1. 尾部滑动窗口（默认 256）；总长不足 `MIN_LEN`（80）不判
2. 单字符 run-length > `CHAR_RUN`（50）→ 命中（空白字符豁免）
3. 短 n-gram（2..`MAX_NGRAM`）尾部连续重复覆盖窗口 ≥ `NGRAM_RATIO` 且次数 ≥ `NGRAM_MIN_REPEATS` → 命中
4. 流上每累加约 32 字符才扫一次窗口（控开销）

**恢复流程**：
```
命中 → abort HTTP 流（尽快停上游计费）→ 污染半截不落库
  → 干净重答一次（完全重发 prompt）
  → 第二次仍命中 → idle + repetition_abort
```

**与通用重试的关系**：`runTurnWithRetries` 的传输退避（`RAW_AGENT_MODEL_MAX_RETRIES`）对 `RepetitionLoopAbortError` **豁免**——复读不是 transient 网络错。干净重答由 `runtime.ts` 外层再调一次 `runTurnWithRetries`。

**挂载点**：外层 `runTurnWithRetries`（`runtime/tool-loop.ts`），不进各 adapter——chat / responses / hybrid 一条路。

---

## Level 2: 思考空转 Watchdog

**检测什么**：模型连续 N 轮（默认 3，`RAW_AGENT_REASONING_SPIN_MAX`）只产出 reasoning 或空输出，无 tool call 无正文。  
**与 LoopGuard 正交**：每段 reasoning 文本不同 → 指纹不重复 → Guard 抓不到；本层按「有无进展」计 streak。

**为什么不重试？** 与复读不同——再问一次只是重送整套 system+tools 换同一份非答案。正确做法是**先落盘已有产出，再优雅结束**（`idle` + `reasoning_spin_abort`）。

**分类器**：
- 有 tool_call → `'tool'`
- 有非空 text → `'message'`
- 只有 reasoning → `'reasoning_only'`
- 全空 → `'empty'`

streak ≥ N 时 finalize。

---

## Level 3: SessionLoopGuard

**检测什么**：跨轮的死循环模式——不是单轮的问题，而是"整体在原地打转"。

三个子信号（默认；见 `.env.example`）：

| 信号 | 检测逻辑 | 默认阈值 | env |
|------|----------|----------|-----|
| 工具连续失败 | 同一工具连续 fail | 3 | `RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK` |
| 调用无进展 streak | 相同调用再次出现且没有新的完整成功结果；交替调用也保留有界历史，新的结果证据重置停滞 | 5 | `RAW_AGENT_RECOVERY_SAME_TOOL_STREAK` |
| 内容指纹重复 | 不含工具调用的 assistant parts 指纹；工具轮等结果返回后判断 | 窗口 8、ratio≥0.75 且 n≥4 | `RAW_AGENT_RECOVERY_REPEAT_WINDOW` / `_RATIO` |

LoopGuard 与 RiskEngine 使用同一结果停滞计数。结构化结果中的观测时间、请求 ID、耗时等明确噪声字段不算进展；业务状态、计数和正文保留。失败、缺失或空结果不会证明进展。这是有界结果差异检测，不替代目标验收；不变的轮询结果仍受停滞阈值约束，纯文本噪声尚不能可靠识别。

总开关：`RAW_AGENT_RECOVERY_POLICY`（默认开）。

### AdvisoryGrace 缓冲

LoopGuard 判定 abort 时**不立即终止**——先消耗 grace budget（`RAW_AGENT_RECOVERY_ADVISORY_GRACE` / `_BUDGET`，默认预算 1）：

```
guard 判定 abort
  ├─ budget > 0 → 降级为 advise（直接 append [recovery-advisory] system）
  │               → 模型有机会改策略；指纹命中时仍先落库 assistant 以配对 tool_use
  └─ budget 耗尽 → 真正 abort → session idle + recovery_abort trace
```

**接线事实**：Grace 的 advise **不**经过 `AdvisoryQueue`（与 Risk 不同）。叠层顺序见 [16-runtime-governance](16-runtime-governance.md)。

---

## Level 4: RiskEngine

**检测什么**：零 LLM 的多信号软评估；**不终止** session，只 enqueue advisory。

引擎 API 支持的信号类型：`tool_error_streak` / `tool_repeat` / `output_repeat` / `iteration_near_limit` / `budget_high`。

**当前 `runtime.ts` 实际接线**：

| 信号 | 接线 | 说明 |
|------|------|------|
| `tool_error_streak` | ✅ | `observeTool` 按「工具名+错误前缀」计数 |
| `iteration_near_limit` | ✅ | turn 距 `RAW_AGENT_MAX_TURNS` ≤ gap |
| `budget_high` | ✅（预算>0） | `usageTotals` vs `RAW_AGENT_TOKEN_BUDGET` |
| `tool_repeat` / `output_repeat` | API 有，runtime **未传入** streak/ratio | 与 LoopGuard 硬信号分开 |

抑制：`userQuietWindow` / coach cooldown / `maxCoachPerSession`（`RAW_AGENT_RISK_*`）。

**与 LoopGuard**：Guard = 单类信号过线 → 可 abort；Risk = 软提示 + 限流，默认不硬停。

---

## AdvisoryQueue：Risk 收口

类型上可挂 `risk | recovery | evolving | goal`；当前 runtime 主要由 Risk 路径 enqueue。要注意真实接线：下一轮先基于旧历史构造 `visibleMessages`，随后才 `drainCombined()` 并 append system，因此新 drain 的消息通常到再下一次 model turn 才进入可见历史。

Grace / Goal 否决文案走**直接** system message。合并队列的设计意图是避免多条 system 稀释注意力——扩展其它 source 时也应走同一 drain。

---

## 与 Evolving 系统的交叉

- **ShadowCoach**：在 advisory 注入时，额外从 case store 召回相似历史 case 的教训，一并注入
- **BackgroundReviewer**：recovery abort 时异步记录 case，为未来的 ShadowCoach 积累经验

这形成了一个闭环：**失败 → 记录 → 下次遇到类似情况 → 主动提醒 → 避免重蹈覆辙**。

---

## Env 速查

| 开关 | 默认倾向 |
|------|----------|
| `RAW_AGENT_STREAM_WATCHDOG` (+ WINDOW/MIN_LEN/CHAR_RUN/…) | 复读轮内检测 |
| `RAW_AGENT_REASONING_SPIN_WATCHDOG` / `_MAX` | 空转 |
| `RAW_AGENT_RECOVERY_POLICY` + TOOL_FAIL/SAME_TOOL/REPEAT_* | LoopGuard |
| `RAW_AGENT_RECOVERY_ADVISORY_GRACE` / `_BUDGET` | Grace |
| `RAW_AGENT_RISK_ENGINE` + RISK_* / `RAW_AGENT_TOKEN_BUDGET` | Risk |

完整表与时间线：[16-runtime-governance](16-runtime-governance.md)。验证以 trace（`repetition_abort` / `reasoning_spin_abort` / `recovery_*` / `risk_advisory`）与 eval 为准，勿把 README 粗估当 SLA。

---

## 治理层补充：失范研究 ↔ 运行时控件

本章四级纵深解决「停不下来」。**意图失范 / 越权**另靠审批、最小权限、沙箱与可选系统附录：

- `RAW_AGENT_AGENTIC_SAFETY_APPENDIX=1|general` → 仅 `general`；`=all` → 全部 agent（`prompt-builder.ts`）
- Domain `allowedTools`、optional groups、外部 AI CLI 门控
- Lab 审批 UI / `permissionMode`

映射与边界（不声称复现训练方法）→ [`AGENTIC_SAFETY_RUNTIME.md`](../AGENTIC_SAFETY_RUNTIME.md)；暴露面汇总 → [19-surfaces-a2ui-domains](19-surfaces-a2ui-domains.md)。

---

## 验证范围

单元测试应分别覆盖流内复读、reasoning 空转、工具失败 streak、重复工具窗口、grace 预算和 advisory cooldown。它们证明阈值与状态机行为，不证明所有模型异常都能被识别。

---

## 关键文件

| 路径 | 说明 |
|------|------|
| `streaming/repetition-watchdog.ts` | 流式复读检测 |
| `streaming/reasoning-spin-watchdog.ts` | 空转检测 |
| `recovery/session-loop-guard.ts` | 跨轮死循环检测 |
| `recovery/advisory-grace.ts` | abort → advise 缓冲 |
| `recovery/risk-engine.ts` | 多信号风险评估 |
| `recovery/advisory-queue.ts` | advisory 合并队列 |
| `runtime.ts` / `runtime/tool-loop.ts` | 叠层编排与流守卫挂载 |
| [16-runtime-governance.md](16-runtime-governance.md) | 时间线 + 全量 env + 正交说明 |
