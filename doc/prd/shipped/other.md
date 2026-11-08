<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## acceptance-gate
验收标准门禁（需求 → 可执行验收用例）

Phase 2 — 把用户需求变成可执行的验收标准，负责人只评审验收用例（不看代码），
发布门禁证明每一条已批准的标准都有通过的测试。

## agent-as-folder-eval
Agent-as-folder path + eval default-on

Agent-as-folder + eval default-on minimal mergeable PR from origin/main.

## agent-learning-governance
纠错评测、技能验证、输入授权与事件调度

这4个点也都挺好，帮我全部实现，做完测试和审查后直接合并。

## agent-skill-management
Agent 在对话中管理自身技能

然后这个共享skill、沉淀skill、修改skill、管理更新删除的能力，我想要agent也具备自己去操作的能力

## agents-clean-layout
Bot 管理页清爽布局

这个界面里很多ui都是乱的，检查优化一下

## agents-management
Bots / Agents / Teams / Skills 管理页清晰易用

让创建/管理 bot、agent、team、skill 清晰、容易：卡片/列表总览加搜索，创建流程只要求最少必填字段并把其余放进「高级」，
空状态要有清晰指引，team 图要易读。

## always-on-reliability
常驻 Agent 的恢复、通知、长期评测、缓存诊断与压缩契约

我觉得这5个点分析的都挺好的，帮我全都实现把

## app-frosted-glass
整个应用是毛玻璃

我要整个应用是毛玻璃效果

## approval-explanations
审批操作与风险说明

这里给的信息太杂了，要告知我风险的原因，以及具体要执行什么，可以让模型来解释这个，避免搞不清楚为啥

## ask-user-live-stream
回答追问后继续看到生成内容

Bug: after the user answers an ask_user approval (回复并继续), the backend keeps streaming output, but the Lab chat frontend does not continue updating. The user can see the run still producing on the backend.
After approve/deny of ask_user, the UI must attach again to the live output stream (or must never have detached) so new assistant tokens and tool events show up without a manual refresh.

## auto-review-authorized-by
Auto-review 批准回执记录授权引用

Persist authorizedBy: string[] on approval / Auto-review receipts (批准回执). When a high-risk tool call is escalated or approved under an owner authorization chain, the stored approval/receipt must record which owner message/card ids authorized it — Grok-aligned audit trail, not a UI clone.
Tools that mutate under owner authority accept optional authorizedBy: string[] (max 4): owner message ids (e.g. tNu…) and/or answered-card ids (e.g. tNsM…).
A helper/subagent may only cite p-prefixed ids it was given by its parent (do not invent or scrape chat history for ids).
When Auto-review creates / resolves an approval receipt for a high-risk Shell/MCP call, persist the cited authorizedBy on that receipt so later audit can answer "which owner messages authorized this?".
Missing authorizedBy must remain legal (omit / empty); do not break existing approve flows.
Do not treat authorizedBy as a bypass of Auto-review: soft-block → card → approve still required for high-risk calls. authorizedBy is an audit citation, not a skip-gate flag.

## auto-review-shell-mcp
Auto-review 工具级审批卡（高危 Shell/MCP）

Auto-review / tool-level approval card aligned with Grok behavior:
Lab already has approvals/Risk/approve; tree has NO AutoReview / request_smart_mode.
Slice: high-risk spawn/Shell/MCP default-block → native approval card → same-action retry with approval flag; denial = final; no bypass routes.
Accept: risky shell/MCP blocked by default, card shown, same-params retry after approve, deny terminal.
Auto-review approval cards must clearly show a kind badge (Shell vs MCP / tool kind) and the human-readable blockReason from the Auto-review gate, so the owner can decide without guessing why it blocked.

## auto-source-continuity
Auto 对话连续执行

auto的权限太低了，一点也不auto，这种怎么都要我审批，简直不能用，导致我只有bypass的能用

## background-job-restart
重启后中断无人执行的后台命令

如果bot在执行过程中，服务重启了，之前的任务就直接停了，重启之后，也没有继续执行。后台命令在进程死亡后不能永远停在运行中，也不能被自动再执行一遍。

## bg-run-host-park
Host parks durable wait for owned bg_run

Under an active Goal or Routine, bg_run should host-park a durable wait (hostParked)
so the model does not need a second wait_for round. Fewer watch loops; quieter complete.

## bots
Bot 名册、互发消息与权限

用户可以创建多个长期存在的 Bot，每个 Bot 有自己的对话、记忆、模型和权限档位；
Bot 之间可以互相发消息协作，危险的权限需要明确确认。

## brief-hide-monologue
精简界面隐藏混进正文的思考独白

只看关键信息时，中文回答后面那段英文思考不要再当正文展示

## brief-no-process-note
精简模式不显示「已收起 N 条过程」

聊天里「已收起 N 条过程」的折叠块，在精简模式下应完全不渲染任何 UI（包括标题行和展开内容）；非精简模式保持不变。

## browser-navigate-private-network
浏览器导航拒绝私网和本地文件

Fix: browser navigation must reject private, loopback, link-local, and CGNAT addresses (use the repo's isPrivateOrReservedIp) and must reject file:// URLs. Do not add a new env flag; the existing private-network allow switch may stay if it already exists, but the default remains deny. Acceptance-first, user asked to fix now, tests first.

## child-wake-workitem
子代理完成唤醒继续同一项工作

Feature (minimal mergeable slice OK): Child-agent wake carries/continues WorkItem (work association) properly.
When a child/subagent/fork finishes or emits a wake, the parent resume path preserves workRef/parentWorkRef (or equivalent goal/execution correlation) so the continued work is the same WorkItem, not a detached orphan session.
Wake payload / service.wake / wait evidence must continue the owning Goal/Routine execution fence (revision, correlationId, session scope) — no silent drop of work identity across child→parent wake.
Cover concurrent-fork and goal_dispatch child session waits: wake resumes the correct owner once with evidence; wrong owner/revision rejected.
Tests proving: child completion wake continues parent workRef; missing/mismatched work association fails closed; no double-wake.
No new WorkItem table/system. No RAW_AGENT_* flags.

## classic-solid-dark
经典主题深色用纯色

经典主题黑色要纯色的，不要搞一些毛玻璃效果。

## cli-bot
命令行使用机器人

当前项目的cli模式，是否完整？分多个agent去检查下入口、功能、链路、以及新加入的bot模式是否支持在cli模式里使用？如果要能使用，要做什么？分多个agent去快速排查和补齐

## cli-session-permission
命令行调整会话权限

当前项目的cli模式，是否完整？分多个agent去检查下入口、功能、链路、以及新加入的bot模式是否支持在cli模式里使用？如果要能使用，要做什么？分多个agent去快速排查和补齐

## command-hardline
危险命令硬拦截与密钥脱敏

无论 Agent 处在哪个权限档位（包括 bypass），都不能执行毁灭性的系统命令；
命令输出里的密钥不能回流给模型。

## compact-archive-pointer
压缩摘要带上原文位置

runAutoCompact 成功做闭区间 replace 时，把归档相对路径写进同一条 summary。有记忆附录时 working-log tail 不会贴上，所以路径必须在摘要正文里，不能靠另一条 appendix。
摘要空则 empty_summary 跳过。这段逻辑不要改。
在 replace 之前拿到 archive 路径。路径要同时出现在 replacement 的 text 和 session.summary 里。
没有路径（archive 未提供或返回空）时，摘要文本与今天一致。
有路径时加一两行，说明这是被压缩掉的原文位置，只在摘要缺了具体代码或报错时再读。不要把归档正文塞进摘要。
如果 compact 的 archive 没返回模型能 read_file 的相对路径，让它返回这种路径，再让 auto-compact 写进摘要。

## compact-bot-secondary-tabs
精简 Bot 能力与权限及记录页

其他2个tab的也这么改一下

## compact-bot-settings
Bot 设置优先展示基本信息与已有定时任务

这个界面太臃肿了，核心信息全部被档到下面，定时任务新增应该要隐藏到二次弹窗里，已有的定时任务和基本信息在第一个tab里前置展示，其他的配置，非必要就隐藏或者折叠起来

## connector-authorization
Lab connector authorization states and SecretVault grant

The Lab Connectors panel shows a visible authorization state for every connector:
needsAuth (credential required, no SecretVault reference yet), needsGrant (a
reference is present, or no secret is required, and the user has not granted),
and granted. One-click grant posts only a SecretVault name or an existing
credential reference. Secret values never enter the grant record, the public
list, or the model prompt. The same grant is available on the chat surface:
a needsAuth or needsGrant card shows Grant, and Grant posts only a SecretVault
name to the existing grant route.

## context-reliability
持续对话的任务保真与历史记忆找回

那你分多个agent， 去把需要做的任务都完成，然后做一下回归和验证

## context-send-ceiling
压缩先于发送上限，任务事实有上限，已保存的 32768 生效

Fix:
6. A canonical bot turn must not fail with context-length exceeded before the 50% compact tier can run, on the default 131072 window and on a small window. Compact first, then apply the send ceiling. Do not delete the latest user message. Do not change the 20% normal-session cap or the 50/85 ratios.
7. Task facts injected into the system prompt need a hard size cap so they cannot by themselves blow the normal-session 20% pin set and force the whole history to be sent. Keep the latest user message.
8. A saved fallback context window of exactly 32768 must be honored if the user saved it. Do not treat 32768 as an unsaved placeholder anymore (the old placeholder bug). Default when unset stays resolveMaxContextTokens (131072).
No new RAW_AGENT_* feature flags. Acceptance-first, user asked to fix now, tests first.

## conversation-date-clock
续聊时日期跟现在走，不跟历史里的旧日期走

我发现一个问题，bot对于对话中的日期很不敏感，如果历史对话里有日期了，过几天回来对话，一般日期都会不对，这个问题怎么解决？深度分析一下，然后分多个Agent去修复这个问题

## conversation-loop-defaults
对话默认行为要进入新对话和正在跑的普通对话

检查设置页「对话默认行为」里的配置，以及这个页面里的配置是否都生效了。感觉没有生效；而且改了「工作中发来新消息」（新消息是否转向）也没有办法保存。
这一页有：默认任务模式、默认技能范围、重复检测、工作中发来新消息。底部写着「已保存，立即生效」。
找出这四项各自是否保存且生效。存不住的要能保存并在刷新后还在；标了立即生效但运行时不读的，接到现有读取路径。已经生效的不要改行为。若「已保存」在请求失败时仍出现，改成失败可见。
对话里系统气泡写着：执行已停止。[recovery] Stopped: tool "edit_file" failed 8 times in a row。用户把重复检测设成了关闭，问这样还会停吗？若是另一条规则，关掉重复检测不会放行这种连续失败停止；不要为了让这个例子继续跑下去而关掉失败熔断。

## correction-capture-hover
纠错转评测改为悬停图标

用户指着助手气泡旁一直显示的按钮「纠错转评测」（button.btn.btn-ghost.btn-sm，组件 CorrectionCapture），说这个太重了。改成 hover 才展示的图标，不要一直展示文字按钮。

要做成：
- 默认不显示「纠错转评测」文字，也不占一行。
- 鼠标悬停这条助手回合（气泡或标签行）时，才出现一个小图标。键盘聚焦到这条回合时也能看到，避免只能用鼠标。移开后图标消失。
- 点图标仍展开原来的表单，保存、字段、出现条件都不变：正在输出的消息、用户消息仍然没有这个入口。
- 图标要有可访问名称，文案走 i18n，不要硬编码新的中英文。不要改评测保存逻辑。

## create-menu-trigger-hit-area
新增菜单展开后按钮仍可点击

按你分析的优先级，把这七个问题完整修掉，补齐跨状态、跨执行入口和跨用户的回归测试，再审查一遍整个链路，没问题就提交 PR 合并。

## daydream-tick-cost
每日复盘调度不能拖死 daemon

怎么我本地的bot都不显示了？赶紧看看可能是其他agent搞的

## default-super-bot
默认 Super Bot 的状态查看、派工与结果汇总

我觉得有几个关键点，你补充分析一下：一个bot是可以持续一直对话的，他的记忆和历史会话管理，现在是否能满足，定时任务，以及跟其他bot的通信的模式，组群会话的能力是否能支持，以及调用各种其他软件的能力，这几个点先补充一下，然后bot模式可以先默认加一个super bot，作为老大，他可以管理以及和任意的bot通信，分多个agent去完成这个分析

## delete-page
Delete library pages and revoke public shares

Implement the smallest correct cut for r5-5 delete_page (store/port delete + admin DELETE /api/library/pages/:id + tool delete_page; share read 404 after delete).
Run focused unit + acceptance tests for delete_page (delete then list omits; get/share 404; missing id fails without mis-delete; admin DELETE; public share read-only) with nice and low concurrency.

## delivery-quiet-hours
用户可见外发的全局静默时段

UserDeliveryPort 是用户可见外发的唯一出口。配置了全局静默时段后，窗口内不立即发送，
而是暂存（保留人工批准），窗口结束后自动发出；窗口外与未启用时行为不变。
Add a Lab settings card for delivery quiet-hours, wired to the existing UserDeliveryPort quiet-hours API.
Lab UI shows a settings card where the user can view/edit quiet-hours (enable/disable, schedule/window as the API already supports).
Card reads/writes only through the existing quiet-hours API. i18n zh+en.

## desktop-preload-typecheck
桌面预加载脚本通过类型检查

分多个agent去彻底解决这几个问题

## desktop-safe-update
客户端手动一键更新、备份与失败回滚

那你帮我把一键更新做出来，更新前自动备份，保留我的正式数据，失败能回滚，由我点击更新才执行。

## dev-lab-process-cleanup
开发启动器退出时完整清理子进程

之前开发启动器退出后残留 Next 子进程、重启端口漂移的问题修好了吗？没修好的话继续修，补上回归测试，review 通过后合并，再验证本地重启。

## dev-tailnet-https
本地启动自动同步 Tailnet HTTPS

把 HTTPS 和 Tailscale 访问整合到项目启动流程里，以后 pnpm run dev 启动就能直接访问，端口变化也自动更新转发地址。别泄露隐私

## discovery-default-on
能力发现总开关默认开启

能力发现 / tool_search 的总开关要默认开启。

## email-webhook-replay
邮件事件不能靠换投递号重放

Fix: email webhook HMAC must cover X-Ppeng-Delivery (or equivalent delivery id) the same way GitHub now covers delivery id. Replaying within 5 minutes with the same signature and a new delivery id must not wake a second routine. Do not weaken Slack or the GitHub format from #114. No new env vars. Acceptance-first, user asked to fix now, tests first. Open a PR and merge when the relevant checks are green. Do not publish npm. Do not edit browser, cron secretEnv, compact, or the web console.

## execution-log-analysis
执行日志能查出问题并指到具体调用

帮我看看现在的agent的执行日志是否记录完成，我想要构建一套基于日志分析agent行为，发现问题，自己去排查问题，解决问题，提升整体能力的方案，分多个agent去帮我检查，如果没有就分多个agent去快速补全

## experimental-settings
设置里的实验特性菜单

用户刚得知 Jev 评估藏在「设置 → 集成与可观测 → 显示高级」里，说这样太深了。要求：把这些高级配置单独抽一个配置菜单，名字叫「实验特性」。

先读设置信息架构：apps/web-console 的 nav（lib/nav.ts）、设置分类 sections/settings/categories/*.tsx、advanced 默认隐藏的机制、doc/UI_REDESIGN.md 里和设置相关的部分。弄清现在哪些条目被标成 advanced、入口在侧栏还是设置内部。

要做成：
1. 有一个一眼能看到的配置菜单，文案是「实验特性」（英文 Experimental）。不要再要求先打开「显示高级」才能看见这些配置。
2. 现在被 advanced 收起来的设置项（含 Jev 评估，以及同一套 advanced 机制里的其它高级项）挪进这个菜单。原位置不要留空壳重复入口。若「显示高级」只是为了露出这些项，挪走后这个开关也不要再挡路；如果它还控制别的东西，只把实验项移走，其余行为保持。
3. 菜单放在现有设置导航里，作为和「模型」「集成与可观测」同级、默认可见的一项（hash 路由跟现有 #/settings/... 一致）。不要新造一套与 Lab 导航无关的页面，也不要只在搜索里才能找到。
4. 文案走 i18n，zh 与 en 同一套 key。不要硬编码中英文。不要新增 RAW_AGENT_*。
5. 只搬入口和分组，不要改这些配置的保存、字段和生效逻辑。

后续：实验特性里每一项都要能一眼看出开/关，并且有自己的开关。每一项一行：名称、一句它做什么、一个开关。关：这项不生效（Jev 就是不调用，等同关闭档）。开：这项生效，它自己的配置出现在这一项下面（Jev 的地址、Key、档位仍用现有保存逻辑）。已有关闭/精简/标准这类档位的，菜单上的开关是总闸：关=不调用；开=使用该项里保存的档位，若保存的档位本身是关闭，打开开关时落到该项原来的默认启用档（Jev 用标准）。持久化走现有 Lab 配置，不要新增 RAW_AGENT_*。上面第 5 条「不改生效逻辑」由这一条代替。

## external-agent-bots
Bot 级外部 Agent 通信

那就先把前两项补齐：Bot 级入站授权和路由，以及统一的外部 Agent 连接与派工工具，配置走 Lab UI。按项目规范实现、测试、review，通过后提交 PR 并合并。

## external-agent-task-handoff
外部 Agent 任务交接

我想要这个部署的服务可以被任意的agent通信、调用传递任务，比如把grok bot里的bot的任务都交接过来，这个可以做到吗？

## feed-reading-anchor-boundary
对话侧栏调整保留实际阅读位置

按你分析的优先级，把这七个问题完整修掉，补齐跨状态、跨执行入口和跨用户的回归测试，再审查一遍整个链路，没问题就提交 PR 合并。

## fold-visible-history
折叠历史保留用户问题

Under the token budget, do NOT hard-slice history to MAX_VISIBLE_MESSAGES (24).
Count cap must not drop the latest user message.
Always keep the original system prompt and the latest user message.
When a cut is required, cut only on a closed tool wave (assistant tool_calls plus
matching tool results). Never leave a leading orphan tool message whose assistant
tool_calls was dropped.
If a prefix must be dropped because the token budget is exceeded, use the existing
autoCompact summary path; if summary fails, fall back to pin-user + closed-wave,
never the old blind slice.

## gateway-im-security
IM 网关入站安全（验签、去重、白名单、Bot 路由）

实现 P0 网关修复：(1) 飞书消息事件必须校验 token/签名（不止 URL 验证），伪造事件（如 header.token=WRONG）返回 401/403；
(2) 飞书事件按 event_id 去重并立即 ack，agent 异步执行，飞书重试不能导致重复执行；
(3) 网关 sender 白名单；企微 bridge 必须配置 secret。配置走 Lab UI / 持久化设置（daemon_control KV / PATCH settings），不新增环境变量。
若成本低，网关路由支持 botId，让 IM 对话落到 Bot 的 canonical 会话（P1）。

## github-webhook-replay
GitHub 事件不能靠换投递号重放

Fix: a GitHub webhook must not run a second routine just by changing X-Github-Delivery while reusing a valid body signature. Include the delivery id in the signed material or reject reuse of a delivery id, and reject stale deliveries (a few minutes, same idea as Slack/email). Do not weaken Slack/email. No new env vars. Acceptance-first, user asked to fix now, tests first (replay with a new delivery id must not enqueue). Open a PR and merge if relevant checks are green. Do not publish npm. Do not edit compact, software egress, precheck, or the web console.

## global-debug-visibility
全局调试信息开关

这种内部机制的内容，全局加一个调试开关，开启才展示，不开启就关闭，这个开关默认关闭，这个开关配置存到到库里，下面的目标与进展也是一样的的处理逻辑

## global-default-model-clarity
全局默认模型配置与群聊模型来源可见

群聊里没有模型选择，都是用的什么模型？是bot里配置的？感觉有点混乱，可以加一个配置，设置全局默认模型，从已有列表里选择

## global-default-model-row-align
全局默认模型行左右对齐

这个左右都没对齐

## hide-approval-continue
聊天不展示审批自动合成的续跑用户消息

审批后系统合成的 user 消息「Approval for <tool> was approved|rejected. Continue.」
仍送给模型，但聊天 UI（历史与即时）不展示。

## hide-dev-overlays
本地页面不展示开发浮层

我想要本地web页面不显示这个next的调试工具，还有右边的4Issue也不要展示，怎么搞

## history-startup-contention
后台调度期间打开历史会话

现在我看刚才启动网页，拉取历史会话的时间还是特别长，帮我排查下原因，看看是否可以进一步提升，甚至可以加本地部署的其他中间件来提升这个性能，深度研究下，另外告诉我现在的日志记录是否完整

## jev-model-settings
在模型设置中配置 Jev 评估

这个开启了也没办法配置了，这个应该放到模型配置里吧？

## knowledge-library-dirs
本地资料目录进入知识库并可检索

把本地目录（他持续收集资料的文档库）加进现有知识库，让对话里的 agent 真能检索到，并且目录更新后索引跟上，形成闭环。
1. Lab「知识与记忆」里可以添加、移除本地目录。用这台电脑的文件夹选择对话框挑选，可以添加多个，不要手填路径。持久化到现有配置（daemon KV / 知识库或 ingestion 设置 API）。禁止新增 RAW_AGENT_*，禁止把私人路径写进仓库。
2. 目录文档进入现有索引。对话里的 agent 能检索到。若现在检索工具存在但模型用不上，把它接到对话回路。
3. 目录里文件新增、修改、删除后索引跟上（监听或保存后刷新，不要求改 .env 或重启）。删掉的文件不再被检索到。
4. 跳过 .env、id_rsa、credentials 以及已有 isBlockedPath。只索引用户明确添加的目录。
5. 文案 i18n，zh 与 en 同一套 key。不要新开导航。
本次改为：这里要能打开他电脑上的路径选择器来选文件夹，不要手动输入；而且可以添加多个路径。
1. 点按钮打开本机文件夹选择对话框（macOS 用 daemon 调系统选择文件夹，返回绝对路径）。浏览器的 input webkitdirectory 拿不到 daemon 能索引的绝对路径，不要用它冒充。这是本机 Lab，对话框必须出现在用户这台电脑上。无图形界面或用户取消时，给出 i18n 错误/取消，不要写进列表。
2. 可以添加多个目录。每选一次追加一个，不要覆盖已有。列表里能逐个移除。重复路径不要加两次。空列表仍有现在的空状态。
3. 去掉手填路径作为主路径。不要留一个必填文本框。选择后沿用现有保存和索引（立即索引、文件变动监听）。
4. 文案走 i18n，zh 与 en 同一套 key。不要新增 RAW_AGENT_*。不要把用户私人路径写进仓库。
5. 选择器 API 只给已登录的本机 Lab 用，不要变成远程替别人弹窗或读任意路径的漏洞。只索引选中的目录，继续跳过密钥文件。
用户看着本地资料目录列表说「没对齐」。每一行同一高度。路径靠左，从同一条左缘开始；「移除」固定在右侧同一列，两行的按钮左缘/右缘对齐，不要跟着路径长短乱跑。路径和「移除」在行内垂直居中。路径过长时单行省略，不要把按钮挤到下一行或撑歪行高。列表本身和上方「选择文件夹」按钮、卡片内容区左右对齐，不要单独缩进或凸出。

## lcu-app-grant
桌面操作应用授权：全自动免审批，批准一次后同会话记住

Super Bot 全自动（permissionMode=bypass）会话里反复弹「Allow Computer Use to use "Voice Memos"?」，
批准后同一应用的下一个动作又再申请。全自动下不该再弹；需要审批时一次批准后同会话同应用不再申请。

## lcu-computer-use
本机 LCU 桌面操作接入

那你去接一下

## lean-default-skills
精简默认技能并保留按需发现

按刚才的建议把默认的 skill 精简一下，重复的合并，其他的保留搜索加载入口，bot 自己创建的 skill 不要动

## live-bot-quality
真实 Bot 任务评估与版本准入

那就直接落地这套真实模型任务评估和新旧版本对照门禁，先把这次 P0 问题和常见任务做成评估集，用当前配置的 Grok 模型跑一轮基线，做好测试和 review 后提交合并。

## local-source-unlock
本机只读命令在批准后能真正执行（来源范围审批匹配、审批卡、已保存 direct 不再 Auto-review）

Bot 读本机数据（如语音备忘录）时，bash 输出带 «external» 标记会让会话进入「已暴露」状态，
之后的有副作用工具需要已保存来源范围或对这次精确调用的批准。现状三处缺陷让批准永远无效：
1) Auto-review 审批卡存的是去掉 requestSmartModeApproval 等升级标志的参数，来源范围检查却拿原始参数比对，批准后 1 秒仍 source_scope_denied；
2) 来源范围拒绝时不出审批卡，提示「approve this exact call」却没有可批准的东西；
3) Lab 已保存隔离方式 direct 时，模型显式写 isolation:"direct" 仍被 Auto-review 当高危拦截，与「保存 direct 不再为这一项单独审批」矛盾。

## login-mandatory-skill
捆绑 login 强制技能可加载并解锁登录面

Repo ships skills/login (SKILL.md + sibling Manifest). load_skill(login)
unlocks collect_credentials / vault_get; without load they stay fail-closed.
Skill body states Vault → Secure Form (vaultEntryId/entryId) → Secure Form
hand-fill → handoff; no plaintext to model; separate from browser vault_fill.

## long-session-compact
长会话能真正做摘要而不是只丢历史

长会话大量 compact_skipped reason=context_budget，真正的 compact 很少，
fold_budget_drop 把历史硬切到大约 8 条。应让自动摘要在长会话或历史已经超过
发送上限时发生，而不是每轮都记 context_budget。不要改 loop_settings，
也不要降低普通会话原来的 token 压缩阈值。

## loop-guard-model-switch
重复检测默认只约束弱模型

另外，我觉得 agent 的重复判断是不是过于严格了，我经常使用着，他就说多个工具重复，然后把 agent-loop 断开了，看看是否可以放松一点，还有使用查看文件的限制，好像也过于强了，你要么加个开关，我觉得目前重复检测可以只针对弱的模型，这样我可以通过开关来控制，同时放开强模型的能力

## loop-native-media
SDK 原生多模态文件理解

那就把 agent-loop 原生调用全模态模型解析图片、音频、视频文件的能力补齐，同步更新 SDK skill 和测试，审查通过后提交并合并。

## loop-prefix-cache
稳定前缀和技能目录不在每轮重做

长会话每轮都重做 skill_catalog、system_prompt、prepare_view、memory_appendix，
pinnedTokens 经常到 15k–21k，把约 26k 的请求预算吃掉大半。
输入没变时不要重做稳定前缀和技能目录；任务模式要收窄列进提示词的技能，
避免固定前缀占满请求预算。不要改 loop_settings。

## low-interference-onboarding-goals
仅向新用户展示首次引导并隐藏少量目标面板

这个不要每个bot第一次创建都搞一个，判定是新用户才加这个，如果不是就不要搞这个了
没有目标或者少于2个目标的时候，目标与进展可以不展示，减少干扰

## mac-retina-text-readability
Mac Retina 屏幕文字可读性优化

主要是文字偏小、发灰，你帮我优化一下 Mac Retina 屏幕上的文字显示效果，先按项目要求写验收标准。

## macos-app-control
macOS 应用控制（外层宿主）

User decision: macOS “App A wants to control App B” (Apple Events / Automation TCC, the Grok Bot → Cursor dialog) should live in the OUTER host and be injected as tools. Do NOT put osascript, Accessibility, or Apple Events inside packages/agent-loop. The loop may only see tool names and results. Existing LCU (lcu_js / lcu_js_reset, requires a local lcu binary and signed ChatGPT app) stays as-is.

Add a sibling outer-layer capability in packages/core (computer-use or a small app-control module):

- Default OFF. Persist in daemon_control KV (same style as computer_use_settings). Lab settings toggle, i18n zh+en. No new RAW_AGENT_* env.
- Model-visible tools are narrow and fixed, not arbitrary AppleScript. Suggested: activate a named app, type text into the front app, send a keystroke (small allowlist: return, tab, escape, arrows, cmd-c/v). The host fills a fixed osascript template. Reject any tool argument that looks like raw script, do shell script, or a URL scheme.
- macOS only. On Linux/Windows the tool returns a clear unavailable error and does not spawn.
- First use will cause the normal macOS TCC dialog; do not try to pre-grant or bypass it. Lab approval still required before the host runs the osascript (same spirit as LCU: approve this action, not a permanent silent grant).
- Spawn via sanitizeSpawnEnv with a minimal env. No network.
- agent-loop: at most add the tool names to an allowlist constant if that is the existing pattern for host-implemented tools (see how lcu_js is named). Do not import node or osascript from the SDK. If you touch SKILL.md, one sentence: app control is a host tool, not in the portable loop.

## mandatory-skill-gate
高危面必须先加载对应技能

Shopping, login, outbound-send, payment, and site-playbooks tools fail closed
unless this session has successfully load_skill'd the matching skill (or a
loaded skill Manifest declares that name in requiredSkills). Ungated tools
are unchanged. After the skill is loaded, the tool still goes through
Auto-review and any active Manifest allowTools ceiling (and URL refuse for
browser_navigate).

## memory-deletion-suppression
删除记忆后阻止自动写回

先按你建议的顺序推进第一批：记忆删除抑制、严格预检、定时任务故障治理。按仓库的验收优先流程，先写验收标准给我确认。

## micro-compact-stub-wording
微压缩占位只说明工具输出被省略

In packages/agent-loop only, change the micro-compact tool-result stub
(formatToolResultStub / microCompactMessages, session/tool-result-stub.ts and
session/micro-compact.ts) so the placeholder does NOT say the user context or
"output dropped from context" in a way the model tells the user the conversation
was compressed. The stub should say the earlier tool output was omitted to save
space, and keep tool name / ids if those are already there. Do not change
fold-budget.ts, kernel.ts, or prepare-view.ts (another worker owns the 24-message
slice).

## mobile-chat-density
窄屏对话区优先展示聊天记录

竖屏对话页被固定区占满，中间聊天记录只剩一条窄带：
1. 顶栏「会话列表」
2. Bot 信息条（头像/权限/详情/目标历史/空闲·全自动/费用·token/Trace）
3. 大块「目标 待核对」卡片
4. 底部「目标与进展」折叠条 + 输入框 + 主导航（Bot/对话/…）
窄屏（≤760px，已有 apps/web-console/styles/mobile.css）优先展示对话内容。固定区默认更矮/折叠/可展开；桌面宽屏尽量保持现状。不改业务逻辑、不降功能可达性。
建议改动方向（可自研更好方案）
- apps/web-console/styles/mobile.css、PlayPanel.tsx、BotFace.tsx、shell/*、相关 css
- 手机默认：BotFace/目标卡收成一行摘要；「目标与进展」默认收起；减少 sticky 堆叠高度
- 对话 feed 用 flex:1; min-height:0 吃掉剩余视口

## mobile-console
控制台移动端布局

当前项目的移动端适配完全不行，帮我设计、优化一下移动端的展示

## model-fallback
备用模型自动切换

主模型的上游临时故障时，对话能自动换到用户事先排好顺序的备用模型继续完成，
而不是直接报错；鉴权这类不是临时性的错误不应被掩盖。

## model-retry-progress
临时模型故障延长退避并展示重试进度

那就把这块改一下，临时模型报错别这么快就停，延长重试退避，界面显示重试进度。先按验收优先写标准给我确认。

## model-sandbox-isolation
命令隔离由对话里的 Agent 自己选

而且沙箱的隔离方式，应该是都提供，让模型自己选的啊，而不是都要人去设置，这个理解成本太高了吧？

## necessary-tool-injection
只把当前任务需要的工具定义交给模型

减少无效工具注入，只注入必要的工具

## no-windows-desktop-pack
不再打 Windows 桌面安装包

修隔离测试，如果windows不能用，就不要打windows包了

## normal-session-request-budget
普通会话请求不超过窗口的 20%

User decided: normal sessions must keep the final model request at or below 20% of the model context window. Bot canonical sessions stay on the existing 50% / 85% compression. Do not change bot thresholds.

Implement for normal (non-canonical-bot) sessions:
- Measure the request that will actually be sent: system + tool schemas + messages, divided by the resolved context window (default 131072). Cap is 20% (about 26214 tokens when the window is 131072).
- Apply after micro-compact, before the adapter call. Under the cap: send as-is.
- Over the cap: drop older closed tool waves first (tool_call stays paired with tool_result). Keep the leading system prompt and the latest user message (memory appendix on that message stays).
- If still over, summarize the dropped prefix with the existing compact path. If summary fails, do not fall back to a blind 24-slice.
- If the pinned pieces alone exceed 20%, stop dropping, send the turn, and record a trace that it is over budget. Never delete the latest user question to hit the number.
- No new RAW_AGENT_* env. A constant or existing daemon_control/Lab setting defaulting to 0.2 is fine. Do not add a visible settings toggle unless one already exists for compact.

## npm-auto-publish
公开 npm 包自动发布

增加自动 npm 发布的 GitHub Action，对照 hyper-vibe-kanban。能在仓库里做完的都做完，并列出必须由维护者自己完成的事（npm 登录、trusted publisher、secrets、第一次手动发布）。只发布已经公开的包。不要在这次改动里自己改版本号或真的执行 npm publish。

## ops-console
运维页：系统健康总览与轨迹浏览

控制台「运维」区要清晰：健康状况一眼可见；会话轨迹（trace / trajectory）容易浏览与筛选；
自愈状态看得懂；有效配置可读。减少噪音，渐进披露（默认摘要，需要时再展开细节）。
Evolution 从产品可达路径拿掉：不显示入口，也不自动运行。

## ops-session-trace-repair
运维会话轨迹能定位没看过的对话

上一轮结论是：运维会话轨迹不够。用户说「那你就去补上啊」。补的是下面这 5 项「缺了会修不了」，不要顺手做「有了更好」里的模型调试日志页面、toolCallId 耗时、会话列表父会话标记，除非为了这 5 项必须碰到。

1. tool_end 写上工具参数和失败正文。现在只有工具名和 ok。失败时要能看到命令/参数和报错（stdout/stderr/异常里真正的错误）。成功时参数也要在，结果正文过长就沿用会话消息已有的头尾保留、中间省略（约 12 万字那套），不要整段无限写入。
2. 轨迹里要有用户话和助手正文。空转、截断要能看到复读了什么、断在哪一句。不要把整份 prompt 或系统提示倒进去。只记本轮用户可见的用户消息和助手输出。过长同样头尾保留。
3. spawn_subagent / 会创建子会话的工具，在轨迹里记下子会话 id，能对上另一场轨迹。goal 续跑、concurrent-bot-work、botGoalWorker 若已有子会话，也要能从父轨迹找到子会话 id。
4. 运维页面不要只拿最后 500 条。读取上限已是 5000，页面要用上，避免 134 轮这种场次把开头静默丢掉、统计变小。若 5000 仍不够，不要静默截断：页面上要能看出「还有更早的记录没显示」。不要为此新增 RAW_AGENT_*。
5. 目标没达成要能看出来：goal_eval.met=false 计入出错/可筛选，并带上目标原文（或标题）和拿去评判时的那句 reason。reason 仍是「goal not met」时，至少让人知道目标是哪一句。

密钥沿用现有 result redaction，写成 [REDACTED:名字]，不要把 .env / token 原样写进 events.jsonl。
用户可见的新文案走 i18n，zh/en 同步。禁止新增 RAW_AGENT_*。

## outbound-draft-edit-identity
外发草稿可编辑预览，并显示将以哪个身份发送（Draft → Confirm → Send 之上）

P1-B（接在 #307 之上）：用户在批准发送之前，可以修改待发草稿的预览文字，并清楚看到这条消息会以哪个身份发出。
仍然必须由人确认才发送，不新增任何静默发送路径。不新增环境变量。

## outbound-send-mandatory-skill
捆绑 outbound-send 强制技能可加载并解锁外发面

Repo ships skills/outbound-send (SKILL.md + sibling Manifest). load_skill(outbound-send)
unlocks schedule_social_post; without load it stays fail-closed. Skill body forces
Draft → Confirm → Send; may remind style sampling; NEVER send without confirmation.

## outbound-style-sample-hint
外发前建议先采样同渠道近期消息，只提示语气，不改已编正文

r4-6（接在 #326 之上，只做选项 A）：外发前可选采样同渠道近期消息 → 提示语气；不自动改写用户已编正文。
在批准并发送之前，给出不阻断的提示，建议先采样该渠道最近几条消息，好让草稿更贴近用户在这个渠道里的口气。
提示只是建议：不阻止批准并发送，不自动改写草稿正文，不把风格提示词写进正文，也不把样例摘要附进草稿。
点开后最多给用户看几条同渠道近期消息供扫一眼，仍然绝不改写正文。不新增静默发送路径，不新增环境变量。

## outer-skin-picker
外层外观设置可选中

外层的主题设置的按钮坏了，选择没反应。

## page-revisions
Page revision history (list / get / restore)

Append-only Page revision archive so edits are recoverable via DurablePagePort,
assistant tools, daemon admin HTTP, and a minimal Lab Knowledge Pages history
list. Align capability with Grok EditCanvas history — NOT a canvas/grok UI clone.

## page-share-html
Public library page share HTML (read-only)

Implement the smallest correct cut for r5-7 public library-level Page read-only share HTML.
pageSharePath(shareId) is /pages/${shareId}. Humans opening that path must read title + body
as sanitized HTML without login. After rotate/delete, old shareId returns 404. No edit/delete/
rotate controls. No canvas / grok visual clone; keep a plain document.

## page-tools
助手可调用的库级页面工具

Add assistant-callable library Page tools wired to DurablePagePort so the agent loop can create/list/get/edit durable Pages — product bar = Grok WriteCanvas/ListCanvases capability parity for tools. Do NOT clone Grok/canvas visual UI.

Tools:
1. list_pages — summaries only (id, title, revision, sharePath/shareId; NO body)
2. get_page — by id (optional shareId) → full page incl. markdown
3. write_page — create(title, markdown) → { id, revision, sharePath }; reject empty title
4. edit_page — update(id, title?, markdown?) → monotonic revision; share path stable across edits

## payment-mandatory-skill
捆绑 payment 强制技能可加载并解锁支付面

Repo ships skills/payment (SKILL.md + sibling Manifest). load_skill(payment)
unlocks secure_form/vault_fill when touching cardNumber/CVV/card; without load
they stay fail-closed. Secrets NEVER enter the model; separate from login Secure Form.

## pm2-service
用 PM2 启动并管理服务

帮我加 ecosystem 配置和 pm2:start 脚本，然后用pm2启动和管理

## pnpm-migration
全仓库迁移至 pnpm 并完成回归

那就整体迁移到pnpm，做好回归

## pr152-approval-followups
Consistent approval decisions and cancelled parked work

Implement these 4 small follow-ups in this repo worktree. Do not commit or push, no env-var flags, do not deploy or restart anything.
Make the permissionMode approval path use latest-record-wins consistently with the hook path (createdAt ordering), preserving existing test expectations where they encode intended behavior; add a test where a later approval after a rejection is honored.
Cache latestMatchingApproval once per wave the way sessionApprovals is.
Assert that cancelling a parked session also rejects the pending approval record.
Add a comment noting that the createdAt >= string compare relies on ISO 8601 lexicographic ordering.
Run the packages/agent-loop tests and build, plus packages/core bot-work test. Report per item.

## prd-test-trace
产品需求与测试对照

按这个做对照表、核心用例和命令

## product-prd
产品需求目录

我想要在readme之外，构建一套产品的prd体系，一个是现有的功能的说明，一个是开发了具体哪些feature，还有未来待开发的功能的特性，然后还有一个这个项目使用的skill也要同步的配套更新，分多个agent去完成这几件事情

## quiet-goal-results
目标结果不再默认要求人工核对

还有个问题，这个目标列表，老是让我审批、审批，要审批和核对什么？如果非必要就去掉类似的询问的功能

## rail-foot-menu
侧栏底部收成悬停菜单

你在仓库 /Users/penglei/developer/self-test-grounding/ppeng-agent-core。用户指着左侧栏底部 div.lab-rail__foot（组件 Rail），里面现在铺开了「配置模型」、语言「中文 / English」，附图里同一块还有几个图标。他说这几个放到一个 hover 菜单里，不要搞这么大的占位。

要做成：
- 默认底部只留一个小触发按钮，不要把配置模型和语言选择铺成大块。
- 鼠标悬停（以及键盘聚焦，避免只能用鼠标）时展开菜单，里面仍是原来的「配置模型」、语言切换，以及这个 foot 里现有的其它按钮。点「配置模型」和切换语言的行为不变。
- 菜单不要撑高侧栏。移开鼠标和焦点后收起。
- 文案继续走 i18n，不要硬编码新的中英文。语言按钮仍显示语言自称（中文 / English）。
- 不要改模型配置页本身，不要新增环境变量。

## rail-foot-theme
侧栏底部主题按钮能切换

点击左下角的theme点击还是没动静

## rail-settings-icon
侧栏设置入口使用设置图标

用户点了左侧栏的设置入口，要求这里用设置按钮/设置图标，不要现在这个太阳。
#nav-settings 显示设置图标（齿轮或项目里已有的 settings 图标），不要太阳。
太阳如果是主题切换，它应该留在自己的控件上，不要占设置入口。
折叠侧栏只显示图标时，设置入口必须是设置图标。展开后的文字「设置」保持 i18n，不要硬编码新的中英文。

## recap-content-only
回顾有内容才展示

如果没有回顾，就不要展示，只加一个主动回顾的按钮就行了，另外回顾逻辑给我说一下

## recap-next-action
回顾之后推荐下一步行动

还有个问题，在recap的后续，其实可以把之前自动建议下一步行动的那个功能串联上，让模型给出下一步的的行动建议推荐

## recap-request-lifecycle
主动回顾正常生成与取消

这个点击也是失败的，查一下问题，我点了主动回顾，也返回这次没有回顾成

## refresh-keeps-agent-run
刷新页面不终止正在进行的对话

刷新页面，按道理不应该把 agent 终止的，怎么刚才我刷新页面，就说 agent 终止了，这个也要处理一下。

## registered-machine-desktop-agent
Desktop agent long-connect for personal registered machines (non-SSH)

Personal registered machines can connect via a long-lived desktop agent attachment
(DesktopAgentHub + createDesktopAgentBackend), without Factory SSH and without
requiring an sshAlias. When an agent is attached, list/shell/read/copy work through
the agent handlers. Composite backend prefers the agent over the SSH Host-alias
backend. Offline / detached machines fail closed.
A desktop agent in another process can keep that same attachment over the daemon's
HTTP/SSE channel: opening the event stream marks the machine connected, shell/read/copy
are delivered as events on that stream, and posting a matching reply completes the op.
Closing the stream or an explicit detach marks the machine disconnected and fails any
in-flight op. This path never uses Factory SSH.

## registered-machine-live-backend
Live SSH backend for personal registered machines (not Factory SSH)

Personal registered machines work end-to-end: register (with an ssh alias) -> list ->
shell/read/copy. Transport is the user's own ssh client config (BatchMode, strict host
keys) driven by a RegisteredMachineBackend that is separate from FactoryTransport.
Offline, unregistered, or alias-less machines fail closed. Remote ops need approval.

## registered-machine-phone-local
Phone registered machines via device-local tools (non-SSH, read-only default)

Personal registered machines of kind phone show up on list_machines with their
deviceLocalTools. Connectivity is a DeviceLocalHub attachment, not createSsh and
not Factory SSH. The r5-1 slice is read-only: read_file / backend read dispatches
to the phone handler and never spawns ssh. Shell and copy stay closed
(device_local_readonly) unless the attachment opts in AND device_shell / device_copy
is available. Detach and sensitive paths fail closed. Factory settings stay untouched.
A phone in another process can keep that same DeviceLocalHub attachment over the
daemon HTTP/SSE channel (its own device-local stream, not the desktop-agent stream).
Opening the stream marks the phone connected. list_machines and read are delivered
on that stream and complete from a matching reply. Shell and copy stay gated the
same way as an in-process attach: no opt-in yields device_local_readonly, and a
tool that is not available yields device_local_tool_unavailable. Sensitive paths
are refused. Closing the stream or an explicit detach marks the phone disconnected
and fails any in-flight op. This path never uses Factory SSH.

## remotevm-no-host-downgrade
microVM 命令不会悄悄改在宿主机上跑

Fill gaps so enforcement is fail-closed (no silent host downgrade for high-risk tools; no skill tools/paths/network beyond Manifest; untrusted tool/web content cannot induce cwd/eval escape).

## remove-needs-confirm
列表里的移除需要再确认一次

会话或 Bot 行上的移除按钮第一次点击不删除，变成确认，再点一次才删除

## request-metric-follows-turn
已发送请求指标随所选轮变化

这里要跟着下面拖动的会话轮数显示对应轮的请求token啊

## risk-advisory-ui
对话里的运行策略提醒

这种是什么？为什么会有这个提醒？算警告？给他先加个ui，然后分析下他警告的是否合理，我看这个最近挺频繁的

## room-task-collaboration
群聊临时负责人任务协作模式

按你说的方向改吧，先把目标的两套状态和展示统一起来，完成或失败的保留历史但别一直挂底部，再把重复调用检测改成看有没有实际进展。Jev我已经恢复了，不用管了。群聊组织模式，可以按你说的再新增一种模式，我对比看看执行效果。

分多个agent去推进

## rotate-page-share
Rotate library page share links without deleting content

Implement the smallest correct cut for r5-6 rotate_page_share (store rotate share_id + DurablePagePort.rotateShare + admin POST /api/library/pages/:id/rotate-share + tool rotate_page_share; old share 404; page+body kept; pick and test revision policy).
Run focused unit + acceptance tests for rotate_page_share (rotate keeps page+body; old share 404; new share works; missing id fails cleanly; revision policy asserted; admin POST rotate-share; public share read-only) with nice and low concurrency.

## runtime-gap-closures
事件密钥、内置工具名、发布脚本环境、只读 MCP、HTTP 来源与幂等并发

Fix all of these:
3. Event/routine secretEnv must reject operator tokens the same way software connections reject RAW_AGENT_AUTH_TOKEN and RAW_AGENT_HUMAN_RELEASE_SECRET.
4. Reserved builtin tool names must include the remaining builtins that can still be shadowed, at least vision_analyze, plus any other builtin name that filterForSession would hide. Do not allow a connection to remove another session's builtin.
5. scripts/bot-release/http-soak.mjs and history-benchmark.mjs git/ps spawns must use sanitizeSpawnEnv (or an explicit minimal env), matching soak.mjs.
10. Honor McpExecutor.readOnly: read-only MCP calls must not be stuck in the write/unknown retry ban.
11. HTTP tool results must not be fenced as source mcp.
12. Concurrent duplicate idempotency keys must return the existing invocation, not throw a unique-constraint error.
No new env vars. Acceptance-first, user asked to fix now, tests first. One PR. Merge when relevant checks are green. Do not publish npm. Do not edit email HMAC, browser navigation, bot compact thresholds, or web-console bot panels.

## sanctum-skin
圣所外观可切换且不覆盖原主题

加个主题切换能力，能动态切换，免得我怕你搞烂了，然后就可以分多个Agent去先搞一版，我看看效果

## saved-sandbox-mode-constrains-shell
已保存的隔离方式约束 shell

1、SSH 被沙箱拦住了，这个我不是设置了沙箱用模式吗？为什么还会走沙箱的shell的模式？

## scheduler-db-lock
调度写目标时不再因数据库锁失败

[daemon] scheduler loop failed Error: database is locked
at MiscStore.setDaemonControl
at mutateGoalSnapshot
at BotGoalService.recover
at tickBotGoals
at RawAgentRuntime.runScheduler

## schema-upgrade-safety
数据库升级不丢数据

升级到新版本后，旧版本留下的数据库能自动升级并继续使用，会话、记忆等数据一条不丢。

## secure-form
对话里的单字段安全表单

用户在对话里填写一次性验证码、密码、卡号或 CVV，而不是走浏览器 vault_fill。
模型只收到填写状态和一条不透明的 uvref。明文只进 UserVault，不进模型上下文，也不进对话文本。
这条路径与 vault_fill（浏览器会话填表）和 SecretVault（连接器环境变量）分开。

## secure-form-multi
对话里的多字段安全表单

用户在对话里一次性填写多个验证字段（如卡号和 CVV），而不是分别填写。
模型只收到多个字段的填写状态和对应的不透明 uvref。明文只进 UserVault，不进模型上下文，也不进对话文本。
保持单字段向后兼容；多字段和单字段共用同一接口。

## secure-form-vault
Secure Form fill-from-Vault

Lab Secure Form card can pick a saved UserVault login or card entry and map fields
by match (username/password/otp, cardNumber/cvv). Daemon POST /secure-form accepts
vaultEntryId (and entryId alias) while keeping legacy value/values. Port resolves
uvref: server-side; receipts stay fillRefs; plaintext never enters the model or
transcript. Separate track from browser vault_fill.

## settings-categories
设置页「行为 / 安全 / 工具 / 集成」分类易用化

配置太多不好用。行为、安全与沙箱、工具与技能、集成与可观测这几类设置要按意图分组，
用大白话写清每一项是干什么的并显示默认值，危险或专家级选项收进「高级」，
保存 / 重置 / 未保存提示的交互要统一，并且都能被搜索到。

## settings-models-onboarding
设置：模型向导、首次引导、搜索与保存状态

让配置真正可用：模型配置做成简单的向导流程（选服务商、填 key、选模型、测试连接），
有合理默认值，高级选项放在开关后面；设置搜索要好用，保存/未保存状态要清楚；
没配置模型时给首次引导提示；登录页要精致；并增加网关/IM 设置卡片（飞书/企业微信的
token、encryptKey、secret、发送者白名单、botId），密钥永不回显。

## shared-chat-header
会话和群聊统一浮动顶部

群聊和普通会话的顶部也按这个方式统一一下，重复的按钮都收一收，保持整个 UI 一致

## shared-info-compact
共享信息紧凑入口

这里展示优化一下，太乱了，界面占用太多了

## shell-output-untrusted-fence
命令输出作为不可信内容围栏后再给模型

r3-7：bash / bg_run / work_evidence 的命令 stdout/stderr 与网页、MCP、IM 一样用 fenceExternalContent 包裹，模型不得把命令输出当成指令。

## shopping-mandatory-skill
捆绑 shopping 强制技能可加载并解锁购物面

Repo ships skills/shopping (SKILL.md + sibling Manifest). load_skill(shopping)
unlocks vault_fill / checkout-marked browser_click|browser_type; without load
they stay fail-closed. Skill body: read then dispatch; no plaintext; no Grok/Canvas
commerce UI clone; separate from login Secure Form track.

## sidebar-unified-menu
统一群聊和分组菜单

群聊的也按bot的加一个菜单，用类似的菜单
这个列表里很多功能都是重复的，看看哪些可以聚合，哪些可以放到一个统一入口，哪些可以放到更深的菜单里，让这个列表更清爽

## single-host-bot-completion
单机 Bot 工作收尾与默认入口

那就按你说的干，把需要补齐的补齐，太长期的可以先不做，短期也是单机部署

## skin-mode-adapt
非经典外观适配深浅色

除了经典主题，其他主题都没有适配深色、浅色的切换。

## slack-events-inbound
Slack Events 入站按线程唤醒例行任务

Slack Events 的用户消息要能进入 Agent 的会话，并按频道和线程区分。
监听 slack/message 的例行任务要被这条消息唤醒，而且知道消息落在哪个线程。
签名不对、过期、机器人自己的消息、以及同一条事件的重试都不能再跑一遍。
不新增环境变量；飞书入站保持原样；回复仍然先草稿，不直接发到 Slack。

## software-egress-reserved-tools
软件出站地址与内置工具名

Fix two issues only:
1. Software HTTP egress must block 100.64.0.0/10 (and otherwise match the repo's existing isPrivateOrReservedIp, including cloud metadata such as 100.100.100.200). Read-only calls must not be a way around that block.
2. A bot/software connection must not shadow builtin tools for other sessions. Expand the reserved names so at least grep_files, browser_screenshot, history_search, history_read, memory_read, message_agent, and cron_* cannot be taken. Binding a reserved name is rejected.

## startup-invariants-compact
启动时校验压缩策略、稳定前缀与重复守卫

Feature (minimal mergeable slice OK): Startup invariants for compact + stable prefix + repeatGuard (align with Grok改造 / ppeng-side concepts similar to ain #297; implement on ppeng only).

Context: compact settings in apps/daemon/src/routes/compact.ts + core compact settings helpers; stablePrefix / stablePrefixHash in packages/core/src/model/prompt-builder.ts and turn/kernel.ts (doc/PROMPT_CACHE.md); repeatGuard in packages/agent-loop/src/recovery/repeat-guard.ts and loop_settings (default weak).

Required outcomes:
1) On daemon/runtime startup (or first loop assembly), assert/normalize invariants:
   - compact settings parse to a valid effective policy (keep_recent/after_any_assistant/after_text_assistant) with sane keepRecent bounds; persisted UI settings preferred over defaults; no new RAW_AGENT_* switches.
   - stable prefix builder produces a non-empty identity+repo stable segment; stablePrefixHash is computed consistently for turn_start diagnostics.
   - repeatGuard resolves to weak|all|off (default weak) from loop_settings before the first tool round; invalid values fall back safely.
2) Fail closed or log+repair clearly if invariants are violated; do not silently run with undefined compact/prefix/guard state.
3) Unit tests for startup/invariant helpers (core and/or agent-loop). Keep slice small and mergeable.
4) No ain work. Avoid colliding #302-305. No force-push. Protect main.
5) Author magele758; every commit trailer Machine: 4090. Final acceptance by lei pending.

## stream-live-status
生成中的速度与正在做什么

[Image #1]  我想要在他生成的时候知道他在干嘛怎么办？加个交互，让我知道他的速度和在干嘛，另外这里的三个 ... 可以加点动效，免得太静态了

## stream-text-once
流式输出时助手文字只出现一次

你在仓库 /Users/penglei/developer/self-test-grounding/ppeng-agent-core 里排查并修复：对话流式输出时，经常出现重复的消息。直接改代码并跑相关测试。不要 commit，不要 push，不要重启 daemon。

现象：用户跟 bot 聊天，流式输出过程中，同一段助手文字会重复出现。不是偶发整页刷新，是流式过程中经常重复。

已知客户端拼接（先读再改，行号可能已变）：
- apps/web-console/components/usePlayChat.ts 里 applySseModelText：event===model 且 type===text_delta 时，把 p.text 追加到最后一个 text segment 的 raw。如果最后一个不是 text，就新开一段。reasoning_delta 同样追加。
- 同文件有 stream_reset：回滚到 turnCheckpoint。如果服务端先发了一段全文，又发 stream_reset 再发一遍，或 text_delta 里装的是累计全文而不是增量，界面就会重复。
- 不要假设只有这一处。也查：SSE 重连后把已播过的 delta 再播一遍；乐观消息和会话快照各渲染一次；同一 message id 插进列表两次；daemon 把 model delta 转发了两次。

要求：
1. 先定位重复是「delta 实际是累计全文」「同一 delta 发了两次」还是「同一条已完成消息又被列表渲染一次」。用代码路径说明，不要只猜。可以看 apps/daemon 的 SSE 转发和 packages/agent-loop 或 packages/core 里发出 text_delta 的地方。
2. 修到流式过程中同一段文字只出现一次。已完成的历史消息也不会因为快照再贴一遍正在流的内容。
3. 按仓库规则：先写 acceptance/<kebab-id>.yaml（status: approved）和带 [AC:<feature-id>#<criterion-id>] 的失败测试，再实现。只跑你改到的 node:test 文件。
4. 不要顺手改预算、回顾、子任务、启动 trace。工作区里已有这些未提交改动，保留它们，不要回滚，也不要在那些文件上再改，除非重复 bug 的根就在其中一个文件里。那样的话在 /tmp/omp-stream-dup/result.txt 里写明为什么必须改它。

跑完把：根因（文件和机制）、改了哪些文件、测试命令和退出码，写入 /tmp/omp-stream-dup/result.txt。

## subagent-delegation
委派子任务的上下文隔离、权限收敛与重启未知态

When a bot (or any agent) spawns a subagent/delegate task: the child must start without the parent's transcript (summary back only, which you likely already do — keep it), and the child must NOT be given tools that write memory, send outbound IM, create cron/routines, or ask the user to clarify. If the process restarts, an in-flight subagent must be marked unknown, not replayed as success (side effects may have happened). Add heartbeat/timeouts only if a hook already exists; do not build a new supervisor. Acceptance-first, user pre-authorized, tests first. Open a non-draft PR. Do not merge. Do not edit gateway, compression, or approval expiry.

## superbot-factory-setup
Super Bot 独立配好多机软件工厂

如果我想要super bot有超级大的权限，可以把这一套都独立的完成，需要给他加哪些能力，放开哪些权限，我觉得super bot的权限可以是全能的，分多个agent先分析，然后给我结论
那就分多个agent去完成，我想要让他能力超强

## system-context-cards
会话摘要与 Jev 提示卡片

这种给他加个ui吧，这种裸的太丑了
这种goal的，给他加个ui吧
这种jev的也加个ui吧

## system-message-ui
统一聊天系统消息展示

顺便把聊天里其他这种裸的系统消息也检查一遍，统一加上合适的 UI，长内容默认折叠，原始详情保留，别漏了。

## thinking-effort
思考力度

现在这个有没有thinking Effect level的控制？没有就规划一下，加一个

## turn-stats-end-time
对话轮次统计显示结束时间

我不是要求在这个地方，显示这个会话的结束时间吗？这里还没加上

## unattended-approval-expiry
无人值守审批超时拒绝

For approvals raised by a bot routine, cron, or other unattended wake (not a human sitting in the Lab chat): if nobody answers within 10 minutes, expire the approval as DENY, do not run the tool. Human-present chat approvals keep current behavior. Record the expire reason on the approval. No new env vars; 10 minutes can be a named constant. Surface the state in existing approval inbox if cheap, with i18n zh+en.

## unified-bot-goal-lifecycle
统一 Bot 目标生命周期与归档展示

按你说的方向改吧，先把目标的两套状态和展示统一起来，完成或失败的保留历史但别一直挂底部，再把重复调用检测改成看有没有实际进展。Jev我已经恢复了，不用管了。群聊组织模式，可以按你说的再新增一种模式，我对比看看执行效果。
分多个agent去推进

## unlimited-bot-rounds
Bot 对话轮和执行轮默认不限

怎么bot还有max_turn的限制，我是要无限轮的，你去掉类似的限制或者开关默认关闭，我要无限轮对话和执行轮的

## unlimited-execution-steps
默认不限单次执行步数

那就这个配置可以保留，直接改成默认无上限轮数限制，你刚改功能名字的事儿也可以，去做吧

## unowned-legacy-bot
无主旧 Bot 不被打开时认领

Fix: the first openBot on a canonical session that has no userId must not rewrite that bot into the installer principal in a way that lets any logged-in user open their own forever-chat with that bot's tool allowlist. Keep existing owned bots unchanged. Prefer: unowned legacy bots stay unowned until an explicit claim, and another user cannot spawn a personal canonical chat from that allowlist. No new env vars.

## untrusted-cwd-default-deny
不可信内容不能带出工作目录或执行动态代码

Fill gaps so enforcement is fail-closed (no silent host downgrade for high-risk tools; no skill tools/paths/network beyond Manifest; untrusted tool/web content cannot induce cwd/eval escape).

## upstream-resilience
上游模型异常时的稳健性

上游模型服务出各种状况（输出被截断、连接中断、限流、卡住不动）时，
用户看到的是准确的结果或明确的错误，不会把半截回答当成完整回答，也不会看到重复的文字。
