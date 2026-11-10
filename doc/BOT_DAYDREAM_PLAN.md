# Bot Daydream 与共享知识开发计划

日期：2026-11-03
状态：D0–D5 核心通路已实现，构建、49 项专项行为测试、10 项浏览器场景与独立审查通过；精确费用与冲突人工处置边界见第 9 节。
范围：每日独立复盘 → 私有 Memory/Skill → 上报 → Super Bot 治理 → 授权共享 → 后续任务使用 → 增量反馈。

## 1. 产品决定

- Daydream 默认开启，包括没有保存过该设置的已有 Bot；明确关闭过的配置必须保留。提供总开关与始终可访问的配置入口，开启时展开策略，默认配置无需先保存即可生效。
- 配置通过 Lab UI 与数据库持久化，热生效，不新增功能开关环境变量。默认每天 03:00；使用用户已保存时区，无偏好时采用实例的显式时区设置并在界面展示，不依赖宿主隐式时区。
- Memory 默认自动保存可靠长期信息；Skill 默认产生候选、一次确认后安装，可单独授权自动安装该 Bot 私有技能。
- 协作学习、发现共享候选、读取已有授权成果默认开启；扩大共享范围需授权。允许用户配置范围内自动发布，不把默认开启理解为默认公开私有内容。
- 首次启用从当天开始积累，次日复盘；仅补偿启用期间漏跑，默认最近 7 天，首次不回扫全部历史。历史复盘由用户手动选日期。
- 关闭后停止新调度，运行中任务在安全检查点停止写入；保留历史产出和配置。重新开启不重置策略，不补跑关闭期间的数据。
- 一个协作空间只有一个 Super Bot 治理终点；不设上级或 Super Bot 自动转发链。未配置时本地复盘正常执行，共享候选留存并显示待配置。
- Super Bot 掌握授权范围内的知识目录、上报、版本和冲突，按权限追溯必要证据；不自动获得全部私有对话权限。公共知识属于项目/团队，不属于 Super Bot 私人 Memory。

## 2. 现状与复用边界

代码复核基线：`packages/core/src/memory/memory-dreamer.ts`、`memory-turn-end.ts`、`memory/store.ts`、`doc/SKILL_CAPTURE.md`。

现有 Dreamer 在 curator 接受后触发，只传当轮一条 user 消息，最低要求却为三条；先占当天任务再检查数量，skipped 会阻止当天再次处理。其 completeText 参数尚未用于模型归纳。已有日记和每日记录不能视为完整每日复盘。

复用 AgentMemoryStore、记忆写入门禁、Bot 私有技能/只读共享、技能安装与目录加载。将每日任务与轮结束即时提取分离，避免双重调度。旧 dreamerEnabled 显式关闭与新 Bot 开关的迁移须有测试，不能直接覆盖。Bot 日级完成不能只以 UTC 日期或进程内节流判定。

本计划与通信/派工系统共存：不通过群聊广播、自动互发消息或递归委派传播知识，不重建工作任务状态系统。

## 3. 数据契约（逻辑结构，迁移时映射现有租户/团队/项目身份）

所有记录携带 tenantId 和明确作用域，服务端校验成员关系；spaceId 是协作边界的逻辑引用，不默认新建第二套组织体系。

| 记录 | 必需字段与约束 |
|---|---|
| BotDaydreamSettings | botId、enabled、timezone、dailyAt、memoryPolicy、skillPolicy、collaborationEnabled、预算、effectiveFrom；保留显式保存标记 |
| SpaceKnowledgePolicy | scopeRef、superBotId、allowedPublishScopes、publishPolicy；每个协作边界一个治理者，变更不扩大权限 |
| DaydreamRun | id、botId、kind(localReview/sharedGovernance)、logicalDate、timezone、inputCutoffAt、checkpoint、status、leaseOwner、leaseExpiresAt、usage、summary |
| DaydreamInput | runId、sessionId、messageId/seq、内容版本或摘要、处理状态；保存确定输入集合和增量水位 |
| KnowledgeSubmission | id、sourceBotId、sourceRunId、kind、operation、localArtifactRef及版本、targetSharedId、summary、reason、evidenceRefs、proposedScope、origin、derivedFrom、dedupeKey、status、decisionReason、publishedArtifactRef |
| SharedArtifact | id、kind、scopeRef、stewardBotId、contributorBotIds、currentVersion、status(active/disputed/retired)、publicationMode(reference/curated) |
| SharedArtifactVersion | artifactId、version、contentRef、submissionIds、evidenceRefs、supersedesVersion、changeReason、createdAt；发布版本不可变 |
| KnowledgeFeedback | artifactId、artifactVersion、fromBotId、kind(verified/failed/correction/extension)、新 evidenceRefs、dedupeKey、status、resolvedInVersion |
| KnowledgeEvent / ConsumerCursor | published/updated/revoked、artifactId、version、作用域、事件序号；消费者进度可恢复，幂等消费 |

ArtifactRef 统一包含种类、稳定 ID、确定版本；EvidenceRef 包含来源会话、消息或工具执行引用、原始发生时间，证据访问仍受权限约束。引用原 Bot 技能时保留原维护权；整合多 Bot 成果才建立独立公共版本。

运行状态区分 queued/running/partial/completed/failed/cancelled，空数据另记原因。日期任务唯一约束结合租约与 fencing 防止旧 worker 恢复后继续写入；显式手动增量复盘建立可关联的新批次，不覆盖旧审计记录。上报和发布去重标识必须包括租户、来源成果及版本。

## 4. 执行和共享通路

1. 定时/手动/补跑创建任务，锁定 Bot、当地日期时间窗口、输入截止点。分会话分段读取消息与必要工具结果；无数据不调用模型。
2. 模型只分析证据，不执行来源中的命令。提取有来源的 Memory/Skill 候选，与已有成果归并；摘要不能替代原始证据。
3. Memory 排除临时要求、拒绝记忆内容、凭证和助手猜测。明确修订可替代旧版本，情境差异拆分，无法判断的冲突待处理。Skill 要有成功执行或用户确认的证据、适用条件和验证方法。
4. 保存私有成果并刷新现有召回/技能目录。共享失败不阻止本地使用。拒绝与撤销记录用于防止下次原样重提。
5. Daydream 自动生成上报，普通任务可选使用同一入口的 knowledge_submit；不要求模型想起调用工具才会共享。
6. Super Bot 每批锁定候选集合，决定新增、合并、暂缓、拒绝。服务端复核作用域、证据与目标版本。发布、候选状态和 outbox 事件原子提交；文件型技能采用暂存、可恢复提交协议，不声称数据库事务能够直接涵盖文件写入。
7. 事件消费者更新索引、技能目录和更新记录；每次检索与加载重新检查权限，撤销不能等待异步索引刷新才生效。
8. Memory 检索接入自有及授权项目/团队知识；Skill 搜索与 load_skill 返回准确 ID、版本和来源，继续受原白名单和工具权限约束。无需将全部共享正文塞进每轮上下文。
9. 只在实际使用产生新证据后生成反馈，下一批治理。读取或转述不构成新的验证。

用户明确要求的 A→B 直接共享继续沿用现有流程，使用同一权限与目录；仅自主共享候选经过 Super Bot。Super 不可用时上报排队，已发布知识照常检索。

## 5. 防递归与一致性

- derivedFrom 与原始 evidenceRefs 保留血缘；A→B→C 的转述只算同一份原始证据。
- 来源为共享成果且无新增证据，不产生上报；Super 不向自己提交自己发布的成果。
- 发布只更新目录，不触发新的 Daydream、派工或 Bot 聊天；每批只处理启动时的输入，反馈推迟下一批。
- 来源、版本和内容去重；并发发布使用预期版本检查，冲突重新归并，不覆盖用户的新修改。
- 取消授权立即阻止后续加载；来源纠正使相关成果标记待复核，保留历史引用，不声称能删除已进入对话的正文。
- 超预算保存进度，不把未处理数据标记完成；单段失败进入 partial，可单独恢复。运行中关闭需在提交前再次检查有效配置。

## 6. UI 与 API 开发范围

Bot 详情增加每日复盘设置、日期运行列表、来源展开、Memory/Skill 产出、共享候选与反馈。Super 视图增加待治理队列、公共版本和冲突。日报区分候选/已保存/已安装/范围不允许使用，正常无产出不强行生成内容。

建议 API（实施时对齐现有路由与鉴权，不与旧技能接口重复）：

- GET/PATCH /api/bots/:id/daydream/settings
- POST /api/bots/:id/daydream/runs；GET runs 与单次详情
- GET/PATCH 协作边界的 knowledge-policy
- GET/POST knowledge/submissions；受权的 decision 操作
- GET knowledge/artifacts 及 versions；POST feedback

查询按调用者权限过滤；手动运行、治理和共享写入使用既有管理权限。所有前端文案同步 zh/en，新增逻辑遵守 CRAP 门禁，不向已超标组件添加分支。

## 7. 开发顺序与完成条件

| 阶段 | 交付内容 | 必须通过的验收 |
|---|---|---|
| D0 配置与契约 | 确定身份映射、迁移、开关默认值、授权和版本协议 | 新旧 Bot 默认与显式关闭正确；跨租户访问被拒；配置热生效 |
| D1 每日 Memory | 独立调度、分段回顾、模型提取、记忆写入、日报 | 昨日不同会话遗漏信息合并，新会话能召回；临时/不记忆内容不保存；时区边界正确 |
| D2 私有 Skill | 证据提炼、同名/相似技能比较、确认或预授权安装 | 实际成功方法能在后续任务搜索加载；失败/猜测不成技能；更新可撤销 |
| D3 上报与治理 | 持久队列、Super 批次治理、共享版本、事务事件 | 无 Super 可排队；重复上报只处理一次；已有技能归属不被擅改 |
| D4 使用通路 | 权限过滤、Memory 召回、Skill 搜索加载、目录刷新 | A 上报→Super 发布→B 新会话直接使用；未授权 C 不可见；撤销后 B 不能加载 |
| D5 反馈与恢复 | 血缘、增量反馈、冲突、租约、预算、补跑 | A→B→C 不反复上报；新增证据可形成下一版；崩溃/重跑/双 worker 不重复产出 |

依赖顺序 D0→D1→D2→D3→D4→D5。D1/D2 可单独交付本地价值，但完整功能必须完成 D4/D5，不能以“生成日报”或“已有共享 API”代替端到端验收。

实现每阶段时按 acceptance-first 创建 approved 标准（notes 含 assumedApproval: standing-order-2026-10-22），先写带 AC 标签的失败行为测试，再实现并标记 implemented。验收文件为 `acceptance/bot-daydream-{local,knowledge,integration,http,ui}.yaml`，以实际行为测试为准。

验证包括核心单测、daemon 鉴权/故障恢复测试、前端 i18n 与操作 E2E、跨 Bot 完整闭环及 test:acceptance。功能完成后 review，再按仓库流程提交、PR、合并。若实际修改 agent-loop，必须同步 SDK skill 并运行其 test/build；本方案优先在 core 与 daemon 组装层实现。

## 8. 本期不做

不引入自动无限讨论、跨空间 Super 转发、默认读取所有私有对话、未经授权自动公开、训练模型或新消息中间件。共享知识与来源证据保留可审计引用，日志和计划不记录真实私密对话内容。

## 9. 已实现入口与运行边界

- Bot 详情 → 每日复盘：配置开关、时间/时区、Memory/Skill策略、协作范围、Super Bot、手动日期复盘、审核与撤销。
- 同一所有者与功能分组构成当前协作边界，复用既有 functional groups；未分组 Bot 使用所属用户的个人协作空间。没有新建平行组织体系。
- 默认时区为显式实例配置 `daydream.instanceTimezone`，未配置时显示 UTC，可在 Bot 界面改为本地时区；当前用户偏好没有通用时区字段，因此不会伪称已读取它。
- 自动和手动复盘按分段处理到完成。调度按原任务断点恢复中断的复盘，包括超过七天的存量任务。
- 引用原技能或记忆时每次访问检查来源是否仍有效；原内容撤销或记忆更正后停止提供旧引用。公共整合版本保留贡献与反馈血缘。
- review 模式仍调用 Super Bot 生成建议，人工确认才发布；反馈可人工修订或忽略。autoWithinScope 模式只在已保存授权范围内自动处理。
- 手动任务由后台完成，界面定期刷新；关闭会在安全点停止新增写入，关闭进程会中止模型分析并等待活动任务结束。
- 冲突记忆保持待处理，不使用普通合并器将矛盾信息拼成“已保存”；界面提供现有记忆管理入口，人工核对修订原记忆后处理候选。本版不自动推断要覆盖的目标版本。
