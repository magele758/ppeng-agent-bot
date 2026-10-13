# Bot CUA 验收交接

本次交接准备隔离环境与操作步骤，并完成了辅助实例的短暂纯 HTTP 启动/清理自检。当前会话未提供可调用的专用 computer-use/CUA 工具，因此没有执行或声称完成 CUA；这不表示其他会话、桌面主机或环境没有 CUA。已完成的 Playwright 是独立的浏览器自动化证据，不能代替本交接的屏幕、鼠标、键盘验收。

## 已有证据与环境边界

- `test-results/bot-round12-full-junit.xml`：114/114，无重试。
- `test-results/bot-round12-critical-{1,2,3}-junit.xml`：11/11 三轮，无重试。
- `test-results/bot-round12-fingerprint-{before,after}.json`：被测生产源码与构建产物前后相同。
- 本文及 `scripts/bot-cua-instance.mjs` 在上述测试之后新增，不属于 Round 12 执行覆盖。辅助脚本已检查语法、`--help`，并在明确授权后完成纯 HTTP 启动/清理自检；没有启动浏览器，没有构建或修改生产源码/dist。下文的屏幕 CUA 仍待接收者执行。

现有 `scripts/e2e-run.mjs` 使用独立 mkdtemp、随机回环端口、daemon/Next 同一随机 Bearer，结束时通过 `e2e-lifecycle.mjs` 清理进程组和状态目录。它没有“测试后保留实例”的开关。设置 `PLAYWRIGHT_BASE_URL` 只表示使用已存在实例，并不会替使用者创建或保留服务。

## 启动和保留可操作实例

在长测结束后，使用已安装依赖、已构建的同一候选目录。不要同时运行 Next build/dev，也不要将这个实例接到生产状态目录。

```bash
cd /workspace/ppeng-agent-core
TMPDIR=/workspace/.bot-test-tmp node scripts/bot-cua-instance.mjs
```

其他主机将第一行换为候选仓库路径，TMPDIR 必须是已存在、可写的目录；也可不指定 TMPDIR 使用系统临时目录。脚本遇到缺失或非完整生产构建会直接报错，不自动重新构建。需要构建时应先完成独立候选构建与快照流程。

该命令不启动浏览器。终端出现 `READY` 后，复制输出的 `webBase`，在具有 CUA 能力的**同一主机**浏览器中打开。若 CUA 位于另一主机，需要环境提供者配置经过授权的浏览器访问或端口转发；不要把回环 URL 当作公网 URL，也不要自行将 daemon 改为公网监听。

终端保持运行就是“保留实例”；浏览器刷新或关闭不会删除状态。输出的 `infoPath` 指向临时 `cua-instance.json`，含动态 URL、PID、Bot/session ID 和可直接粘贴的本地 OpenAPI 文档，不含认证 token。

完成后：

1. 将截图、录像、逐项结果和需要的非敏感 fixture 描述复制到持久的验收产物目录。
2. 在运行脚本的终端按 Ctrl+C；或向输出的 `runnerPid` 发送 SIGTERM（`kill -TERM <实际 PID>`）。不要使用进程名批量杀进程。
3. 生命周期 helper 对本次进程组先 TERM、超时 KILL，并删除本次临时状态；回环 HTTP fixture 随 runner 退出。不要以 SIGKILL runner 作为常规清理方式，因为它不能运行清理处理器。
4. 不要把未清理的实例当作长期部署；状态在正常关闭后不可恢复。

如要在保留实例上追加已有自动化，可从另一终端显式设置输出的 URL：

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:<实际 webPort> PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e -- e2e/bot-workspace.spec.ts --workers=1 --retries=0
```

这是可选 Playwright 复核，仍不算 CUA，并会增加测试数据。CUA 本身应由可用的 computer 工具截图并以鼠标/键盘走下面的产品入口。

## Fixture 与凭据核对

脚本只继承 PATH、临时目录、语言、时区、Windows SystemRoot 等 OS 基础变量；不继承云、模型、OAuth、代理或软件连接凭据。`.env` 通过 `DOTENV_CONFIG_PATH` 指向空设备，独立状态目录不读取用户已有 Bot/连接配置。daemon 显式设置 E2E isolation、heuristic 模型、禁用自动 self-heal。daemon/Next 共享的 Bearer 是本次随机生成、仅用于临时本地测试认证的标记，不是用户或生产凭据；它存在于测试子进程环境中，不输出、不写入 fixture JSON。

种子只有 `Super Bot`、`CUA Worker`、55 条合成历史、`green` 合成记忆及其原文来源。另有仅监听回环地址的 `/weather` HTTP fixture，返回 `CUA_LOCAL_SOFTWARE_OK`。OpenAPI 指向该本地服务，无 auth、无真实软件账户。不得在本验收中填写真实 API key、导入用户配置或选择真实远程服务。上述凭据核对包含启动脚本静态检查与纯 HTTP fixture 自检；没有做网络抓包，也没有执行 CUA，不将其描述为全量网络流量审计。

既有 Round 12 fixture 的模型 provider key 为明确的 `sk-e2e-*` 假值、地址为不可连接的回环端口；OpenAPI import/revoke 测试使用 example.com 文档但没有发起工具执行。heuristic 不调用真实模型供应商。本交接进一步使用回环软件 fixture，避免把软件操作发向外部站点。


## 辅助实例启动与清理实测

2026-10-13 UTC 完成短暂纯 HTTP 验证：

- 首次窗口：11:14:42.066610—11:14:43.926414。默认 Super、55 条历史、原文锚点、记忆、本地软件 marker 均通过，SIGTERM 后状态删除；该轮通过 `/proc` 读取子 PID 得到空列表，因此**不采用该轮的子进程清理字段作为证据**。
- 补强窗口：11:15:40.605533—11:15:42.402175。helper 明确返回其 spawn 创建的两个 service PID；停止前验证二者存在，仅 SIGTERM runner（exit 143）后验证二者均消失、daemon/Next/fixture 三个回环端口均关闭、临时 state 删除。五项 HTTP 数据检查再次通过。
- 最终有效报告：`test-results/bot-cua-http-smoke-v2.json`；脱敏日志：`test-results/bot-cua-http-smoke-v2.log`。日志只含合成 fixture ID、本地 URL、临时路径、PID 和停止通知，不含随机 Bearer 或真实凭据。首轮文件保留为 `bot-cua-http-smoke.{json,log}`，不冒充完整清理证据。
- 两个窗口与长测共享主机资源，属于辅助测试干扰窗口，**不能作为参考性能数据**；负责长测分析者应保留这两个时间窗的干扰标记。未启动浏览器、未触发真实模型/真实外部软件请求。

## CUA 逐步操作与预期

各项都保存前后截图、实际文案、结果与异常。不要只记录“按钮可点击”。

| 切片 | 屏幕操作 | 预期与证据 |
| --- | --- | --- |
| 默认 Super / 持续对话 | 左侧“对话”→“Bot”；首次没有保存选择时确认 Super Bot。切换 CUA Worker，发送 `Reply ready.`，等结果后刷新。 | 选择保留，回复仍在同一 Bot 历史，切回 Super 不混入 Worker 私聊。保存刷新前后截图。 |
| 历史完整性 | “Bots 与 Agents”→Bots→CUA Worker→“历史原文”；先确认首屏最新 50 条，再“加载更早记录”；搜索 `CUA historical anchor 77331` 并打开上下文。再打开 Bot 对话使用主聊天“加载更早记录”。 | 锚点最初不在最新页，加载或搜索后可见；上下文是原始历史。主聊天分页也能找回锚点。 |
| 记忆来源及更正 | Worker 详情的记忆面板找到 `cua-favorite-color=green`，点“记忆来源”，修改为 `blue`、保存、刷新；再移除。 | 来源显示历史锚点；修改持久化；删除后记忆消失，但原始历史仍可搜索。不得记作“彻底删除原文”。 |
| Super 分派/结果 | Bots 页面“团队工作”，目标选择 CUA Worker，任务填 `Reply ready.`，分派；等完成，打开详情，刷新后再次查看。 | 未解决任务转成历史任务；完成结果不是空占位；关联目标正确、刷新保留。记录任务状态与结果。 |
| 定时执行闭环 | Worker 详情展开“定时任务”，选择“一次”，使用所选时区设置未来约 1 分钟，prompt `Reply ready.`；保存、刷新，等到时间，点“运行记录”→“详情”→会话入口。 | 时区和时间保存正确；出现完成 run、结果和独立工作会话，主私聊仍保留旧历史。再分别保存未来 interval/event/cron 配置并核对字段；不要将“保存成功”记成这些触发已执行。 |
| Room 共享及隔离 | Bots 页群组面板，新建 `CUA Room`，加入 Super 与 Worker，配置主持人与轮次预算；发共享消息，明确选择/提及 Worker。刷新再打开；暂停，再恢复。 | 成员与消息持久化，自动出现 Bot 回复与结束状态；暂停阻止新工作；Worker 私聊没有群消息。费用未知时显示未计量，不能记作测得 0。 |
| 软件绑定、检查、撤销 | Worker→“软件连接”，标识填 `cua-local-weather`，粘贴 `cua-instance.json` 的 `openApi` 对象，导入，刷新，检查连接；再撤销、刷新。 | 本地连接持久化，健康检查展示真实响应状态，撤销后绑定消失。这个动作不等于已完成 Agent 工具调用。 |
| 软件实际执行/unknown | 若接收环境另有受控本地工具调用驱动，沿 Bot 正常工具审批链调用 readWeather，观察调用记录 marker，再检查失败/unknown 核对入口。 | 只有记录真实 invocation/result `CUA_LOCAL_SOFTWARE_OK` 才可判执行通过。默认 heuristic 不保证按自然语言选择任意新导入工具；若没有驱动，明确记“未执行”，不能用探活/导入代替，也不能绕过审批造成功记录。停止或 unknown 不意味着撤销外部效果。 |
| 权限/恢复控件 | 查看 Worker 的暂停/禁用后台工作控件，保存后刷新；只在合成任务上尝试取消/重试；unknown 先阅读提示再确认核对。 | 控制持久化；unknown 未确认不能重试。恢复不声称回滚既有外部效果。 |

对 attachment、审批停留、unknown、容量故障等没有现成 UI fixture 的分支，应引用已验证的后端用例并单独记录 CUA 未覆盖；本交接不把 happy-path 截图提升成全部故障验证。

## 交接打包清单

源码快照由负责人生成，本文不复制密钥、运行数据库或 node_modules。

最小新增文件：

- `docs/reports/bot-cua-handoff.md`
- `scripts/bot-cua-instance.mjs`

辅助脚本依赖与验收定位文件（应来自同一候选源码快照）：

- `scripts/e2e-lifecycle.mjs`、`scripts/spawn-utils.mjs`
- `scripts/e2e-run.mjs`、`playwright.config.ts`、`e2e/bot-workspace.spec.ts`
- `package.json`、`package-lock.json`、workspace package manifests
- Round 12 JUnit、日志、前后 fingerprint JSON
- `test-results/bot-cua-http-smoke-v2.{json,log}`（辅助启动/清理证据，非 CUA）

执行环境另外需要同候选的 `apps/daemon/dist`、依赖 workspace dist、`apps/web-console/.next` 完整生产输出，以及按 lockfile 安装的 Node 依赖。不要只拷贝两个 helper 文件就声称是可独立运行的安装包；离线分发构建产物时应由负责人验证路径与依赖一致性。CUA 的实际截图/视频与结果表在执行后另行加入，当前不存在。
