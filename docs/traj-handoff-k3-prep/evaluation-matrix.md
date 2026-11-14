# 第三刀评估矩阵（预备）

期望列在「实现后验收」。`tip now` 列是 `c67112bc` 上的只读实核，供表征测试对照。
`blocked`：必须等第二刀合入或第三刀实现接线后才能从表征转为行为验收。

图例：

- **拒绝**：不得扣父级、不得授本地额、不得恢复、不得启动调用。
- **幂等命中**：返回与首次成功相同的已提交结果，不再扣、不再加。
- **未开放**：不进入轨迹交接状态机（走既有 Swarm / 旧路径）。

## A. 可信来源与入口隔离

| ID | 用例 | 前置 | 期望（实现后） | tip `c67112bc` now | blocked |
| --- | --- | --- | --- | --- | --- |
| A1 | 可信宿主上下文 `independent_swarm`，未显式关闭 | 第三刀入口已打开 | 独立 Swarm teammate 可进入交接 | 入口未接线，不得进入交接 | 打开入口（k2 合入当天起实现） |
| A2 | 来源 = `flywheel`，即使进入共用 `SwarmExecutor` | 飞轮 `implement` / `orchestrationRunId` | 不得自动启用交接 | 无交接接线，未启用 | 实现时保持关闭；解除属第四刀 |
| A3 | 来源字段缺失 | 可信上下文无字段，或根本没有可信上下文 | 未开放；不得默认 `independent_swarm` | 无来源字段，未启用 | 接线后仍须 fail-closed |
| A4 | 来源未知 / 非法格式（空串、非字符串、大小写变体乱写、数组、对象） | 同上 | 未开放；不得默认 `independent_swarm` | 无解析器 | 接线后仍须 fail-closed |
| A5 | Worker 在 `metadata`（或其它可写载体）自报 `independent_swarm` / `enabled: true` | 无可信上下文，或可信上下文未设来源 | 未开放；忽略自报 | metadata 可被写入但执行器不读交接资格；不得因此启用 | 接线时禁止改读 metadata 作为资格 |
| A6 | 显式关闭 + 可信上下文声称 `independent_swarm` | `enable=false` / 会话标志 / `taskRunMode` 关 | 显式关闭优先，走旧路径，不读层级 | 入口本来就关 | 依赖第二刀已走通的显式关闭语义 |
| A7 | 非 `pipeline` 策略 | `parallel-review` / `best-of-n` / `debate` / `research-implement-review` | 仍失败关闭，不顺便开交接 | 已失败关闭（既有） | 回归即可，不要改策略枚举语义 |
| A8 | 本预备 / 回退后的生产入口 | 入口关闭标志生效 | 独立 Swarm 亦不得新准入交接 | 入口未开 | 表征测试必须保持红灯用例为「未启用」 |

## B. waitDeadline 原子父级扣减 + 本地授额

| ID | 用例 | 前置 | 期望 | tip now | blocked |
| --- | --- | --- | --- | --- | --- |
| B1 | 裁决时刻 `now < waitDeadline`，仍为该身份 `awaiting_coordinator`，父级有余额，未触硬上限 | 合法 `refillId` | 同一事务：父级扣 N + 本地授 N；然后才允许恢复 / 调用 | 无父账本；`checkDeadline` 原语已在，未接线 | 账本实现（k2 合入后） |
| B2 | `now >= waitDeadline`，超时事务尚未提交 | 恢复指令先到达存储 | **拒绝**（`deadline_reached`）；不得扣、授、恢复、启动调用 | `checkDeadline` 已覆盖该原语 | 必须把该检查放进账本事务，不能只在恢复边事后检查 |
| B3 | 超时事务已提交 | 无论 deadline 是否仍在墙上 | **拒绝**（`timeout_committed`） | 原语已有 | 同上 |
| B4 | 已不再是该身份的 `awaiting_coordinator`（已 cancelled / timed_out / 已恢复 / 已驳回） | 迟到指令 | **拒绝**；不扣不授 | 内核终态无出边；账本未接线 | 账本条件提交 |
| B5 | 取消与超时都满足前置、并发提交 | 两个事务 | 先成功提交者生效，后到忽略 | 无 | 原子技术可后选，行为不可后选 |
| B6 | 等待协调器期间重启 | 独立 deadline 仍在、轮次计时器已结束 | 仍用持久化 `waitDeadline` 裁决，不继承已结束占用剩余时间 | 契约已定；宿主未把 deadline 与账本绑在一起 | 持久化形态可后选 |

## C. 幂等、竞争、硬上限、作废旧额

| ID | 用例 | 前置 | 期望 | tip now | blocked |
| --- | --- | --- | --- | --- | --- |
| C1 | 同一 `refillId` 重复投递 | 首次已成功扣+授 | 幂等命中；父级不再扣，本地不再加 | 无 | 账本 |
| C2 | 同一 `refillId` 首次失败后重试 | 例如当时 deadline 已到 | 不得把失败「重放成成功」；若前置仍失败则仍拒绝。不得另发一个成功语义 | 无 | 账本；需定义失败是否可在前置恢复后用**同一** refillId 重试（建议：期限拒绝等终局失败冻结该 refillId，新授予用新 refillId） |
| C3 | 两 Worker 争最后一份父级额度 | 并发事务 | 只有一个成功，另一个拒绝，不得超发 | 无 | 账本原子 |
| C4 | 不同 `refillId` 争同一次挂起 | 同一 `runId+workerId+attemptId` 仍 awaiting | 只一个裁决成功；另一个拒绝（即使父级余额足够） | 无 | 账本 |
| C5 | 会话已 6 次，请求第 7 次（N 至少 1） | 其余前置合法 | **拒绝**；不扣不授 | `checkHandoffCap` 已拒 session_cap；未接到补额 | 补额必须取最紧上限 |
| C6 | 本轮已 3 次，请求第 4 次 | 会话未满 | **拒绝** | `checkHandoffCap` 已拒 turn_cap | 同上 |
| C7 | N 非正整数（0、负、小数、NaN） | — | **拒绝**；不得当缺省 1 | 无 | 账本校验 |
| C8 | N 超过该 Worker 原本地上限或父级剩余 | — | 拒绝或必须钳到最紧剩余且仍为正；推荐直接拒绝超额请求，避免静默少授导致协调器误判。无论哪种，不得超发 | 无 | 实现时在接口草稿选定并写死测试 |
| C9 | `shared_scope_escalated` 时本地仍有剩余额度，随后新授成功 | 上交前 leftover > 0 | 旧本地剩余作废；只有新授额度可用；父级只按新授扣 | 无 event 名接线 | 组合层 + 账本 |
| C10 | 恢复转移进 `executor_write` | 授予已在事务中扣过父级 | 计入新授额度 1 次；**不再另扣**父级；本轮/会话/角色历史不清零；新 `attemptId`，新授已用从 0 计 | `coordinator_resumed` 已 +1 总计数；无 granted-quota 字段、无父账本 | 宿主必须把 granted quota 与 session/turn counters 分开记账 |
| C11 | 无合法 `planVersion` | 授予或驳回之外的恢复 | 不得进 `executor_write`；验收 `coordinator_no_plan → planner_readonly` **和** `coordinator_repair → planner_repair` | 内核两边已有单测；宿主未按计划有无选择边 | 组合层 |
| C12 | 角色预算累计耗尽后的授权恢复 | 其余看似合法 | 不得进执行层 | 角色预算不在本预备范围的新模块里；须接到既有角色预算 | 可能依赖第二刀已走通的普通会话预算 |
| C13 | `coordinator_rejected` | 父级不再授予或硬上限已满 | → `failed` 或 `capped` | **事件类型不存在** | 合入后扩内核事件；现在不改 `types.ts` |
| C14 | 旧 attempt 迟到恢复 / 过期 planVersion | 新 attempt 已开始或计划已升级 | 忽略或升级为协调器重验；不执行、不扣、不授 | 无 | 组合层 |
| C15 | 两个并发修订同一 `expectedOldVersion` | PlanStore 条件提交 | 只接受一个，另一个 conflict，不得静默覆盖 | `commitPlanRevision` / PlanStore API 已有 | 真实 Swarm 共享计划路径需再验 |

## D. #516 真实路径（不只 DM）

| ID | 用例 | 期望 | tip now | blocked |
| --- | --- | --- | --- | --- |
| D1 | 缺证据 / 证据不可用 / 旧版本证据 | 不得过门 | DM 与 `qualityPassed` 在任务完成路径已存在；无「真实 Swarm 交接恢复后再过门」路径 | 真实调用+恢复（入口打开后） |
| D2 | 恢复后再完成 | 必须再跑证据门并过门 | 无恢复交接路径 | 同上 |
| D3 | 内核 `done`、`answered`、`capped`、`failed`、`cancelled`、`timed_out`、`awaiting_coordinator` | 不得映射为交付成功 | delivery-mapping 已覆盖终态表；不够 | 必须在真实 Swarm 路径再验 |
| D4 | Swarm run `completed` 但质量门未过 / 评估器缺失 | 任务失败，不得交付成功 | `advanceInProgressTask` 缺评估器 → `failedQuality`；飞轮 `tryCompleteImplementStep` 仅看 Swarm 终态（第四刀主责，第三刀不得经飞轮泄出成功） | 独立 Swarm 路径保持走 `qualityPassed`；不要改 `gate.ts` |
| D5 | 既有 pipeline / store / DM 回归 | 不得回退 | 现有测试在 | 实现时必须跑 |

## E. 回退与已持久化自动会话

见 `rollback-prep.md`。矩阵摘要：

| ID | 用例 | 期望 |
| --- | --- | --- |
| E1 | 关闭获准 Swarm 入口 | 新的独立 Swarm 交接准入立即停止 |
| E2 | 在途 Swarm 交接运行 | 受控收尾或取消；结果未知失败关闭；不在旧路径重放 |
| E3 | 已持久化 `auto_policy` / 显式开启的普通会话 | 仍按第二刀策略运行；回退第三刀不得把它们关掉或改写默认 |
| E4 | 回退后的飞轮 `implement` | 不得经共用 Swarm 间接打开交接 |
| E5 | 绕过父账本「临时继续」 | 禁止 |
| E6 | 未验证产物 / 旧证据 / 内核 `done` | 不得因回退获得交付成功身份 |
