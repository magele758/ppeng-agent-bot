# 会话生命周期验证：范围与发现

日期：2026-10-19。以下保留首次验证的反例；用户批准三条独立修复标准后，L-1、L-2 已修复，生命周期与修复验收均为 implemented。

运行 `npm run test:lifecycle`。证据写入 `coverage/formal/lifecycle/report.json` 和 `report.md`。设计模型独立通过不代表真实实现通过；修复后的整体运行已通过。

首次证据快照见 [session-lifecycle-evidence.json](session-lifecycle-evidence.json)：验收测试 9 通过、2 失败；真实场景 17 通过、3 失败（其中两种迟到取消对应同一条 AC-3）；三种变异均捕获且恢复一致。Node 22.21.1 与 26.7.0 的完整报告除版本字段外一致，配对验证与相关 30 项回归保持通过。静态验收门禁通过只代表测试标签齐备，运行门禁因 AC-3/AC-5 正确失败。

## L-1：已结束运行收到取消后，结束原因被改写

真实场景 `late-cancel-completed`、`late-cancel-failed`：

1. 通过 RawAgentRuntime 正常完成任务，或令一次模型重试耗尽并失败。
2. 确认 SQLite 中已有 completed/completed 或 failed/failed 的状态和运行结果。
3. 调用公开取消入口。
4. 会话状态仍是 completed/failed，但结果变成 aborted、reason=abort。

来源：`packages/core/src/runtime/session-control.ts` 的取消路径，对非等待审批的会话未判断是否仍有活动运行，直接写入取消结果。

这是公开运行与取消接口的真实复现，不是仅检查手写状态表。新运行收到旧调用方信号、旧审批决定以及取消后的旧重试计时器场景目前通过；不能把 L-1 泛化为这些场景都失败。

## L-2：部分审批后，会话状态和等待原因不一致

真实场景 `approval-partial`：

1. 模型请求两个必须审批的本地工具，真实流程创建两项待决审批，会话进入 waiting_approval。
2. 只批准第一项，第二项仍 pending。
3. 立即查询会话：status=idle，outcome.kind=waiting_approval，interrupt 仍存在。
4. 再次进入运行会重新停回 waiting_approval，且没有执行未获准工作；但这不能消除第 3 步已经存在的对外不一致。

来源：`packages/core/src/runtime/session-facade.ts` 的审批决定路径，只要当前会话等待审批，就将其置为 idle，没有等待其余事项全部决定。

## 证据和边界

- 设计模型：普通对话/任务、先后两次运行、每次最多两个审批和一次模型请求重试、一波工具；穷举 368 个状态、2,290 次转移。单写者，不证明多进程或无限规模。
- 真实实现：20 个场景，使用 RawAgentRuntime、默认 agent-loop 装配及 SQLite。只有模型/工具输出可控，不替换取消、审批、重试或内核控制流。仓库与状态目录分开，避免夹具自身的递归复制错误。
- 模型错误与运行前置条件错误不能冒充产品反例。首次夹具把状态目录放在任务仓库内，导致复制任务工作区失败；已修正夹具后才确认 L-1/L-2。
- 故障演练：在独立子进程的 ESM 加载边界变异真实源码，分别关闭取消信号、保留错误的 running 状态、重复执行审批恢复工具。只有基线绿色场景新增失败才算捕获，且必须确认变异模块实际加载。原源码不变，恢复结果必须与基线一致。
- 已有工具配对验证原样保留。未扩大到 UI、真实网络模型、外部副作用撤销或强杀/断电后的恢复。

## 已批准修复与复验

- 取消仅在仍有活动运行或等待审批时修改 transcript 与结束结果；迟到重复取消保留已结束结果。后台任务取消信号仍正常发送。
- 同会话还有 pending 审批时保持 waiting_approval；最后一项决定后才允许恢复。部分审批后的取消会拒绝剩余事项并清除 interrupt。
- 新增三条 SQLite 测试先得到 3/3 失败，再实现修复得到 3/3 通过。红阶段分别观察到结束原因覆盖、提前 idle、取消后 interrupt 残留。
- core TypeScript 构建通过；相关取消、审批、结束结果和工具波次测试 58/58 通过（含新增 3 项）。验证器验收测试 19/19 通过；npm run test:formal 包含两项完整验证及原 25 项回归，全部通过。
- 生命周期真实场景 20/20 通过；有界模型 368 状态、2,290 转移穷尽；三种源码变异均捕获且恢复一致。配对模型 5,988 状态、11,392 转移、真实探针和变异均通过。
- npm run test:acceptance 静态追踪通过。随后全量单测 3,824 通过、0 失败、4 项按既有环境条件跳过；SDK Vitest 407/407、Chromium E2E 160/160 通过，E2E 无跳过或 flaky。工作区完整构建及 git diff --check 通过。

修复证据见 [session-lifecycle-fix-evidence.json](session-lifecycle-fix-evidence.json)。原始失败快照保留，所有已批准标准和原真实运行探针未改变；复核只更新两处修复源码指纹并纳入新增回归测试。

## 全量回归补验

2026-10-19 按用户要求完成全量回归，未发现新的产品缺陷，现有验收标准未改动。详情及跳过原因见 [session-lifecycle-full-regression-evidence.json](session-lifecycle-full-regression-evidence.json)。根目录单测与 SDK/E2E 使用 Node 22.21.1；工作区构建使用 Node 26.7.0。日志及 E2E JSON 报告保存在 coverage/formal/full-regression/。
