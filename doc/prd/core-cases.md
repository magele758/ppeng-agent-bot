<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格、现状章节的依据或核心用例后重新运行该脚本。 -->

# 核心用例

领域包和交互卡片没有单独的验收规格，所以不进核心用例。演进不是日常入口由运维页规格证明。

这些是人能走完的路径。每条只点名已经实现、并且已有测试的功能。只跑这些测试：

```bash
node scripts/prd/core-cases.mjs --list
node scripts/prd/core-cases.mjs
```

## 打开产品落在默认 Bot，旧的普通会话还在

`default-entry`

对应现状：[产品是什么](current/01-product.md)、[Bot、名册与工作台](current/02-bots-and-workspace.md)

- `single-host-bot-completion` 单机 Bot 工作收尾与默认入口
- `bots` Bot 名册、互发消息与权限
- `bot-entry-simplification` Bot 创建入口统一与管理页面职责拆分

## 一只 Bot 一条主对话，压缩和换模型都不另开

`forever-chat`

对应现状：[主对话](current/03-conversation.md)

- `bot-forever-chat` Bot 永久主会话命令
- `bot-dual-compact` 规范 Bot 会话的双阈值压缩
- `bot-window-compact` 规范 Bot 按真实模型窗口的一半和 85% 压缩

## 发出的话马上出现、忙时还能插话、下一句建议要按 Tab 才采纳

`speak-while-busy`

对应现状：[主对话](current/03-conversation.md)

- `bot-immediate-steer` Bot 回合中直接插入并转向
- `bot-input-suggestion` Bot 输入框下一句建议
- `session-recap` 会话末尾回顾

## 目标没达到不能显示完成，子任务结果回到原来的目标

`goal-done-means-done`

对应现状：[目标、协作与外部软件](current/04-goals-and-collaboration.md)

- `unified-bot-goal-lifecycle` 统一 Bot 目标生命周期与归档展示
- `bot-goal-result-return` 子执行结果回到原目标并收口
- `bot-multi-goal-coordination` Bot 多目标持续执行与自动选择执行方式

## 群里只有被点到的才发言

`room-speaks-when-picked`

对应现状：[目标、协作与外部软件](current/04-goals-and-collaboration.md)

- `bot-room-speaker-pick` 群聊按贴题程度决定谁开口
- `bot-rooms` 多 Bot 群会话与可靠发言

## 待批准停在对话里等人决定，超时未批不执行

`approval-and-failure`

对应现状：[安全、模型与运行方式](current/06-safety-and-runtime.md)

- `chat-approval-inline` 待审批嵌在对话流里
- `bot-goal-nested-approval` 目标子任务的待批准出现在主对话
- `unattended-approval-expiry` 无人值守审批超时拒绝

## 技能和定时任务的结果留在这只 Bot 上

`skills-and-routines`

对应现状：[记忆、技能与定时任务](current/05-memory-skills-routines.md)

- `bot-scoped-skill-sharing` Bot 私有技能沉淀与指定 Bot 共享
- `bot-routine-main-session` Bot 定时任务跟自己的会话走
- `agent-skill-management` Agent 在对话中管理自身技能

## 运维页能看服务和自愈，没有演进入口；工具默认按层提供，不是一次全给

`ops-without-evolution`

对应现状：[自愈、演进与平台能力](current/07-evolution-and-platform.md)

- `ops-console` 运维页：系统健康总览与轨迹浏览
- `tool-exposure-tiers` 工具三层分类与独立的渐进和全量提供方式
