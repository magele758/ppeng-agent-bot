# 多机软件工厂：第一阶段只读试运行

验收规格：[`multi-machine-readonly-pilot`](../acceptance/multi-machine-readonly-pilot.yaml)。

## 使用

1. 在 Lab 创建协调 Bot、执行 Bot 和包含这些 Bot 的协作群。
2. 打开 **设置 → 运维 → 多机软件工厂**（`#/settings/ops/factory`）。选择协作群、协调 Bot，添加机器。
3. 每台机器填写 SSH 别名、容量、关联 Bot、允许派单的用户标识，以及远程仓库标识和绝对路径。SSH 凭据沿用运行 daemon 的账户已有配置，不通过页面或提示词传递私钥。Linux/WSL 执行端需要 Python 3、Git、已验证的 SSH 主机密钥。当前执行端使用 `fcntl` 和 `/proc`；Mac 容量应设为 0，作为连接跳板使用。
4. 保存后检查连接。Ubuntu1/Ubuntu2 的推荐容量是 2，4090 是 5，跳板机器是 0；新建机器默认 2，可修改。
5. 在配置好的协作群发送：

```text
/factory run <machine-id> <repository-id> snapshot
/factory run <machine-id> <repository-id> count-files
/factory run <machine-id> <repository-id> read-log <log-id>
/factory status <task-id>
```

也可用自然语言请求配置好的协调 Bot 派发上述只读操作；它通过 `factory_dispatch` 执行。`factory_status` 查询同一账本。群内显式指令不调用模型；自然语言派单依赖所选模型正确调用工具。每条人类请求至多建立一个任务，结果通知不会触发新的 Bot 回合。

`read-log` 只能读取配置中明确列出的普通日志文件，最多末尾 16 KiB，拒绝敏感路径、符号链接与特殊文件。结果入库、回群前脱敏已知环境密钥及常见凭据格式。不要把凭据文件配置为日志。

## 任务与恢复

- 单个中央 daemon 的 SQLite 账本是权威状态；多个调度调用共享同一账本进行原子认领。不把各机器独立的数据库当成一个分布式锁。
- 绑定工厂的 Bot 与工厂群仅提供工厂只读工具；普通 shell、编码 CLI、PTC、动态工具和写文件工具均不暴露，用户文字不能解除限制。需要后续开发能力时应进入另行验收的阶段。
- 同一机器的多个 Bot 共用容量；连接检查识别同一物理机器的不同别名，统一计数并采用其中较小的容量。
- 状态为排队、执行中、待核实、成功、失败、超时、取消。成功仅代表本次只读任务成功。排队期间移除机器或撤销权限后，该任务明确失败，不阻断其他机器。探查期间变更连接时丢弃过期结果。
- 远程执行端只运行固定程序，不接受 shell 命令；所有子进程使用脱敏环境。远程额外写入仅为 `~/.local/state/ppeng-factory` 下的任务回执与锁，不修改目标仓库。
- 启动请求与远程回执使用持久化任务编号去重。进程重启或 SSH 断开后先查原回执，不自动重新发送启动。
- 未确认远程结束的任务保留占用。主机身份变化会进入待核实。当前 UI 只允许取消排队任务；无法核实的执行不能通过界面假装完成或强行释放槽位。
- 群结果通过持久化待发送记录和群消息幂等键去重；可在群中查询状态，也可在 Lab 展开时间线和结果。
- 设置按登录主体隔离，管理设置需要管理员权限。应由同一工厂管理主体配置和使用对应协作群；本阶段不改变既有 Room 的主体隔离规则。

## 巡检

创建工厂配置后巡检默认停用，需在 Lab 启用。按 Asia/Shanghai 每个整点小时最多执行一次；后台调度器恢复后合并错过的检查。无未结束任务，或无变化且没有超过一小时无进展的执行任务时，仅检查本地账本，不 SSH、不调用模型、不发消息。

疑似停滞任务核实进程、状态新鲜度、最近提交与 CPU，保留核实记录。排队不算停滞。仅对新卡点或待核实事项发询问式提醒；当前阶段不发送常规进度巡检消息，因此夜间也仅有这两类通知。提醒去重记录随服务重启保留。

## API

所有接口通过现有 Lab 认证和路由权限检查：

| 接口 | 用途 |
|---|---|
| `GET/PATCH /api/factory/settings` | 查看/保存工厂配置；保存需要管理员 |
| `GET /api/factory/board` | 机器容量和统一任务快照 |
| `POST /api/factory/machines/:id/probe` | 连接与机器身份检查 |
| `POST /api/factory/tasks` | 只读派单；必须传 `requestKey` |
| `GET /api/factory/tasks/:id` | 任务详情与时间线 |
| `POST /api/factory/tasks/:id/cancel` | 取消排队任务 |
| `GET/PATCH /api/factory/patrol` | 巡检记录与启停；启停需要管理员 |
| `POST /api/factory/patrol/run` | 手动巡检 |
| `GET /api/factory/evidence` | 已成功任务的执行证据 |

## 重做真实机器验收

准备本机私有 JSON 配置：`machines` 数组至少两项，每项包含 `id`、`name`、`sshAlias`、`capacity`、`repositoryPath`。不用把真实路径或地址提交到仓库。

```sh
node scripts/factory-readonly-pilot.mjs <本机配置.json> <证据目录>
```

脚本启动隔离的临时本地 daemon，建立工厂 Bot 和协作群，通过真实 HTTP 群入口派单。独立 SSH 观测与任务结果交叉核对分支、SHA、工作区状态摘要和已跟踪改动内容摘要，并确认物理机器身份不同。脚本不会部署或重启已有服务。证据目录保存完整 JSON 和本地状态库，可复查实际 HTTP 看板及群消息记录。

自动化检查：

```sh
npx tsc -b packages/core apps/daemon
node --test packages/core/test/factory-readonly.test.js scripts/test/factory-routes.test.mjs scripts/test/route-access-contract.test.mjs
npm run test:acceptance
```

前端验收用例：`e2e/factory-readonly.spec.ts`，覆盖配置保存、连接反馈、状态刷新、结果展开与刷新后保留配置。真实多机证据独立于界面测试，不能用模拟机器通过代替。
