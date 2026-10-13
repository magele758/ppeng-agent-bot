# Bot 最终独立纵向审阅

日期：2026-10-13。对照 `docs/plans/2026-10-13-bot-mode-multi-agent-development.md` 的 G01–G19，检查当前工作区的接口、执行主机、持久状态和 Lab 入口；不把源码接线或局部测试当作发布完成。审批续跑和旧身份迁移是集成团队已知专项，本报告不重复提出。

结论：G01–G18 的主要纵向入口已经接入。本轮又复现了撤权竞争、无人值守审批来源、长期任务显示截断、Room 控制和缺失会话收件悬空问题；这些问题已补修复，并在统一构建 round 10 上完成本包专项与独立复验。G19 仍需同一最终候选的完整门禁、真实环境质量与长时证据，不能凭本报告放行。

## 逐切片检查

| Gap | 检查链路 | 结论与边界 |
|---|---|---|
| G01–G02 | Bot/open API → 持久 principal → canonical 绑定 → 私有记忆 | 已有明确安装／登录身份。未重报旧身份迁移专项。缺失 canonical 对已接收消息的影响见下文。 |
| G03–G04 | session history API → 原文索引／稳定游标 → 历史面板／来源展开 | 入口与权限守卫、分页和来源回读已接入；规模与 API p95 仍以发布证据为准。 |
| G05–G06 | 模型窗口解析／fallback → 压缩预算 → 记忆纠错删除／来源 UI | 已有实现与专项；不能据此替代 200 轮、12 次压缩及真实模型质量验证。 |
| G07–G08 | 收件／派工 API → 事务队列／执行租约 → 回报 → Super／任务 UI | 已持久接收和关联回报；长期显示必须保留较旧未解决任务，无人值守来源必须重新标记。 |
| G09–G12 | cron／once／interval／event → occurrence → 独立会话 → 结果和运行 UI | 主链路已接入；Routine 的 unknown 与取消恢复有主机钩子。active／unknown 显示和历史分页已补，独立复验旧 unknown 可见。 |
| G13 | 默认 Super → 固定会话 → 状态／派工／回报／汇总 UI | 已接入；其完整性依赖 G08 不隐藏未解决记录，接收不能冒充完成。 |
| G14 | Room API → 独立 context → 确定调度／预算 → 群历史 UI | 已隔离历史并刷新 Bot 配置；暂停／禁用检查已补并独立复验，最终仍须整体验证。 |
| G15–G17 | Bot 连接 UI/API → 工具过滤 → HTTP/OpenAPI/MCP executor → 真实结果 | 本地真实协议测试通过；OpenAPI 是明确子集，MCP 继承既有 server 凭据。探测结果不能复活撤销或覆盖新 revision。 |
| G18 | 调用 attempt → SQLite 索引／unknown → 上游工作状态 → 核对 UI | 账本已支持稳定分页，10,011 条记录回归通过。W1/W3/W5 的 host 均接有未知副作用检测。Bash 的非零退出必须返回失败。 |
| G19 | 统一构建 → JUnit 验收 → 故障／迁移／容量／长时／真实质量 | 尚不能独立判定发布 ready；最终门禁及实测证据由集成报告统一记录。 |

## 本轮确证问题与交接

| 问题 | 复现及观察 | 当前处理 |
|---|---|---|
| 晚到 probe 复活撤销连接／覆盖新绑定 | `/tmp/software-probe-revoke-review.mjs`：HEAD 等待中撤权，返回后连接数重新变成 1。`software-execution.ts` 原 probe 尾部无条件写回。 | 自有模块已增加存在性＋revision 检查；两项红测试记录 `/tmp/w7-probe-race-red.log`；新构建专项 2/2 通过，记录 `/tmp/w7-probe-race-green.log`。 |
| 自动 Bot 收件没有无人值守审批期限 | `/tmp/bot-unattended-review.mjs`：真实 SQLite 审批 `pending`，`expiresAt:null`、`approvalWake:null`。 | A 已在每次 peer／delegation 启动前 stamp unattended。独立复验真实审批出现期限及 `source:delegation`，不再沿用 human wake。 |
| Super 与任务面板隐藏旧 unknown | `/tmp/bot-task-window-review.mjs`：旧 unknown 持久存在，501 新完成后 list/status 中 unknown 均为 0。原 `listBotTasks` 无提示地截断 500 条。 | A 已将 unresolved 与近期终态历史分开查询。独立复验 listCount 501、listUnknown/statusUnknown 均为 1，旧 unknown 始终可见；终态历史已有分页。 |
| Routine 历史隐藏阻塞 unknown | `/tmp/routine-window-review.mjs`：旧 unknown＋501 queued 后，内部仍有 unknown，显示窗口却没有。 | C 已补 active 独立查询及终态历史分页。独立复验 visibleCount 502、visibleUnknown 1，旧 unknown 可见。 |
| 后台禁用不约束 Room 新执行 | `/tmp/bot-disabled-room-review.mjs`：paused＋disabled 后新群回合仍执行一次并 completed。 | D 已补 process 与 prepareSession 控制 gate。独立复验执行数 0、回合 queued，解除后才可执行。开关阻止新增／恢复，不宣称撤销已有外部效果。 |
| canonical 修复后 pending 收件悬空 | `/tmp/bot-missing-session-review.mjs`：删除旧 canonical 后 openBot 修复新会话，旧消息仍 pending 且指向不存在会话、执行数 0。 | A 已补缺失会话 pending 重绑。round 10 独立复验：新 canonical 被修复、消息 processed、引用不再悬空、执行数为 1。 |
| Bash 有输出时非零退出被当成功 | 真实 CLI 同时写 stdout/stderr、exit 7，原工具返回 `ok:true`。 | 自有窄修保留两路输出、脱敏及沙箱链路，非零／signal 返回失败并附 exit 证据；两项红测试 `/tmp/w7-bash-exit-red.log`；round 10 对应失败／成功真实 shell 回归均通过。 |
| Bot 软件凭据可选择 daemon operator secret 并发往用户服务 | round 11 真实本地 HTTP 使用合成 `RAW_AGENT_AUTH_TOKEN`，返回 `ok:true` 且服务收到其 Bearer；复现 `/tmp/w7-operator-secret-reproduction.log`，新增先红 `/tmp/w7-operator-secret-red.log`。 | binding 与每次运行读取双拒绝 `RAW_AGENT_AUTH_TOKEN`／`RAW_AGENT_HUMAN_RELEASE_SECRET`（含 `vault:` 引用），明确沿用 sandbox operator deny 策略，不改变 Vault 全局写策略。round 12 真实服务验证新配置拒绝、旧配置执行失败、probe unavailable且请求 0；普通软件凭据仍真实成功。 |

Bot-work 路由主机重复 `hasUnconfirmedEffects` 属性曾构成编译阻断，当前源码已消除。最终仍须以统一构建结果确认。

## 验收补强与实测范围

现有 AC 覆盖大多数基础流程，但单纯标签全绿不能证明以下边界：并发 probe 与 revoke/rebind、超过 500 条记录后仍能查询旧未解决工作、peer 回合覆写 human 审批来源、canonical 丢失后的已接收收件、Room 对 Bot 禁用的响应，以及真实 shell 非零退出。上述边界已分别交给工作包负责人补回归；不得仅修改状态文本或削弱规格关闭问题。

本包此前最新专项日志 `/tmp/w7-indexed-ledger-tests.log` 为 19/19：真实 HTTP、实际 HTTP MCP 握手／调用、插件声明到执行、SecretVault、撤权、重定向、取消／限额、未知副作用、SQLite 重开、迁移和 10,011 条账本记录。统一构建 round 10 后的最新完整本包日志 `/tmp/w7-final-round10.log` 为 23/23，包括 probe 竞争和真实 Bash 失败／成功；10,011 条账本回归约 2.94 秒。未自行改写共享构建产物。

统一构建 round 12 后最终本包专项 `/tmp/w7-final-round12.log` 为 **27/27**（exit 0，3.87 秒），包括职责拆分新增验证及 operator 凭据越权回归。实际复杂度收集器结果：software-execution 最大 17、OpenAPI 最大 12；未改阈值／基线。此前 round 11 的 26/26 不作为 operator 凭据问题已关闭的证据。源码与共享 dist 保持冻结。

本报告没有重新运行全量门禁，未宣称真实模型长期记忆质量、24 小时浸泡或所有桌面平台软件流程已通过。最终发布结论必须查看集成报告及对应原始证据。

## G04 round 13 历史与模型路径优化验证

完整 HTTP baseline 保持原百万消息、每秒 40 次读取及原 `http_source_*` 查询；baseline 停止并解除冻结后，统一应用历史检索与模型 fold 候选，中央 round 13 build exit 0。本包随后使用 round 13 的真实 dist 运行 7 个目标文件，**71/71 通过**（exit 0，4.80 秒）：新增 8 项、现有历史／记忆／namespace、memory HTTP 隔离、真实历史 HTTP 和路由回归。原始日志为 `test-results/bot-validation/g04-round13-history-memory-http-targets.log`。该轮不包含之后尚未统一构建的 HTTP harness/helper 修改，也不替代完整性能重测。

历史检索仅以安全 ASCII 字面量 trigram MATCH 生成候选，按 message id 查原表，DISTINCT 防止遗留 FTS 重复行破坏分页。原 text/content JSON 提取与 LIKE ESCAPE 始终决定最终结果；Unicode、JSON 编码字符与短查询保留原回退。回归验证大小写、下划线与百分号、引号／反斜杠／控制字符、跨 part 及 JSON metadata 假命中、工具 content、时间、cursor 和 session 隔离，EXPLAIN 确认 MATCH 候选及主键查询。现有十万历史小型回归中分页约 0.44ms、检索约 0.94ms，此数字只代表该确定性 fixture。

模型路径在同一 SQLite SAVEPOINT 快照下读取轻量元数据，合并所有 replace/hide 的有效闭区间，再按 seq 索引查询补集，仅加载可见正文。隐藏的 replacement 仍参与 shadow 区间；hide 自身不输出。每次重读元数据，不缓存正文，也不假设数据库只能通过当前连接追加。异常 seq/range 保留原转换与回退，原严格递增错误保持；外层事务回滚、直接 SQL 修改、跨连接在两阶段间提交、原 foldSurface 输出逐字段一致均通过。SDK、migration 和质量门禁没有修改。

收益只针对候选过滤及已被 shadow 的正文。尚未压缩且全部可见的历史仍需加载；轻量元数据仍随历史行数增长，区间查询次数随合并后区间数增长。正式每秒 40 次读取及持续写入、百万数据规模、峰值内存和延迟是否满足 G19，必须以同负载的新候选完整 HTTP 报告判定。
