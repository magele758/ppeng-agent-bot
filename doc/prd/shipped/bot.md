<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## bot-activity-open-session
活动卡点击打开所属会话

这种要能点击跳转到会话里

## bot-activity-rail
Lab activity rail 展示 Bot 在途工作，并按 owner 隔离

Lab 右侧活动栏（GET /api/sessions/:id/activity）为当前打开的 Bot 会话展示
正在运行或最近完成的后台工作（routine 跑批、后台 job、子代理会话）。
只展示属于同一个 owner 的工作；其他用户的工作绝不出现在该 Bot 的活动栏里。
单用户本地模式（无 userId）下所有工作均可见，不要求登录。

## bot-async-summary
Bot 历史摘要后台更新

我觉得这个可以异步处理，会话更新了异步更新，只留一份就行了，这样长会话的bot，又能知道历史上下文，又不会每次开始就直接开始compact，导致启动时间增长？

## bot-autonomous-execution-coverage
Bot 自动选择并完整承接原有执行能力

现在的bot模式是否可以使用所有的原来的agent的执行模式和功能？帮我检查下，bot应该是原来会话的agent的增强版才对，核查一下这个问题
bot不应该继续让用户配置，把原来的模式让bot流程里自己根据任务去选择呢？

## bot-bloub-dynamic
Bloub 动态头像风格

另加一套 “Bloub 动态”

## bot-chat-header
Bot 对话头部只显示名字、活脸和权限入口

Bot 对话头部不要「Bot Chat」前缀，标题只显示这只 Bot 的名字。普通非 Bot 会话保持原来的标题。
头部要有进入这只 Bot 权限设置的入口，打开已有的权限 / 工具审批 / 允许名单，不另做一套权限。
头部名字旁边显示与选择器、列表、详情相同的会动的脸。

## bot-chat-image-compatibility
Bot 历史图片兼容与群聊发送恢复

怎么这个bot突然不能对话了？模型是没问题的，其他的bot可以对话，帮我排查一下，我之前还碰到过群聊不能发送消息问题，一起看看

## bot-child-task-chat-entry
普通会话列表里的 Bot 子任务入口

“可以考虑让bot模式加一个能力：自动在输入框填下一次可能输入的内容（用输入框的提示模式），tab才真实输入，如果不tab直接输入，就正常输入，这个下一次的提示来”: 这个会话是bot的子任务是吗？我看点击是跳转到会话页面了？会话页面那边列表里没有，要么在会话列表里可以加个入口也可以

## bot-child-task-chip-fill
子任务芯片有底色

这种加个背景色做颜色区分

## bot-child-task-stream-entry
主对话流里的子任务入口

确认，分多个agent去开发完成吧，另外bot的对话流里，也可以加个小UI作为入口，点击可以跳转过去，免得不知道主bot在干嘛

## bot-completion-reliability
完成验证可追溯与任务收尾可靠性

继续修复目标已完成却停在 queued、CSV 未保存和严格输出格式的问题，补齐完成判官的原始证据，不降低门禁标准，用当前 Grok 重跑新旧版本对照，通过测试和 review 后再合并 PR #251。

## bot-composer-next-hint
Bot 输入框推荐下一句

可以考虑让bot模式加一个能力：自动在输入框填下一次可能输入的内容（用输入框的提示模式），tab才真实输入，如果不tab直接输入，就正常输入，这个下一次的提示来源，可以让bot根据之前会话内容推荐
2、bot会话框里推荐的会话是要推荐下一步的行动的，你现在推荐的内容质量比较低
那就对话框里的内容让bot生成，然后作为下一步的行动推荐，不要搞成写死的

## bot-concurrent-subagents
Bot 并发工作时派生子代理，并允许子代理复用记忆与互助

When bot mode is doing several things at once, does it fork sub-agents by itself? If it does not, make concurrent bot work fork a sub-agent per extra piece of work (the parent bot stays the coordinator). One in-flight turn does not need a fork. Two or more concurrent pieces of work do.
A sub-agent’s context search and memory search must be able to reuse the parent bot’s memory and the global bot memory, and the sub-agent must be able to ask the parent (and sibling sub-agents of the same bot) for help. That is the 「通信互助」. Do not give sub-agents new rights to send external IM, schedule cron, or overwrite the parent’s memory. Search and a help message back to the parent/siblings only. Keep the existing subagent privilege limits.

## bot-console-selection
切换 Bot 时显示当前会话，开发态仍能载入默认 Bot

Switching bots must reset the displayed session/history to the newly selected bot. A late /open response for a previous bot must not overwrite the current selection (generation or abort).
In next dev Strict Mode, default-bot loading must not get stuck cancelled: the loading guard must reset on cleanup so the second effect run still loads.

## bot-create-named-tools
对话里能用 create_bot 和 create_room 创建

没有 create_bot / create_room 工具？我不是说要加这些工具吗？
不是加密内容，是一些秘钥类的东西，模型说无法读取，但是创建 bot 又需要，你看这个怎么处理比较好？要么创建 bot 不要存这些呢，只存必要的信息，免得搞的乱。

## bot-daydream-http
每日复盘与共享治理真实 HTTP 通路

按照这个开发计划，帮我分多个agent去完成开发

## bot-daydream-integration
每日复盘共享成果进入后续 Bot 任务

按照这个开发计划，帮我分多个agent去完成开发

## bot-daydream-knowledge
Daydream Super Bot 共享治理

按照这个开发计划，帮我分多个agent去完成开发

## bot-daydream-local
Bot 每日独立复盘

按照这个开发计划，帮我分多个agent去完成开发

## bot-daydream-missing-session
缺少固定对话时每日复盘继续

[runtime] Daydream failed { error: 'Error: Bot session not found' }
[runtime] Daydream failed { error: 'Error: Bot session not found' }
[runtime] Daydream failed { error: 'Error: Bot session not found' }
[runtime] Daydream failed { error: 'Error: Bot session not found' } 修复这个问题

## bot-daydream-ui
Bot 每日复盘配置与治理界面

按照这个开发计划，帮我分多个agent去完成开发

## bot-delegation-lookup
Bot 对话直接委派并打断重复查询

那把这两个问题修一下，Bot 对话里默认注入 bot_delegate，像这次 bot_get 同参数、同结果一直重复的，也要能及时拦住。

## bot-delete
删除 Bot 并保留对话历史

删除bot的选项呢？我怎么没看到
删除 Bot 和定时任务，保留历史会话、群聊记录

## bot-detail-child-tasks-tab
子任务改到详情页签

“子任务 可以考虑让bot模式加一个能力：自动在输入框填下一次可能输入的内容（用输入框的提示模式），tab才真实输入，如果不tab直接输入，就正常输入，这个下一次”: 这个子任务改到tab菜单里吧，下面的都看不到了

## bot-detail-menu
Bot 对话右侧详情菜单

还有一个问题，就是 bot 界面右侧要加一个菜单，显示每个 bot 的详细信息，可以看到他有哪些定时任务，生成的什么历史的文件或者资料，以及他的记忆的情况
定时任务在这个 bot 菜单里，要能直接操作开启和关闭
文件要能直接打开文件所在目录

## bot-detail-skill-management
在 Bot 详情中查看可选技能并管理技能

还有一个问题，我想要点击bot详情能看到他有哪些可选的skill，也可以在里面管理skill

## bot-dialog-solid
Bot 消息弹窗使用纯色背景

这个弹窗太丑了，直接纯色就行了，不要搞毛玻璃之类的

## bot-dual-compact
规范 Bot 会话的双阈值压缩

Repo /workspace (magele758/ppeng-agent-core). Pull latest origin/main. Read AGENTS.md and /cursor/stores/self/docs/personal-assistant-agents-vs-chat-agents.md section 3.2 and the 6.2 bullet on dual safety-net compression.

For canonical bot sessions only, implement two compression thresholds as a fraction of the model context window (default window 131072): at 50% run structured compact (goal, constraints, progress, decisions, files, next steps; incremental if a summary already exists); at 85% run a hygiene compact. Both must cut only on closed tool waves (tool_call stays paired with tool_result). Prune large old tool outputs before summarizing. Soft-archive the replaced transcript (existing archive jsonl path is fine) and keep it searchable if a session search already exists; do not invent a new vector DB. Do not change non-bot sessions. Do not add RAW_AGENT_* env; ratios can be constants or existing daemon_control/bot settings. There is an open PR #87 that changes SDK clampFoldToVisible; do not depend on it; implement the bot policy in the product compact path (packages/core compact host) so bot sessions compact earlier than the ~109k default.

Acceptance-first, user pre-authorized. Tests first. Open a non-draft PR. Do not merge. Do not edit gateway silence, approvals, or slash commands. Final reply: PR link and the exact trigger rules.

## bot-entry-dialog-shell
新建 Bot 弹窗遮罩与底部按钮

这个白边是什么？搞成半透明遮罩，然后底部按钮 fix 在 dialog 底部，免得滚动，而且也不知道下面有什么，点击遮罩要能关闭弹窗。

## bot-entry-simplification
Bot 创建入口统一与管理页面职责拆分

这个新增界面，还是功能揉的太多了，看看怎么把功能拆开一下，免得人根本不会用
这个团队工作都不知道什么意思？还有必要留吗？现在有bot 组了？
这个很多余，有设置了，这里一行其实只要保留添加就行了，每个组和bot后面带个删除加double check就够了
新建群聊、新建bot、新建功能分组都统一收到上面的新建里，可以做hover菜单，现在搞的怪怪的

## bot-execution-p0
Bot 任务直达执行与证据保真

那就按你建议的顺序直接改，先把 P0 的分类路由、压缩丢证据、完成验证和执行提示修好，参考 grok-build 的实现，做好测试和 review 后提交合并。

## bot-extreme-concurrency
Bot 以高并发同时推进多件工作

现在bot的并发能力和并发机制是什么样的？我想要极致的并发能力，来快速完成各种任务，分多个agent去分析和完成提升

## bot-face-readable-shapes
脸型圆润，列表里能看见表情，干活时更忙

这个云朵的 bot，有点小，嘴巴看不到了。
这里形状不好看，可以把十字星，房子的改成一些更圆润的，还有一些 icon 太小，不方便展示表情，然后如果在干活，他的动作可以丰富一点，感觉很忙碌一样。

## bot-face-soft-style
软萌机器人脸与经典脸并存

Add a parallel soft robot-face icon set. Do not change or replace the existing classic BotFace geometric icons, emoji, or image avatar behavior. Default must stay classic.
Persist faceStyle as classic or soft. Null, absent, or unknown means classic.
Soft faces are an original rounded blob set: silhouette, color, and expression chosen deterministically from a seed. Same seed stays the same; different seeds can differ.
Emoji and image avatars still win over either face style.
The create and edit picker has a Classic | Soft robot toggle. Classic keeps the current shape and color grids. Soft shows soft silhouette, color, and optional expression picks, with a soft preview.
Soft faces render as static SVG. Do not animate every list row.

## bot-first-task-dismissal
首次任务引导可关闭且不干扰已有对话

这个也非常的干扰，要么显示过了不要显示了，要么加个关闭，现在关闭也管不了

## bot-first-task-new-user
首次任务引导只给新用户看

这个不要每个bot新建都展示，只有新用户才展示

## bot-forever-chat
Bot 永久主会话命令

Implement bot forever-chat commands only. Current bots already have a canonical session (RawAgentRuntime createBot/openBot). Gap: in that canonical bot chat, `/new` must NOT open a new session; it compacts the same session (like Hermes desktop Bot Mode). Also support `/stop` (abort current turn) and `/model` (switch that bot's model) as channel/composer commands that hit the bot's canonical session. Wire this for Lab chat when a bot is selected AND for gateway inbound text if a botId is bound. Do not rewrite the gateway security code from PR #76 beyond a small command hook.
Config via existing bot settings / Lab, no new RAW_AGENT_* env.

## bot-fork-retrievable-inheritance
Bot 子任务按权限检索父 Bot 的记忆、技能、文件与上下文

bot 模式，如果 fork 子任务，要继承父 bot 的信息，记忆、skill、文件、上下文等，作为可以检索的内容，可以不用一次性塞入，但是要能做权限继承和隔离，现在好像是不对的。

## bot-fork-sessions-in-detail
Bot 子任务会话放进详情菜单

“可以考虑让bot模式加一个能力：自动在输入框填下一次可能输入的内容（用输入框的提示模式），tab才真实输入，如果不tab直接输入，就正常输入，这个下一次的提示来”: 这些事bot fork的子任务会话？这个放到bot的详情菜单里吧，不要放这里了

## bot-functional-groups
Bot 功能分组、共享范围优先级与头像修复

群聊不能删除
这个小花朵的icon还是有问题，没正常显示
没任务的时候，不要这个表情，用个静止的等待的活泼点的表情
不需要按照日期分组，按照功能分组，可以有未分组，以及按照功能分组，可以拖拽到不同的分组里，分组是隔离域的优先级，比全局的bot共享互通信息优先级高一档，群聊内的最高，最低是未分组的和全局的之间的

## bot-gateway-delivery
IM 静默回复、至少一次投递与例行预检

Implement three bot/gateway behaviors:
1. Outbound: if the assistant reply is exactly or clearly marked [SILENT] or NO_REPLY, do not deliver to IM. If the turn was a direct human message (not cron/webhook), replace a lone silent marker with a short acknowledgement so the human is not left with no reply. i18n zh+en for that acknowledgement.
2. Delivery ledger: persist outbound IM deliveries; on restart, redelivery may happen and the resent text must be prefixed so the user can see it may be a duplicate (Hermes uses a recovered-reply prefix). At-least-once, not exactly-once.
3. Cron/routine precheck: a bot routine may set a precheck (script or predicate) that runs BEFORE the model. If it returns wakeAgent false, do not start a model turn and do not spend a model call. No new env vars; store the precheck on the existing routine/bot config (Lab/KV).
Acceptance-first, user pre-authorized, tests first. Open a non-draft PR. Do not merge. Do not change slash-command routing, compression thresholds, or approval timeouts.

## bot-goal-conclusion
目标结算与子会话身份的生命周期闭环

修复目标结算与子会话身份的生命周期闭环（breakpoint-5，同一件活，一次做完）。
1. 派出的子会话结束后，等待记录要指向这个子会话而不是父执行会话，目标能读到子会话的结果，不会被判为未授权而阻塞。
2. 同一 Bot 同时有多件待办、其中一件已登记为目标并交给子会话时，子会话跑完后目标按实际结果结算，不再停在执行中，结果不只留在子会话里。
3. 委托给另一个 Bot 后，原目标只依据对方这个委托任务的状态和结果继续；对方在自己会话里另开的子会话不是原目标的执行。
4. 团队或群体扇出后，成员会话失败或群体没有任何任务时，对应计划或执行进入失败终态；父目标不会一直等待，也不会被缺失的执行误唤醒。
5. 回合已经给出可核对的完成证据时，完成判官不可用或抛错不得把该回合收成阻塞。

## bot-goal-lifecycle-boundaries
Bot 目标跨用户与执行生命周期闭环

按你分析的优先级，把这七个问题完整修掉，补齐跨状态、跨执行入口和跨用户的回归测试，再审查一遍整个链路，没问题就提交 PR 合并。

## bot-goal-live-chain
Bot 默认配置完整执行与证据回流

按优先级把这次实测发现的四个卡点完整修掉，补齐回归，再用真实模型跑通默认配置下的完整链路，不要靠手动绕行。审查和验收通过后提交 PR 合并，更新本地并重启服务。

## bot-goal-nested-approval
目标子任务的待批准出现在主对话

再用真实模型跑一轮复杂场景：多目标并行、子任务失败重试、暂停恢复、执行中追加要求和服务重启恢复，检查默认配置下有没有新的卡点，发现问题就修复补回归，审查通过后合并并重启。

## bot-goal-only-when-needed
Bot 只在必须时才为目标再开子任务

我看现在bot模式有个问题，他bot已经分析和处理好了，不是必须的时候也去启动了一个goal去做子任务，有时候感觉很多余，非必须，可以优化这个流程

## bot-goal-result-return
子执行结果回到原目标并收口

按「结果能不能回到父目标并正确收口」排序。依据是 grok 写在 .grok-reviews/bot-goal-conclusion.md 里的结论。

子会话身份写不回父目标。 spawnSubagentOutcome 不复制 botGoalId / botGoalScopeSessionId（spawn-host.ts:235-271）。dispatch 丢掉 childSessionId，runRef 仍指向父执行会话（runtime-dispatch.ts:104、128）。收成 source: 'session' 的等待后，完成会被判 unauthorized，目标 blocked（scheduler.ts:33-39、240-243）。后面的回收都依赖这个关联。

子会话结束不等于目标结算。 并发 fork 跑完只 deliverNote，不调用 settleGoalExecution（concurrent-fork.ts:203-214）。调度器对已经不在 running / waiting_approval 的 execution 不 report（scheduler.ts:214-235）。审批到达时租约过期会直接返回，恢复和 block 都跳过（scheduler.ts:189、233-234）。目标停在 running，结果留在子会话。

bot_delegate 的对方子会话回不到原目标。 适配器只记下对方一个 bot_task id（adapters.ts:62-66）。调度器只读这个 task 的 status / result（scheduler.ts:41-43、103-106）。对方内部再建的子会话没有原目标的 botGoalId。status 不在终态集合里就一直 waiting；requesterBotId 对不上就 block。

Team / Swarm 扇出后，父目标可能一直 waiting，也可能被误唤醒。 Team 只 enqueueSchedulerWake，不 runSession，也没有任务失败分支（teams/executor.ts:311-328、464）。Swarm 把 idle 计入队友上限，空任务列表也不会把 run 收成终态（swarm/executor.ts:135-158）。launchTeammate 失败不把任务标失败（swarm/executor.ts:51-53）。run 记录缺失被当成 unknown 并 wake（scheduler.ts:49、256）。

完成判定会把已经走完的回合收成 blocked。 candidate_completed 再交给 verifyCompletion，judge 抛错时报告变成 blocked（runtime-host.ts:327-337、345-350）。self_heal | factory | evolution 没有 inspectSpecialty 时是 unsupported 并 block（scheduler.ts:50、240-243）。factory / evolution 会话不在 externalWorkers 里，文本刮不进 evidence（scheduler.ts:54-63）。 这几个问题解决了吗？如果没解决就去解决掉

## bot-goals-panel-rules
目标与进展只展示同时在做的多件事

“目标与进展 (3) 下一条消息关联的目标 自动判断 现在ppeng-agent-core又加了很多提交，特别是bot room这一块，看看新增的特性有什么可以搬”: 这个goal的逻辑要调整一下
1、为什么会有阻塞？这几个内容应该是我还在询问和讨论，是否不该直接定目标？
2、已完成的就从这里显示里去掉
3、如果少于2个目标就不要展示目标和进展，这个是给一个会话中有多个主题同时在干准备的

## bot-goals-panel-threshold
目标与进展少于两个目标时不展示

这个少于2个goal的时候不要展示

## bot-group-drag-only
Bot 侧栏移组仅保留拖拽入口

这个显示纯多余，去掉，已经有拖拽进入分组的能力了

## bot-history-memory
Bot 持续对话历史与记忆

完整补齐前述 gap，从纵向切片完成开发计划，包括持续对话、历史、记忆与模型窗口。

## bot-human-continuation
Bot忙时接收与连续对话

补齐既定G01/G07持续对话中的忙时接收，承接用户已授权完整实施。

## bot-identity-continuity
Bot可靠工作与身份连续性

分多个agent补齐所有缺失直到评估完成

## bot-immediate-steer
Bot 回合中直接插入并转向

Bot 模式默认支持 steering。Bot 回合还在跑时，在对话输入框里发出的消息必须立刻出现在对话列表里，并在循环能接收的最早点插入对话，不要询问用户是否 steering。普通会话保持原来的先询问再转向。只有规范 Bot 对话会立刻插入。Bot 不能因为插入一条 steering 消息而再要一次批准。这不是工具审批。

## bot-input-suggestion
Bot 输入框下一句建议

开发 /home/shinemo/wt/ppeng-input-suggestion（分支 feat/ppeng-input-suggestion，基线 origin/main 665d041c）：实现「bot 模式输入框下一句建议（ghost text + Tab 提交）」新功能。

功能需求：
1. 在 bot 会话/Agent Lab 输入框实现下一句建议：输入框内显示淡色建议文本（ghost text），视觉上明显区别于真实输入，不占真实值。
2. Tab 键把建议落为真实输入（可继续编辑，再回车发送）；用户不按 Tab 直接打字 → 正常输入、建议立即消失。
3. Esc 撤销建议；发送后清除建议；输入框已有内容或失焦时不显示。
4. 建议来源：每轮 assistant 回复结束后，bot 基于本会话最近上下文静默生成 1 条「下一次可能输入」，可附 1-2 条备选（Tab 可循环）；轻量模型调用、可配置开关（默认开）。
5. 竞态防护：建议请求带 requestId，防乱序串台。同一回复轮复用持久化推荐，跨轮拒绝过期结果（补充需求见 bot-input-suggestion-cache）。

## bot-input-suggestion-cache
Bot 每轮推荐只生成一次并保留

还有，帮我检查下，之前做的bot自动推荐问题的功能，有保存和重复调用模型吗？我切换一下会话就没了，我想要一轮会话只调用模型推荐一次，切换会话还可以保留

## bot-linked-watchers
关联原工作的临时盯梢与观察证据

那就按v2计划开始改，先把日志里这些真实问题复现成测试，再逐项修好，验收通过后review、提交PR并合并，不要停下来等我确认。

## bot-list-face-plate
侧栏 Bot 脸保持原形，不套外框也不拉变形

你这个框加错了，你给 icon 都加个框干嘛？
你这都把 icon 搞的变形了，赶紧修复一下，还有上面那个六边形的也变形了。
你把上一版的 super bot 的 icon 给我恢复，我挺喜欢那个的。

## bot-list-idle-motion
Bot 列表待机头像保持活性

这个列表里的icon，还是保持一定的活性，不要呆着不动，让他活泼点，动作多点

## bot-message-name
Bot 回复标签显示 Bot 名称

这个用bot的名称，不要只搞个助手

## bot-mock-interview
内置模拟面试官按指定信息出题、评分并给改进建议

帮我建个模拟面试的bot，根据指定的信息，出题面试和给出评分和改进建议

## bot-multi-goal-coordination
Bot 多目标持续执行与自动选择执行方式

那你帮我设计一下，怎么把这些已有能力围绕多goal统一起来，让bot能自动选择执行方式，我插话也不会丢任务，先给我方案。

## bot-panel-reset
切换 Bot 时重置记忆、暂停开关和软件连接

#117 already resets session/history on bot switch. Memory panel, pause switch, and software-connection rows still keep the previous bot. Reset those when the selected bot id changes, and ignore late responses from the previous bot.

## bot-pin-area
Bot 列表置顶区

我还想要加一个bot里的置顶的功能，顶部加一个置顶区域，我把bot拖进去就可以置顶，默认是把big boss（super bot？）置顶的

## bot-pin-sync
跨浏览器置顶同步

为什么，我在codex里的浏览器里访问的置顶列表和我在浏览器里访问的不一样？浏览器里有rsi bot，但是我在codex里的置顶列表里没这个？排查根因修复问题

## bot-product-admin
对话 bot 能管理产品和配置

我问 bot，他说也没有创建 bot 和创建群聊的能力，其实这个项目里的功能都可以暴露给 bot，让他能完全自主的操作和管理，你先评估一下，缺哪些，然后都去补齐一下，包含创建以及修改配置之类的都要能支持

## bot-product-p0
Bot可靠工作与可验收交付闭环

我觉得你说的非常好，P0到P2的功能，我都挺喜欢的，帮我都做了

## bot-product-p1
Bot首次任务与软件连接引导

我觉得你说的非常好，P0到P2的功能，我都挺喜欢的，帮我都做了

## bot-product-p2
Bot成果复用记忆纠错与持续协作

我觉得你说的非常好，P0到P2的功能，我都挺喜欢的，帮我都做了

## bot-quality-reliability
限定写入范围与辅助判断可靠性及重复对照

继续把这次基线暴露的额外保存和辅助请求取消导致用量缺失的问题修好，扩充评估集并用当前 Grok 跑新旧版本重复对照，别降低门禁标准，做好测试和 review 后提交合并。

## bot-quality-sample-plan
真实模型评估的独立任务与样本量预检

那就继续解决主分支冲突，补足独立评估任务，不降低门禁标准，对最新代码重新跑 Grok 新旧版本对照，通过测试和 review 后直接合并 PR #251。

## bot-readonly-api
Bot 正文 API 与显式只读路由

继续把 API 混入 reasoning 和只读消息误建目标这两个问题修好，补上针对性的回归测试，不扩大评估。测试和 review 通过后直接提交合并，再更新本地、构建重启 daemon，用当前 Bot 验证到通过。

## bot-receipt-queue
历史回执不占用新委派的执行位置

这个为什么会互相阻塞？新的任务不是应该自动去执行吗？老的就算不回复，也不该卡住，就是个记录而已，为什么要卡住？哪个pr改出来的问题，先修复，再排查定位

## bot-relay-island
Bot 通信收起为灵动岛式胶囊

这个加个小UI，可以用个类似灵动岛的设计，对话内容不用展示，点开再展示

## bot-relay-slug
非 bot_ 前缀的 Bot 通信也收成小提醒

Bot 之间的通信即使发送方 id 是 ubuntu2-bot 这种 slug，也收成一行小提醒，点击才看全文

## bot-relay-strip
Bot 间通信在聊天流里显示为紧凑通信条，点击弹窗看全文

runtime 投递给 Bot 会话的 user 消息「Message from <名称> / <bot_id>[ (from room <id>)]: <正文>」
（正文可为「Delegated task <btask_id>: …」委派任务、「Task <btask_id> <status>: …」委派结果或普通消息）
在聊天流里只显示一行通信条：来源 Bot 名称 + 类型 + 正文首行摘要，不以 bot_/btask_ id 作主文本。
点击通信条打开弹窗，以 Markdown 展示完整原文；Esc / 点遮罩 / 关闭按钮可关闭。
模型侧消息与「模型视图」不变；普通用户消息与非精确前缀文本不受影响。

## bot-reliable-messaging
Bot可靠工作与身份连续性

分多个agent补齐所有缺失直到评估完成

## bot-reply-quote
引用某条 Bot 回复再发消息

我还想要加一个回复bot里某个具体回复的能力，类似引用的能力

## bot-robot-faces
Bot 显示稳定的机器人头像

User wants each bot in bot mode to show a small robot icon, inspired by https://github.com/Louis-CFM/coucou. FIRST check that repo's license.
License result: coucou source is MIT, but character art, app icon, design/, and docs/media/ are excluded in LICENSE-ASSETS.md. Do NOT copy their PNGs, vectors, or Mochi drawing. Implement original simple robot-face SVGs. Assign deterministically from the bot name (stable hash, same name → same face). Show on bot cards, detail, and the chat bot picker.
Empty state too if there is a bot avatar slot. All new user-visible strings via i18n zh+en.

## bot-room-console
大规模群的对话区界面

成员很多时不要平铺所有人。可以按职能组查看，并整组加入或移出。群成员仍至少 2 人。
输入 @ 时要能看到职能组，也能按职责找到名字并不相同的 Bot。
界面语言切换后，这些新文案跟着变。
默认不在群里放批准按钮。

## bot-room-goal-intake
群目标与中途插话

群正在做事时，用户询问进度、补充约束或喊停，要马上得到对应处理，而不是等当前这轮全部跑完。
看不出指哪一件事时先追问，不停止全体。

## bot-room-inline-approval
群内原位批准

approval = private-default：默认仍转到该 Bot 私聊，结果不自动回群。群内原位批准只作为 Lab 里另行打开的策略，不进第一批实现。

## bot-room-recall
群纪要、群规约与按群取回

记忆打通单独成阶段，放在群上下文推送之后。
bot-room-recall：纪要 + 群规约 + 最近消息 + 按群取回。

## bot-room-sparse-routing
所有群稀疏唤醒

routing = sparse-all：所有群（含 2–3 人小群）都稀疏唤醒，不再「未点名则全员轮流」。静默不占有效发言预算。未点名且和每名成员都对不上时，这一轮零回复，不替群主补一句。群成员仍至少 2 人。
把点名直达、容量、静默不占预算，与「未点名按贴题程度选人」放到同一个可合并切片。

## bot-room-speaker-identity
Bot 一开始就知道群里发言用自己的身份

bot回复群聊的时候，或者从单聊发送消息到群聊的时候，现在是不是没有指定发送人的身份的？比如我从单聊让bot去群里回复，他没办法使用自己的身份去发送消息
好像是可以的，但是好像各个bot开始不知道这个规则，你看看增强一下这个

## bot-room-speaker-pick
群聊按贴题程度决定谁开口

群聊不要只靠群主。未点名时，知道细节的成员要能先答。群主已经答过，明显更贴题的那一只还可以补充或修正。大家都不沾边，就整群不回复。不要把每个成员都叫醒写长回复。
未点名、未引用：用名字、头衔、简介、职能组对用户这句话打分。只叫醒超过门槛的前几位，不超过每轮发言人数（默认 4）。这些专家先并行答。群主如果也过线，可以在这批里；群主没过线就不要为了收尾先写长回复。
有专家给出可见的实质回复之后，群主若还没发言，可以再做一次短收尾。没有新事实就不要发。收尾不是再把其余成员跑一遍。
群主已经有可见回复，且还有一只没发言但分数明显更高：再用「最多再加一位」把那只叫起来。它能看到已有回复，可以补充或修正，也可以沉默。不要第二轮把所有人再跑一遍。
没人过门槛：这一轮零回复。不叫醒大家表态，不贴「我先接住」。
[SILENT] 和短否定（我不知道、不清楚、没有要补充）不进群，不占有效发言。
被 @ 时仍只叫醒被点到的人，截到本轮人数上限。点名没人中，保持现有「没找到」行为。引用某条 bot 回复时，仍只叫醒被引用的那只。
群主是建群时指定的那一只；没指定就是成员列表第一只。不要假设某个固定 Bot 一定是群主。

## bot-room-tasks
群子任务与成员接力

bot-room-tasks：子任务、接力；审批仍默认私聊。
approval = private-default：默认仍转到该 Bot 私聊，结果不自动回群。群内原位批准只作为 Lab 里另行打开的策略，不进第一批实现。

## bot-room-touched-memory
按触达打通单聊记忆与群内容

我想要都有，他保留自己的单聊记忆，同时能接入群里的信息，如果群聊的内容，他也可以融入到单聊里，因为他触达了这个信息，只要他的触达，就算他的信息源。

## bot-room-wave-dispatch
群发言并行与停止拦截

并行波次可以紧随其后。未点名由 bot-room-speaker-pick 按贴题程度稀疏选人，不是全员轮流，也不是群主点名。
覆盖：并行波次、一人一轮一次公开发言、停止后旧回复不入群。

## bot-room-work-continuity
群派工到原 Bot 持久工作的可靠承接

那就按v2计划开始改，先把日志里这些真实问题复现成测试，再逐项修好，验收通过后review、提交PR并合并，不要停下来等我确认。

## bot-rooms
多 Bot 群会话与可靠发言

跟其他bot的通信的模式，组群会话的能力是否能支持
群里遇到需要真人登录/验证/审批的步骤，转到私聊完成

## bot-routine-lifecycle
Bot 可靠例行任务

完整补齐前述 gap，按 Bot 模式多 Agent 协作开发计划实施。

## bot-routine-main-session
Bot 定时任务跟自己的会话走

bot 的定时任务怎么还是通过新建会话来执行的？而且权限也没继承？我不是说要 bot 的定时任务是跟着 bot 的会话一起走的吗？

## bot-row-menu
Bot 列表操作菜单

给bot列表里的bot加一个三个点的点击菜单，里面包含查看他详情、查看他的定时任务、加入到某个分组、加入到某个群聊、删除等这些操作

## bot-runtime-log-regressions
Bot 实际运行日志回归

那就按v2计划开始改，先把日志里这些真实问题复现成测试，再逐项修好，验收通过后review、提交PR并合并，不要停下来等我确认。

## bot-scoped-skill-sharing
Bot 私有技能沉淀与指定 Bot 共享

我希望沉淀的技能默认按 Bot 隔离，也可以选择共享给其他 Bot。帮我设计一下，先写验收标准给我确认。

## bot-session-row
单 Bot 会话行显示名字、问题和活体脸

选中的 Play 侧边栏会话行不要再显示「Bot Chat」前缀，也不要把原始 bot id 当副标题。
单个 Bot 的会话行显示这只 Bot 的名字，以及这条对话里最后一条用户问题。
还没有用户问题时，用一句很短的空状态文案，不要显示 id。
问题只占一行；悬停时横向滚动，能读完整句，不能把这一行撑高换行。
这一行上显示这只 Bot 的活体脸：会眨眼、眼睛跟着指针、颜色由名字决定，
和输入框里 Bot 选择器使用的是同一个组件。
多 Bot 群聊行可以保留自己的标记。普通会话标题保持原样。删除仍然可用。

## bot-settings-flow
简化 Bot 操作与设置生效反馈

按你这个review直接改吧，把这些问题都修好，简化Bot操作流程，补齐面板配置和生效状态，测试review通过后提交PR并合并。

## bot-sidebar-child-sessions
Bot 侧栏不列出子任务会话

这种子任务的会话又跑到bot的列表里了？修复一下

## bot-sidebar-order
Bot 列表同一区域内拖拽排序

你在仓库 /Users/penglei/developer/self-test-grounding/ppeng-agent-core。用户看着左侧 Bot 列表（附图：主导航旁边的会话/Bot 侧栏，有置顶、Jarvis 群聊、功能分组「开发 / 日常 / 研究 / 生活」和一列 Bot 头像）。他说这里面 Bot 的顺序会变化，要加拖拽排序，不要乱变顺序。

他点中的节点是 aside.lab-rail（主导航：Agent Home、Bot、对话、Bots 与 Agents、任务、知识与记忆、设置）。Bot 头像不在这个导航里，而在旁边的 play-sidebar / sessionListMini。先确认顺序变化发生在 Bot 列表，不要去给主导航那几项做排序，除非你发现主导航里真的有会跳动的 Bot。

先查清现在按什么排（最近消息、更新时间、不稳定的对象键顺序等），用一句话写进回报。

要做成：
- 同一区域内可以拖拽改顺序：置顶区内部、每个功能分组内部、未进分组也未置顶的列表内部。群聊若出现在这些区域里，也参与同一套顺序。
- 顺序持久化，刷新后还在。沿用现有的置顶 / 功能分组存储（例如 lab.botPins 或服务端分组），不要另起一套只活在内存里的排序，也不要新增 RAW_AGENT_*。
- 一旦有了用户顺序，新消息、执行中、刷新都不得把 Bot 重新排到前面。新出现的 Bot 或群聊追加到该区域末尾。
- 已有的「拖进置顶 / 拖出取消置顶 / 拖进功能分组」保留。拖拽排序不要把换区拖拽弄坏。
- 文案如需新增，走 i18n，zh/en 同一套 key。

## bot-skill-panel-layout
Bot 技能面板布局清晰且适应窄屏

这个页面结构都是乱的，特别上面的部分，去修一下

## bot-soft-create-runtime
软萌头像可正常创建和保存

修复这个问题
我本来想让他参考这个 https://github.com/jeremy-prt/bloub 实现的，好像现在是自己做的svg？我是想参考 https://github.com/nightly-labs/openbot 的效果的，先修复好，看看要么再加一套

## bot-soft-motion
软萌头像跟随实际工作状态动起来

这种新的表情，没我原来的icon活泼，而且有动作的时候完全没动画，修复一下这个问题

## bot-software-execution
Bot 软件连接与可靠执行

一个bot是可以持续一直对话的，他的记忆和历史会话管理，现在是否能满足，定时任务，以及跟其他bot的通信的模式，组群会话的能力是否能支持，以及调用各种其他软件的能力

## bot-source-authorization-continuity
Bot 已授权工作的来源连续性

那就按v2计划开始改，先把日志里这些真实问题复现成测试，再逐项修好，验收通过后review、提交PR并合并，不要停下来等我确认。

## bot-startup-summary-latency
摘要服务变慢时 Bot 启动有界等待

帮我分析下现在启动bot会话的耗时，怎么感觉启动会话这么慢？排查定位根因，修复问题

## bot-startup-trace
Bot 启动耗时分段可观测

我觉得现在bot启动特别慢，在对应位置，打上日志或者trace分析，让我能分析找到具体慢的原因，分多个Agent去快速开发完成

## bot-steer-visible
Bot 对话里的实时插话马上出现在对话流

我在bot对话流中，实时插话，没有立即显示在对话流的UI中，经常延迟很久，插话时机的逻辑不用改，这个ui调整一下

## bot-supervision-freshness
Bot 监督状态新鲜度与回复关联

那就按v2计划开始改，先把日志里这些真实问题复现成测试，再逐项修好，验收通过后review、提交PR并合并，不要停下来等我确认。

## bot-switch-live-turn
切换 Bot 后主画面离开上一场进行中的对话

我在一个 bot 里会话，切换别的 bot，ui 会话没切换过去，新的 bot 里展示的是正在对话的 UI，不过从历史信息看，数据是对的。
在一个 bot 吐文字的时候，切换其他 bot，还是会话有问题。

## bot-task-permission-inheritance
同 Bot 任务继承权限，跨 Bot 按目标权限执行

可以，就按这个规则改，先按项目要求写验收标准，同一个 Bot 创建的任务会话继承 auto 权限，跨 Bot 按目标 Bot 的权限，bypass 不自动继承。
bypass也要继承

## bot-task-terminal-wait
已结束的委派能唤醒接收回执的 Bot

具体线索是，我用科研小助手发送的给RSI的，说是一直在队列里，但是没看到RSIbot执行

## bot-window-compact
规范 Bot 按真实模型窗口的一半和 85% 压缩

Fix only issue 1: canonical bot sessions must compact at 50% and 85% of the real model context window again (default 131072 via resolveMaxContextTokens), not a squeezed history budget and not the 32768 fallback when the adapter omits contextWindow. Hygiene must remain reachable on the default window. Do not change the normal-session 20% cap. Do not emit compact_skipped on a turn that just compacted successfully if that false trace is in the same bot compact path. Update tests that locked the wrong 32768 behavior. No new RAW_AGENT_* env. Acceptance-first: user asked to fix it now; acceptance yaml approved with that note; failing tagged tests first.

## bot-work-durable-wait
Bot 任务停在持久等待上并只恢复一次

如果bot在执行过程中，服务重启了，之前的任务就直接停了，重启之后，也没有继续执行。Bot 任务在等待自己启动的后台命令时，要停在持久等待上；重启后条件没满足就不叫模型，条件满足后同一任务只恢复一次。

## bot-work-restart-resume
重启后从安全检查点继续 Bot 任务

如果bot在执行过程中，服务重启了，之前的任务就直接停了，重启之后，也没有继续执行。开发期频繁重启时，canonical bot 对话里已经停在安全检查点上的任务要继续；做了一半且效果未确认的保持未知，必须确认后才能重试。

## bot-working-animation
Bot 工作期间持续动态、列表待机保持活性

最好加个特性，如果bot在干活，他就表情和动作一直在动，如果没干活再静止

## bot-workspace-interaction-polish
Bot 工作台引用、任务通知、上下文与长会话体验优化

这个引用的交互太粗糙了，帮我优化一下
这里是否可以继续优化一下展示？
这种对于定时任务，可以加个特殊的ui来提醒，不用这么直接把原始调试文案都发出来
这边加一个收起列表的按钮
这里跟上面新建融合一下，可以用iconfont去表达
帮我检查下，共享信息的写入和读取链路是否完整
分组的名称用浅一点的颜色
这里我是想要看到实时发送给模型的上下文的长度统计，这里是有的吗？最好标识的明显一点
这里要能显示是一次性的任务还是循环的，而且对于他 cron表达式要能查看、编辑和更新
这种都不知道什么内容，看不懂，最好能跳转文件
这个列表的内容太多了，看看怎么优化一下展示，看看是否可以做分组或者多个tab拆分
超长的会话列表，会有性能问题，看看能不能继续优化一下性能和展示，避免白屏和样式错乱
