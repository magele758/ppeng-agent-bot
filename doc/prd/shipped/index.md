<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

# 已经开发的功能

已实现 423 条。每条对上一条已经实现的验收规格：名称在下面，用户需求在对应分页。满 4 条的前缀单独成页，其余收在 [other](other.md)。

## acceptance（1）

需求正文见 [other](other.md)。

- `acceptance-gate` 验收标准门禁（需求 → 可执行验收用例）

## agent（3）

需求正文见 [other](other.md)。

- `agent-as-folder-eval` Agent-as-folder path + eval default-on
- `agent-learning-governance` 纠错评测、技能验证、输入授权与事件调度
- `agent-skill-management` Agent 在对话中管理自身技能

## agents（2）

需求正文见 [other](other.md)。

- `agents-clean-layout` Bot 管理页清爽布局
- `agents-management` Bots / Agents / Teams / Skills 管理页清晰易用

## always（1）

需求正文见 [other](other.md)。

- `always-on-reliability` 常驻 Agent 的恢复、通知、长期评测、缓存诊断与压缩契约

## app（1）

需求正文见 [other](other.md)。

- `app-frosted-glass` 整个应用是毛玻璃

## approval（1）

需求正文见 [other](other.md)。

- `approval-explanations` 审批操作与风险说明

## ask（1）

需求正文见 [other](other.md)。

- `ask-user-live-stream` 回答追问后继续看到生成内容

## assistant（4）

需求正文见 [assistant](assistant.md)。

- `assistant-actions-at-end` 助手消息的引用/纠错按钮放在正文末尾
- `assistant-label-dedupe` 连续助手发言只在第一条显示「助手」标题
- `assistant-repeat-collapse` 助手正文里相邻的重复行收成一行
- `assistant-run-spacing` 连续助手消息省略标题后不留大段空白

## auto（3）

需求正文见 [other](other.md)。

- `auto-review-authorized-by` Auto-review 批准回执记录授权引用
- `auto-review-shell-mcp` Auto-review 工具级审批卡（高危 Shell/MCP）
- `auto-source-continuity` Auto 对话连续执行

## background（1）

需求正文见 [other](other.md)。

- `background-job-restart` 重启后中断无人执行的后台命令

## bg（1）

需求正文见 [other](other.md)。

- `bg-run-host-park` Host parks durable wait for owned bg_run

## bot（134）

需求正文见 [bot](bot.md)。

- `bot-activity-flow` 从 Bot 运行记录查看工作流
- `bot-activity-open-session` 活动卡点击打开所属会话
- `bot-activity-rail` Lab activity rail 展示 Bot 在途工作，并按 owner 隔离
- `bot-async-summary` Bot 历史摘要后台更新
- `bot-autonomous-execution-coverage` Bot 自动选择并完整承接原有执行能力
- `bot-bloub-dynamic` Bloub 动态头像风格
- `bot-browser-notices` Bot 桌面通知
- `bot-chat-header` Bot 对话头部只显示名字、活脸和权限入口
- `bot-chat-image-compatibility` Bot 历史图片兼容与群聊发送恢复
- `bot-child-task-chat-entry` 普通会话列表里的 Bot 子任务入口
- `bot-child-task-chip-fill` 子任务芯片有底色
- `bot-child-task-stream-entry` 主对话流里的子任务入口
- `bot-completion-reliability` 完成验证可追溯与任务收尾可靠性
- `bot-composer-next-hint` Bot 输入框推荐下一句
- `bot-concurrent-subagents` Bot 并发工作时派生子代理，并允许子代理复用记忆与互助
- `bot-console-selection` 切换 Bot 时显示当前会话，开发态仍能载入默认 Bot
- `bot-create-named-tools` 对话里能用 create_bot 和 create_room 创建
- `bot-daydream-http` 每日复盘与共享治理真实 HTTP 通路
- `bot-daydream-integration` 每日复盘共享成果进入后续 Bot 任务
- `bot-daydream-knowledge` Daydream Super Bot 共享治理
- `bot-daydream-local` Bot 每日独立复盘
- `bot-daydream-missing-session` 缺少固定对话时每日复盘继续
- `bot-daydream-ui` Bot 每日复盘配置与治理界面
- `bot-delegation-lookup` Bot 对话直接委派并打断重复查询
- `bot-delete` 删除 Bot 并保留对话历史
- `bot-detail-child-tasks-tab` 子任务改到详情页签
- `bot-detail-menu` Bot 对话右侧详情菜单
- `bot-detail-skill-management` 在 Bot 详情中查看可选技能并管理技能
- `bot-dialog-solid` Bot 消息弹窗使用纯色背景
- `bot-dual-compact` 规范 Bot 会话的双阈值压缩
- `bot-entry-dialog-shell` 新建 Bot 弹窗遮罩与底部按钮
- `bot-entry-simplification` Bot 创建入口统一与管理页面职责拆分
- `bot-execution-p0` Bot 任务直达执行与证据保真
- `bot-extreme-concurrency` Bot 以高并发同时推进多件工作
- `bot-face-readable-shapes` 脸型圆润，列表里能看见表情，干活时更忙
- `bot-face-soft-style` 软萌机器人脸与经典脸并存
- `bot-first-task-dismissal` 首次任务引导可关闭且不干扰已有对话
- `bot-first-task-new-user` 首次任务引导只给新用户看
- `bot-flow-read-projection` 工作流只接收展示所需的会话数据
- `bot-forever-chat` Bot 永久主会话命令
- `bot-fork-retrievable-inheritance` Bot 子任务按权限检索父 Bot 的记忆、技能、文件与上下文
- `bot-fork-sessions-in-detail` Bot 子任务会话放进详情菜单
- `bot-functional-groups` Bot 功能分组、共享范围优先级与头像修复
- `bot-gateway-delivery` IM 静默回复、至少一次投递与例行预检
- `bot-goal-conclusion` 目标结算与子会话身份的生命周期闭环
- `bot-goal-context-boundary` 聊天隐藏内部摘要，历史 Goal 仅供回顾
- `bot-goal-lifecycle-boundaries` Bot 目标跨用户与执行生命周期闭环
- `bot-goal-live-chain` Bot 默认配置完整执行与证据回流
- `bot-goal-nested-approval` 目标子任务的待批准出现在主对话
- `bot-goal-only-when-needed` Bot 只在必须时才为目标再开子任务
- `bot-goal-result-return` 子执行结果回到原目标并收口
- `bot-goals-panel-rules` 目标与进展只展示同时在做的多件事
- `bot-goals-panel-threshold` 目标与进展少于两个目标时不展示
- `bot-group-cleanup` 删除分组时可一并删除 Bot
- `bot-group-disclosure-memory` 刷新后记住各 Bot 分组的展开状态
- `bot-group-drag-only` Bot 侧栏移组仅保留拖拽入口
- `bot-history-memory` Bot 持续对话历史与记忆
- `bot-human-continuation` Bot忙时接收与连续对话
- `bot-identity-continuity` Bot可靠工作与身份连续性
- `bot-immediate-steer` Bot 回合中直接插入并转向
- `bot-input-suggestion` Bot 输入框下一句建议
- `bot-input-suggestion-cache` Bot 每轮推荐只生成一次并保留
- `bot-linked-watchers` 关联原工作的临时盯梢与观察证据
- `bot-list-face-plate` 侧栏 Bot 脸保持原形，不套外框也不拉变形
- `bot-list-idle-motion` Bot 列表待机头像保持活性
- `bot-message-name` Bot 回复标签显示 Bot 名称
- `bot-mock-interview` 内置模拟面试官按指定信息出题、评分并给改进建议
- `bot-multi-goal-coordination` Bot 多目标持续执行与自动选择执行方式
- `bot-network-and-schedule-list` 多 Bot 协作关系图与紧凑的定时列表
- `bot-network-motion` 协作网络从 Bot 特写展开
- `bot-network-pan` 横向拖动的 Bot 协作全景
- `bot-panel-reset` 切换 Bot 时重置记忆、暂停开关和软件连接
- `bot-pin-area` Bot 列表置顶区
- `bot-pin-sync` 跨浏览器置顶同步
- `bot-product-admin` 对话 bot 能管理产品和配置
- `bot-product-p0` Bot可靠工作与可验收交付闭环
- `bot-product-p1` Bot首次任务与软件连接引导
- `bot-product-p2` Bot成果复用记忆纠错与持续协作
- `bot-quality-reliability` 限定写入范围与辅助判断可靠性及重复对照
- `bot-quality-sample-plan` 真实模型评估的独立任务与样本量预检
- `bot-readonly-api` Bot 正文 API 与显式只读路由
- `bot-recall-replies` Bot 原文召回与逐字确认
- `bot-receipt-queue` 历史回执不占用新委派的执行位置
- `bot-relay-island` Bot 通信收起为灵动岛式胶囊
- `bot-relay-slug` 非 bot_ 前缀的 Bot 通信也收成小提醒
- `bot-relay-strip` Bot 间通信在聊天流里显示为紧凑通信条，点击弹窗看全文
- `bot-reliable-messaging` Bot可靠工作与身份连续性
- `bot-reply-quote` 引用某条 Bot 回复再发消息
- `bot-robot-faces` Bot 显示稳定的机器人头像
- `bot-room-console` 大规模群的对话区界面
- `bot-room-goal-intake` 群目标与中途插话
- `bot-room-inline-approval` 群内原位批准
- `bot-room-recall` 群纪要、群规约与按群取回
- `bot-room-sparse-routing` 所有群稀疏唤醒
- `bot-room-speaker-identity` Bot 一开始就知道群里发言用自己的身份
- `bot-room-speaker-pick` 群聊按贴题程度决定谁开口
- `bot-room-tasks` 群子任务与成员接力
- `bot-room-touched-memory` 按触达打通单聊记忆与群内容
- `bot-room-wave-dispatch` 群发言并行与停止拦截
- `bot-room-work-continuity` 群派工到原 Bot 持久工作的可靠承接
- `bot-rooms` 多 Bot 群会话与可靠发言
- `bot-routine-create-receipt` Bot 对话直接创建定时任务并取得确认
- `bot-routine-lifecycle` Bot 可靠例行任务
- `bot-routine-main-session` Bot 定时任务跟自己的会话走
- `bot-row-menu` Bot 列表操作菜单
- `bot-runtime-log-regressions` Bot 实际运行日志回归
- `bot-scoped-skill-sharing` Bot 私有技能沉淀与指定 Bot 共享
- `bot-session-decisions` Bot 在同一身份的会话间找回决定
- `bot-session-row` 单 Bot 会话行显示名字、问题和活体脸
- `bot-settings-flow` 简化 Bot 操作与设置生效反馈
- `bot-sidebar-child-sessions` Bot 侧栏不列出子任务会话
- `bot-sidebar-load` Bot 侧栏按需加载与切换响应
- `bot-sidebar-order` Bot 列表同一区域内拖拽排序
- `bot-sidebar-routing` Bot 名册入口与主对话一致
- `bot-skill-panel-layout` Bot 技能面板布局清晰且适应窄屏
- `bot-soft-create-runtime` 软萌头像可正常创建和保存
- `bot-soft-motion` 软萌头像跟随实际工作状态动起来
- `bot-software-execution` Bot 软件连接与可靠执行
- `bot-source-authorization-continuity` Bot 已授权工作的来源连续性
- `bot-source-trace-pairing` 跨会话原文召回与乱序工具回执
- `bot-startup-summary-latency` 摘要服务变慢时 Bot 启动有界等待
- `bot-startup-trace` Bot 启动耗时分段可观测
- `bot-status-polling` 工作状态轮询区分慢响应和断线
- `bot-steer-visible` Bot 对话里的实时插话马上出现在对话流
- `bot-supervision-freshness` Bot 监督状态新鲜度与回复关联
- `bot-switch-live-turn` 切换 Bot 后主画面离开上一场进行中的对话
- `bot-task-permission-inheritance` 同 Bot 任务继承权限，跨 Bot 按目标权限执行
- `bot-task-terminal-wait` 已结束的委派能唤醒接收回执的 Bot
- `bot-turn-ownership` Bot 当轮任务和目标审查归属
- `bot-window-compact` 规范 Bot 按真实模型窗口的一半和 85% 压缩
- `bot-work-durable-wait` Bot 任务停在持久等待上并只恢复一次
- `bot-work-restart-resume` 重启后从安全检查点继续 Bot 任务
- `bot-working-animation` Bot 工作期间持续动态、列表待机保持活性
- `bot-workspace-interaction-polish` Bot 工作台引用、任务通知、上下文与长会话体验优化

## brief（2）

需求正文见 [other](other.md)。

- `brief-hide-monologue` 精简界面隐藏混进正文的思考独白
- `brief-no-process-note` 精简模式不显示「已收起 N 条过程」

## browser（1）

需求正文见 [other](other.md)。

- `browser-navigate-private-network` 浏览器导航拒绝私网和本地文件

## bypass（4）

需求正文见 [bypass](bypass.md)。

- `bypass-full-auto` bypass 全自动与重复审批修复
- `bypass-remote-shell` bypass 下不再为无隔离反复审批，远端查找不被本机浏览规则拦住
- `bypass-skill-write` bypass 的 Bot 写技能不再被额外确认拦住
- `bypass-source-scope` permissionMode=bypass 视为用户显式授权，不再被来源范围拦截

## chat（13）

需求正文见 [chat](chat.md)。

- `chat-approval-inline` 待审批嵌在对话流里
- `chat-basics` 对话基础体验
- `chat-bubble-written-stamp` 对话气泡不展示写入时间戳
- `chat-clean-theme` 清爽的浅色阅读界面
- `chat-column` 对话区对齐与阅读留白
- `chat-experience` 对话页简洁易用
- `chat-floating-chrome` 浮动聊天标题与低干扰摘要
- `chat-header-menu-only` 聊天顶部只保留更多入口
- `chat-inline-history` 单行附件入口与自动加载聊天历史
- `chat-more-menu-on-top` 对话头部「⋯」更多菜单在最上层且不透明
- `chat-reading` 会话正文阅读节奏
- `chat-tail-kept` 对话结束时助手正文留在对话里
- `chat-width` 内容展示宽度

## child（1）

需求正文见 [other](other.md)。

- `child-wake-workitem` 子代理完成唤醒继续同一项工作

## ci（7）

需求正文见 [ci](ci.md)。

- `ci-action-reliability` Actions 长短验证可靠性
- `ci-audit-p1-p2` CI audit P1/P2 release gate hardening
- `ci-fast-and-bihourly-gates` 两分钟快速门禁与每两小时完整验证
- `ci-http-fixture-timing` 共享持续集成 HTTP 夹具计时
- `ci-parallel-validation` 完整验证职责并行与覆盖率产物复用
- `ci-review-drift-signal` 评审指纹不一致时不要再报一次结果缺失
- `ci-zero-coverage-complexity` 零覆盖画面仍能通过复杂度门禁

## classic（1）

需求正文见 [other](other.md)。

- `classic-solid-dark` 经典主题深色用纯色

## cli（2）

需求正文见 [other](other.md)。

- `cli-bot` 命令行使用机器人
- `cli-session-permission` 命令行调整会话权限

## command（1）

需求正文见 [other](other.md)。

- `command-hardline` 危险命令硬拦截与密钥脱敏

## compact（3）

需求正文见 [other](other.md)。

- `compact-archive-pointer` 压缩摘要带上原文位置
- `compact-bot-secondary-tabs` 精简 Bot 能力与权限及记录页
- `compact-bot-settings` Bot 设置优先展示基本信息与已有定时任务

## composer（4）

需求正文见 [composer](composer.md)。

- `composer-draft-per-session` 聊天输入框草稿按会话隔离
- `composer-drop-retirement-soak-isolation` 退役消息框拖拽并独立验证 HTTP soak 性能
- `composer-ime-enter` 输入法确认回车不发送
- `composer-quote-layout` 输入栏中线对齐与不占行的消息操作

## connector（1）

需求正文见 [other](other.md)。

- `connector-authorization` Lab connector authorization states and SecretVault grant

## console（7）

需求正文见 [console](console.md)。

- `console-font-size-preference` 控制台字体大小偏好
- `console-knowledge` 知识与记忆：分层记忆、搜索与摄取设置
- `console-navigation` 控制台主导航与页面结构
- `console-settings` 设置页渐进披露与搜索
- `console-skin-motion` 各外观独立特效与极简黑白
- `console-skins` 多套可切换外观
- `console-tasks` 任务页：队列、编排运行与审批收件箱

## context（2）

需求正文见 [other](other.md)。

- `context-reliability` 持续对话的任务保真与历史记忆找回
- `context-send-ceiling` 压缩先于发送上限，任务事实有上限，已保存的 32768 生效

## conversation（2）

需求正文见 [other](other.md)。

- `conversation-date-clock` 续聊时日期跟现在走，不跟历史里的旧日期走
- `conversation-loop-defaults` 对话默认行为要进入新对话和正在跑的普通对话

## correction（1）

需求正文见 [other](other.md)。

- `correction-capture-hover` 纠错转评测改为悬停图标

## create（1）

需求正文见 [other](other.md)。

- `create-menu-trigger-hit-area` 新增菜单展开后按钮仍可点击

## cron（2）

需求正文见 [other](other.md)。

- `cron-detail-markdown` 定时任务详情直接阅读 Markdown
- `cron-message-details` 聊天中的定时任务详情

## daydream（2）

需求正文见 [other](other.md)。

- `daydream-tick-cost` 每日复盘调度不能拖死 daemon
- `daydream-unlimited-resume` 每日复盘移除额度并续跑

## default（1）

需求正文见 [other](other.md)。

- `default-super-bot` 默认 Super Bot 的状态查看、派工与结果汇总

## delete（1）

需求正文见 [other](other.md)。

- `delete-page` Delete library pages and revoke public shares

## delivery（1）

需求正文见 [other](other.md)。

- `delivery-quiet-hours` 用户可见外发的全局静默时段

## desktop（2）

需求正文见 [other](other.md)。

- `desktop-preload-typecheck` 桌面预加载脚本通过类型检查
- `desktop-safe-update` 客户端手动一键更新、备份与失败回滚

## dev（2）

需求正文见 [other](other.md)。

- `dev-lab-process-cleanup` 开发启动器退出时完整清理子进程
- `dev-tailnet-https` 本地启动自动同步 Tailnet HTTPS

## discovery（1）

需求正文见 [other](other.md)。

- `discovery-default-on` 能力发现总开关默认开启

## durable（4）

需求正文见 [durable](durable.md)。

- `durable-agent-waits` Agent 持久化条件等待与恢复
- `durable-artifact-port` 大结果落盘并按页引用
- `durable-page-port` 库级持久页面与分享链接
- `durable-wait-default` Durable wait is the default Goal/Routine park path

## email（1）

需求正文见 [other](other.md)。

- `email-webhook-replay` 邮件事件不能靠换投递号重放

## execution（1）

需求正文见 [other](other.md)。

- `execution-log-analysis` 执行日志能查出问题并指到具体调用

## experimental（1）

需求正文见 [other](other.md)。

- `experimental-settings` 设置里的实验特性菜单

## external（2）

需求正文见 [other](other.md)。

- `external-agent-bots` Bot 级外部 Agent 通信
- `external-agent-task-handoff` 外部 Agent 任务交接

## feed（1）

需求正文见 [other](other.md)。

- `feed-reading-anchor-boundary` 对话侧栏调整保留实际阅读位置

## fold（1）

需求正文见 [other](other.md)。

- `fold-visible-history` 折叠历史保留用户问题

## functional（1）

需求正文见 [other](other.md)。

- `functional-group-disclosure` Bot 侧栏功能分组折叠与展开

## gateway（1）

需求正文见 [other](other.md)。

- `gateway-im-security` IM 网关入站安全（验签、去重、白名单、Bot 路由）

## github（1）

需求正文见 [other](other.md)。

- `github-webhook-replay` GitHub 事件不能靠换投递号重放

## global（3）

需求正文见 [other](other.md)。

- `global-debug-visibility` 全局调试信息开关
- `global-default-model-clarity` 全局默认模型配置与群聊模型来源可见
- `global-default-model-row-align` 全局默认模型行左右对齐

## goal（4）

需求正文见 [goal](goal.md)。

- `goal-history-toolbar-align` 目标历史与标题栏按钮垂直居中
- `goal-intake-hot-path` 开轮不再等待目标判定和数据库锁
- `goal-restart-resume` 重启后从安全检查点继续 Goal
- `goal-update-hidden` 目标更新通知不在聊天里展示

## grok（1）

需求正文见 [other](other.md)。

- `grok-local-history` Lab 只读查看本机 Grok Bot 会话

## group（13）

需求正文见 [group](group.md)。

- `group-active-header` 群聊顶部仅显示工作中的成员
- `group-chat-settings-save` 群聊设置改完可以保存
- `group-chat-sidebar-placement` 群聊可置顶并可拖入功能分组
- `group-chat-stable-layout` 群聊顶部状态更新和输入区布局
- `group-command-same-as-dm` 群里的命令跟该 Bot 单聊同一套放行
- `group-face` 群聊行展示成员头像
- `group-member-partial-roster` 群里有旧成员时仍可添加当前可选的 Bot
- `group-member-quiet` 群聊成员区只留成员本身的信息
- `group-member-sections` 群成员分成已在群里和添加成员
- `group-mode-explanations` 群聊回复模式与运行限制说明
- `group-mode-instant-selection` 群聊回复方式可以连续切换
- `group-reply-mode` 群聊回复模式
- `group-settings-clarity` 群聊设置分区与成员提及清理

## hide（2）

需求正文见 [other](other.md)。

- `hide-approval-continue` 聊天不展示审批自动合成的续跑用户消息
- `hide-dev-overlays` 本地页面不展示开发浮层

## history（1）

需求正文见 [other](other.md)。

- `history-startup-contention` 后台调度期间打开历史会话

## jev（1）

需求正文见 [other](other.md)。

- `jev-model-settings` 在模型设置中配置 Jev 评估

## knowledge（1）

需求正文见 [other](other.md)。

- `knowledge-library-dirs` 本地资料目录进入知识库并可检索

## lab（8）

需求正文见 [lab](lab.md)。

- `lab-auth-and-route-access` 控制台鉴权与接口访问隔离
- `lab-auth-loading-recovery` 网页登录检查可恢复
- `lab-bootstrap-retry` 工作台启动失败后恢复
- `lab-library-pages` Lab library Pages panel (list / open / share / rotate / delete / create / edit)
- `lab-poll-crash-diagnostics` 轻量会话列表与客户端异常诊断
- `lab-registered-machines` Lab Settings → Tools → Registered Machines panel
- `lab-startup-request-load` 控制台启动时的请求负担
- `lab-startup-timing` Lab 会话显示启动耗时

## lcu（2）

需求正文见 [other](other.md)。

- `lcu-app-grant` 桌面操作应用授权：全自动免审批，批准一次后同会话记住
- `lcu-computer-use` 本机 LCU 桌面操作接入

## lean（1）

需求正文见 [other](other.md)。

- `lean-default-skills` 精简默认技能并保留按需发现

## live（1）

需求正文见 [other](other.md)。

- `live-bot-quality` 真实 Bot 任务评估与版本准入

## local（1）

需求正文见 [other](other.md)。

- `local-source-unlock` 本机只读命令在批准后能真正执行（来源范围审批匹配、审批卡、已保存 direct 不再 Auto-review）

## login（1）

需求正文见 [other](other.md)。

- `login-mandatory-skill` 捆绑 login 强制技能可加载并解锁登录面

## long（1）

需求正文见 [other](other.md)。

- `long-session-compact` 长会话能真正做摘要而不是只丢历史

## loop（3）

需求正文见 [other](other.md)。

- `loop-guard-model-switch` 重复检测默认只约束弱模型
- `loop-native-media` SDK 原生多模态文件理解
- `loop-prefix-cache` 稳定前缀和技能目录不在每轮重做

## low（1）

需求正文见 [other](other.md)。

- `low-interference-onboarding-goals` 仅向新用户展示首次引导并隐藏少量目标面板

## mac（1）

需求正文见 [other](other.md)。

- `mac-retina-text-readability` Mac Retina 屏幕文字可读性优化

## macos（1）

需求正文见 [other](other.md)。

- `macos-app-control` macOS 应用控制（外层宿主）

## mandatory（1）

需求正文见 [other](other.md)。

- `mandatory-skill-gate` 高危面必须先加载对应技能

## memory（1）

需求正文见 [other](other.md)。

- `memory-deletion-suppression` 删除记忆后阻止自动写回

## message（2）

需求正文见 [other](other.md)。

- `message-body-search` 按消息正文搜索可见会话
- `message-search-ui` 对话页搜索消息正文

## micro（1）

需求正文见 [other](other.md)。

- `micro-compact-stub-wording` 微压缩占位只说明工具输出被省略

## mobile（2）

需求正文见 [other](other.md)。

- `mobile-chat-density` 窄屏对话区优先展示聊天记录
- `mobile-console` 控制台移动端布局

## model（3）

需求正文见 [other](other.md)。

- `model-fallback` 备用模型自动切换
- `model-retry-progress` 临时模型故障延长退避并展示重试进度
- `model-sandbox-isolation` 命令隔离由对话里的 Agent 自己选

## multi（5）

需求正文见 [multi](multi.md)。

- `multi-machine-controlled-delivery` 多机软件工厂第三阶段：受控远端交付至 MERGED
- `multi-machine-controlled-development` 多机软件工厂第二阶段：受控开发至 READY
- `multi-machine-local-foundation` 多机软件工厂第四阶段本地软件交付
- `multi-machine-readonly-pilot` 多机软件工厂第一阶段：只读试运行
- `multi-page-live-session` 多个网页同时看到流式结果和页面状态

## necessary（1）

需求正文见 [other](other.md)。

- `necessary-tool-injection` 只把当前任务需要的工具定义交给模型

## no（1）

需求正文见 [other](other.md)。

- `no-windows-desktop-pack` 不再打 Windows 桌面安装包

## normal（1）

需求正文见 [other](other.md)。

- `normal-session-request-budget` 普通会话请求不超过窗口的 20%

## npm（1）

需求正文见 [other](other.md)。

- `npm-auto-publish` 公开 npm 包自动发布

## ops（2）

需求正文见 [other](other.md)。

- `ops-console` 运维页：系统健康总览与轨迹浏览
- `ops-session-trace-repair` 运维会话轨迹能定位没看过的对话

## other（1）

需求正文见 [other](other.md)。

- `bots` Bot 名册、互发消息与权限

## outbound（3）

需求正文见 [other](other.md)。

- `outbound-draft-edit-identity` 外发草稿可编辑预览，并显示将以哪个身份发送（Draft → Confirm → Send 之上）
- `outbound-send-mandatory-skill` 捆绑 outbound-send 强制技能可加载并解锁外发面
- `outbound-style-sample-hint` 外发前建议先采样同渠道近期消息，只提示语气，不改已编正文

## outer（1）

需求正文见 [other](other.md)。

- `outer-skin-picker` 外层外观设置可选中

## page（3）

需求正文见 [other](other.md)。

- `page-revisions` Page revision history (list / get / restore)
- `page-share-html` Public library page share HTML (read-only)
- `page-tools` 助手可调用的库级页面工具

## payment（1）

需求正文见 [other](other.md)。

- `payment-mandatory-skill` 捆绑 payment 强制技能可加载并解锁支付面

## play（7）

需求正文见 [play](play.md)。

- `play-bot-group` Bot 会话列表里的多 Bot 群聊
- `play-context-replay` Play 上下文回放
- `play-context-stack` Play 右侧栏模型上下文
- `play-feed-window` 对话记录按页加载并窗口渲染
- `play-group-delete-menu` 群聊行的删除收进更多菜单
- `play-rail-default-closed` 对话页右侧栏默认关闭
- `play-sidebar-collapse` 对话页会话列表可收起

## pm2（1）

需求正文见 [other](other.md)。

- `pm2-service` 用 PM2 启动并管理服务

## pnpm（1）

需求正文见 [other](other.md)。

- `pnpm-migration` 全仓库迁移至 pnpm 并完成回归

## pr152（1）

需求正文见 [other](other.md)。

- `pr152-approval-followups` Consistent approval decisions and cancelled parked work

## prd（1）

需求正文见 [other](other.md)。

- `prd-test-trace` 产品需求与测试对照

## product（1）

需求正文见 [other](other.md)。

- `product-prd` 产品需求目录

## quiet（1）

需求正文见 [other](other.md)。

- `quiet-goal-results` 目标结果不再默认要求人工核对

## r5（7）

需求正文见 [r5](r5.md)。

- `r5-19-agent-native-email` Agent native email inbox (product-domain)
- `r5-21-check-email-inbox-availability` Independent check_email_inbox_availability tool
- `r5-22-outbound-from-claimed` Outbound email from=claimed when ChannelSpec.from empty
- `r5-23-daemon-claimed-from` Daemon delivery port wires claimedFrom from AgentInboxPort
- `r5-24-outbound-email-reply` Outbound email reply threading (inReplyTo / Re subject)
- `r5-25-reply-draft-ingress` Reply draft ingress + Lab thread preview
- `r5-26-inbound-refs` Inbound References/In-Reply-To persist + auto-draft References chain

## rail（3）

需求正文见 [other](other.md)。

- `rail-foot-menu` 侧栏底部收成悬停菜单
- `rail-foot-theme` 侧栏底部主题按钮能切换
- `rail-settings-icon` 侧栏设置入口使用设置图标

## recap（3）

需求正文见 [other](other.md)。

- `recap-content-only` 回顾有内容才展示
- `recap-next-action` 回顾之后推荐下一步行动
- `recap-request-lifecycle` 主动回顾正常生成与取消

## refresh（1）

需求正文见 [other](other.md)。

- `refresh-keeps-agent-run` 刷新页面不终止正在进行的对话

## registered（3）

需求正文见 [other](other.md)。

- `registered-machine-desktop-agent` Desktop agent long-connect for personal registered machines (non-SSH)
- `registered-machine-live-backend` Live SSH backend for personal registered machines (not Factory SSH)
- `registered-machine-phone-local` Phone registered machines via device-local tools (non-SSH, read-only default)

## remotevm（1）

需求正文见 [other](other.md)。

- `remotevm-no-host-downgrade` microVM 命令不会悄悄改在宿主机上跑

## remove（1）

需求正文见 [other](other.md)。

- `remove-needs-confirm` 列表里的移除需要再确认一次

## reply（1）

需求正文见 [other](other.md)。

- `reply-hover-ended-at` 悬停 Bot 回复时显示结束时间

## request（1）

需求正文见 [other](other.md)。

- `request-metric-follows-turn` 已发送请求指标随所选轮变化

## risk（1）

需求正文见 [other](other.md)。

- `risk-advisory-ui` 对话里的运行策略提醒

## room（1）

需求正文见 [other](other.md)。

- `room-task-collaboration` 群聊临时负责人任务协作模式

## rotate（1）

需求正文见 [other](other.md)。

- `rotate-page-share` Rotate library page share links without deleting content

## routine（6）

需求正文见 [routine](routine.md)。

- `routine-failure-governance` 例行任务连续故障治理
- `routine-owner-permission` 定时任务沿用 Bot 免审批
- `routine-precheck-fail-closed` 例行预检失败不唤醒模型
- `routine-quiet-chat` 无结论的定时回执不进主对话
- `routine-strict-precheck` 严格例行预检与持久游标
- `routine-weekday-daytime-default` 新建例行任务默认工作日白天

## runtime（2）

需求正文见 [other](other.md)。

- `runtime-diagnostics-skill` Agent Home 故障排查技能
- `runtime-gap-closures` 事件密钥、内置工具名、发布脚本环境、只读 MCP、HTTP 来源与幂等并发

## sanctum（1）

需求正文见 [other](other.md)。

- `sanctum-skin` 圣所外观可切换且不覆盖原主题

## saved（1）

需求正文见 [other](other.md)。

- `saved-sandbox-mode-constrains-shell` 已保存的隔离方式约束 shell

## scheduler（1）

需求正文见 [other](other.md)。

- `scheduler-db-lock` 调度写目标时不再因数据库锁失败

## schema（1）

需求正文见 [other](other.md)。

- `schema-upgrade-safety` 数据库升级不丢数据

## secure（3）

需求正文见 [other](other.md)。

- `secure-form` 对话里的单字段安全表单
- `secure-form-multi` 对话里的多字段安全表单
- `secure-form-vault` Secure Form fill-from-Vault

## session（12）

需求正文见 [session](session.md)。

- `session-brief` 会话可以只看关键信息
- `session-eval-baseline` 会话评估能留下基准并发现短板
- `session-eval-lift` 会话评估能区分能力提升和下降
- `session-lifecycle-state-consistency` 生命周期验证发现的结束原因与部分审批状态一致性修复
- `session-lifecycle-verification` 会话生命周期验证：取消、重试与审批恢复
- `session-multiprocess-concurrency-verification` 多进程并发验证：写入占用、迟到结果与审批恢复
- `session-multiprocess-state-consistency` 多进程会话状态一致性修复
- `session-recap` 会话末尾回顾
- `session-recap-model-routing` 会话回顾使用会话配置的模型
- `session-restart-recovery-state-consistency` 重启恢复发现的运行状态、审批衔接与未确认工具结果修复
- `session-restart-recovery-verification` 进程重启恢复验证：运行中、重试等待与等待审批
- `session-review-runtime` 会话复盘中的工具选择、请求预算和启动观测

## settings（2）

需求正文见 [other](other.md)。

- `settings-categories` 设置页「行为 / 安全 / 工具 / 集成」分类易用化
- `settings-models-onboarding` 设置：模型向导、首次引导、搜索与保存状态

## shared（2）

需求正文见 [other](other.md)。

- `shared-chat-header` 会话和群聊统一浮动顶部
- `shared-info-compact` 共享信息紧凑入口

## shell（1）

需求正文见 [other](other.md)。

- `shell-output-untrusted-fence` 命令输出作为不可信内容围栏后再给模型

## shopping（1）

需求正文见 [other](other.md)。

- `shopping-mandatory-skill` 捆绑 shopping 强制技能可加载并解锁购物面

## sidebar（1）

需求正文见 [other](other.md)。

- `sidebar-unified-menu` 统一群聊和分组菜单

## single（1）

需求正文见 [other](other.md)。

- `single-host-bot-completion` 单机 Bot 工作收尾与默认入口

## skill（9）

需求正文见 [skill](skill.md)。

- `skill-capture-dismissal` 技能沉淀完成提示可收起和关闭
- `skill-capture-intent-confirmation` 模型判断技能沉淀并在提炼前请求确认
- `skill-capture-save` 技能沉淀确认后能把正文存下来
- `skill-load-recovery` 自建技能与搜索结果可加载
- `skill-manifest-boundary` 技能能力边界
- `skill-operation-card-dismissal` 技能管理结果可收起关闭且不干扰对话
- `skill-operation-confirm-bar` 技能操作确认后收成可关闭的小横条
- `skill-pending-retry` 技能待确认请求重新授权
- `skill-proposals` 技能提案审批

## skin（1）

需求正文见 [other](other.md)。

- `skin-mode-adapt` 非经典外观适配深浅色

## slack（1）

需求正文见 [other](other.md)。

- `slack-events-inbound` Slack Events 入站按线程唤醒例行任务

## software（1）

需求正文见 [other](other.md)。

- `software-egress-reserved-tools` 软件出站地址与内置工具名

## startup（1）

需求正文见 [other](other.md)。

- `startup-invariants-compact` 启动时校验压缩策略、稳定前缀与重复守卫

## steer（4）

需求正文见 [steer](steer.md)。

- `steer-completion-coverage` Bot 完成检查覆盖本次全部插话
- `steer-model-flight` 模型生成期间插话与旧工具启动前转向
- `steer-timeline-order` 实时插话前后的回复保持时间线位置
- `steer-tool-continuity` 插话即时入会话与按工具取消

## stream（2）

需求正文见 [other](other.md)。

- `stream-live-status` 生成中的速度与正在做什么
- `stream-text-once` 流式输出时助手文字只出现一次

## subagent（1）

需求正文见 [other](other.md)。

- `subagent-delegation` 委派子任务的上下文隔离、权限收敛与重启未知态

## superbot（1）

需求正文见 [other](other.md)。

- `superbot-factory-setup` Super Bot 独立配好多机软件工厂

## system（2）

需求正文见 [other](other.md)。

- `system-context-cards` 会话摘要与 Jev 提示卡片
- `system-message-ui` 统一聊天系统消息展示

## thinking（1）

需求正文见 [other](other.md)。

- `thinking-effort` 思考力度

## tool（7）

需求正文见 [tool](tool.md)。

- `tool-call-pairing-batch-dedup` 同批重复工具结果去重（验证试点发现 F-1）
- `tool-call-pairing-verification` 工具调用与结果配对验证试点
- `tool-exposure-tiers` 工具三层分类与独立的渐进和全量提供方式
- `tool-loop-same-call` 工具循环按同一次调用判断
- `tool-observation-thumbnails` 工具观察截图缩略图
- `tool-progress-guard` 重复工具调用按实际进展判断
- `tool-search-experiment` 可切换的增强工具检索实验

## turn（1）

需求正文见 [other](other.md)。

- `turn-stats-end-time` 对话轮次统计显示结束时间

## unattended（1）

需求正文见 [other](other.md)。

- `unattended-approval-expiry` 无人值守审批超时拒绝

## unified（1）

需求正文见 [other](other.md)。

- `unified-bot-goal-lifecycle` 统一 Bot 目标生命周期与归档展示

## unlimited（2）

需求正文见 [other](other.md)。

- `unlimited-bot-rounds` Bot 对话轮和执行轮默认不限
- `unlimited-execution-steps` 默认不限单次执行步数

## unowned（1）

需求正文见 [other](other.md)。

- `unowned-legacy-bot` 无主旧 Bot 不被打开时认领

## untrusted（1）

需求正文见 [other](other.md)。

- `untrusted-cwd-default-deny` 不可信内容不能带出工作目录或执行动态代码

## upstream（1）

需求正文见 [other](other.md)。

- `upstream-resilience` 上游模型异常时的稳健性

## user（4）

需求正文见 [user](user.md)。

- `user-message-actions` 自己发送的消息支持复制和重试
- `user-preference-sync` 用户长期偏好入库与迁移
- `user-vault-ref-fill` User Vault reference fill (distinct from secret-vault)
- `user-vault-tools` User Vault assistant tools and Lab reference-fill
