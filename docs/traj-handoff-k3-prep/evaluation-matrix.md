# 第三刀评估矩阵（预备）

生产入口保持关闭。tip `c67112bc` 没有轨迹交接宿主接线：Swarm 执行器不读交接资格，飞轮 `implement` 只经既有 `startSwarmForRun`，不得因此启用交接。

期望列在「实现后验收」。`tip now` 列是 `c67112bc` 上的只读实核，供表征测试对照。
`blocked`：必须等第二刀合入或第三刀实现接线后才能从表征转为行为验收。新行为（父级账本 / 宿主接线）标第二刀合入后。只有 tip 上已经存在的行为才写「回归即可」。

不得改 `gate.ts`。不得把交接接到 `createTeammateSession`。缺失 `capabilityTiers` 仍是 `enabled: false`，不得改成默认启用。

图例：

- **拒绝**：不得扣父级、不得授本地额、不得恢复、不得启动调用。
- **幂等命中**：返回与首次成功相同的已提交结果，不再扣、不再加。
- **未开放**：不进入轨迹交接状态机（走既有 Swarm / 旧路径）。

## A. 可信来源与入口隔离

| ID | 用例 | 前置 | 期望（实现后） | tip `c67112bc` now | blocked |
| --- | --- | --- | --- | --- | --- |
| A1 | 可信宿主上下文 `independent_swarm`，未显式关闭 | 第三刀入口已打开 | 独立 Swarm teammate 可进入交接 | 入口未接线，不得进入交接 | 打开入口（k2 合入当天起实现） |
| A2 | 来源 = `flywheel`，即使进入共用 `SwarmExecutor` | 飞轮 `implement` / `orchestrationRunId` | 不得自动启用交接（来源缺失但仍是飞轮 run 见 A9） | 无交接接线，未启用 | 实现时保持关闭；解除属第四刀 |
| A3 | 来源字段缺失 | 可信上下文无字段，或根本没有可信上下文 | 未开放；不得默认 `independent_swarm` | 无来源字段，未启用 | 接线后仍须 fail-closed |
| A4 | 来源未知 / 非法格式（空串、非字符串、大小写变体乱写、数组、对象） | 同上 | 未开放；不得默认 `independent_swarm`。精确匹配见 A10 | 无解析器 | 接线后仍须 fail-closed |
| A5 | Worker 在 `metadata`（或其它可写载体）自报 `independent_swarm` / `enabled: true` | 无可信上下文，或可信上下文未设来源 | 未开放；忽略自报 | metadata 可被写入但执行器不读交接资格；不得因此启用 | 接线时禁止改读 metadata 作为资格 |
| A6 | 显式关闭 + 可信上下文声称 `independent_swarm` | `enable=false` / 会话标志 / `taskRunMode` 关 | 显式关闭优先，走旧路径，不读层级 | 入口本来就关 | 依赖第二刀已走通的显式关闭语义 |
| A7 | 非 `pipeline` 策略 | `parallel-review` / `best-of-n` / `debate` / `research-implement-review` | 仍失败关闭，不顺便开交接 | 已失败关闭（既有） | 回归即可，不要改策略枚举语义 |
| A8 | 本预备 / 回退后的生产入口 | 入口关闭标志生效 | 独立 Swarm 亦不得新准入交接 | 入口未开 | 表征测试必须保持红灯用例为「未启用」 |
| A9 | `orchestrationRunId` 或任何飞轮 run 关联，即使来源字段缺失 | 飞轮 `implement` 进入共用 Swarm；来源未写或缺失 | 仍关闭；**不得**默认 `independent_swarm` | Swarm run 上已有可选 `orchestrationRunId`；`dispatchTask` metadata 只有 `swarmRunId` / `swarmTaskId` / `autoRun`；无交接接线 | 宿主接线（第二刀合入后）；接线后仍须 fail-closed |
| A10 | 来源字符串不精确 | `Independent_Swarm`、首尾空白、数字、对象 | **未开放**；只承认精确字符串 `independent_swarm`；不得默认、不得修剪后放行 | 无来源解析器；入口未接线 | 宿主接线（第二刀合入后） |

## B. waitDeadline 原子父级扣减、本地授额与在途调用守恒

| ID | 用例 | 前置 | 期望 | tip now | blocked |
| --- | --- | --- | --- | --- | --- |
| B1 | 裁决时刻 `now < waitDeadline`，仍为该身份 `awaiting_coordinator`，父级有余额，未触硬上限 | 合法 `refillId` | 同一事务：父级扣 N + 本地授 N；然后才允许恢复 / 调用 | 无父账本；`checkDeadline` 原语已在，未接线 | 账本实现（k2 合入后） |
| B2 | `now >= waitDeadline`，超时事务尚未提交 | 恢复指令先到达存储 | **拒绝**（`deadline_reached`）；不得扣、授、恢复、启动调用 | `checkDeadline` 已覆盖该原语 | 必须把该检查放进账本事务，不能只在恢复边事后检查 |
| B3 | 超时事务已提交 | 无论 deadline 是否仍在墙上 | **拒绝**（`timeout_committed`） | 原语已有 | 同上 |
| B4 | 已不再是该身份的 `awaiting_coordinator`（已 cancelled / timed_out / 已恢复 / 已驳回） | 迟到指令 | **拒绝**；不扣不授 | 内核终态无出边；账本未接线 | 账本条件提交 |
| B5 | 取消与超时都满足前置、并发提交 | 两个事务 | 先成功提交者生效，后到忽略 | 无 | 原子技术可后选，行为不可后选 |
| B6 | 等待协调器期间重启 | 独立 deadline 仍在、轮次计时器已结束 | 仍用持久化 `waitDeadline` 裁决，不继承已结束占用剩余时间 | 契约已定；宿主未把 deadline 与账本绑在一起 | 持久化形态可后选 |
| B7 | 调用意图已持久化、结果未落盘 | 崩溃或重启后对账 | 标记**结果未知**并失败关闭（不得把未知当成功或未发生）；保留该次预算占用，未决不得释放再花；不得自动重放。对得上账才可继续，对不上账进 `failed`，不得记 `done`。这是内核恢复行为，Swarm 路径不得分叉，不得另起第二套预算会计 | 内核已有 `checkDeadline`；调用预留把未落盘结果标 `unknown_outcome` 且不自动重放。无 Swarm 接线，无父账本 | 父级账本 / 宿主接线（第二刀合入后） |

## C. 幂等、竞争、硬上限、上交与状态边

| ID | 用例 | 前置 | 期望 | tip now | blocked |
| --- | --- | --- | --- | --- | --- |
| C1 | 同一 `refillId` 重复投递 | 首次已成功扣+授 | 幂等命中；父级不再扣，本地不再加 | 无 | 账本 |
| C2 | 同一 `refillId` 首次已因终局原因失败后再投递 | deadline 已到、该挂起已有裁决、或硬上限已拒绝 | 该 `refillId` **冻结**。不得把失败重放成成功，也不得在前置后来变好后用同一 `refillId` 改判成功。后续成功授予必须用新 `refillId` | 无父账本 | 父级账本（第二刀合入后） |
| C3 | 两 Worker 争最后一份父级额度 | 并发事务 | 只有一个成功，另一个拒绝，不得超发 | 无 | 账本原子 |
| C4 | 不同 `refillId` 争同一次挂起 | 同一 `runId+workerId+attemptId` 仍 awaiting | 只一个裁决成功；另一个拒绝（即使父级余额足够） | 无 | 账本 |
| C5 | 会话已 6 次，请求第 7 次（N 至少 1） | 其余前置合法 | **拒绝**；不扣不授 | `checkHandoffCap` 已拒 session_cap；未接到补额 | 补额必须取最紧上限 |
| C6 | 本轮已 3 次，请求第 4 次 | 会话未满 | **拒绝** | `checkHandoffCap` 已拒 turn_cap | 同上 |
| C7 | N 非正整数（0、负、小数、NaN） | — | **拒绝**；不得当缺省 1 | 无 | 账本校验 |
| C8 | N 超过该 Worker 原本地上限、父级剩余，或本轮/本会话剩余硬上限 | — | **拒绝**超额 N；不得静默钳制少授。不得超发 | 无 | 父级账本（第二刀合入后） |
| C9 | `shared_scope_escalated` 时本地仍有剩余额度，随后新授成功 | 上交前 leftover > 0 | 进入 `awaiting_coordinator` 即作废旧本地剩余（不等新授成功才作废）；只有新授额度可用；父级只按新授扣；旧剩余不得与新授并存 | 无 event 名接线 | 组合层 + 账本 |
| C10 | 恢复转移进 `executor_write` | 授予已在事务中扣过父级 | 计入新授额度 1 次；**不再另扣**父级；本轮/会话交接计数、角色历史累计、**父级已用计数**都不清零；新 `attemptId`，新授已用从 0 计 | `coordinator_resumed` → `executor_write` 在内核计 +1；无 granted-quota 字段、无父账本，tip 上没有父级已用计数可清零 | 宿主必须把 granted quota 与 session/turn counters 分开记账；父级已用另计 |
| C11 | 无合法 `planVersion` | 授予或驳回之外的恢复 | 不得进 `executor_write`。无合法计划时允许改走 `failed`（代替进入执行层），但验收仍必须打到 `coordinator_no_plan → planner_readonly` **和** `coordinator_repair → planner_repair`。不得收成「只要不是 executor」 | 内核两边已有单测；宿主未按计划有无选择边 | 组合层 |
| C12 | 角色预算累计耗尽后的授权恢复 | 其余看似合法 | → `failed`，或退回规划态并仍受该累计约束。**不得**进 `executor_write`。**不得**靠新 attempt / 新占用把累计预算刷新为满额 | 角色预算不在本预备范围的新模块里；须接到既有角色预算 | 可能依赖第二刀已走通的普通会话预算 |
| C13 | `coordinator_rejected` | 父级不再授予或硬上限已满 | → `failed` 或 `capped` | **事件类型不存在** | 合入后扩内核事件；现在不改 `types.ts` |
| C14 | 旧 attempt 迟到恢复 / 过期 planVersion | 新 attempt 已开始或计划已升级 | 忽略或升级为协调器重验；不执行、不扣、不授 | 无 | 组合层 |
| C15 | 两个并发修订同一 `expectedOldVersion` | PlanStore 条件提交 | 只接受一个，另一个 conflict，不得静默覆盖 | `commitPlanRevision` / PlanStore API 已有 | 真实 Swarm 共享计划路径需再验 |
| C16 | 依赖、共享接口或验收标准变更 | 本地额度仍有剩余 | 发出 `shared_scope_escalated` 并进入 `awaiting_coordinator`；不是任务终止。旧本地剩余作废（见 C9） | 无该事件名接线。内核 `escalate` 可进 `awaiting_coordinator`，但不是这条 Swarm 事件。无父账本 | 父级账本 / 宿主接线（第二刀合入后） |
| C17 | 恢复 Worker A 会使已按旧接口做完的 Worker B 过期 | 不能证明其他 Worker 不受影响 | **不得**只恢复 A。暂停并重新验证受影响集合，再恢复该集合。「只恢复该 Worker」不是无条件保证 | 无影响范围证明，无 Swarm 恢复接线 | 宿主接线（第二刀合入后） |
| C18 | 尚无已接受计划时的失败与上交 | `planner_readonly`，计划仍空 | 失败与上交事件仍须能发出；**不得**进入 `executor_write` | 内核在无计划时已有 `fail → failed` 与 `escalate_no_plan → awaiting_coordinator`，都不进执行层。宿主未发 Swarm 失败/上交事件 | 宿主接线（第二刀合入后） |
| C19 | 崩溃恢复 | 崩溃前同一运行态或挂起态 | 不是协调器恢复：不加一、不新授、不新建 `attemptId`、不新开轮次、不清计数。不得与 `coordinator_resumed` 混用 | 内核计数注释写明崩溃恢复不加一；`handoffIncrement` 无崩溃恢复 +1 边。无父账本、无新授 | 宿主接线（第二刀合入后）；不得在 Swarm 侧把崩溃恢复做成补额 |
| C20 | `local_capped_escalated` | 仅本地上限用尽，父级仍可能有余额 | 上交到 `awaiting_coordinator`，不是任务终止。父级也用尽且不再授予时，才进入 Swarm 级 `capped` 或 `failed` | 无该事件名接线。内核 `escalate → awaiting_coordinator` 与 `cap_exceeded → capped` 已分开，宿主 Swarm 未用。无父级耗尽裁决 | 父级账本 / 宿主接线（第二刀合入后） |
| C21 | 一次授予 N 个正整数单位 | 授予事务已提交 | 恢复后最多再完成 N 次本地交接。进入 `executor_write` 的这次恢复消耗其中 1 次。父级已在授予时扣过，恢复转移不再另扣 | 内核 `coordinator_resumed` 进 `executor_write` 计 +1，注释写明父级在授予时已扣。无 granted-quota 字段、无父账本，tip 上不能验收「最多 N 次」 | 父级账本 / 宿主接线（第二刀合入后） |
| C22 | `plan_ready` 交接预算不足，且 Swarm 可以上交 | 已有计划，本地/本轮/本会话交接额度不够上执行 | → `awaiting_coordinator`。不得直接 `capped` 当交付成功，不得进 `executor_write`。尚无已接受计划时，允许从 `planner_readonly` 上交（见 C18） | 内核已有 `plan_ready` + `budget_insufficient` → `awaiting_coordinator`，以及 `planner_readonly` + `escalate_no_plan` → `awaiting_coordinator`。另有 `cap_exceeded` → `capped`。不得把这些内核边写成宿主 Swarm 路径已使用。入口未接线 | 宿主接线（第二刀合入后）；内核边可回归，不得据此声称 Swarm 宿主已走该边 |

## D. #516 真实路径（不只 DM）

第三刀必须验证真实 Swarm 调用与恢复路径，包括缺证据、不可用证据和旧版本证据。不能只测终态映射。完整 `acceptance/collaboration-quality-gates.yaml` 留第四刀。不得改 `gate.ts`，不得把缺失 `capabilityTiers` 改成默认启用。

| ID | 用例 | 前置 | 期望 | tip now | blocked |
| --- | --- | --- | --- | --- | --- |
| D1 | 缺证据 / 证据不可用 / 旧版本证据 | 真实 Swarm 调用或恢复后的完成路径 | 不得过门 | DM 与 `qualityPassed` 在任务完成路径已存在；无「真实 Swarm 交接恢复后再过门」路径 | 真实调用+恢复（入口打开后） |
| D2 | 恢复后再完成 | 已恢复并再次完成 | 必须再跑证据门并过门 | 无恢复交接路径 | 同上 |
| D3 | 内核 `done`、`answered`、`capped`、`failed`、`cancelled`、`timed_out`、`awaiting_coordinator` | 这些状态要映射到交付 | 不得映射为交付成功 | delivery-mapping 已覆盖终态表；不够 | 必须在真实 Swarm 路径再验 |
| D4 | Swarm run `completed` 但质量门未过 / 评估器缺失 | Swarm 终态已完成 | 任务失败，不得交付成功 | `advanceInProgressTask` 缺评估器 → `failedQuality`；飞轮 `tryCompleteImplementStep` 仅看 Swarm 终态（第四刀主责，第三刀不得经飞轮泄出成功） | 独立 Swarm 路径保持走 `qualityPassed`；不要改 `gate.ts` |
| D5 | 既有 pipeline / store / DM 回归 | 既有测试集 | 不得回退 | 现有测试在 | 实现时必须跑 |
| D6 | 证据与被验证版本、任务范围绑定 | 恢复后或版本/范围已变的完成出口 | 证据必须同时绑定被验证的版本**和**任务范围。旧版本或错范围不得过门。不得改 `gate.ts` | 任务完成路径有证据门；没有「版本且任务范围」绑定的 Swarm 交接恢复路径。飞轮 implement 完成不看 `qualityPassed`（第四刀，本预备不改） | 父级账本 / 宿主接线（第二刀合入后）；真实调用+恢复 |

## E. 回退与已持久化自动会话

见 `rollback-prep.md`。矩阵摘要：

| ID | 用例 | 前置 | 期望 | tip now | blocked |
| --- | --- | --- | --- | --- | --- |
| E1 | 关闭获准 Swarm 入口 | 实现后入口曾打开；本预备未打开 | 新的独立 Swarm 交接准入立即停止 | 入口未开，无交接接线；没有可关的已准入运行 | 入口打开后的回退演练；现在不得借回退打开入口 |
| E2 | 在途 Swarm 交接运行 | 存在在途交接运行 | 受控收尾或取消；结果未知失败关闭；不在旧路径重放 | 无交接运行可收尾 | 入口打开且有在途运行后；见 B7 |
| E3 | 已持久化 `auto_policy` / 显式开启的普通会话 | 第二刀已写入的普通会话开启面 | 仍按第二刀策略运行；回退第三刀不得把它们关掉或改写默认 | 本预备不改普通会话默认，也未打开 Swarm / 飞轮入口 | 第二刀合入后的回退演练 |
| E4 | 回退后的飞轮 `implement` | 第三刀入口已关 | 不得经共用 Swarm 间接打开交接 | 飞轮经 `startSwarmForRun`，无交接接线 | 入口打开后再回退时仍须保持关闭；现在不得打开飞轮 |
| E5 | 绕过父账本「临时继续」 | 有人提议绕过父账本补额 | 禁止 | 无父账本，也无临时继续路径 | 账本存在后的回退演练 |
| E6 | 未验证产物 / 旧证据 / 内核 `done` | 回退之后的交付判定 | 不得因回退获得交付成功身份 | 门禁在；交接恢复路径未接线。不得改 `gate.ts` | 真实路径再验；回退不得放宽 |
| E7 | 用第三刀回退演练第四刀飞轮回退 | 本预备；两入口都未打开 | 不得靠关掉一个尚未验收、本预备也未打开的独立 Swarm 入口，来模拟第四刀回退。第三刀回退不得打开飞轮。已验收的独立 Swarm 入口只在显式回退第三刀时关闭，不随飞轮回退一起关 | 本预备没有打开独立 Swarm 入口，也没有打开飞轮入口 | 入口都未打开；不得在本预备里预支任一入口的开或关 |
