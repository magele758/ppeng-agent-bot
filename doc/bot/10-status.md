# 10 状态与维护

这里登记 Bot 模式相关规格现在处于哪一档，以及改产品时要改哪一章。状态词和 `acceptance/*.yaml` 里的 `status` 一致。

| 状态 | 意思 |
|------|------|
| implemented | 已经按标准做完。01–09 里用现在时描写 |
| approved | 标准已定，还没标成做完。只出现在各章的「还没收口」，以及下面这张表 |
| draft | 还没定。不是当前产品。不要写进「现在会怎样」 |
| retired | 需求取消。从现在时描述里删掉，表里留一行原因 |

数字以文件为准。改状态时改这张表，不要只改某一章。

## 已实现

| 规格 | 写在 |
|------|------|
| `turn-stats-end-time` | 03。轮次结束时间，替代旧文档中不存在的发送时间草稿引用 |
| `bot-activity-open-session` | 00、03 |
| `bot-child-task-chip-fill` | 03。子任务入口布局 |
| `bot-composer-next-hint` | 00、04 |
| `bot-input-suggestion-cache` | 00、04 |
| `bot-human-continuation` | 00、04 |
| `bot-sidebar-child-sessions` | 00、03 |
| `bot-room-speaker-pick` | 00、07。替代旧版未点名依赖群主及小群必须回复的描述 |
| `superbot-factory-setup` | 00、08 |
| `room-task-collaboration` | 00、07。临时负责人协作切片，完整群子任务规格仍待收口 |
| `unified-bot-goal-lifecycle` | 05。统一目标核验与终态历史 |
| `bots` | 01、02、06、08、09 |
| `bot-autonomous-execution-coverage` | 01、05 |
| `bot-chat-header` | 02 |
| `bot-chat-image-compatibility` | 04 |
| `bot-child-task-chat-entry` | 03 |
| `bot-child-task-stream-entry` | 03 |
| `bot-input-suggestion` | 04 |
| `session-recap` | 04。离开再回来时的一行回顾，也可当场回顾 |
| `bot-concurrent-subagents` | 05 |
| `bot-console-selection` | 03 |
| `bot-create-named-tools` | 02、07 |
| `bot-detail-child-tasks-tab` | 03 |
| `bot-detail-menu` | 03 |
| `bot-detail-skill-management` | 03、06 |
| `bot-dual-compact` | 04 |
| `bot-entry-dialog-shell` | 02 |
| `bot-entry-simplification` | 01、03 |
| `bot-face-first-creation` | 02 |
| `bot-face-readable-shapes` | 02 |
| `bot-first-task-dismissal` | 03 |
| `bot-first-task-new-user` | 03 |
| `bot-forever-chat` | 04 |
| `bot-fork-retrievable-inheritance` | 05 |
| `bot-fork-sessions-in-detail` | 03 |
| `bot-functional-groups` | 03、06 |
| `bot-gateway-delivery` | 06 |
| `bot-goals-panel-rules` | 03、05 |
| `bot-goals-panel-threshold` | 03 |
| `bot-group-drag-only` | 03 |
| `bot-immediate-steer` | 04 |
| `bot-list-idle-motion` | 02 |
| `bot-mock-interview` | 02。内置模拟面试官按指定信息出题、评分并给改进建议 |
| `bot-goal-nested-approval` | 05 |
| `bot-multi-goal-coordination` | 05 |
| `bot-panel-reset` | 03 |
| `bot-pin-area` | 03 |
| `bot-product-admin` | 08 |
| `bot-product-p0` | 05、08、09 |
| `bot-product-p1` | 05、08 |
| `bot-product-p2` | 05、06、08 |
| `bot-reply-quote` | 04 |
| `bot-robot-faces` | 02 |
| `bot-room-recall` | 07 |
| `bot-room-sparse-routing` | 07 |
| `bot-room-speaker-identity` | 07 |
| `bot-room-touched-memory` | 07 |
| `bot-room-wave-dispatch` | 07 |
| `bot-rooms` | 07 |
| `bot-routine-main-session` | 06 |
| `bot-scoped-skill-sharing` | 06 |
| `bot-session-row` | 02 |
| `bot-skill-panel-layout` | 06 |
| `bot-switch-live-turn` | 03 |
| `bot-task-permission-inheritance` | 05、09 |
| `bot-window-compact` | 04 |
| `bot-working-animation` | 02、04 |
| `bot-workspace-interaction-polish` | 03、04、06 |
| `play-bot-group` | 07 |
| `goal-update-presentation` | 03 |
| `low-interference-onboarding-goals` | 03 |
| `unowned-legacy-bot` | 02 |
| `loop-guard-model-switch` | 09。全局对话设置，Bot 和普通对话同一条规则 |
| `bot-goal-result-return` | 05。子会话、委派、团队、Swarm、工厂和演进的结果回到原目标并收口 |

## 已批准，还没标成已实现

| 规格 | 意图 | 先不要写成 |
|------|------|------------|
| `bot-activity-rail` | 活动栏只显示这个主人的在途工作 | 已经按用户隔离验收通过 |
| `bot-history-memory` | 长期对话的历史和记忆足够继续用 | 压缩和召回已经按这份标准收口 |
| `bot-identity-continuity` | 重启和压缩之后仍是同一只 Bot | 身份连续性已经验收 |
| `bot-list-face-plate` | 侧栏的脸保持原形，不套外框、不拉变形 | 列表脸的底板已经按这份改完 |
| `bot-release-readiness` | 完整工作流可以按发布标准验收 | 已经达到发布验收 |
| `bot-reliable-messaging` | 消息接收和身份在失败后仍可靠 | 可靠消息已经单独收口 |
| `bot-room-console` | 人多的群，对话区仍然看得清 | 百人群界面已经交付 |
| `bot-room-goal-intake` | 群有自己的目标，中途插话能归到那件目标 | 群目标已经能用 |
| `bot-room-inline-approval` | 人可以在群里原地批准，只挂起那个成员 | 默认已经是群内批准 |
| `bot-room-tasks` | 群子任务和成员接力 | 完整群子任务生命周期已经验收；临时负责人协作切片另见 `room-task-collaboration` |
| `bot-routine-lifecycle` | 例行任务的错过、补跑、未知结果和租约有完整产品语义 | 生命周期已经全部验收 |
| `bot-software-execution` | 软件调用以真实回执为准 | 软件执行验收已经通过 |
| `bot-steer-visible` | 插话马上出现在对话流里 | 实时出现已经验收 |
| `default-super-bot` | 默认 Super Bot 查看、派工、汇总 | 派工汇总已经是默认体验 |

## 草稿

不实现、不在 01–09 的现在时里描述。

| 规格 | 想做的事 |
|------|----------|
| `bot-composer-chrome-slim` | Bot 输入区左侧只留头像，其余配置拿掉 |
| `bot-detail-routine-switch` | 定时任务用拨动开关，时间显示本地钟点；持续盯着的事走定时任务 |
| `bot-group-members-off-canvas` | 群成员管理离开主聊天区 |
| `bot-user-bubble-color` | 用户气泡用这只 Bot 的主题色，不跟系统深浅走 |

## 统一入口的文档方向与界面差异

2026-10-23 用户明确整个产品以 Bot 模式作为统一入口，已据此更新 00、01 和目录。当前 `lib/nav.ts`、`shell/Rail.tsx` 仍保留 Bot / Chat 等并列导航，默认位置仍为 Chat。本次仅整理文档，没有变更验收标准或运行行为，也不把导航收敛标成已实现。

## 代码从哪读

产品行为变了再来对这张表。路径是入口，不是调用清单。

| 区域 | 入口 |
|------|------|
| 名册、外观、命令、权限、互发 | `packages/core/src/bots/` |
| 目标、派发、子任务隔离 | `packages/core/src/bots/goals/`、`concurrent-fork.ts`、`fork-inheritance.ts` |
| 群 | `packages/core/src/rooms/` |
| 定时任务 | `packages/core/src` 里的 cron / routine，以及 `doc/BOT_ROUTINES.md` |
| 下一句建议 | `packages/core/src/session/input-suggestion.ts`。产品规则以 `bot-input-suggestion` 为准 |
| 会话回顾 | `apps/web-console/lib/session-recap.ts`。产品规则以 `session-recap` 为准 |
| Lab 界面 | `apps/web-console/components/` 里的 `PlayPanel`、`BotDetailMenu`、`bot-work/`、`SessionListRow` |
| HTTP | `apps/daemon/src/routes/` 下的 bots、rooms、cron、goals |

## 以后怎么更新这篇目录

行为或规则有变化时，和代码放在同一次改动里：

1. 打开对应的章，改「人现在会看到什么」。不要把实现步骤写进来。
2. 规格状态变了，改上面的表。从 draft 变成 implemented 时，把那段从「还没做」挪进正文。retired 时从正文删掉，表里留原因。
3. 在 [目录页](README.md) 的「最近更新」加一行：日期和改了哪一章。
4. 新能力没有现成的章，就新开一章，并在目录页登记。不要把新产品规则只写进 `doc/BOT_*.md` 那些设计笔记。
5. 设计笔记可以继续记接口和历史取舍。它们和本目录冲突时，改笔记或在笔记顶部注明「产品行为见 `doc/bot/`」。
