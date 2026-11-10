# 06 — Goal Soft-Completion Gate

> **核心洞察**：模型说"我做完了"不代表目标真的达成。传统 agent 的 `stop` 逻辑完全依赖模型自判——但模型会过早声明完成（尤其在遇到困难时）。Goal Gate 是一个正交于主循环的"否决权"——不替代 stop，只**质疑** stop。

---

## 问题与动机

### 模型"过早完成"的真实场景

1. 用户说"帮我重构这个模块"→ 模型改了一个文件 → 声明完成 → 实际上还有 3 个文件没动
2. 用户说"确保所有测试通过"→ 模型跑了测试 → 看到 2 个失败 → 说"大部分通过了"→ 结束
3. 任务需要用户输入 → 模型等了一轮 → 没收到 → 直接跳过 → 声明完成

### 为什么不能用 `max_turns` 兜底？

`max_turns` 只保证"不会跑太久"，但不能判断"跑够了没有"。你需要的是一个**语义级的完成判断**。

### 解法：Goal Gate

正交于 session mode 的"完成闸门"——叠加在**任何 mode 之上**：

```
模型按自己的逻辑跑完 → stop
  ↓
Goal Gate 介入
  ├─ 条件满足 → achieved → session completed
  └─ 条件不满足 → 注入原因 → 继续循环
```

---

## 设计方案

### Fail-open 设计（最重要的决策）

| 故障 | 行为 |
|------|------|
| judge 调用抛错/超时 | `met: true` → 放行 |
| judge 返回不可解析 JSON | `met: true` → 放行 |
| gate 构建失败 | 不创建 gate → 完全不参与 stop 路径 |

**为什么 fail-open？** 因为 Goal Gate 不是 loop 的动力源——main loop 的 stop 判断已经足够可靠。Gate 只做"否决正常完成"。如果 gate 自己出了问题，让 session 正常结束远比把用户锁在无限循环里好。

这是一个反直觉但深思熟虑的设计：安全机制本身的故障不应该成为新的安全风险。

### 触发条件

| 条件 | 行为 |
|------|------|
| `RAW_AGENT_GOAL_GATE=0` | 不创建 gate |
| `metadata.goalCondition` 非空字符串 | 创建 `GoalGate`（`createGoalGateFromMetadata`） |
| 仅有 `goalEnabled`、无有效 `goalCondition` | **不激活**（`resolveGoalCondition` 不推导文案） |
| 可选 `goalMaxTurns` / env `RAW_AGENT_GOAL_MAX_TURNS` | 默认 25（夹在 1..100） |

### 评估流程

```
正常 stop（stopReason !== tool_use）且 gate 激活
  → GoalGate.evaluate()
  1. judge = modelAdapter.completeText({ …, jsonMode: true })
     无 completeText → 直接 { met: true } fail-open
  2. 解析 JSON: { met, reason, progress, missing, missing_kind, steer_action }
  3. decideGoalTurn 决策矩阵
  4. 账本写入 metadata；trace kind: goal_eval
```

拦截点：`runtime.ts` 完成路径（recovery 硬停已提前 return，Gate 不介入）。叠层位置见 [16-runtime-governance](16-runtime-governance.md)。

---

## 决策矩阵

| 优先级 | 条件 | 结果 | 设计意图 |
|--------|------|------|----------|
| 1 | `steerAction === 'supersede'` | close | 外部信号表明目标已被替代 |
| 2 | `met === true` | achieved | 正常完成 |
| 3 | 连续 2 轮 `progress === 'stalled'` | close (stalled) | 避免无进展循环 |
| 4a | `missingKind === 'user'` 首轮 | continue + "假设 or 留缺口" | 给模型一次自主决策的机会 |
| 4b | 连续 2 轮 user-missing | close | 无人值守场景不能无限等 |
| 5 | `turnsUsed >= maxTurns` | close (exhausted) | 硬上限兜底 |
| 6 | 其他 | continue | 继续工作 |

### Ledger（账本）机制

每次评估追加一条记录，最近 5 条注入给 judge——让 judge 看到**趋势**：

```
turn 1: not met, progress=progressing → continue
turn 2: not met, progress=progressing → continue
turn 3: not met, progress=stalled    → continue（首次 stalled）
turn 4: not met, progress=stalled    → close（连续 2 轮无进展）
```

这解决了"模型在原地打转但每轮都声称在做"的问题——judge 能看到历史趋势而非只看当前快照。

---

## Bot 对话的收尾检查

`goalCondition` 这道闸只管普通会话。Bot 私聊走持久目标，软停时按下面的顺序检查，实现都在 `bots/goals/`，入口是 `runtime/l5-bindings.ts` 的 `evaluateGoalGate`。

| 这一轮的情况 | 谁检查 | 结果 |
|---|---|---|
| 绑定了目标，直接执行 | `reviewDirectGoalBeforeEnd`（`runtime-host.ts`） | 判官说没做完就打回一次；轮数上限的最后一轮只记录结论 |
| 绑定了目标，执行结束 | `settleGoalExecution` → `verifyCompletion` | 写回目标状态；因轮数上限结束且没被判完成的，回到排队，由调度器接着做，对话里出现一张「目标还在继续」的提示（`[goal-continuing]`） |
| 没有目标 | `reviewUnboundFinish`（`finish-check.ts`） | 见下 |

没有目标的一轮先看便宜的信号：回复里有没有「接下来我会…」「要不要我继续」「稍后汇报」这类说法，这一轮自己写的 `TodoWrite` 是否还有未完成项。会话里更早留下的待办不看。信号都没有就直接结束，不调用模型。有信号才问一次判官，结论三选一：

- `continue`：承诺了没做，或在能自己决定的下一步上停下来问人。注入 `[finish check]` 让它继续。
- `wake`：说了稍后汇报，而事情确实在别处跑着。有后台任务、`wait_for`、`cron_create` 或目标等待在跟进时什么都不做；都没有时登记一次到期唤醒（`finish-wake.ts`），trace 里记 `deferredWithoutWake: true`。
- `stop`：答完了（附带的可选提议不算没做完），或确实需要用户登录、给凭证、确认不可逆操作，或用户要求先讨论。判官拿不准也归这里。

边界：

- 一轮最多打回 2 次（可在 Lab 改）。打回后没有新的工具调用就直接结束。
- 等审批、`ask_user`、用户中止、预算用尽、轮数上限的最后一轮、recovery 中止都不进这项检查。
- 判官出错或返回无法解析时重试一次，仍失败就放行，trace 里 `failOpen: true`。唯一的例外是这一轮自己的待办还没做完、回复里又没有问人或稍后汇报的说法，这时按待办继续。
- 唤醒默认 10 分钟后第一次，之后间隔翻倍，同一件事最多 3 次。用户在到期前发了新消息，这次唤醒作废。

「继续」和进度追问：对话里有 24 小时内动过的未完成目标、其后用户没有聊别的事时，`prepareGoalIntake` 把这条消息接到该目标上（`followup.ts`），这一轮由主对话直接执行它，结束时走上表第一、二行。目标正在执行或等待时只报告状态。暂停的目标只有明确说「继续」才恢复。没有未完成目标时说「继续」，不再反问是哪个目标。

可查的记录：

| trace kind | 内容 |
|---|---|
| `goal_intake` | 每条用户消息的分类、降级原因（`question_mark` / `self_contained` / `open_inquiry` / `conversation_request`）、接续到哪个目标 |
| `goal_eval`（`source: bot_goal_completion` / `bot_goal_before_end`） | 目标完成判官的每次结论、理由、是否出错放行 |
| `finish_check` | 无目标收尾检查的结论、理由、来源、是否出错放行、已打回次数、是否登记了唤醒 |
| `finish_wake` | 唤醒触发或作废 |

开关和上限在 Lab「设置 → Agent 行为 → Bot 收尾跟进」，存在 `bot_finish_settings`，保存后下一轮生效，没有对应的环境变量。

---

## 验证与限制

测试重点应是：无 `goalCondition` 时不介入、judge 返回非法 JSON 时 fail-open、达到 goal turn 上限时按决策器收尾、ledger metadata 可恢复。完成率和误否决率需要带任务集的 eval，不能从状态机代码推导。

---

## 关键文件

| 路径 | 说明 |
|------|------|
| `goal/goal-gate.ts` | `GoalGate` / `createGoalGateFromMetadata` |
| `goal/decide-goal-turn.ts` | 纯函数决策器 |
| `goal/parse-goal-eval.ts` | JSON 宽容解析 |
| `goal/types.ts` | `goalCondition` 等 metadata key |
| `runtime.ts`（完成路径） | gate 拦截点 + `completeText` 注入 |
| `bots/goals/finish-check.ts` | Bot 无目标一轮的收尾检查 |
| `bots/goals/finish-wake.ts` | 稍后汇报的到期唤醒 |
| `bots/goals/followup.ts` | 「继续」与进度追问接续旧目标 |
| `bots/goals/finish-settings.ts` | 上述三项的开关与上限 |
| `types.ts` `ModelAdapter.completeText?` | 判官边 |
| [16-runtime-governance.md](16-runtime-governance.md) | 与 LoopGuard/Risk 的正交关系 |
