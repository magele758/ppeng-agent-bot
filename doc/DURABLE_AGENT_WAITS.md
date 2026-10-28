# Agent 持久化等待

Goal / Routine 执行中调用 `wait_for`，登记来源、引用、条件与继续执行的摘要。登记及工具结果写入后，执行器结束本次模型回合。现有调度器读取轻量状态，只有条件满足才恢复原 Goal 或同一次 Routine occurrence。

```json
{
  "source": "session",
  "ref": "<当前权限范围内已有的子会话 ID>",
  "condition": {"op": "in", "field": "status", "values": ["completed", "failed", "cancelled"]},
  "summary": "读取已完成执行的证据，核对目标，再继续剩余工作",
  "maxChecks": 1000
}
```

工具仅对正在执行且归属明确的 Goal / Routine 直接暴露，完整工具模式和工具搜索也不绕过此范围及既有 allowlist；引用必须来自实际工具结果，不能杜撰。一次执行只有一个有效等待。`deadline` 是可选的绝对 Unix 毫秒时间，`maxChecks` 是观测次数预算。应独立调用 `wait_for`，不要在同一工具波次混入新的外部副作用。

## 机制与边界

- SQLite 保存 owner、修订/attempt、主体权限、条件、基线、最新证据及消费状态。等待可跨进程重启。
- 条件支持 `eq/ne/in/gte/lte/changed/all/any`，限定来源声明的标量字段；缺失字段、观察失败、未知状态均不等于完成。`changed` 比较首次可用基线。
- 触发后保留 ready 状态；恢复前重新检查资源访问权限。消费和写入恢复事件处在同一数据库事务内；原有 Goal 唤醒去重和 Routine lease 继续负责调度。
- 取消、目标修订变化、Routine attempt 变化使旧等待无效。授权撤销阻止恢复。超出期限或检查预算不会触发模型。停用 Routine 时保留等待，重新启用后检查。
- 工具调用和结果必须配对完整才能形成等待检查点。未关闭的工具波次按未知副作用处理，不伪造结果。恢复后的外部副作用仍由现有执行器的检查点、审批和幂等机制负责，不能把调度去重理解为所有外部操作严格执行一次。
- Goal 复用原目标与执行器；Routine 使用原 occurrence 和会话，追加 `[wait resumed]` 证据，不重复追加原始启动指令。等待不调用模型，也不发周期性静默消息。Goal 的既有资源/并发保留策略不变。

## 来源扩展

内置 `session`（同主体、同 Bot 的后代会话）、`bot_task`（当前 Bot 请求的任务）、`routine_run`（同 scope 的 occurrence）。字段为 `status/version`，后两者还含 `attempt`。引用表示逻辑资源；需要限定一次尝试时，把 `attempt` 条件纳入 `all`。

宿主经公开的 `registerWaitSource(store, name, adapter)` 注册通用来源，声明 `fields` 并实现同步 `observe(context, ref)`，返回 `available + facts`、`unavailable` 或 `unauthorized`。适配器必须每次鉴权、不得调用模型，并在宿主重启后重新注册。工具描述自动列出已注册来源的字段。适配器是宿主能力，模型不能注册任意代码。

本阶段读取本地结构化状态，沿用现有调度 tick，尚未接入远端 webhook，也不把任意 shell / 网页轮询自动转换成被动订阅。后续外部连接器可把事件落入本地观测存储，复用条件判断与恢复链路；无需为具体任务另写调度分支。既有 Routine 不会自动迁移，新执行在调用 `wait_for` 后进入此模式。

## 验证与真实日志回放

```sh
pnpm exec tsc -b packages/core
node --test packages/core/test/durable-*.test.js
node scripts/replay-agent-waits.mjs
pnpm run test:acceptance
```

`packages/core/test/fixtures/durable-wait-cadence.json` 来自本机 2026-10-20 至 2026-10-28 的 Routine 快照：54 个 Routine、826 次调度。仅保留分组序号、相对时间、历史状态；删除提示词、身份、结果正文，记录原快照 SHA-256。

回放分“不可用”和“持续不变”两组，各按 826 次真实调度节奏检查，中途关闭/重开数据库。两组在注入完成前恢复次数均为 0；对一个来源注入完成后，该 owner 恢复 1 次，其他 owner 和重复检查均为 0。这里的观测是明确标注的合成输入：原日志没有足够的外部观测，不能证明历史任务已完成或健康，也不能据此声称实际节省了多少账单。真实内核集成测试另行验证等待前后模型调用次数与工具配对。

当前停止边界复用默认 `agent-loop` 内核的 `stopAtToolNames`，不修改 SDK。实验性 `ppeng` 旧内核缺少该能力，工具在登记前明确拒绝；可通过 Lab 现有 Loop 设置切换到 `agent-loop`，避免登记后继续空转。

### 后台执行来源

`bg_run` 在当前宿主确认的 Goal/Routine 执行内返回 `waitFor` 时，可将其 source/ref/condition 传入 `wait_for`，再补充当前工作的继续摘要。`background_job` 来源暴露 `status/version/startedAt/sessionId`，只接受该次实际执行获得的任务；每次观察和消费都重验主体、Bot 与持久任务的启动身份。读取旧 PID、另一项工作的任务 ID 或模型生成的引用都不会获得恢复权限。状态变化只是继续检查的触发，不是 Goal 完成证据；输出仍需通过 `bg_check` 获取并核验。
