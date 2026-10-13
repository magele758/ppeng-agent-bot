# Bot HTTP 性能补充验收

`scripts/bot-release/http-load.mjs` 使用独立子进程中的真实 `createDaemonApp`、AuthStore 登录 cookie、持久 SQLite 和正常 1500ms 调度周期。模型与软件仅调用受控本地实现，不使用供应商密钥或外部服务。它补充实际 API 证据，不替代浏览器、24h、SSD 或标准硬件验收。

当前状态：小规模 harness fixture 已执行；百万条、完整 20 分钟 HTTP 负载尚未执行。每次执行产物才是该次测量证据，脚本存在不代表完整验收通过。

## 自测

```sh
node --experimental-strip-types --test scripts/test/bot-http-load-harness.test.mjs
node scripts/bot-release/http-load.mjs --smoke --smoke-seconds 5 --out test-results/bot-http-load-smoke.json
```

Smoke 保持 50 Bot、20 客户端及原请求速率，用 500 条历史、2 秒预热和 5 秒测量验证 harness。它始终标记 `fullReadWriteProtocol=false`、`fullProtocol=false`，不能用于发布放行。测试还验证子进程在 readiness 前失败、结果发出后异常退出时拒绝通过。

## 后续串行完整 API 测量

先确认原 soak 已退出，且没有其他构建、浏览器或规模负载抢占资源。此命令现在不应与 soak 同时启动：

```sh
node scripts/bot-release/http-load.mjs --out test-results/bot-http-load-full.json
```

需要排队等待某个 soak PID 时：

```sh
node scripts/bot-release/http-load.mjs --after-pid SOAK_PID --out test-results/bot-http-load-full.json
```

将 `SOAK_PID` 替换为实际数字。等待状态写入 `.queue.json`，尚未启动负载；退出后再检查现存 soak 和磁盘资源。不指定等待 PID 时，发现同机仍有 soak 会写入 `blocked-before-start`，拒绝启动完整负载。

完整版遵循原 workload.v1 的 50 Bot、10 活跃 Bot、一个 Bot 100000 条、总计 1000000 条原始历史；数据直接放入各 Bot 的实际 canonical chats，活跃对话也包含历史，未预先压缩。20 个独立客户端整体 40 RPS，300 秒预热、900 秒测量，分页/原文检索/任务状态比例 50%/30%/20%。同时输入 2 个顶层工作/秒：人类 40%、Routine 20%、委派 20%、Room 20%，委派与 Room 各至多三个下游。审批样本由测试操作者在创建至少 5 秒后通过真实 HTTP API 批准。结束后按原 120 秒预算排空。

需为种子数据库、WAL、实时历史与产物预留至少 **14 GiB** 可用工作区空间。之前存储基准的百万条数据库约 **10 GiB**；本 harness 实际大小以执行结果和保存的 stateDir 为准，不能把估算当实测。历史种子中的 1 MiB 产物以引用表达，实时软件每 100 次调用保存一次真实 1 MiB 文件并记录字节数。

## 指标与限制

- HTTP 读总延迟从计划发送时刻算到 JSON 完整接收，包括调度迟到、客户端排队和网络/服务处理；另列 socket 延迟、排队延迟、实际请求数和实际吞吐。最多同时发出 20 个读请求；不要求低延迟时人为制造 20 个在途请求。
- 接收延迟包含客户端等待。人类消息以真实 `sendUserMessage` 返回后的落盘观测为界，不把模型生成算入接收延迟；其他入口用持久接收响应，三路委派按整个顶层接收完成计。另列写 API 总延迟。
- 独立空闲探针在负载前向三个空闲目标派工，核对三个指定 session 首次真实模型调用是否在两个正常周期内开始。混合负载记录各项启动时间，不把繁忙队列都声称为空闲。
- 每个成功接收的操作按持久账本核对：人类原文及完成输出、三个委派结果、Routine 完成结果、Room 三个不同成员各一次完整结果。失败、未知、丢失或子进程异常退出不能得到 fixturePassed。
- 审批与排空查询属于额外控制请求，单列说明，不混入 40 RPS 读样本。
- `fullReadWriteProtocol` 只表示本次完整 HTTP 读写测量的数量与时长达标。`fullProtocol` 仍为 false：20 分钟运行不覆盖每小时突发、24h、浏览器首屏及全部 W8 协议。
- 浏览器 50 条首屏和 24h 进程树 RSS 窗口明确未验收，不能用分页 API 耗时代替。

当前环境实际 CPU quota 为 4 核、内存上限 16 GiB，工作区为底层介质未知的 overlay；执行 Node 为 v24，而 `.nvmrc` 指定 22。串行运行可以补充真实 API 数据，仍不满足原标准 4 vCPU、8 GiB、SSD、仓库规定 Node 的完整性能放行条件。报告始终保留 `referenceHardwareMatched=false` 和 `NOT ACCEPTED`。
