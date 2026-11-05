<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格、现状章节的依据或核心用例后重新运行该脚本。 -->

# 现状章节与验收对照

每一章只列出它点名、并且已经实现的规格，以及标题里带有该规格验收标签的测试。草稿、已批准未实现、已取消，和还没有规格的方向，不记为已覆盖。一条规格可以出现在多章里。

## 产品是什么

现状：`doc/prd/current/01-product.md`

点名来自：`doc/bot/01-product.md`

### bot-autonomous-execution-coverage

Bot 自动选择并完整承接原有执行能力

- `packages/core/test/bot-autonomous-execution.test.js`
- `packages/core/test/bot-autonomous-factory.test.js`
- `packages/core/test/bot-autonomous-lifecycle.test.js`

### bot-entry-simplification

Bot 创建入口统一与管理页面职责拆分

- `e2e/bot-entry-sidebar.spec.ts`
- `e2e/bot-management-focus.spec.ts`
- `e2e/bot-room-deletion.spec.ts`
- `e2e/bot-task-settings-split.spec.ts`

### bots

Bot 名册、互发消息与权限

- `e2e/agent-home-features.spec.ts`
- `e2e/bot-model.spec.ts`
- `e2e/bot-policy.spec.ts`
- `packages/core/test/bot-memory-namespace.test.js`
- `packages/core/test/bot-model-override.test.js`
- `packages/core/test/bots.test.js`
- `packages/core/test/legacy-bots-migration.test.js`
- `packages/core/test/message-agent-runtime.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/schema-migration-snapshots.test.mjs`
- `scripts/test/session-bot-policy-routes.test.mjs`

## Bot、名册与工作台

现状：`doc/prd/current/02-bots-and-workspace.md`

点名来自：`doc/bot/02-identity.md`、`doc/bot/03-workspace.md`

### bot-activity-open-session

活动卡点击打开所属会话

- `apps/web-console/components/BotActivityList.test.ts`
- `apps/web-console/lib/bot-activity.test.ts`
- `packages/core/test/bot-activity.test.js`

### bot-activity-rail

Lab activity rail 展示 Bot 在途工作，并按 owner 隔离

- `packages/core/test/bot-activity.test.js`

### bot-chat-header

Bot 对话头部只显示名字、活脸和权限入口

- `apps/web-console/lib/bot-chat-header.test.ts`

### bot-child-task-chat-entry

普通会话列表里的 Bot 子任务入口

- `apps/web-console/components/SessionListRow.child-task.test.ts`
- `apps/web-console/lib/bot-child-tasks.test.ts`
- `apps/web-console/lib/session-row.test.ts`

### bot-child-task-stream-entry

主对话流里的子任务入口

- `apps/web-console/components/BotChildTaskStreamEntry.test.ts`
- `apps/web-console/lib/bot-child-task-stream.test.ts`

### bot-console-selection

切换 Bot 时显示当前会话，开发态仍能载入默认 Bot

- `apps/web-console/lib/bot-console-selection.test.ts`

### bot-create-named-tools

对话里能用 create_bot 和 create_room 创建

- `packages/core/test/product-admin-tools.test.js`

### bot-detail-child-tasks-tab

子任务改到详情页签

- `apps/web-console/components/BotDetailMenu.test.ts`

### bot-detail-menu

Bot 对话右侧详情菜单

- `apps/daemon/test/bot-materials.test.ts`
- `apps/web-console/components/BotDetailMenu.test.ts`
- `apps/web-console/lib/bot-detail-menu.test.ts`
- `e2e/bot-detail-skills.spec.ts`

### bot-detail-skill-management

在 Bot 详情中查看可选技能并管理技能

- `apps/daemon/test/bot-skill-selection.test.ts`
- `e2e/bot-detail-skills.spec.ts`
- `packages/core/test/agent-skill-management.test.js`

### bot-entry-simplification

Bot 创建入口统一与管理页面职责拆分

- `e2e/bot-entry-sidebar.spec.ts`
- `e2e/bot-management-focus.spec.ts`
- `e2e/bot-room-deletion.spec.ts`
- `e2e/bot-task-settings-split.spec.ts`

### bot-face-readable-shapes

脸型圆润，列表里能看见表情，干活时更忙

- `apps/web-console/components/BotFace.render.test.ts`
- `apps/web-console/lib/bot-face.test.ts`

### bot-first-task-dismissal

首次任务引导可关闭且不干扰已有对话

- `e2e/bot-first-task-dismissal.spec.ts`

### bot-first-task-new-user

首次任务引导只给新用户看

- `e2e/bot-first-task-new-user.spec.ts`

### bot-functional-groups

Bot 功能分组、共享范围优先级与头像修复

- `apps/web-console/components/BotFace.render.test.ts`
- `e2e/bot-functional-groups.spec.ts`
- `e2e/bot-room-deletion.spec.ts`
- `packages/core/test/bot-functional-groups.test.js`
- `packages/core/test/bot-reply-quote.test.js`
- `packages/core/test/bot-room-deletion.test.js`
- `packages/core/test/history-shared-isolation.test.js`
- `packages/core/test/memory-shared-context-isolation.test.js`
- `packages/core/test/session-fork.test.js`
- `scripts/test/bot-functional-group-routes.test.mjs`
- `scripts/test/route-access-contract.test.mjs`

### bot-goals-panel-rules

目标与进展只展示同时在做的多件事

- `apps/daemon/test/bot-goals-panel-rules.test.ts`
- `apps/web-console/components/bot-work/BotGoals.panel.test.ts`
- `e2e/bot-goals-panel-threshold.spec.ts`
- `packages/core/test/bot-goals-panel-rules.test.js`

### bot-goals-panel-threshold

目标与进展少于两个目标时不展示

- `e2e/bot-goals-panel-threshold.spec.ts`

### bot-group-drag-only

Bot 侧栏移组仅保留拖拽入口

- `e2e/bot-entry-sidebar.spec.ts`
- `e2e/bot-functional-groups.spec.ts`

### bot-mock-interview

内置模拟面试官按指定信息出题、评分并给改进建议

- `packages/core/test/bot-mock-interview.test.js`

### bot-panel-reset

切换 Bot 时重置记忆、暂停开关和软件连接

- `apps/web-console/lib/bot-panel-reset.test.ts`

### bot-pin-area

Bot 列表置顶区

- `apps/web-console/components/BotPinArea.test.ts`
- `apps/web-console/lib/bot-pin-area.test.ts`
- `apps/web-console/lib/bot-pin.test.ts`
- `e2e/bot-pin-area.spec.ts`

### bot-robot-faces

Bot 显示稳定的机器人头像

- `apps/web-console/lib/bot-face.test.ts`

### bot-session-row

单 Bot 会话行显示名字、问题和活体脸

- `apps/web-console/lib/session-row.test.ts`
- `e2e/agent-home-features.spec.ts`
- `packages/core/test/bot-history-memory.test.js`

### bot-skill-panel-layout

Bot 技能面板布局清晰且适应窄屏

- `e2e/bot-detail-skills.spec.ts`

### bot-switch-live-turn

切换 Bot 后主画面离开上一场进行中的对话

- `apps/web-console/lib/live-turn-session.test.ts`
- `apps/web-console/lib/session-panel-resource.test.ts`
- `e2e/bot-switch-live-turn.spec.ts`

### bot-workspace-interaction-polish

Bot 工作台引用、任务通知、上下文与长会话体验优化

- `apps/web-console/lib/feed-window.test.ts`
- `e2e/bot-interaction-polish.spec.ts`
- `packages/core/test/bot-functional-groups.test.js`
- `packages/core/test/normal-request-budget.test.js`
- `packages/core/test/routine-continuation.test.js`

### bots

Bot 名册、互发消息与权限

- `e2e/agent-home-features.spec.ts`
- `e2e/bot-model.spec.ts`
- `e2e/bot-policy.spec.ts`
- `packages/core/test/bot-memory-namespace.test.js`
- `packages/core/test/bot-model-override.test.js`
- `packages/core/test/bots.test.js`
- `packages/core/test/legacy-bots-migration.test.js`
- `packages/core/test/message-agent-runtime.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/schema-migration-snapshots.test.mjs`
- `scripts/test/session-bot-policy-routes.test.mjs`

### default-super-bot

默认 Super Bot 的状态查看、派工与结果汇总

- `e2e/bot-work-recovery.spec.ts`
- `e2e/bot-workspace.spec.ts`
- `e2e/lab.smoke.spec.ts`
- `packages/core/test/bot-work.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/bot-work-routes.test.mjs`

### low-interference-onboarding-goals

仅向新用户展示首次引导并隐藏少量目标面板

- `e2e/bot-first-task-dismissal.spec.ts`
- `e2e/bot-first-task-new-user.spec.ts`
- `e2e/bot-goals-panel-threshold.spec.ts`

### turn-stats-end-time

对话轮次统计显示结束时间

- `apps/web-console/lib/turn-feed-stats.test.ts`

### unowned-legacy-bot

无主旧 Bot 不被打开时认领

- `packages/core/test/message-agent.test.js`
- `packages/core/test/unowned-legacy-bot.test.js`

## 主对话

现状：`doc/prd/current/03-conversation.md`

点名来自：`doc/bot/04-conversation.md`

### bot-chat-image-compatibility

Bot 历史图片兼容与群聊发送恢复

- `apps/web-console/lib/model-errors.test.ts`
- `e2e/bot-chat-recovery.spec.ts`
- `packages/core/test/bot-rooms.test.js`
- `packages/core/test/image-compatibility.test.js`

### bot-composer-next-hint

Bot 输入框推荐下一句

- `apps/daemon/test/composer-hint.test.ts`
- `apps/web-console/lib/composer-next-hint.test.ts`

### bot-dual-compact

规范 Bot 会话的双阈值压缩

- `packages/core/test/bot-dual-compact.test.js`

### bot-forever-chat

Bot 永久主会话命令

- `apps/web-console/lib/bot-chat-commands.test.ts`
- `packages/capability-gateway/test/bot-forever-chat.test.js`
- `packages/core/test/bot-forever-chat.test.js`
- `scripts/test/bot-forever-chat-routes.test.mjs`

### bot-human-continuation

Bot忙时接收与连续对话

- `packages/core/test/bot-work.test.js`
- `packages/core/test/human-continuation.test.js`
- `scripts/test/bot-human-continuation.test.mjs`

### bot-immediate-steer

Bot 回合中直接插入并转向

- `apps/daemon/test/loop-steer-policy.test.ts`
- `apps/web-console/lib/running-turn-send.test.ts`
- `packages/agent-loop/src/runtime/agent-loop.test.ts`
- `packages/agent-loop/src/session/steer-ack.test.ts`
- `packages/agent-loop/src/turn/kernel.test.ts`
- `packages/core/test/bot-immediate-steer.test.js`

### bot-input-suggestion

Bot 输入框下一句建议

- `apps/daemon/test/input-suggestion-cache.test.ts`
- `apps/daemon/test/input-suggestion-http.test.ts`
- `apps/web-console/lib/input-suggestion.test.ts`
- `packages/core/test/input-suggestion.test.js`

### bot-input-suggestion-cache

Bot 每轮推荐只生成一次并保留

- `apps/daemon/test/input-suggestion-cache.test.ts`
- `apps/daemon/test/input-suggestion-http.test.ts`
- `e2e/bot-input-suggestion-cache.spec.ts`

### bot-reply-quote

引用某条 Bot 回复再发消息

- `apps/web-console/components/ReplyQuote.test.ts`
- `e2e/bot-reply-quote.spec.ts`
- `packages/agent-loop/src/session/apply-claimed-inbox.test.ts`
- `packages/agent-loop/src/session/fork-quote.test.ts`
- `packages/agent-loop/src/session/step-inbox-context.test.ts`
- `packages/core/test/bot-reply-quote.test.js`
- `packages/core/test/human-continuation.test.js`
- `packages/core/test/session-fork.test.js`

### bot-steer-visible

Bot 对话里的实时插话马上出现在对话流

- `apps/web-console/lib/feed-window.test.ts`
- `apps/web-console/lib/live-turn-session.test.ts`

### bot-window-compact

规范 Bot 按真实模型窗口的一半和 85% 压缩

- `packages/core/test/bot-dual-compact.test.js`

### bot-working-animation

Bot 工作期间持续动态、列表待机保持活性

- `apps/web-console/components/BotFace.render.test.ts`
- `e2e/bot-working-state.spec.ts`
- `scripts/test/bot-work-routes.test.mjs`

### session-recap

会话末尾回顾

- `apps/daemon/test/session-recap-settings.test.ts`
- `apps/daemon/test/session-recap-text.test.ts`
- `apps/daemon/test/session-recap-yield.test.ts`
- `apps/web-console/lib/session-recap.test.ts`

## 目标、协作与外部软件

现状：`doc/prd/current/04-goals-and-collaboration.md`

点名来自：`doc/bot/05-goals-and-work.md`、`doc/bot/07-rooms.md`、`doc/bot/08-collaboration.md`

### bot-autonomous-execution-coverage

Bot 自动选择并完整承接原有执行能力

- `packages/core/test/bot-autonomous-execution.test.js`
- `packages/core/test/bot-autonomous-factory.test.js`
- `packages/core/test/bot-autonomous-lifecycle.test.js`

### bot-concurrent-subagents

Bot 并发工作时派生子代理，并允许子代理复用记忆与互助

- `packages/core/test/bot-concurrent-subagents.test.js`

### bot-create-named-tools

对话里能用 create_bot 和 create_room 创建

- `packages/core/test/product-admin-tools.test.js`

### bot-fork-retrievable-inheritance

Bot 子任务按权限检索父 Bot 的记忆、技能、文件与上下文

- `packages/core/test/bot-fork-retrieval.test.js`
- `packages/core/test/bot-fork-spawn-inheritance.test.js`
- `packages/core/test/fork-sibling-isolation.test.js`

### bot-goal-result-return

子执行结果回到原目标并收口

- `packages/core/test/bot-goal-result-return.test.js`

### bot-multi-goal-coordination

Bot 多目标持续执行与自动选择执行方式

- `apps/daemon/test/bot-goals-http.test.ts`
- `apps/daemon/test/bot-goals.test.ts`
- `e2e/bot-multi-goal.spec.ts`
- `packages/core/test/bot-goal-intake.test.js`
- `packages/core/test/bot-goal-routing-gateway.test.js`
- `packages/core/test/bot-goal-routing-runtime.test.js`
- `packages/core/test/bot-goal-routing.test.js`
- `packages/core/test/bot-goal-runtime.test.js`
- `packages/core/test/bot-goals-budget.test.js`
- `packages/core/test/bot-goals-executor-cancellation.test.js`
- `packages/core/test/bot-goals-scheduler.test.js`
- `packages/core/test/bot-goals.test.js`

### bot-product-admin

对话 bot 能管理产品和配置

- `packages/core/test/product-admin-tools.test.js`

### bot-product-p0

Bot可靠工作与可验收交付闭环

- `apps/web-console/lib/approval-preview.test.ts`
- `apps/web-console/lib/bot-dispatch.test.ts`
- `apps/web-console/lib/bot-product-state.test.ts`
- `apps/web-console/lib/bot-recovery-link.test.ts`
- `apps/web-console/lib/bot-work-state.test.ts`
- `e2e/bot-product-approval.spec.ts`
- `e2e/bot-product-delivery.spec.ts`
- `e2e/bot-product-state.spec.ts`
- `packages/core/test/bot-product-activity.test.js`
- `packages/core/test/bot-product-delivery.test.js`
- `packages/core/test/bot-work.test.js`

### bot-product-p1

Bot首次任务与软件连接引导

- `e2e/bot-product-onboarding.spec.ts`
- `packages/core/test/software-execution.test.js`
- `scripts/test/bot-product-connection.test.mjs`

### bot-product-p2

Bot成果复用记忆纠错与持续协作

- `e2e/bot-product-metrics.spec.ts`
- `e2e/bot-product-onboarding.spec.ts`
- `e2e/bot-product-p2.spec.ts`
- `e2e/bot-workspace.spec.ts`
- `packages/core/test/bot-product-collaboration.test.js`
- `packages/core/test/bot-product-delivery.test.js`
- `packages/core/test/bot-product-memory.test.js`
- `packages/core/test/bot-product-metrics.test.js`
- `packages/core/test/bot-product-routine.test.js`
- `scripts/test/bot-product-metrics.test.mjs`
- `scripts/test/bot-product-p2.test.mjs`

### bot-reliable-messaging

Bot可靠工作与身份连续性

- `packages/core/test/bot-work.test.js`
- `packages/core/test/message-agent.test.js`

### bot-room-console

大规模群的对话区界面

- `apps/web-console/components/play-group/room-console.test.ts`

### bot-room-goal-intake

群目标与中途插话

- `packages/core/test/bot-room-goal-intake.test.js`

### bot-room-inline-approval

群内原位批准

- `packages/core/test/bot-room-inline-approval.test.js`

### bot-room-recall

群纪要、群规约与按群取回

- `packages/core/test/bot-room-recall.test.js`
- `packages/core/test/message-agent.test.js`

### bot-room-sparse-routing

所有群稀疏唤醒

- `packages/core/test/bot-room-sparse-routing.test.js`
- `packages/core/test/bot-room-speaker-pick.test.js`
- `packages/core/test/bot-rooms.test.js`
- `packages/core/test/room-scheduling.test.js`

### bot-room-speaker-identity

Bot 一开始就知道群里发言用自己的身份

- `packages/core/test/bot-rooms.test.js`
- `packages/core/test/product-admin-tools.test.js`

### bot-room-speaker-pick

群聊按贴题程度决定谁开口

- `packages/core/test/bot-room-sparse-routing.test.js`
- `packages/core/test/bot-room-speaker-pick.test.js`
- `packages/core/test/bot-rooms.test.js`
- `packages/core/test/room-scheduling.test.js`
- `packages/core/test/room-speaker-score.test.js`

### bot-room-tasks

群子任务与成员接力

- `packages/core/test/bot-room-tasks.test.js`

### bot-room-touched-memory

按触达打通单聊记忆与群内容

- `packages/core/test/bot-room-touched-memory.test.js`

### bot-room-wave-dispatch

群发言并行与停止拦截

- `packages/core/test/bot-room-wave-dispatch.test.js`

### bot-rooms

多 Bot 群会话与可靠发言

- `apps/web-console/lib/history-window.test.ts`
- `e2e/bot-workspace.spec.ts`
- `packages/core/test/bot-room-sparse-routing.test.js`
- `packages/core/test/bot-room-speaker-pick.test.js`
- `packages/core/test/bot-room-wave-dispatch.test.js`
- `packages/core/test/bot-rooms.test.js`
- `packages/core/test/history-tool-unification.test.js`
- `packages/core/test/room-human-step.test.js`
- `packages/core/test/room-scheduling.test.js`
- `scripts/test/bot-room-routes.test.mjs`

### bot-software-execution

Bot 软件连接与可靠执行

- `e2e/bot-workspace.spec.ts`
- `packages/core/test/bash-execution-result.test.js`
- `packages/core/test/discovery-openapi.test.js`
- `packages/core/test/software-dns-policy.test.js`
- `packages/core/test/software-execution.test.js`
- `packages/core/test/software-http-response.test.js`
- `scripts/test/bot-software-credential-access.test.mjs`

### bot-task-permission-inheritance

同 Bot 任务继承权限，跨 Bot 按目标权限执行

- `packages/core/test/bot-concurrent-subagents.test.js`
- `packages/core/test/bot-policy.test.js`
- `packages/core/test/bot-product-collaboration.test.js`
- `packages/core/test/product-admin-tools.test.js`
- `packages/core/test/subagent-blocked.test.js`

### bots

Bot 名册、互发消息与权限

- `e2e/agent-home-features.spec.ts`
- `e2e/bot-model.spec.ts`
- `e2e/bot-policy.spec.ts`
- `packages/core/test/bot-memory-namespace.test.js`
- `packages/core/test/bot-model-override.test.js`
- `packages/core/test/bots.test.js`
- `packages/core/test/legacy-bots-migration.test.js`
- `packages/core/test/message-agent-runtime.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/schema-migration-snapshots.test.mjs`
- `scripts/test/session-bot-policy-routes.test.mjs`

### default-super-bot

默认 Super Bot 的状态查看、派工与结果汇总

- `e2e/bot-work-recovery.spec.ts`
- `e2e/bot-workspace.spec.ts`
- `e2e/lab.smoke.spec.ts`
- `packages/core/test/bot-work.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/bot-work-routes.test.mjs`

### play-bot-group

Bot 会话列表里的多 Bot 群聊

- `apps/web-console/lib/bot-group.test.ts`

### room-task-collaboration

群聊临时负责人任务协作模式

- `e2e/room-task-collaboration.spec.ts`
- `packages/core/test/bot-room-wave-dispatch.test.js`
- `packages/core/test/bot-rooms.test.js`
- `packages/core/test/tool-exposure-tiers.test.js`

### superbot-factory-setup

Super Bot 独立配好多机软件工厂

- `packages/core/test/factory-discover.test.js`
- `packages/core/test/factory-tool-policy.test.js`
- `packages/core/test/superbot-factory-setup.test.js`

## 记忆、技能与定时任务

现状：`doc/prd/current/05-memory-skills-routines.md`

点名来自：`doc/bot/03-workspace.md`、`doc/bot/06-memory-skills-routines.md`

### bot-activity-open-session

活动卡点击打开所属会话

- `apps/web-console/components/BotActivityList.test.ts`
- `apps/web-console/lib/bot-activity.test.ts`
- `packages/core/test/bot-activity.test.js`

### bot-activity-rail

Lab activity rail 展示 Bot 在途工作，并按 owner 隔离

- `packages/core/test/bot-activity.test.js`

### bot-child-task-chat-entry

普通会话列表里的 Bot 子任务入口

- `apps/web-console/components/SessionListRow.child-task.test.ts`
- `apps/web-console/lib/bot-child-tasks.test.ts`
- `apps/web-console/lib/session-row.test.ts`

### bot-child-task-stream-entry

主对话流里的子任务入口

- `apps/web-console/components/BotChildTaskStreamEntry.test.ts`
- `apps/web-console/lib/bot-child-task-stream.test.ts`

### bot-console-selection

切换 Bot 时显示当前会话，开发态仍能载入默认 Bot

- `apps/web-console/lib/bot-console-selection.test.ts`

### bot-detail-child-tasks-tab

子任务改到详情页签

- `apps/web-console/components/BotDetailMenu.test.ts`

### bot-detail-menu

Bot 对话右侧详情菜单

- `apps/daemon/test/bot-materials.test.ts`
- `apps/web-console/components/BotDetailMenu.test.ts`
- `apps/web-console/lib/bot-detail-menu.test.ts`
- `e2e/bot-detail-skills.spec.ts`

### bot-detail-skill-management

在 Bot 详情中查看可选技能并管理技能

- `apps/daemon/test/bot-skill-selection.test.ts`
- `e2e/bot-detail-skills.spec.ts`
- `packages/core/test/agent-skill-management.test.js`

### bot-entry-simplification

Bot 创建入口统一与管理页面职责拆分

- `e2e/bot-entry-sidebar.spec.ts`
- `e2e/bot-management-focus.spec.ts`
- `e2e/bot-room-deletion.spec.ts`
- `e2e/bot-task-settings-split.spec.ts`

### bot-first-task-dismissal

首次任务引导可关闭且不干扰已有对话

- `e2e/bot-first-task-dismissal.spec.ts`

### bot-first-task-new-user

首次任务引导只给新用户看

- `e2e/bot-first-task-new-user.spec.ts`

### bot-functional-groups

Bot 功能分组、共享范围优先级与头像修复

- `apps/web-console/components/BotFace.render.test.ts`
- `e2e/bot-functional-groups.spec.ts`
- `e2e/bot-room-deletion.spec.ts`
- `packages/core/test/bot-functional-groups.test.js`
- `packages/core/test/bot-reply-quote.test.js`
- `packages/core/test/bot-room-deletion.test.js`
- `packages/core/test/history-shared-isolation.test.js`
- `packages/core/test/memory-shared-context-isolation.test.js`
- `packages/core/test/session-fork.test.js`
- `scripts/test/bot-functional-group-routes.test.mjs`
- `scripts/test/route-access-contract.test.mjs`

### bot-gateway-delivery

IM 静默回复、至少一次投递与例行预检

- `apps/web-console/lib/cron.test.ts`
- `packages/capability-gateway/test/outbound-delivery.test.js`
- `packages/core/test/routine-precheck.test.js`
- `scripts/test/cron-job-patch.test.mjs`

### bot-goals-panel-rules

目标与进展只展示同时在做的多件事

- `apps/daemon/test/bot-goals-panel-rules.test.ts`
- `apps/web-console/components/bot-work/BotGoals.panel.test.ts`
- `e2e/bot-goals-panel-threshold.spec.ts`
- `packages/core/test/bot-goals-panel-rules.test.js`

### bot-goals-panel-threshold

目标与进展少于两个目标时不展示

- `e2e/bot-goals-panel-threshold.spec.ts`

### bot-group-drag-only

Bot 侧栏移组仅保留拖拽入口

- `e2e/bot-entry-sidebar.spec.ts`
- `e2e/bot-functional-groups.spec.ts`

### bot-history-memory

Bot 持续对话历史与记忆

- `apps/web-console/lib/history-window.test.ts`
- `e2e/bot-workspace.spec.ts`
- `packages/core/test/bot-history-memory.test.js`
- `packages/core/test/history-tool-unification.test.js`
- `packages/core/test/history-trigram-candidate.test.js`
- `packages/core/test/history-visible-fold.test.js`
- `scripts/test/bot-history-http.test.mjs`
- `scripts/test/bot-history-routes.test.mjs`

### bot-identity-continuity

Bot可靠工作与身份连续性

- `packages/core/test/bot-work.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/bot-identity-http.test.mjs`

### bot-panel-reset

切换 Bot 时重置记忆、暂停开关和软件连接

- `apps/web-console/lib/bot-panel-reset.test.ts`

### bot-pin-area

Bot 列表置顶区

- `apps/web-console/components/BotPinArea.test.ts`
- `apps/web-console/lib/bot-pin-area.test.ts`
- `apps/web-console/lib/bot-pin.test.ts`
- `e2e/bot-pin-area.spec.ts`

### bot-product-p2

Bot成果复用记忆纠错与持续协作

- `e2e/bot-product-metrics.spec.ts`
- `e2e/bot-product-onboarding.spec.ts`
- `e2e/bot-product-p2.spec.ts`
- `e2e/bot-workspace.spec.ts`
- `packages/core/test/bot-product-collaboration.test.js`
- `packages/core/test/bot-product-delivery.test.js`
- `packages/core/test/bot-product-memory.test.js`
- `packages/core/test/bot-product-metrics.test.js`
- `packages/core/test/bot-product-routine.test.js`
- `scripts/test/bot-product-metrics.test.mjs`
- `scripts/test/bot-product-p2.test.mjs`

### bot-routine-lifecycle

Bot 可靠例行任务

- `apps/web-console/lib/routine-status.test.ts`
- `apps/web-console/lib/routine-time.test.ts`
- `e2e/bot-work-recovery.spec.ts`
- `e2e/bot-workspace.spec.ts`
- `packages/core/test/cron-facade.test.js`
- `packages/core/test/cron-store.test.js`
- `packages/core/test/event-routine.test.js`
- `packages/core/test/routine-continuation.test.js`
- `packages/core/test/routine-lease.test.js`
- `packages/core/test/routine-lifecycle.test.js`
- `packages/core/test/routine-room-delivery.test.js`
- `scripts/test/cron-job-patch.test.mjs`

### bot-routine-main-session

Bot 定时任务跟自己的会话走

- `e2e/bot-workspace.spec.ts`
- `packages/core/test/routine-bot-session.test.js`

### bot-scoped-skill-sharing

Bot 私有技能沉淀与指定 Bot 共享

- `e2e/bot-scoped-skills.spec.ts`
- `packages/core/test/bot-scoped-skills.test.js`

### bot-skill-panel-layout

Bot 技能面板布局清晰且适应窄屏

- `e2e/bot-detail-skills.spec.ts`

### bot-switch-live-turn

切换 Bot 后主画面离开上一场进行中的对话

- `apps/web-console/lib/live-turn-session.test.ts`
- `apps/web-console/lib/session-panel-resource.test.ts`
- `e2e/bot-switch-live-turn.spec.ts`

### bot-workspace-interaction-polish

Bot 工作台引用、任务通知、上下文与长会话体验优化

- `apps/web-console/lib/feed-window.test.ts`
- `e2e/bot-interaction-polish.spec.ts`
- `packages/core/test/bot-functional-groups.test.js`
- `packages/core/test/normal-request-budget.test.js`
- `packages/core/test/routine-continuation.test.js`

### bots

Bot 名册、互发消息与权限

- `e2e/agent-home-features.spec.ts`
- `e2e/bot-model.spec.ts`
- `e2e/bot-policy.spec.ts`
- `packages/core/test/bot-memory-namespace.test.js`
- `packages/core/test/bot-model-override.test.js`
- `packages/core/test/bots.test.js`
- `packages/core/test/legacy-bots-migration.test.js`
- `packages/core/test/message-agent-runtime.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/schema-migration-snapshots.test.mjs`
- `scripts/test/session-bot-policy-routes.test.mjs`

### low-interference-onboarding-goals

仅向新用户展示首次引导并隐藏少量目标面板

- `e2e/bot-first-task-dismissal.spec.ts`
- `e2e/bot-first-task-new-user.spec.ts`
- `e2e/bot-goals-panel-threshold.spec.ts`

### turn-stats-end-time

对话轮次统计显示结束时间

- `apps/web-console/lib/turn-feed-stats.test.ts`

## 安全、模型与运行方式

现状：`doc/prd/current/06-safety-and-runtime.md`

点名来自：`doc/bot/02-identity.md`、`doc/bot/05-goals-and-work.md`、`doc/bot/09-safety.md`

### bot-autonomous-execution-coverage

Bot 自动选择并完整承接原有执行能力

- `packages/core/test/bot-autonomous-execution.test.js`
- `packages/core/test/bot-autonomous-factory.test.js`
- `packages/core/test/bot-autonomous-lifecycle.test.js`

### bot-chat-header

Bot 对话头部只显示名字、活脸和权限入口

- `apps/web-console/lib/bot-chat-header.test.ts`

### bot-concurrent-subagents

Bot 并发工作时派生子代理，并允许子代理复用记忆与互助

- `packages/core/test/bot-concurrent-subagents.test.js`

### bot-create-named-tools

对话里能用 create_bot 和 create_room 创建

- `packages/core/test/product-admin-tools.test.js`

### bot-face-readable-shapes

脸型圆润，列表里能看见表情，干活时更忙

- `apps/web-console/components/BotFace.render.test.ts`
- `apps/web-console/lib/bot-face.test.ts`

### bot-fork-retrievable-inheritance

Bot 子任务按权限检索父 Bot 的记忆、技能、文件与上下文

- `packages/core/test/bot-fork-retrieval.test.js`
- `packages/core/test/bot-fork-spawn-inheritance.test.js`
- `packages/core/test/fork-sibling-isolation.test.js`

### bot-goal-result-return

子执行结果回到原目标并收口

- `packages/core/test/bot-goal-result-return.test.js`

### bot-mock-interview

内置模拟面试官按指定信息出题、评分并给改进建议

- `packages/core/test/bot-mock-interview.test.js`

### bot-multi-goal-coordination

Bot 多目标持续执行与自动选择执行方式

- `apps/daemon/test/bot-goals-http.test.ts`
- `apps/daemon/test/bot-goals.test.ts`
- `e2e/bot-multi-goal.spec.ts`
- `packages/core/test/bot-goal-intake.test.js`
- `packages/core/test/bot-goal-routing-gateway.test.js`
- `packages/core/test/bot-goal-routing-runtime.test.js`
- `packages/core/test/bot-goal-routing.test.js`
- `packages/core/test/bot-goal-runtime.test.js`
- `packages/core/test/bot-goals-budget.test.js`
- `packages/core/test/bot-goals-executor-cancellation.test.js`
- `packages/core/test/bot-goals-scheduler.test.js`
- `packages/core/test/bot-goals.test.js`

### bot-product-p0

Bot可靠工作与可验收交付闭环

- `apps/web-console/lib/approval-preview.test.ts`
- `apps/web-console/lib/bot-dispatch.test.ts`
- `apps/web-console/lib/bot-product-state.test.ts`
- `apps/web-console/lib/bot-recovery-link.test.ts`
- `apps/web-console/lib/bot-work-state.test.ts`
- `e2e/bot-product-approval.spec.ts`
- `e2e/bot-product-delivery.spec.ts`
- `e2e/bot-product-state.spec.ts`
- `packages/core/test/bot-product-activity.test.js`
- `packages/core/test/bot-product-delivery.test.js`
- `packages/core/test/bot-work.test.js`

### bot-product-p1

Bot首次任务与软件连接引导

- `e2e/bot-product-onboarding.spec.ts`
- `packages/core/test/software-execution.test.js`
- `scripts/test/bot-product-connection.test.mjs`

### bot-product-p2

Bot成果复用记忆纠错与持续协作

- `e2e/bot-product-metrics.spec.ts`
- `e2e/bot-product-onboarding.spec.ts`
- `e2e/bot-product-p2.spec.ts`
- `e2e/bot-workspace.spec.ts`
- `packages/core/test/bot-product-collaboration.test.js`
- `packages/core/test/bot-product-delivery.test.js`
- `packages/core/test/bot-product-memory.test.js`
- `packages/core/test/bot-product-metrics.test.js`
- `packages/core/test/bot-product-routine.test.js`
- `scripts/test/bot-product-metrics.test.mjs`
- `scripts/test/bot-product-p2.test.mjs`

### bot-robot-faces

Bot 显示稳定的机器人头像

- `apps/web-console/lib/bot-face.test.ts`

### bot-session-row

单 Bot 会话行显示名字、问题和活体脸

- `apps/web-console/lib/session-row.test.ts`
- `e2e/agent-home-features.spec.ts`
- `packages/core/test/bot-history-memory.test.js`

### bot-task-permission-inheritance

同 Bot 任务继承权限，跨 Bot 按目标权限执行

- `packages/core/test/bot-concurrent-subagents.test.js`
- `packages/core/test/bot-policy.test.js`
- `packages/core/test/bot-product-collaboration.test.js`
- `packages/core/test/product-admin-tools.test.js`
- `packages/core/test/subagent-blocked.test.js`

### bots

Bot 名册、互发消息与权限

- `e2e/agent-home-features.spec.ts`
- `e2e/bot-model.spec.ts`
- `e2e/bot-policy.spec.ts`
- `packages/core/test/bot-memory-namespace.test.js`
- `packages/core/test/bot-model-override.test.js`
- `packages/core/test/bots.test.js`
- `packages/core/test/legacy-bots-migration.test.js`
- `packages/core/test/message-agent-runtime.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/schema-migration-snapshots.test.mjs`
- `scripts/test/session-bot-policy-routes.test.mjs`

### default-super-bot

默认 Super Bot 的状态查看、派工与结果汇总

- `e2e/bot-work-recovery.spec.ts`
- `e2e/bot-workspace.spec.ts`
- `e2e/lab.smoke.spec.ts`
- `packages/core/test/bot-work.test.js`
- `packages/core/test/message-agent.test.js`
- `scripts/test/bot-work-routes.test.mjs`

### loop-guard-model-switch

重复检测默认只约束弱模型

- `apps/web-console/lib/i18n/repeat-guard-copy.test.ts`
- `packages/agent-loop/src/assembly/max-host.test.ts`
- `packages/agent-loop/src/recovery/repeat-guard.test.ts`
- `packages/agent-loop/src/tools/shell-policy.test.ts`
- `packages/agent-loop/src/turn/repeat-guard-kernel.test.ts`
- `packages/core/test/repeat-guard-settings.test.js`

### unattended-approval-expiry

无人值守审批超时拒绝

- `apps/web-console/lib/approval-inbox.test.ts`
- `packages/core/test/unattended-approval-expiry.test.js`
- `packages/core/test/unattended-approval-writer-scope.test.js`

### unowned-legacy-bot

无主旧 Bot 不被打开时认领

- `packages/core/test/message-agent.test.js`
- `packages/core/test/unowned-legacy-bot.test.js`

## 自愈、演进与平台能力

现状：`doc/prd/current/07-evolution-and-platform.md`

点名来自：`doc/bot/05-goals-and-work.md`

### bot-autonomous-execution-coverage

Bot 自动选择并完整承接原有执行能力

- `packages/core/test/bot-autonomous-execution.test.js`
- `packages/core/test/bot-autonomous-factory.test.js`
- `packages/core/test/bot-autonomous-lifecycle.test.js`

### bot-concurrent-subagents

Bot 并发工作时派生子代理，并允许子代理复用记忆与互助

- `packages/core/test/bot-concurrent-subagents.test.js`

### bot-fork-retrievable-inheritance

Bot 子任务按权限检索父 Bot 的记忆、技能、文件与上下文

- `packages/core/test/bot-fork-retrieval.test.js`
- `packages/core/test/bot-fork-spawn-inheritance.test.js`
- `packages/core/test/fork-sibling-isolation.test.js`

### bot-goal-result-return

子执行结果回到原目标并收口

- `packages/core/test/bot-goal-result-return.test.js`

### bot-multi-goal-coordination

Bot 多目标持续执行与自动选择执行方式

- `apps/daemon/test/bot-goals-http.test.ts`
- `apps/daemon/test/bot-goals.test.ts`
- `e2e/bot-multi-goal.spec.ts`
- `packages/core/test/bot-goal-intake.test.js`
- `packages/core/test/bot-goal-routing-gateway.test.js`
- `packages/core/test/bot-goal-routing-runtime.test.js`
- `packages/core/test/bot-goal-routing.test.js`
- `packages/core/test/bot-goal-runtime.test.js`
- `packages/core/test/bot-goals-budget.test.js`
- `packages/core/test/bot-goals-executor-cancellation.test.js`
- `packages/core/test/bot-goals-scheduler.test.js`
- `packages/core/test/bot-goals.test.js`

### bot-product-p0

Bot可靠工作与可验收交付闭环

- `apps/web-console/lib/approval-preview.test.ts`
- `apps/web-console/lib/bot-dispatch.test.ts`
- `apps/web-console/lib/bot-product-state.test.ts`
- `apps/web-console/lib/bot-recovery-link.test.ts`
- `apps/web-console/lib/bot-work-state.test.ts`
- `e2e/bot-product-approval.spec.ts`
- `e2e/bot-product-delivery.spec.ts`
- `e2e/bot-product-state.spec.ts`
- `packages/core/test/bot-product-activity.test.js`
- `packages/core/test/bot-product-delivery.test.js`
- `packages/core/test/bot-work.test.js`

### bot-product-p1

Bot首次任务与软件连接引导

- `e2e/bot-product-onboarding.spec.ts`
- `packages/core/test/software-execution.test.js`
- `scripts/test/bot-product-connection.test.mjs`

### bot-product-p2

Bot成果复用记忆纠错与持续协作

- `e2e/bot-product-metrics.spec.ts`
- `e2e/bot-product-onboarding.spec.ts`
- `e2e/bot-product-p2.spec.ts`
- `e2e/bot-workspace.spec.ts`
- `packages/core/test/bot-product-collaboration.test.js`
- `packages/core/test/bot-product-delivery.test.js`
- `packages/core/test/bot-product-memory.test.js`
- `packages/core/test/bot-product-metrics.test.js`
- `packages/core/test/bot-product-routine.test.js`
- `scripts/test/bot-product-metrics.test.mjs`
- `scripts/test/bot-product-p2.test.mjs`

### bot-task-permission-inheritance

同 Bot 任务继承权限，跨 Bot 按目标权限执行

- `packages/core/test/bot-concurrent-subagents.test.js`
- `packages/core/test/bot-policy.test.js`
- `packages/core/test/bot-product-collaboration.test.js`
- `packages/core/test/product-admin-tools.test.js`
- `packages/core/test/subagent-blocked.test.js`

## 没有被现状章节点名的已实现规格

### acceptance-gate

验收标准门禁（需求 → 可执行验收用例）

- `scripts/test/acceptance-gate-cli.test.mjs`
- `scripts/test/acceptance-lib.test.mjs`

### agent-as-folder-eval

Agent-as-folder path + eval default-on

- `packages/core/test/agent-as-folder-eval.test.js`

### agent-learning-governance

纠错评测、技能验证、输入授权与事件调度

- `apps/daemon/test/learning-http.test.ts`
- `e2e/learning-governance.spec.ts`
- `packages/core/test/learning-governance.test.js`

### agent-skill-management

Agent 在对话中管理自身技能

- `e2e/bot-detail-skills.spec.ts`
- `packages/core/test/agent-skill-management.test.js`

### agents-management

Bots / Agents / Teams / Skills 管理页清晰易用

- `apps/web-console/lib/agents-view.test.ts`
- `e2e/agent-home-features.spec.ts`
- `e2e/agents-management.spec.ts`
- `e2e/bot-model.spec.ts`

### always-on-reliability

常驻 Agent 的恢复、通知、长期评测、缓存诊断与压缩契约

- `apps/daemon/test/session-reliability.test.ts`
- `e2e/always-on-reliability.spec.ts`
- `packages/core/test/always-on-reliability.test.js`

### app-frosted-glass

整个应用是毛玻璃

- `apps/desktop/src/window-glass.test.ts`
- `apps/web-console/components/sections/settings/settings-glass.test.ts`
- `apps/web-console/styles/glass.test.ts`

### approval-explanations

审批操作与风险说明

- `apps/daemon/test/approval-explanation.test.ts`
- `apps/web-console/components/approval-explanation.test.ts`
- `e2e/approval-explanations.spec.ts`

### ask-user-live-stream

回答追问后继续看到生成内容

- `apps/web-console/lib/live-stream-attach.test.ts`
- `packages/core/test/ask-user-live-stream.test.js`

### assistant-actions-at-end

助手消息的引用/纠错按钮放在正文末尾

- `apps/web-console/components/assistant-actions-at-end.test.ts`

### assistant-label-dedupe

连续助手发言只在第一条显示「助手」标题

- `apps/web-console/components/correction-capture.test.ts`
- `apps/web-console/lib/assistant-label-run.test.ts`

### assistant-repeat-collapse

助手正文里相邻的重复行收成一行

- `apps/web-console/lib/collapse-repeated-lines.test.ts`

### assistant-run-spacing

连续助手消息省略标题后不留大段空白

- `apps/web-console/components/assistant-run-spacing.test.ts`

### auto-review-authorized-by

Auto-review 批准回执记录授权引用

- `packages/agent-loop/src/approval/auto-review.test.ts`
- `packages/core/test/approval-authorized-by.test.js`

### auto-review-shell-mcp

Auto-review 工具级审批卡（高危 Shell/MCP）

- `apps/web-console/components/AutoReviewMarks.render.test.ts`
- `apps/web-console/lib/auto-review-card.test.ts`
- `packages/agent-loop/src/approval/auto-review.test.ts`
- `packages/core/test/model-sandbox-isolation.test.js`

### background-job-restart

重启后中断无人执行的后台命令

- `packages/core/test/background-job-restart.test.js`

### bg-run-host-park

Host parks durable wait for owned bg_run

- `packages/core/test/bg-run-host-park.test.js`

### bot-bloub-dynamic

Bloub 动态头像风格

- `apps/web-console/lib/bloub-motion.test.ts`
- `apps/web-console/lib/bot-face-save.test.ts`
- `e2e/bot-bloub-dynamic.spec.ts`
- `packages/core/test/bots.test.js`

### bot-child-task-chip-fill

子任务芯片有底色

- `apps/web-console/components/BotChildTaskStreamEntry.test.ts`

### bot-completion-reliability

完成验证可追溯与任务收尾可靠性

- `packages/core/test/bot-completion-reliability.test.js`
- `scripts/test/bot-quality-reliability.test.mjs`
- `scripts/test/completion-audit.test.mjs`

### bot-daydream-http

每日复盘与共享治理真实 HTTP 通路

- `apps/daemon/test/bot-daydream-http.test.ts`

### bot-daydream-integration

每日复盘共享成果进入后续 Bot 任务

- `packages/core/test/daydream-integration.test.js`
- `packages/core/test/daydream-runtime.test.js`

### bot-daydream-knowledge

Daydream Super Bot 共享治理

- `packages/core/test/daydream-knowledge.test.js`

### bot-daydream-local

Bot 每日独立复盘

- `packages/core/test/bot-daydream-local.test.js`

### bot-daydream-missing-session

缺少固定对话时每日复盘继续

- `packages/core/test/daydream-runtime.test.js`

### bot-daydream-ui

Bot 每日复盘配置与治理界面

- `e2e/bot-daydream.spec.ts`

### bot-dialog-solid

Bot 消息弹窗使用纯色背景

- `e2e/bot-dialog-solid.spec.ts`

### bot-entry-dialog-shell

新建 Bot 弹窗遮罩与底部按钮

- `apps/web-console/components/BotEntryDialog.test.ts`
- `e2e/bot-entry-sidebar.spec.ts`

### bot-execution-p0

Bot 任务直达执行与证据保真

- `packages/core/test/bot-execution-p0.test.js`
- `packages/core/test/bot-goal-result-return.test.js`

### bot-extreme-concurrency

Bot 以高并发同时推进多件工作

- `apps/web-console/lib/bot-goal-concurrency.test.ts`
- `packages/core/test/bot-extreme-concurrency.test.js`

### bot-face-soft-style

软萌机器人脸与经典脸并存

- `apps/web-console/components/BotFace.render.test.ts`
- `apps/web-console/lib/bot-avatar.test.ts`
- `apps/web-console/lib/bot-face-save.test.ts`
- `apps/web-console/lib/bot-face.test.ts`
- `apps/web-console/lib/soft-bot-face.test.ts`
- `packages/core/test/bots.test.js`

### bot-fork-sessions-in-detail

Bot 子任务会话放进详情菜单

- `apps/web-console/components/BotDetailMenu.test.ts`
- `apps/web-console/lib/bot-child-tasks.test.ts`

### bot-goal-conclusion

目标结算与子会话身份的生命周期闭环

- `packages/core/test/bot-goal-conclusion.test.js`
- `packages/core/test/bot-goals-scheduler.test.js`
- `packages/core/test/bot-goals.test.js`

### bot-goal-lifecycle-boundaries

Bot 目标跨用户与执行生命周期闭环

- `apps/daemon/test/bot-goals-http.test.ts`
- `apps/daemon/test/bot-goals.test.ts`
- `apps/web-console/components/bot-work/BotGoals.panel.test.ts`
- `e2e/bot-goals-panel-threshold.spec.ts`
- `packages/core/test/bot-goal-boundaries.test.js`

### bot-goal-live-chain

Bot 默认配置完整执行与证据回流

- `packages/core/test/bot-goal-live-chain.test.js`
- `packages/core/test/bot-goal-routing-runtime.test.js`
- `packages/core/test/deferred-tool-load.test.js`

### bot-goal-nested-approval

目标子任务的待批准出现在主对话

- `apps/web-console/lib/goal-chat-approvals.test.ts`
- `packages/core/test/bot-goals-scheduler.test.js`

### bot-goal-only-when-needed

Bot 只在必须时才为目标再开子任务

- `packages/core/test/bot-goal-only-when-needed.test.js`

### bot-linked-watchers

关联原工作的临时盯梢与观察证据

- `e2e/bot-linked-watchers.spec.ts`
- `packages/core/test/bot-goals-scheduler.test.js`
- `packages/core/test/bot-linked-watchers-runtime.test.js`
- `packages/core/test/bot-linked-watchers.test.js`
- `scripts/test/bot-linked-watchers-http.test.mjs`

### bot-list-face-plate

侧栏 Bot 脸保持原形，不套外框也不拉变形

- `apps/web-console/components/SessionListRow.face-plate.test.ts`

### bot-list-idle-motion

Bot 列表待机头像保持活性

- `apps/web-console/lib/bot-face.test.ts`
- `e2e/bot-list-idle-motion.spec.ts`
- `e2e/bot-working-state.spec.ts`

### bot-message-name

Bot 回复标签显示 Bot 名称

- `apps/web-console/lib/assistant-name.test.ts`
- `e2e/bot-message-name.spec.ts`

### bot-pin-sync

跨浏览器置顶同步

- `apps/daemon/test/bot-pin-settings-http.test.ts`
- `apps/web-console/lib/bot-pin-sync.test.ts`

### bot-quality-reliability

限定写入范围与辅助判断可靠性及重复对照

- `packages/core/test/bot-quality-reliability.test.js`
- `scripts/test/bot-quality-reliability.test.mjs`

### bot-quality-sample-plan

真实模型评估的独立任务与样本量预检

- `scripts/test/quality-sample-plan.test.mjs`

### bot-readonly-api

Bot 正文 API 与显式只读路由

- `apps/daemon/test/bot-readonly-api-http.test.ts`
- `packages/core/test/bot-readonly-api.test.js`

### bot-relay-island

Bot 通信收起为灵动岛式胶囊

- `apps/web-console/components/bot-relay-strip.test.ts`
- `e2e/bot-dialog-solid.spec.ts`

### bot-relay-slug

非 bot_ 前缀的 Bot 通信也收成小提醒

- `apps/web-console/lib/bot-relay-message.test.ts`

### bot-relay-strip

Bot 间通信在聊天流里显示为紧凑通信条，点击弹窗看全文

- `apps/web-console/components/bot-relay-strip.test.ts`
- `apps/web-console/lib/bot-relay-message.test.ts`

### bot-room-work-continuity

群派工到原 Bot 持久工作的可靠承接

- `e2e/bot-room-work-continuity.spec.ts`
- `packages/core/test/bot-room-work-continuity.test.js`
- `packages/core/test/bot-room-work-runtime.test.js`
- `scripts/test/bot-room-work-continuity-http.test.mjs`

### bot-runtime-log-regressions

Bot 实际运行日志回归

- `packages/core/test/bot-runtime-log-regressions.test.js`

### bot-settings-flow

简化 Bot 操作与设置生效反馈

- `apps/daemon/test/bot-settings-flow.test.ts`
- `apps/web-console/lib/bot-console-selection.test.ts`
- `e2e/bot-entry-sidebar.spec.ts`
- `e2e/bot-face-creation.spec.ts`
- `e2e/bot-face-persistence.spec.ts`
- `e2e/bot-settings-flow.spec.ts`
- `packages/core/test/bot-settings-flow.test.js`

### bot-sidebar-child-sessions

Bot 侧栏不列出子任务会话

- `apps/web-console/lib/bot-child-tasks.test.ts`

### bot-sidebar-order

Bot 列表同一区域内拖拽排序

- `apps/web-console/lib/sidebar-order.test.ts`

### bot-soft-create-runtime

软萌头像可正常创建和保存

- `e2e/bot-soft-create-runtime.spec.ts`

### bot-soft-motion

软萌头像跟随实际工作状态动起来

- `apps/web-console/components/BotFace.render.test.ts`
- `e2e/bot-soft-motion.spec.ts`

### bot-source-authorization-continuity

Bot 已授权工作的来源连续性

- `packages/core/test/bot-source-authorization-continuity.test.js`

### bot-startup-summary-latency

摘要服务变慢时 Bot 启动有界等待

- `packages/core/test/bot-startup-summary-latency.test.js`

### bot-startup-trace

Bot 启动耗时分段可观测

- `apps/daemon/test/bot-startup-boot.test.ts`
- `packages/agent-loop/src/turn/prepare-startup-trace.test.ts`
- `packages/agent-loop/src/turn/startup-trace.test.ts`
- `packages/core/test/bot-startup-admit.test.ts`
- `packages/core/test/bot-startup-kernel.test.ts`
- `packages/core/test/bot-startup-prepare.test.ts`
- `packages/core/test/bot-startup-wake.test.ts`

### bot-supervision-freshness

Bot 监督状态新鲜度与回复关联

- `packages/core/test/bot-linked-watchers.test.js`
- `packages/core/test/bot-supervision-freshness.test.js`
- `packages/core/test/bot-supervision-runtime.test.js`

### bot-work-durable-wait

Bot 任务停在持久等待上并只恢复一次

- `packages/core/test/bot-work-durable-wait.test.js`

### bot-work-restart-resume

重启后从安全检查点继续 Bot 任务

- `packages/core/test/bot-work-restart-resume.test.js`

### brief-hide-monologue

精简界面隐藏混进正文的思考独白

- `apps/web-console/lib/leaked-monologue.test.ts`

### brief-no-process-note

精简模式不显示「已收起 N 条过程」

- `apps/web-console/lib/session-brief.test.ts`

### browser-navigate-private-network

浏览器导航拒绝私网和本地文件

- `packages/core/test/browser-backend.test.js`
- `packages/core/test/browser-tools.test.js`

### bypass-full-auto

bypass 全自动与重复审批修复

- `packages/agent-loop/src/approval/auto-review.test.ts`
- `packages/agent-loop/src/runtime/tool-loop.test.ts`
- `packages/core/test/bypass-reconcile.test.js`
- `packages/core/test/lcu-computer-use.test.js`

### bypass-remote-shell

bypass 下不再为无隔离反复审批，远端查找不被本机浏览规则拦住

- `packages/agent-loop/src/tools/shell-policy.test.ts`
- `packages/core/test/model-sandbox-isolation.test.js`

### bypass-skill-write

bypass 的 Bot 写技能不再被额外确认拦住

- `packages/core/test/bypass-skill-write.test.js`

### bypass-source-scope

permissionMode=bypass 视为用户显式授权，不再被来源范围拦截

- `packages/core/test/learning-governance.test.js`

### chat-approval-inline

待审批嵌在对话流里

- `apps/web-console/lib/approval-feed.test.ts`
- `e2e/chat-approval-inline.spec.ts`

### chat-basics

对话基础体验

- `apps/web-console/lib/run-leave.test.ts`
- `e2e/chat-basics.spec.ts`
- `e2e/lab.smoke.spec.ts`
- `scripts/test/sse-disconnect.test.mjs`

### chat-bubble-written-stamp

对话气泡不展示写入时间戳

- `apps/web-console/components/chat-bubble-written-stamp.test.ts`
- `apps/web-console/lib/visible-clock.test.ts`

### chat-experience

对话页简洁易用

- `e2e/agent-home-features.spec.ts`
- `e2e/chat-experience.spec.ts`

### chat-inline-history

单行附件入口与自动加载聊天历史

- `e2e/chat-inline-history.spec.ts`

### chat-more-menu-on-top

对话头部「⋯」更多菜单在最上层且不透明

- `apps/web-console/styles/chat-more-menu.test.ts`

### chat-tail-kept

对话结束时助手正文留在对话里

- `apps/web-console/lib/feed-window.test.ts`
- `apps/web-console/lib/history-window.test.ts`
- `apps/web-console/lib/live-turn-session.test.ts`

### child-wake-workitem

子代理完成唤醒继续同一项工作

- `packages/core/test/bot-goals-scheduler.test.js`

### ci-action-reliability

Actions 长短验证可靠性

- `apps/web-console/lib/feed-window.test.ts`
- `e2e/chat-experience.spec.ts`
- `packages/core/test/bot-goal-result-return.test.js`
- `scripts/test/acceptance-lib.test.mjs`
- `scripts/test/ci-action-reliability.test.mjs`
- `scripts/test/e2e-suite.test.mjs`
- `scripts/test/pr-release-paths.test.mjs`

### ci-audit-p1-p2

CI audit P1/P2 release gate hardening

- `packages/core/test/approvals-http.test.js`
- `packages/core/test/rate-limit-proxy.test.js`
- `scripts/test/base-revision.test.mjs`
- `scripts/test/ci-audit.test.mjs`

### ci-fast-and-bihourly-gates

两分钟快速门禁与每两小时完整验证

- `scripts/test/acceptance-lib.test.mjs`
- `scripts/test/changed-complexity.test.mjs`
- `scripts/test/ci-fast-bihourly.test.mjs`
- `scripts/test/core-unit-scope.test.mjs`
- `scripts/test/main-full-health.test.mjs`

### ci-http-fixture-timing

共享持续集成 HTTP 夹具计时

- `scripts/test/bot-http-fixed-window.test.mjs`
- `scripts/test/bot-http-load-harness.test.mjs`
- `scripts/test/ci-http-fixture-timing.test.mjs`

### ci-parallel-validation

完整验证职责并行与覆盖率产物复用

- `scripts/test/ci-parallel-validation.test.mjs`

### ci-review-drift-signal

评审指纹不一致时不要再报一次结果缺失

- `scripts/test/ci-review-drift-signal.test.mjs`

### ci-zero-coverage-complexity

零覆盖画面仍能通过复杂度门禁

- `packages/core/test/agent-inbox-claim-execute.test.js`
- `scripts/test/ci-zero-coverage-complexity.test.mjs`

### classic-solid-dark

经典主题深色用纯色

- `apps/web-console/components/classic-skin-menu.test.ts`
- `apps/web-console/lib/skin.test.ts`
- `apps/web-console/styles/glass.test.ts`

### command-hardline

危险命令硬拦截与密钥脱敏

- `packages/core/test/command-hardline.test.js`
- `packages/core/test/result-redaction.test.js`
- `packages/core/test/sandbox.test.js`

### compact-bot-secondary-tabs

精简 Bot 能力与权限及记录页

- `apps/web-console/components/compact-bot-settings.test.ts`

### compact-bot-settings

Bot 设置优先展示基本信息与已有定时任务

- `apps/web-console/components/compact-bot-settings.test.ts`
- `apps/web-console/components/routine-editor-dialog.test.ts`

### composer-draft-per-session

聊天输入框草稿按会话隔离

- `apps/web-console/lib/composer-draft.test.ts`

### composer-drop-retirement-soak-isolation

退役消息框拖拽并独立验证 HTTP soak 性能

- `e2e/composer-attachments.spec.ts`
- `packages/core/test/skill-router.test.js`
- `scripts/test/bot-http-soak-harness.test.mjs`
- `scripts/test/bot-http-soak-math.test.mjs`
- `scripts/test/composer-retirement-soak.test.mjs`

### composer-ime-enter

输入法确认回车不发送

- `apps/web-console/lib/composer-enter.test.ts`

### composer-quote-layout

输入栏中线对齐与不占行的消息操作

- `e2e/composer-quote-layout.spec.ts`

### connector-authorization

Lab connector authorization states and SecretVault grant

- `apps/web-console/components/ConnectorGrantCard.test.ts`
- `apps/web-console/components/ConnectorsSettingsCard.test.ts`
- `apps/web-console/lib/approval-item-view.test.ts`
- `apps/web-console/lib/connectors-grant-card.test.ts`
- `apps/web-console/lib/connectors-grant.test.ts`
- `packages/core/test/connector-registry.test.js`

### console-font-size-preference

控制台字体大小偏好

- `e2e/font-size-preference.spec.ts`
- `e2e/mac-retina-text-readability.spec.ts`

### console-knowledge

知识与记忆：分层记忆、搜索与摄取设置

- `apps/web-console/components/sections/knowledge/memory-model.test.ts`
- `e2e/tasks-knowledge.spec.ts`

### console-navigation

控制台主导航与页面结构

- `apps/web-console/lib/i18n/messages.test.ts`
- `apps/web-console/lib/nav.test.ts`
- `e2e/agent-home-features.spec.ts`
- `e2e/lab.features.spec.ts`
- `e2e/lab.smoke.spec.ts`

### console-settings

设置页渐进披露与搜索

- `apps/web-console/lib/settings-search.test.ts`
- `e2e/lab.smoke.spec.ts`

### console-skin-motion

各外观独立特效与极简黑白

- `apps/web-console/lib/skin.test.ts`

### console-skins

多套可切换外观

- `apps/web-console/lib/skin.test.ts`

### console-tasks

任务页：队列、编排运行与审批收件箱

- `apps/web-console/components/sections/tasks/i18n-sync.test.ts`
- `apps/web-console/components/sections/tasks/task-filters.test.ts`
- `apps/web-console/lib/approvals.test.ts`
- `e2e/agent-home-features.spec.ts`
- `e2e/tasks-knowledge.spec.ts`
- `packages/core/test/approvals-http.test.js`

### context-reliability

持续对话的任务保真与历史记忆找回

- `packages/agent-loop/src/approval/permission-mode.test.ts`
- `packages/agent-loop/src/session/rolling-summary.test.ts`
- `packages/core/test/bot-dual-compact.test.js`
- `packages/core/test/context-compaction-reliability.test.js`
- `packages/core/test/context-recall-parity.test.js`
- `packages/core/test/history-retrieval.test.js`
- `packages/core/test/history-tool-unification.test.js`
- `packages/core/test/memory-http-isolation.test.js`
- `packages/core/test/task-context.test.js`
- `scripts/test/context-reliability-eval.test.mjs`

### context-send-ceiling

压缩先于发送上限，任务事实有上限，已保存的 32768 生效

- `packages/core/test/context-send-ceiling.test.js`

### conversation-date-clock

续聊时日期跟现在走，不跟历史里的旧日期走

- `apps/daemon/test/session-recap-text.test.ts`
- `packages/agent-loop/src/model/summary-clock.test.ts`
- `packages/core/test/conversation-clock-request.test.js`
- `packages/core/test/conversation-clock-summary.test.js`
- `packages/core/test/room-conversation-clock.test.js`

### conversation-loop-defaults

对话默认行为要进入新对话和正在跑的普通对话

- `apps/daemon/test/loop-steer-policy.test.ts`
- `apps/web-console/lib/loop-composer-defaults.test.ts`
- `packages/agent-loop/src/recovery/repeat-guard.test.ts`

### correction-capture-hover

纠错转评测改为悬停图标

- `apps/web-console/components/correction-capture.test.ts`

### create-menu-trigger-hit-area

新增菜单展开后按钮仍可点击

- `e2e/bot-interaction-polish.spec.ts`

### daydream-tick-cost

每日复盘调度不能拖死 daemon

- `packages/core/test/daydream-tick-cost.test.js`

### delete-page

Delete library pages and revoke public shares

- `apps/daemon/test/durable-page-port.test.ts`
- `packages/core/test/durable-page-port.test.js`
- `packages/core/test/page-tools.test.js`

### delivery-quiet-hours

用户可见外发的全局静默时段

- `apps/daemon/test/delivery-quiet-hours-http.test.ts`
- `apps/web-console/components/DeliveryQuietHoursSettingsCard.test.ts`
- `apps/web-console/lib/delivery-quiet-hours-form.test.ts`
- `packages/capability-gateway/test/delivery-quiet-hours.test.js`

### desktop-preload-typecheck

桌面预加载脚本通过类型检查

- `apps/desktop/src/preload-typecheck.test.ts`

### desktop-safe-update

客户端手动一键更新、备份与失败回滚

- `apps/daemon/test/desktop-update-gate.test.ts`
- `apps/desktop/src/update-data-check.test.ts`
- `apps/desktop/src/update-prompt.test.ts`
- `apps/desktop/src/update-transaction.test.ts`
- `scripts/desktop/test/update-daemon.test.mjs`
- `scripts/desktop/test/update-electron-files.test.mjs`

### dev-lab-process-cleanup

开发启动器退出时完整清理子进程

- `scripts/test/dev-lab-process-cleanup.test.mjs`

### dev-tailnet-https

本地启动自动同步 Tailnet HTTPS

- `scripts/test/dev-tailnet-https.test.mjs`
- `scripts/test/dev-tailnet-start.test.mjs`

### discovery-default-on

能力发现总开关默认开启

- `apps/web-console/lib/discovery-default-on.test.ts`
- `packages/core/test/discovery-settings.test.js`

### durable-agent-waits

Agent 持久化条件等待与恢复

- `packages/core/test/durable-agent-waits.test.js`
- `packages/core/test/durable-wait-chain.test.js`
- `packages/core/test/durable-wait-replay.test.js`

### durable-artifact-port

大结果落盘并按页引用

- `apps/daemon/test/durable-artifact-port.test.ts`
- `packages/core/test/durable-artifact-port.test.js`

### durable-page-port

库级持久页面与分享链接

- `apps/daemon/test/durable-page-port.test.ts`
- `packages/core/test/durable-page-port.test.js`
- `packages/core/test/page-revisions.test.js`

### durable-wait-default

Durable wait is the default Goal/Routine park path

- `packages/core/test/durable-wait-default.test.js`

### email-webhook-replay

邮件事件不能靠换投递号重放

- `packages/core/test/event-routine.test.js`

### execution-log-analysis

执行日志能查出问题并指到具体调用

- `packages/agent-loop/src/runtime/tool-loop.test.ts`
- `packages/agent-loop/src/turn/turn-start-trace.test.ts`
- `packages/core/test/execution-findings.test.ts`

### experimental-settings

设置里的实验特性菜单

- `apps/daemon/test/loop-engine-hint.test.ts`
- `apps/web-console/lib/experimental-settings.test.ts`
- `e2e/experimental-settings.spec.ts`
- `packages/core/test/experimental-switches.test.js`

### external-agent-bots

Bot 级外部 Agent 通信

- `e2e/external-agent-bots.spec.ts`
- `packages/core/test/external-agent-connections.test.js`
- `packages/core/test/tool-exposure-tiers.test.js`
- `scripts/test/external-agent-bots.test.mjs`

### external-agent-task-handoff

外部 Agent 任务交接

- `e2e/external-agent-handoff.spec.ts`
- `scripts/test/external-agent-handoff.test.mjs`

### feed-reading-anchor-boundary

对话侧栏调整保留实际阅读位置

- `apps/web-console/lib/feed-window.test.ts`
- `e2e/bot-interaction-polish.spec.ts`

### fold-visible-history

折叠历史保留用户问题

- `packages/agent-loop/src/session/fold-budget.test.ts`

### gateway-im-security

IM 网关入站安全（验签、去重、白名单、Bot 路由）

- `packages/capability-gateway/test/gateway-security.test.js`

### github-webhook-replay

GitHub 事件不能靠换投递号重放

- `packages/core/test/event-routine.test.js`

### global-debug-visibility

全局调试信息开关

- `apps/daemon/test/user-preferences-http.test.ts`
- `apps/web-console/components/debug-display.test.ts`
- `apps/web-console/lib/debug-display.test.ts`

### global-default-model-clarity

全局默认模型配置与群聊模型来源可见

- `apps/web-console/components/play-group/room-console.test.ts`
- `apps/web-console/lib/group-chat-view.test.ts`
- `apps/web-console/lib/model-providers.test.ts`
- `e2e/global-default-model.spec.ts`
- `e2e/room-model-clarity.spec.ts`
- `packages/core/test/model-providers.test.js`
- `scripts/test/bot-room-models.test.mjs`
- `scripts/test/global-default-model-routes.test.mjs`

### global-default-model-row-align

全局默认模型行左右对齐

- `e2e/global-default-model.spec.ts`

### goal-history-toolbar-align

目标历史与标题栏按钮垂直居中

- `apps/web-console/components/GoalHistory.align.test.ts`

### goal-intake-hot-path

开轮不再等待目标判定和数据库锁

- `packages/core/test/goal-intake-hot-path.test.ts`
- `packages/core/test/goal-snapshot-busy-wait.test.ts`

### goal-restart-resume

重启后从安全检查点继续 Goal

- `packages/core/test/goal-restart-resume.test.js`

### goal-update-hidden

目标更新通知不在聊天里展示

- `apps/web-console/components/goal-update-presentation.test.ts`

### group-active-header

群聊顶部仅显示工作中的成员

- `e2e/group-active-header.spec.ts`

### group-chat-settings-save

群聊设置改完可以保存

- `apps/web-console/lib/group-settings-save.test.ts`
- `e2e/group-settings-save.spec.ts`

### group-chat-sidebar-placement

群聊可置顶并可拖入功能分组

- `apps/web-console/lib/room-sidebar-placement.test.ts`
- `packages/core/test/bot-functional-groups.test.js`

### group-command-same-as-dm

群里的命令跟该 Bot 单聊同一套放行

- `packages/core/test/group-command-scope.test.js`

### group-face

群聊行展示成员头像

- `apps/web-console/lib/group-members.test.ts`

### group-member-quiet

群聊成员区只留成员本身的信息

- `apps/web-console/components/play-group/room-console.test.ts`
- `apps/web-console/lib/group-chat-view.test.ts`
- `e2e/room-model-clarity.spec.ts`

### group-member-sections

群成员分成已在群里和添加成员

- `apps/web-console/components/play-group/room-console.test.ts`

### group-mode-explanations

群聊回复模式与运行限制说明

- `e2e/group-mode-explanations.spec.ts`

### group-reply-mode

群聊回复模式

- `apps/web-console/lib/group-reply-mode.test.ts`
- `packages/core/test/group-reply-mode.test.js`
- `scripts/test/group-reply-mode-routes.test.mjs`

### group-settings-clarity

群聊设置分区与成员提及清理

- `e2e/group-settings-clarity.spec.ts`

### hide-approval-continue

聊天不展示审批自动合成的续跑用户消息

- `apps/web-console/lib/approval-continue.test.ts`

### hide-dev-overlays

本地页面不展示开发浮层

- `apps/web-console/lib/dev-overlays.test.ts`

### jev-model-settings

在模型设置中配置 Jev 评估

- `e2e/jev-model-settings.spec.ts`

### knowledge-library-dirs

本地资料目录进入知识库并可检索

- `apps/daemon/test/library-pick-http.test.ts`
- `apps/web-console/components/sections/knowledge/library-dirs-model.test.ts`
- `apps/web-console/lib/i18n/messages.test.ts`
- `packages/core/test/library-folder-picker.test.js`
- `packages/core/test/library-index.test.js`

### lab-auth-and-route-access

控制台鉴权与接口访问隔离

- `e2e/auth-bearer-proxy.spec.ts`
- `scripts/test/route-access-contract.test.mjs`

### lab-library-pages

Lab library Pages panel (list / open / share / rotate / delete / create / edit)

- `apps/web-console/components/sections/knowledge/LibraryPagesPanel.render.test.ts`
- `apps/web-console/components/sections/knowledge/library-pages-actions.test.ts`
- `apps/web-console/components/sections/knowledge/library-pages-model.test.ts`

### lab-registered-machines

Lab Settings → Tools → Registered Machines panel

- `apps/web-console/components/sections/settings/machines/registered-machines-actions.test.ts`
- `apps/web-console/components/sections/settings/machines/registered-machines-model.test.ts`

### lab-startup-timing

Lab 会话显示启动耗时

- `apps/web-console/lib/turn-feed-stats.test.ts`

### lcu-app-grant

桌面操作应用授权：全自动免审批，批准一次后同会话记住

- `packages/core/test/lcu-computer-use.test.js`

### lcu-computer-use

本机 LCU 桌面操作接入

- `e2e/lcu-computer-use.spec.ts`
- `packages/agent-loop/src/runtime/tool-loop.test.ts`
- `packages/core/test/lcu-computer-use.test.js`

### live-bot-quality

真实 Bot 任务评估与版本准入

- `scripts/test/live-bot-quality.test.mjs`

### local-source-unlock

本机只读命令在批准后能真正执行（来源范围审批匹配、审批卡、已保存 direct 不再 Auto-review）

- `packages/agent-loop/src/approval/auto-review.test.ts`
- `packages/core/test/local-source-unlock.test.js`

### login-mandatory-skill

捆绑 login 强制技能可加载并解锁登录面

- `packages/core/test/login-mandatory-skill.test.js`

### long-session-compact

长会话能真正做摘要而不是只丢历史

- `packages/core/test/long-session-compact.test.ts`

### loop-native-media

SDK 原生多模态文件理解

- `packages/agent-loop/src/assembly/native-media.test.ts`
- `packages/agent-loop/src/model/native-media.test.ts`
- `packages/core/test/context-stack.test.js`

### loop-prefix-cache

稳定前缀和技能目录不在每轮重做

- `packages/agent-loop/src/turn/prepare-input-cache.test.ts`
- `packages/core/test/loop-prefix-cache.test.ts`

### mac-retina-text-readability

Mac Retina 屏幕文字可读性优化

- `e2e/mac-retina-text-readability.spec.ts`

### macos-app-control

macOS 应用控制（外层宿主）

- `e2e/macos-app-control.spec.ts`
- `packages/core/test/app-control.test.js`

### mandatory-skill-gate

高危面必须先加载对应技能

- `packages/core/test/mandatory-skill-gate.test.js`

### memory-deletion-suppression

删除记忆后阻止自动写回

- `e2e/first-batch-reliability.spec.ts`
- `packages/core/test/memory-deletion-suppression.test.js`

### micro-compact-stub-wording

微压缩占位只说明工具输出被省略

- `packages/agent-loop/src/session/tool-result-stub.test.ts`

### mobile-chat-density

窄屏对话区优先展示聊天记录

- `apps/web-console/components/mobile-chat-density.test.ts`
- `e2e/mobile-chat-density.spec.ts`

### mobile-console

控制台移动端布局

- `e2e/mobile-console.spec.ts`

### model-fallback

备用模型自动切换

- `e2e/model-fallback.spec.ts`
- `packages/core/test/model-fallback.test.js`

### model-retry-progress

临时模型故障延长退避并展示重试进度

- `e2e/model-retry-progress.spec.ts`
- `packages/agent-loop/src/runtime/model-retry-progress.test.ts`
- `packages/agent-loop/src/runtime/turn-retries.test.ts`
- `packages/agent-loop/src/turn/kernel.test.ts`
- `packages/core/test/model-fallback.test.js`

### model-sandbox-isolation

命令隔离由对话里的 Agent 自己选

- `apps/web-console/lib/sandbox-settings-copy.test.ts`
- `packages/core/test/model-sandbox-isolation.test.js`

### multi-machine-controlled-delivery

多机软件工厂第三阶段：受控远端交付至 MERGED

- `e2e/factory-delivery.spec.ts`
- `packages/core/test/factory-delivery-process.test.js`
- `packages/core/test/factory-delivery-publisher-regressions.test.js`
- `packages/core/test/factory-delivery-transport.test.js`
- `packages/core/test/factory-delivery-vertical-regressions.test.js`
- `packages/core/test/factory-delivery-worker.test.js`
- `packages/core/test/factory-delivery.test.js`
- `packages/core/test/factory-development-delivery-sync.test.js`
- `scripts/test/factory-delivery-routes.test.mjs`

### multi-machine-controlled-development

多机软件工厂第二阶段：受控开发至 READY

- `e2e/factory-development.spec.ts`
- `e2e/factory-http-integration.spec.ts`
- `packages/core/test/factory-development.test.js`

### multi-machine-local-foundation

多机软件工厂第四阶段本地软件交付

- `e2e/factory-production-http.spec.ts`
- `scripts/test/factory-production-routes.test.mjs`
- `scripts/test/production-evidence-files.test.mjs`
- `scripts/test/production-real-store-backup.test.mjs`
- `scripts/test/production-security-regressions.test.mjs`
- `scripts/test/production-state-backup.test.mjs`
- `scripts/test/production-state-fence.test.mjs`

### multi-machine-readonly-pilot

多机软件工厂第一阶段：只读试运行

- `e2e/factory-http-integration.spec.ts`
- `e2e/factory-readonly.spec.ts`
- `packages/core/test/factory-readonly.test.js`
- `packages/core/test/factory-trust-review.test.js`
- `packages/core/test/factory-worker.test.js`
- `scripts/test/factory-routes.test.mjs`

### multi-page-live-session

多个网页同时看到流式结果和页面状态

- `apps/web-console/lib/run-leave.test.ts`
- `packages/core/test/multi-page-live-session.test.js`

### necessary-tool-injection

只把当前任务需要的工具定义交给模型

- `packages/core/test/deferred-tool-load.test.js`
- `packages/core/test/necessary-tool-injection.test.js`

### no-windows-desktop-pack

不再打 Windows 桌面安装包

- `scripts/desktop/test/targets.test.mjs`

### normal-session-request-budget

普通会话请求不超过窗口的 20%

- `packages/core/test/normal-request-budget.test.js`

### npm-auto-publish

公开 npm 包自动发布

- `scripts/test/npm-publish-workflow.test.mjs`

### ops-console

运维页：系统健康总览与轨迹浏览

- `apps/web-console/lib/effective-config.test.ts`
- `apps/web-console/lib/evolution-results.test.ts`
- `apps/web-console/lib/nav.test.ts`
- `apps/web-console/lib/ops-health.test.ts`
- `apps/web-console/lib/trace-groups.test.ts`
- `e2e/agent-home-features.spec.ts`
- `e2e/ops.spec.ts`
- `packages/core/test/evolution-surface.test.js`
- `scripts/test/evolution-surface-guard.test.mjs`

### ops-session-trace-repair

运维会话轨迹能定位没看过的对话

- `apps/web-console/components/ops-session-trace.test.ts`
- `apps/web-console/lib/trace-groups.test.ts`
- `apps/web-console/lib/trace-page.test.ts`
- `packages/agent-loop/src/runtime/tool-loop.test.ts`
- `packages/core/test/bot-goal-routing-runtime.test.js`
- `packages/core/test/session-trace-repair.test.js`

### outbound-draft-edit-identity

外发草稿可编辑预览，并显示将以哪个身份发送（Draft → Confirm → Send 之上）

- `apps/web-console/components/sections/tasks/OutboundDraftCard.render.test.ts`
- `apps/web-console/lib/outbound-draft-preview.test.ts`
- `packages/capability-gateway/test/outbound-draft-edit-identity.test.js`
- `scripts/test/outbound-draft-human-release.test.mjs`

### outbound-send-mandatory-skill

捆绑 outbound-send 强制技能可加载并解锁外发面

- `packages/core/test/outbound-send-mandatory-skill.test.js`

### outbound-style-sample-hint

外发前建议先采样同渠道近期消息，只提示语气，不改已编正文

- `apps/web-console/components/sections/tasks/OutboundDraftCard.render.test.ts`
- `apps/web-console/lib/outbound-draft-preview.test.ts`

### outer-skin-picker

外层外观设置可选中

- `apps/web-console/components/classic-skin-menu.test.ts`
- `apps/web-console/components/shell/Rail.foot-menu.test.ts`
- `apps/web-console/lib/skin.test.ts`

### page-revisions

Page revision history (list / get / restore)

- `apps/web-console/components/sections/knowledge/library-pages-actions.test.ts`
- `packages/core/test/page-revisions.test.js`
- `packages/core/test/page-tools.test.js`

### page-share-html

Public library page share HTML (read-only)

- `apps/daemon/test/durable-page-port.test.ts`
- `packages/core/test/page-share-html.test.js`

### page-tools

助手可调用的库级页面工具

- `packages/core/test/page-tools.test.js`

### payment-mandatory-skill

捆绑 payment 强制技能可加载并解锁支付面

- `packages/core/test/payment-mandatory-skill.test.js`

### play-context-replay

Play 上下文回放

- `apps/web-console/lib/context-stack-replay.test.ts`
- `packages/core/test/context-snapshots.test.js`

### play-context-stack

Play 右侧栏模型上下文

- `apps/web-console/lib/context-stack-bar.test.ts`
- `packages/core/test/context-stack.test.js`

### play-feed-window

对话记录按页加载并窗口渲染

- `apps/web-console/lib/feed-window.test.ts`
- `packages/core/test/visible-message-page.test.js`

### play-group-delete-menu

群聊行的删除收进悬停图标菜单

- `apps/web-console/components/play-group/PlayBotGroupList.test.ts`
- `e2e/bot-room-deletion.spec.ts`

### play-rail-default-closed

对话页右侧栏默认关闭

- `apps/web-console/lib/play-rail-open.test.ts`

### play-sidebar-collapse

对话页会话列表可收起

- `apps/web-console/lib/play-sidebar-collapsed.test.ts`

### pm2-service

用 PM2 启动并管理服务

- `scripts/test/pm2-service.test.mjs`

### pnpm-migration

全仓库迁移至 pnpm 并完成回归

- `scripts/test/dev-lab-port-retry.test.mjs`
- `scripts/test/pnpm-dev-start.test.mjs`
- `scripts/test/pnpm-migration.test.mjs`

### pr152-approval-followups

Consistent approval decisions and cancelled parked work

- `packages/agent-loop/src/runtime/tool-loop.test.ts`
- `packages/core/test/bot-work.test.js`

### prd-test-trace

产品需求与测试对照

- `scripts/prd/prd-trace.test.mjs`

### product-prd

产品需求目录

- `scripts/prd/prd-catalog.test.mjs`

### quiet-goal-results

目标结果不再默认要求人工核对

- `apps/web-console/components/GoalHistory.results.test.ts`
- `apps/web-console/components/bot-work/BotGoals.panel.test.ts`
- `packages/core/test/bot-goal-live-chain.test.js`
- `packages/core/test/quiet-goal-notice.test.js`

### r5-19-agent-native-email

Agent native email inbox (product-domain)

- `packages/core/test/agent-inbox-port.test.js`

### r5-21-check-email-inbox-availability

Independent check_email_inbox_availability tool

- `packages/core/test/agent-inbox-port.test.js`

### r5-22-outbound-from-claimed

Outbound email from=claimed when ChannelSpec.from empty

- `packages/capability-gateway/test/outbound-email-from-claimed.test.js`
- `packages/core/test/agent-inbox-port.test.js`

### r5-23-daemon-claimed-from

Daemon delivery port wires claimedFrom from AgentInboxPort

- `apps/daemon/test/delivery-claimed-from.test.ts`

### r5-24-outbound-email-reply

Outbound email reply threading (inReplyTo / Re subject)

- `packages/capability-gateway/test/outbound-email-reply.test.js`

### r5-25-reply-draft-ingress

Reply draft ingress + Lab thread preview

- `apps/web-console/components/sections/tasks/OutboundDraftCard.render.test.ts`
- `packages/capability-gateway/test/reply-draft-ingress.test.js`
- `packages/core/test/channel-webhook-inbound-thread.test.js`

### r5-26-inbound-refs

Inbound References/In-Reply-To persist + auto-draft References chain

- `packages/capability-gateway/test/inbound-refs-draft.test.js`
- `packages/core/test/agent-inbox-inbound-refs.test.js`
- `packages/core/test/channel-webhook-inbound-refs.test.js`

### rail-foot-menu

侧栏底部收成悬停菜单

- `apps/web-console/components/shell/Rail.foot-menu.test.ts`

### rail-foot-theme

侧栏底部主题按钮能切换

- `apps/web-console/lib/skin.test.ts`

### rail-settings-icon

侧栏设置入口使用设置图标

- `apps/web-console/components/shell/Rail.settings-icon.test.ts`

### recap-content-only

回顾有内容才展示

- `apps/web-console/components/session-recap-bar.test.ts`

### recap-next-action

回顾之后推荐下一步行动

- `apps/daemon/test/composer-hint.test.ts`
- `apps/daemon/test/session-recap-text.test.ts`
- `apps/web-console/lib/composer-next-hint.test.ts`

### recap-request-lifecycle

主动回顾正常生成与取消

- `apps/daemon/test/session-recap-yield.test.ts`

### refresh-keeps-agent-run

刷新页面不终止正在进行的对话

- `apps/web-console/lib/run-leave.test.ts`
- `e2e/bot-switch-live-turn.spec.ts`
- `scripts/test/sse-disconnect.test.mjs`

### registered-machine-desktop-agent

Desktop agent long-connect for personal registered machines (non-SSH)

- `apps/daemon/test/desktop-agent-http.test.ts`
- `packages/core/test/registered-machines-agent-backend.test.js`
- `packages/core/test/registered-machines-daemon-http-sse-adapter.test.js`

### registered-machine-live-backend

Live SSH backend for personal registered machines (not Factory SSH)

- `packages/core/test/registered-machines-ssh-backend.test.js`

### registered-machine-phone-local

Phone registered machines via device-local tools (non-SSH, read-only default)

- `apps/daemon/test/device-local-http.test.ts`
- `packages/core/test/registered-machines-phone-local.test.js`

### remotevm-no-host-downgrade

microVM 命令不会悄悄改在宿主机上跑

- `packages/core/test/remote-vm-microvm-exec.test.js`

### remove-needs-confirm

列表里的移除需要再确认一次

- `apps/web-console/lib/armed-delete.test.ts`

### request-metric-follows-turn

已发送请求指标随所选轮变化

- `apps/web-console/lib/request-metric-turn.test.ts`
- `e2e/request-metric-follows-turn.spec.ts`

### risk-advisory-ui

对话里的运行策略提醒

- `apps/web-console/lib/risk-advisory.test.ts`
- `e2e/risk-advisory.spec.ts`

### rotate-page-share

Rotate library page share links without deleting content

- `apps/daemon/test/durable-page-port.test.ts`
- `packages/core/test/durable-page-port.test.js`
- `packages/core/test/page-tools.test.js`

### routine-failure-governance

例行任务连续故障治理

- `e2e/first-batch-reliability.spec.ts`
- `packages/core/test/routine-failure-governance.test.js`
- `packages/core/test/routine-lease.test.js`
- `packages/core/test/routine-room-delivery.test.js`

### routine-owner-permission

定时任务沿用 Bot 免审批

- `packages/core/test/routine-owner-permission.test.js`

### routine-precheck-fail-closed

例行预检失败不唤醒模型

- `packages/core/test/routine-precheck.test.js`

### routine-quiet-chat

无结论的定时回执不进主对话

- `apps/web-console/components/routine-quiet-chat.test.ts`
- `packages/core/test/routine-lifecycle.test.js`

### routine-strict-precheck

严格例行预检与持久游标

- `e2e/first-batch-reliability.spec.ts`
- `packages/core/test/routine-failure-governance.test.js`
- `packages/core/test/routine-precheck.test.js`
- `packages/core/test/routine-strict-precheck.test.js`

### routine-weekday-daytime-default

新建例行任务默认工作日白天

- `apps/web-console/lib/routine-weekday-daytime.test.ts`
- `packages/core/test/routine-weekday-daytime.test.js`
- `scripts/test/routine-weekday-daytime.test.mjs`

### runtime-gap-closures

事件密钥、内置工具名、发布脚本环境、只读 MCP、HTTP 来源与幂等并发

- `packages/core/test/runtime-gap-closures.test.js`
- `scripts/test/bot-release-spawn-env.test.mjs`

### sanctum-skin

圣所外观可切换且不覆盖原主题

- `apps/web-console/components/ThemeSettingsCard.skin.test.ts`
- `apps/web-console/lib/skin.test.ts`

### saved-sandbox-mode-constrains-shell

已保存的隔离方式约束 shell

- `apps/web-console/components/os-sandbox-reason.test.ts`
- `apps/web-console/lib/os-sandbox-reason.test.ts`
- `apps/web-console/lib/sandbox-settings-copy.test.ts`
- `packages/core/test/model-sandbox-isolation.test.js`
- `packages/core/test/saved-sandbox-mode.test.js`

### scheduler-db-lock

调度写目标时不再因数据库锁失败

- `packages/core/test/scheduler-db-lock.test.ts`

### schema-upgrade-safety

数据库升级不丢数据

- `packages/core/test/bot-memory-namespace.test.js`
- `packages/core/test/schema-migrations.test.js`
- `scripts/test/bot-migration-rollback.test.mjs`
- `scripts/test/bot-pinned-checkout.test.mjs`
- `scripts/test/schema-migration-snapshots.test.mjs`
- `scripts/test/schema-snapshot-freshness.test.mjs`

### secure-form

对话里的单字段安全表单

- `apps/daemon/test/user-vault-http.test.ts`
- `apps/web-console/lib/secure-form-card.test.ts`
- `packages/core/test/secure-form.test.js`

### secure-form-multi

对话里的多字段安全表单

- `apps/daemon/test/user-vault-http.test.ts`
- `apps/web-console/lib/secure-form-card.test.ts`
- `packages/core/test/secure-form-multi.test.js`

### secure-form-vault

Secure Form fill-from-Vault

- `apps/daemon/test/user-vault-http.test.ts`
- `apps/web-console/lib/secure-form-card.test.ts`
- `packages/core/test/secure-form-vault.test.js`

### session-brief

会话可以只看关键信息

- `apps/web-console/components/SessionBriefDisclosure.test.ts`
- `apps/web-console/lib/session-brief.test.ts`

### session-eval-baseline

会话评估能留下基准并发现短板

- `scripts/test/session-eval-baseline.test.mjs`

### session-eval-lift

会话评估能区分能力提升和下降

- `scripts/test/harness-quality.test.mjs`
- `scripts/test/session-eval-lift.test.mjs`
- `scripts/test/session-eval-suites.test.mjs`

### session-lifecycle-state-consistency

生命周期验证发现的结束原因与部分审批状态一致性修复

- `packages/core/test/approval-admission-race.test.js`
- `packages/core/test/session-lifecycle-state-consistency.test.js`

### session-lifecycle-verification

会话生命周期验证：取消、重试与审批恢复

- `scripts/test/session-lifecycle-verification.test.mjs`

### session-multiprocess-concurrency-verification

多进程并发验证：写入占用、迟到结果与审批恢复

- `scripts/test/session-multiprocess-concurrency-verification.test.mjs`

### session-multiprocess-state-consistency

多进程会话状态一致性修复

- `packages/agent-loop/src/turn/kernel.test.ts`
- `packages/core/test/approval-admission-race.test.js`
- `packages/core/test/multiprocess-stream-fence.test.js`
- `packages/core/test/superbot-factory-setup.test.js`
- `packages/core/test/writer-claim.test.js`
- `scripts/test/session-multiprocess-state-consistency.test.mjs`

### session-restart-recovery-state-consistency

重启恢复发现的运行状态、审批衔接与未确认工具结果修复

- `scripts/test/session-restart-recovery-fix.test.mjs`

### session-restart-recovery-verification

进程重启恢复验证：运行中、重试等待与等待审批

- `scripts/test/session-restart-recovery-verification.test.mjs`

### settings-categories

设置页「行为 / 安全 / 工具 / 集成」分类易用化

- `apps/web-console/lib/i18n/settings-entries.test.ts`
- `apps/web-console/lib/settings-fields.test.ts`
- `e2e/settings-categories.spec.ts`

### settings-models-onboarding

设置：模型向导、首次引导、搜索与保存状态

- `apps/web-console/lib/gateway-settings.test.ts`
- `apps/web-console/lib/model-providers.test.ts`
- `apps/web-console/lib/settings-search.test.ts`
- `e2e/settings-models.spec.ts`

### shared-info-compact

共享信息紧凑入口

- `apps/web-console/components/SharedFactsPanel.test.ts`
- `e2e/bot-interaction-polish.spec.ts`

### shell-output-untrusted-fence

命令输出作为不可信内容围栏后再给模型

- `packages/core/test/bash-execution-result.test.js`
- `packages/core/test/external-content.test.js`

### shopping-mandatory-skill

捆绑 shopping 强制技能可加载并解锁购物面

- `packages/core/test/shopping-mandatory-skill.test.js`

### single-host-bot-completion

单机 Bot 工作收尾与默认入口

- `apps/web-console/lib/nav.test.ts`
- `e2e/bot-first-task-new-user.spec.ts`
- `e2e/bot-interaction-polish.spec.ts`
- `e2e/lab.smoke.spec.ts`
- `packages/core/test/bot-linked-watchers.test.js`
- `packages/core/test/routine-result-isolation.test.js`
- `scripts/test/dev-lab-process-cleanup.test.mjs`

### skill-capture-dismissal

技能沉淀完成提示可收起和关闭

- `e2e/skill-capture-dismissal.spec.ts`

### skill-capture-intent-confirmation

模型判断技能沉淀并在提炼前请求确认

- `e2e/skill-capture.spec.ts`
- `packages/core/test/skill-capture-http.test.js`
- `packages/core/test/skill-capture.test.js`

### skill-capture-save

技能沉淀确认后能把正文存下来

- `packages/core/test/skill-capture.test.js`

### skill-manifest-boundary

技能能力边界

- `packages/core/test/skill-manifest-gate.test.js`
- `packages/core/test/skill-manifest.test.js`

### skill-operation-card-dismissal

技能管理结果可收起关闭且不干扰对话

- `e2e/skill-operation-dismissal.spec.ts`

### skill-operation-confirm-bar

技能操作确认后收成可关闭的小横条

- `apps/web-console/components/skill-operation-card-model.test.ts`
- `e2e/skill-operation-confirm-bar.spec.ts`

### skill-pending-retry

技能待确认请求重新授权

- `packages/core/test/agent-skill-management.test.js`

### skill-proposals

技能提案审批

- `e2e/skill-proposals.spec.ts`
- `packages/core/test/skill-proposals.test.js`

### skin-mode-adapt

非经典外观适配深浅色

- `apps/web-console/lib/skin.test.ts`

### slack-events-inbound

Slack Events 入站按线程唤醒例行任务

- `packages/capability-gateway/test/slack-events-inbound.test.js`

### software-egress-reserved-tools

软件出站地址与内置工具名

- `packages/core/test/software-egress-reserved-tools.test.js`

### startup-invariants-compact

启动时校验压缩策略、稳定前缀与重复守卫

- `packages/core/test/startup-invariants.test.js`

### steer-timeline-order

实时插话前后的回复保持时间线位置

- `apps/web-console/lib/steer-timeline-order.test.ts`

### steer-tool-continuity

插话即时入会话与按工具取消

- `packages/agent-loop/src/runtime/tool-loop.test.ts`
- `packages/agent-loop/src/turn/kernel.test.ts`
- `packages/core/test/steer-tool-continuity.test.js`
- `packages/core/test/tool-wave-close.test.js`

### stream-live-status

生成中的速度与正在做什么

- `apps/web-console/components/StreamLiveStatus.test.ts`
- `apps/web-console/lib/stream-live-status.test.ts`

### stream-text-once

流式输出时助手文字只出现一次

- `apps/web-console/lib/live-stream-once.test.ts`

### subagent-delegation

委派子任务的上下文隔离、权限收敛与重启未知态

- `packages/core/test/subagent-delegation-policy.test.js`

### system-context-cards

会话摘要与 Jev 提示卡片

- `apps/web-console/lib/system-context-notice.test.ts`
- `e2e/system-context-cards.spec.ts`

### system-message-ui

统一聊天系统消息展示

- `apps/web-console/components/goal-update-presentation.test.ts`
- `apps/web-console/lib/system-message-kind.test.ts`
- `e2e/system-message-ui.spec.ts`

### thinking-effort

思考力度

- `apps/daemon/test/thinking-effort-http.test.ts`
- `apps/web-console/components/thinking-effort-settings.test.ts`
- `packages/agent-loop/src/model/reasoning-effort.test.ts`
- `packages/core/test/thinking-effort-settings.test.js`
- `packages/core/test/thinking-effort-turn.test.js`

### tool-call-pairing-batch-dedup

同批重复工具结果去重（验证试点发现 F-1）

- `packages/agent-loop/src/runtime/tool-loop.test.ts`

### tool-call-pairing-verification

工具调用与结果配对验证试点

- `scripts/test/tool-call-pairing-verification.test.mjs`

### tool-exposure-tiers

工具三层分类与独立的渐进和全量提供方式

- `e2e/tool-exposure.spec.ts`
- `packages/core/test/jev-points.test.js`
- `packages/core/test/tool-exposure-tiers.test.js`

### tool-loop-same-call

工具循环按同一次调用判断

- `packages/agent-loop/src/recovery/repeat-guard.test.ts`
- `packages/agent-loop/src/recovery/session-loop-guard.test.ts`
- `packages/agent-loop/src/turn/repeat-guard-kernel.test.ts`
- `packages/core/test/session-loop-guard.test.js`

### tool-observation-thumbnails

工具观察截图缩略图

- `apps/web-console/lib/chat-images.test.ts`

### tool-progress-guard

重复工具调用按实际进展判断

- `packages/agent-loop/src/recovery/session-loop-guard.test.ts`
- `packages/agent-loop/src/turn/repeat-guard-kernel.test.ts`
- `packages/core/test/session-loop-guard.test.js`

### unified-bot-goal-lifecycle

统一 Bot 目标生命周期与归档展示

- `apps/daemon/test/unified-goal-lifecycle.test.ts`
- `apps/web-console/lib/bot-goals.test.ts`
- `e2e/bot-goals-panel-threshold.spec.ts`
- `packages/core/test/bot-goal-projection.test.js`
- `packages/core/test/bot-goal-runtime.test.js`
- `packages/core/test/bot-goals.test.js`

### unlimited-bot-rounds

Bot 对话轮和执行轮默认不限

- `packages/core/test/bot-rooms.test.js`
- `packages/core/test/unlimited-bot-rounds.test.ts`

### unlimited-execution-steps

默认不限单次执行步数

- `apps/web-console/lib/unlimited-execution-steps.test.ts`
- `e2e/bot-policy.spec.ts`
- `packages/core/test/bot-policy.test.js`
- `packages/core/test/bot-room-wave-dispatch.test.js`
- `packages/core/test/routine-lifecycle.test.js`
- `packages/core/test/runtime.test.js`

### untrusted-cwd-default-deny

不可信内容不能带出工作目录或执行动态代码

- `packages/core/test/default-deny-policy.test.js`
- `packages/core/test/default-deny-shell.test.js`

### upstream-resilience

上游模型异常时的稳健性

- `apps/web-console/lib/stream-segments.test.ts`
- `packages/agent-loop/src/model/upstream-replay.test.ts`
- `packages/agent-loop/src/runtime/turn-retries.test.ts`

### user-message-actions

自己发送的消息支持复制和重试

- `apps/web-console/lib/user-message-actions.test.ts`
- `e2e/user-message-actions.spec.ts`

### user-preference-sync

用户长期偏好入库与迁移

- `apps/daemon/test/user-preferences-http.test.ts`
- `apps/web-console/lib/user-preferences.test.ts`

### user-vault-ref-fill

User Vault reference fill (distinct from secret-vault)

- `packages/core/test/user-vault.test.js`

### user-vault-tools

User Vault assistant tools and Lab reference-fill

- `apps/daemon/test/user-vault-http.test.ts`
- `apps/web-console/lib/user-vault.test.ts`
- `packages/core/test/vault-tools.test.js`
