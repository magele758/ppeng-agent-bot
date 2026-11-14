# 第三刀检查清单（预备；生产入口保持关闭）

依据 v2.3 §10 / §8.4 / §6.3 R1 / §12 / §14 Swarm+门禁组，v1.1 §4，拆分稿 §2 与 §5。
本清单是实现日后的对照表，不是批准现在打开入口。

## 0. 门禁与范围（全程）

- [ ] 不放宽 #516，不改 `packages/core/src/quality/gate.ts`，不改成功映射 / 证据复用换绿灯。
- [ ] 不改名或替换飞轮 Orchestrator；不重写 Swarm 策略（非 pipeline 继续失败关闭）。
- [ ] 不在 agent-loop 之外另立交接状态机或预算账本；禁止双权威。
- [ ] 不把「只恢复该 Worker」当成无条件保证。
- [ ] 不由 Worker 自行宣称入口资格。
- [ ] 第三刀不解除「飞轮经共用 Swarm 不得自动启用交接」。
- [ ] Pattern B 零实现（含入口关闭基础原语）。
- [ ] 改代码与刷新 Formal 审查指纹必须同一次推送；推前本机先跑会踩到的 Formal 相关用例。
- [ ] 合入须同时有「未回退」和「本刀能力提升」证据。无提升证据不得合。

## 1. 可信来源与入口隔离（fail-closed）

实现阶段才接线；本预备只要求夹具与表征测试按此断言。

- [ ] 来源只能来自可信宿主上下文（只读），不得读 Worker 可写 / 可注入的 `metadata` 或其他不可信载体。
- [ ] 合法来源枚举（实现时）：`independent_swarm`（第三刀获准后可开）vs `flywheel`（第三刀必须视为未开放）。
- [ ] 缺失、未知、格式非法：一律按未开放处理，**不得默认落入 `independent_swarm`**。
- [ ] 显式关闭优先级最高（v2.3 §8.4）：会话标志 / `taskRunMode` 关闭 / `enable=false` 时，即使可信上下文声称 `independent_swarm`，也不得进入交接。
- [ ] 第三刀实现后：仅可信 `independent_swarm` 且未显式关闭时，独立 Swarm 可进入交接。
- [ ] 即便任务进入共用 `SwarmExecutor`，`flywheel` 来源以及任何 orchestration 飞轮 run 关联，仍不得自动启用交接。
- [ ] 来源必须精确匹配：仅可信上下文中的精确 `independent_swarm` / `flywheel` 为合法来源。`orchestrationRunId` 即使没有来源字符串也算飞轮，不得因此自动启用交接。
- [ ] 缺失 `capabilityTiers` 保持 `enabled: false`；回退不得改成默认开启。显式关闭与旧会话默认关保持关。
- [ ] 实现必须保留关闭获准 Swarm 宿主入口的手段；本预备不在生产代码添加该开关，也不打开入口。
- [ ] 回退后关闭获准入口，立即阻止新的交接准入；不得使飞轮经共用执行器间接打开。
- [ ] **本预备阶段生产入口保持关闭**：表征测试必须证明 tip 上独立 Swarm 也尚未启用交接。

## 2. 父级权威账本 + waitDeadline 原子授额

- [ ] 唯一权威绑定父 `runId`；Worker 只持有被授予的本地额度，不得改父账本。
- [ ] 存储形态可后选（持久化唯一账本，或父实例内权威状态），但不得两份权威；原子技术可后选。
- [ ] 父级扣减与本地授额必须在同一原子事务中提交。
- [ ] 同一事务除校验「仍处于该身份的 `awaiting_coordinator`」外，必须同时校验**裁决时刻未达到持久化 `waitDeadline`**（复用已有 `checkDeadline` 语义，不得另写一套期限）。
- [ ] 期限已到，即使超时事务尚未提交，也必须拒绝：不得恢复、不得扣父级预算、不得授予本地额度、不得启动调用。
- [ ] 超时事务已提交时同样拒绝（`timeout_committed`）。
- [ ] 取消与超时均满足前置而竞争时，以先成功提交的持久化事务为准，后到忽略。

## 3. refill 身份、幂等、一次挂起一次裁决

- [ ] 每一次授予有不可复用的 `refillId`。
- [ ] 同一 `refillId` 重复投递幂等：只承认第一次成功的扣减与授予，不得再次扣减或加额。
- [ ] 授予必须绑定父 `runId`、`workerId`、待恢复 `attemptId` / 挂起身份。
- [ ] 不同 `refillId` 争同一次挂起：只允许一个裁决成功，另一个必须拒绝。
- [ ] 事件必须带 `runId`、`workerId`、`dedupeId`、`attemptId`；`planId` / `planVersion` 仅在已有已接受计划时携带。尚无已接受计划时，失败与上交事件仍须能发出。
- [ ] 过期 `planVersion` 事件丢弃或升级为协调器重验，不得当新指令执行。
- [ ] 旧 attempt 的迟到恢复必须忽略。
- [ ] 等待期取消 / 超时之后的迟到恢复必须忽略，不得重新启动任务。

## 4. 补额守恒与硬上限 3/6

- [ ] 1 单位 = 1 次本地交接。N 为正整数。
- [ ] N 不得超过：该 Worker 原本地上限、父级剩余、剩余本轮硬上限、剩余本会话硬上限。取最紧者。
- [ ] 会话已 6 次不得准许第 7 次；本轮已 3 次不得准许第 4 次。第 6 次合法占用可做完；第 7 次请求才拒绝。
- [ ] `cap=0` / 非法 caps 的解析属配置层（缺省 3/6，不关交接）；补额路径不得用 cap=0 绕过显式关闭，也不得突破硬上限。
- [ ] `shared_scope_escalated`（本地额度未用尽也可上交）必须作废旧本地剩余额度，不得与新授额度同时可用。
- [ ] `local_capped_escalated` 与共享范围上交都不是任务终止；进入 `awaiting_coordinator`。
- [ ] 成功授予后 `coordinator_resumed`：新 `attemptId`，新授额度从 0 计，**不清零**本轮 / 会话 / 角色历史。
- [ ] 崩溃恢复不是协调器恢复：不得把崩溃恢复当成 `coordinator_resumed`，也不得因此加一或清零历史。
- [ ] 父级已用次数不因恢复而清零；`coordinator_resumed` 不得清掉父级已用计数。
- [ ] 有合法已接受计划随指令下发时，`awaiting_coordinator → executor_write` 计入新授额度 1 次；父级已在授予时扣过，恢复转移不再另扣。
- [ ] 无合法 `planVersion` 不得进执行层，须验收回到 `planner_readonly` **和** `planner_repair` 两条路径（不只验收「不得进执行层」）。
- [ ] 角色预算累计耗尽时，授权恢复也不得进执行层。
- [ ] 驳回走 `coordinator_rejected` → `failed` / `capped`（tip 上该事件尚不存在，实现时补；本预备不改 `types.ts`）。

## 5. 共享计划与单 Worker 恢复前提

- [ ] 复用 `PlanStore.save(..., expectedOldVersion)` / `commitPlanRevision`：同一旧版本并发修订只接受一个，不得静默覆盖。
- [ ] 若恢复 A 会使已按旧接口完成的 B 过期，必须暂停并重验受影响集合后再恢复该集合。
- [ ] 共享接口、依赖或验收标准变更必须发出 `shared_scope_escalated`，即使本地额度仍有剩余。
- [ ] 单 Worker 恢复仅在能证明其余 Worker 不受影响时允许；无此证明不得只恢复该 Worker。

## 6. #516 真实路径（本刀不能省，但不能只靠本预备完成）

- [ ] 真实 Swarm 调用与恢复路径，不只 DM-1…DM-9 终态映射。
- [ ] 缺证据、不可用证据、旧版本证据不得过门。
- [ ] 证据必须绑定到实际被验证的版本和任务范围。
- [ ] 恢复后再完成仍过门；恢复路径漏跑门禁被挡住。
- [ ] `answered` / `capped` / `failed` / `cancelled` / `timed_out` / `awaiting_coordinator` 与内核 `done` 不得映射成交付成功。
- [ ] 既有 `swarm-executor.test.js`、`swarm-store.test.js`、`trajectory-handoff-delivery-mapping.test.js`、`acceptance/delivery-mapping.yaml` 不得回退。
- [ ] 不必提前跑完整 `acceptance/collaboration-quality-gates.yaml`（留第四刀），也不得把本刀回归整段推迟。
- [ ] 独立 Swarm 成功出口仍须走现有 `qualityPassed`（`advanceInProgressTask` 已调用）；不得把内核 `done` 或 Swarm `completed` 单独当作交付成功的充分条件。

## 7. 回退（详见 rollback-prep.md）

- [ ] 关闭获准 Swarm 宿主入口，立即阻止新的交接准入。
- [ ] 已有运行受控收尾或取消，不得直接在旧路径重放；结果未知的在途调用失败关闭，保留占用，不得自动重放。
- [ ] 保留且不改写、不重放到旧路径：已用预算、计划版本、未决调用、等待裁决记录、已持久化 `waitDeadline`。迟到事件不得重新启动任务。
- [ ] 普通会话交接仍按第二刀策略运行，**包括已经持久化自动策略的会话**。
- [ ] 不得靠放宽策略或绕过父级账本「临时继续」。
- [ ] 不得破坏第二刀单会话承诺，不得使飞轮经共用 Swarm 间接打开交接。
- [ ] 缺失 `capabilityTiers` 保持 `enabled: false`，回退不得默认开启；显式关闭与旧会话默认关保持关。
- [ ] 实现必须保留关闭获准 Swarm 宿主入口的开关；本预备不实现该开关，不打开生产入口。
- [ ] 入口关闭后，挂起 `awaiting_coordinator` 上的迟到 `coordinator_resumed` 或新 `refillId` 必须拒绝：不扣父级、不授本地额度、不启动调用。取消与超时均已满足前置而竞争时，先成功提交的事务胜出，后到忽略（v2.3 §6.3）。
- [ ] 飞轮 `implement` 经 `startSwarmForRun` / `tryCompleteImplementStep` 仍不得启用交接。不得改 `engine.ts` 或 `gate.ts`，不得借回退打开交接或放宽 #516 去补 `tryCompleteImplementStep` 不调用 `qualityPassed` 的缺口（该缺口属第四刀；tip 上该函数按 Swarm 终态 `completed` / `failed` / `cancelled` 结束 implement 步）。
- [ ] 第四刀交互（预备说明，现在不执行）：一旦第四刀存在，回退第四刀必须让已验收的独立 Swarm 入口仍可运行，并重新施加「飞轮不得经共用执行器自动启用交接」。回退第三刀不得打开飞轮，也不得用来预先关闭将来才验收的独立入口。本预备两个入口都未打开。
- [ ] 只有在没有需新协议处理的活动运行、或已有兼容处理能力时，才回滚到不理解这些运行记录的程序版本。

## 8. 本预备可打勾的项（2026-11-14 17:07 Asia/Shanghai）

- [x] 在隔离树写下检查清单、评估矩阵、夹具说明、回退准备、父账本接口草稿。
- [x] 写下入口 / 补额 / 门禁路径测试骨架，且未放入 `packages/core/test/` 收集路径。
- [x] 确认 tip 表征：Swarm 入口未接线；非 pipeline 失败关闭；内核 cap / 规划态回边已有单测。
- [ ] 表征测试尚未在本树跑通（`packages/core/dist` 缺失；本预备不主动全量 build，以免干扰共享机器与第二刀）。
- [ ] 第二刀合入前，不扩 `types.ts`、不落地账本、不打开入口。
- [ ] 评估矩阵、回退准备与测试骨架的收紧只停留在本预备文档，不代表表征测试已跑（`packages/core/dist` 仍缺失）。
