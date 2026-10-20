# ai-agent-node → ppeng-agent-core：纵向能力切片评估

日期：2026-10-20。性质：源码分析与候选建议，不是实施计划或已批准验收标准。

**结论**

ppeng 早已吸收了不少底层机制，继续按模块名移植收益有限。当前最值得引入的，是把已有模块连接成更可靠的用户闭环：完整表格计算、可控遗忘、可解释召回、长期任务故障治理，以及数据与展示分离。业务宿主授权和分布式子任务执行有价值，但应由业务接入/规模需求驱动。

**范围与证据边界**

- ai-agent-node：本机主仓 `/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node`，HEAD `7c266aff6`（2026-10-19）。当前工作区含未提交的 Bot 产品改动；本报告不把这部分当成已发布能力。Conductor 的 columbia 工作区停在 2026-05-22，没有用它代表当前实现。
- ppeng：`/Users/penglei/developer/self-test-grounding/ppeng-agent-core`，HEAD `a0d12d79`（2026-10-20）。
- 阅读了入口装配、被调用实现、存储/API、相关 UI 和部分测试源码；属于静态代码评估，未运行两仓测试、未做线上链路或性能验证。
- “未见同等实现”指所检查调用链，不是以全文关键词未命中证明绝对不存在。
- 旧 [CAPABILITY_ABSORPTION_PLAN.md](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/doc/CAPABILITY_ABSORPTION_PLAN.md) 的“仍可选深化”已部分过时：RunOutcome、Goal 实体、语义记忆、ingestion、paged artifact 都不能再当作缺失功能。

**整体能力版图：从用户输入到长期运行**

| 用户任务链 | ai-agent-node 的代码落点 | ppeng 当前对应能力 | 判断 |
|---|---|---|---|
| 发消息→路由→执行→停止/插话→回放 | channels、dispatcher、agent-kernel、runner、session | gateway、turn kernel、agent-loop、inbox、surface/WAL | 大量重合，不建议重写内核 |
| 上传附件→解析→计算→业务动作→结果展示 | ingestion、PTC book、BusinessHost、UI snapshot | ingestion、paged artifact、PTC、ERP bundle、A2UI | 表格语义与展示数据通道值得补齐 |
| 完成对话→抽取记忆→检索→注入→用户纠正 | writer/reader/curator/dreamer、suppression、memory UI | semantic writer、curator/dreamer、hybrid recall、context compiler | 补删除抑制与逐条召回回执 |
| 定时/事件→预检→运行→投递→异常恢复 | cron gate、occurrence、lease、failure policy、delivery | event-routine、precheck、routine lease/runtime、gateway ledger | 补严格预检与连续故障治理 |
| 业务岗位→授权快照→工具裁剪→执行期重验 | registry/business-host、host channel | DomainBundle、connectors、ERP、审批 | 可扩展为通用宿主集成契约 |
| 委派→独立 worker→租约→流式回传→取消 | fission、job store、event bridge | Teams DAG、Swarm、Bot work、独立工作区 | 缺口在分布式执行面，不在“多 Agent”本身 |
| 执行→失败归因→成本/质量统计 | RunOutcome、firefight、Langfuse、run log | RunOutcome、trace、usage、Langfuse | 补运行质量维度，不重造终态 |

---

**切片 1：用户上传表格，要求计算或导入业务数据**

ai-agent-node 的链路是：上传原件 → ingestion 判别/持久化 → 保留工作表网格 → 给模型目录与少量样本 → 将完整结构绑定到 PTC → 程序执行计算 → 必要时调用宿主工具。

关键不只是“能读 xlsx”。[table-catalog-text.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/ingestion/table-catalog-text.ts) 生成目录与抽样；[pipeline.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/ingestion/pipeline.ts) 将表绑定会话；[book.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/entry/openai-agent-runner/ptc/book.ts) 提供 sheets/table/date/num；[hooks.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/entry/openai-agent-runner/ptc/hooks.ts) 注入执行环境。结构包含原始行、合并单元格、隐藏状态、表块、原行号、1904 日期体系，而不只是平铺文本。

ppeng 的 [ooxml-text.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/ingestion/ooxml-text.ts) 返回 text/unreadable；[route.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/ingestion/route.ts) 已有原件保存、文本截断及大文本归档，但此链未提供同等的 workbook→book 执行绑定。现有 PTC 也不等于具备完整表格语义。

**建议引入：结构化表格资产 + 只读计算接口。**

原因：避免把抽样当全量、合计行当明细、空值当 0、日期序列当普通数字；减少逐页工具读取与重复模型往返。

最小完整引入范围：附件原件/哈希与结构保存 → 模型目录/截断声明 → PTC 或受控工具可读全量 → 输出带来源范围 → Lab 可查看原件与结果。先支持本地 XLSX/CSV，再考虑大表分析服务。

不要照搬：当前 book 在会话对象内最多保留 4 份表，同名替换，不等于重启后持久可用；大表的 durable analysis 依赖外部分析桥，不能只抄路由分支就宣称已支持。验收应覆盖多级表头、隐藏表、空列、合计行、同名重传和进程重启。

**切片 2：用户删除错误记忆，之后它不应自动回来**

ai-agent-node 的 [memory-service.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/memory/memory-service.ts) 删除前记录拒绝信息；[memory-suppression.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/memory/memory-suppression.ts) 做规范化匹配与可选向量匹配；[memory-writer.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/memory/memory-writer.ts) 在写入时检查；[memory-dreamer.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/memory/memory-dreamer.ts) 还会把删除摘录加入禁止再输出的背景。

ppeng 已有抽取、整理、梦境、语义合并，但 [store.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/memory/store.ts:325) 的 delete 删除来源/向量/事实，没有在这条路径写入拒绝再学习记录；自动写入入口见 [memory-turn-end.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/memory/memory-turn-end.ts)。

**建议引入：可控遗忘/删除抑制。**

原因：只删数据库中的一行，无法阻止旧对话在下一次整理时再次生成同一事实。记忆越自动化，这个问题越明显。

最小完整引入范围：用户删除 → 按 tenant/user/bot scope 写抑制记录 → 自动提取/curator/dreamer 共用写入检查 → 界面显示抑制原因、期限及撤销 → 显式“重新记住”有独立语义。保留 ppeng 的 Bot 私有记忆边界。

不要照搬：node 当前仅 PG/remote 提供 suppression store，缺 store 时不拦截；期限是北京时间当天结束。它不是永久遗忘，也不是完整的历史资料清除。ppeng 应通过 UI 持久化策略明确期限，而不是新增 env。

**切片 3：用户问“为什么记住了却没用上？”**

ai-agent-node 的 [memory-reader.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/memory/memory-reader.ts) 在筛选/评分等阶段收集 dropped reason；召回观测、prompt snapshot 与 memory API 连接调试界面。[recall-receipt.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/ai-agent-web/src/features/memory/recall-receipt.ts) 区分类型不符、分数不足、条数限制、字数预算、外层再裁剪，并避免同一事实在另一分区已注入时被重复计为遗漏。[session-timeline.tsx](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/ai-agent-web/src/features/memory/session-timeline.tsx) 将其放进轮次时间线。

ppeng 已有 [memory preview API](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/apps/daemon/src/routes/memory.ts:112)、[context-stack.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/session/context-stack.ts) 及上下文界面；缺口不是“完全没有可观测性”。但 [RecallSources](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/memory/memory-recall.ts:22) 主要是四块字符串，当前 diagnostic 偏向检索服务降级，不能完整回答某条 memory 为什么落选。

**建议引入：逐条召回回执，绑定实际执行轮次。**

原因：区分“没存”“搜不到”“搜到了但预算挤掉”“注入了但模型没遵循”，才能有依据地改检索和预算。

最小范围：候选 memoryId/来源 → 排序及裁剪原因 → 最终注入 ID/字符范围 → 与本轮 trace/request 关联 → Lab 查询。复用现有 ContextStack/Trajectory，避免另做一套调试台。下一轮预览不能冒充历史某轮实际发送内容；异步调试快照也需明确丢失/过期状态。

**切片 4：自动任务长期运行，不空转、不刷屏、不盲目重试**

node 有两处值得吸收的增量。

A. [cron-gate.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/cron/cron-gate.ts) 只接受成功退出且末行合法的 `{fire:boolean,state?,message?}`；格式错误属于 failed，state 有大小上限，失败不提交新状态。执行身份、凭据与一次性沙箱也沿同一链路传递。

ppeng 的 [routine-precheck.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/cron/routine-precheck.ts:72) 已有隔离、超时与零 token 预检；但 parseWakeGate 对空输出、非 JSON、缺 wakeAgent 的输出默认 true。运行层 [routine-runtime.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/cron/routine-runtime.ts) 将不唤醒结果归为 skipped，并将错误放在 reason。它与“预检健康且无变化”还可进一步区分。

**建议引入：严格、可迁移的预检契约 + 持久游标。**

原因：监控脚本误打日志或解析失败，不应意外唤醒模型；邮件/指标扫描需要游标，避免每轮重复消费。不要直接改变旧任务的兼容语义，应显式升级契约并在 UI 显示 no-change/failed。

B. [cron-failure-policy.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/cron/cron-failure-policy.ts) 提供硬失败分类、指数退避、失败边沿通知、冷却与自停用；[cron-scheduler.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/cron/cron-scheduler.ts:2180) 实际更新计数并连接结果投递与恢复通知。相关 [测试源码](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/test/unit/cron/cron-failure-policy.test.ts) 覆盖退避、通知边沿和瞬时错误分类。

ppeng 已有 occurrence 去重、租约心跳、审批后续跑、unknown 外部副作用隔离及事件验签，不应重写 scheduler。但所检查 routine 调度链未见等价的连续故障退避与恢复通知状态机。

**建议引入：Routine 故障治理策略。**

原因：定时任务从“能运行”提升为“能长期无人值守”，减少无效计费与告警疲劳。

最小范围：每次执行归因 → 持久失败序列/nextRetryAt → 退避与暂停 → 一次失败通知 → 一次恢复通知 → UI 手动恢复与运行记录。先从只读任务落地；现有 unknown 副作用状态禁止因退避结束而自动重放。node 的固定 7 次/30 分钟等常量是其策略，不是 ppeng 必须采用的默认值。

**切片 5：用户看完整结果，模型只接收它真正需要的信息**

node [ui-snapshot.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/entry/openai-agent-runner/ptc/ui-snapshot.ts) 的 ui() 将 component/props 留在服务端，返回短引用；[web-server.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/web-server.ts:2908) 按会话与用户鉴权取回；[snapshot-ref.tsx](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/ai-agent-web/src/chat/ui-spec/snapshot-ref.tsx) 在消息正文中解析引用并渲染。相关测试实际断言“大数据返回短 token”及跨用户/会话不可读取。

ppeng 已有 [A2UI tools](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/tools/builtin-tools.ts:1532)、surface 持久化和 paged artifact。因此建议是增加数据直达渲染器的通道，不能把已有 A2UI 说成缺失，也不能断言所有 A2UI metadata 都会原样进入模型。

**建议引入：带权限的展示资产引用，复用 A2UI 渲染。**

原因：工具/程序已经拿到的明细，不需要模型抄写完整 JSON 才能展示。对表格、查询结果、多卡片看板尤为有用。

最小范围：工具/PTC 产出资产 → 模型收到摘要/统计/引用 → A2UI 数据绑定按需取回 → 用户点击动作携带资产 ID/版本 → 历史消息可复原。

不要照搬：node 快照采用内存 Map、6 小时 TTL、有会话/数量上限，过期后前端会提示重新询问；它不是持久化产物系统。ppeng 已经持久化的历史展示能力不应倒退。

**切片 6：同一个 Agent 嵌入不同业务系统，权限随岗位变化**

node 的 [types.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/registry/business-host/types.ts) 定义带 policyVersion/catalogDigest/decisionId/expiry 的能力包；[enforce.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/registry/business-host/enforce.ts) 对请求、profile 和宿主上限做收窄；[host-tool-provider.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/registry/business-host/host-tool-provider.ts:215) 装配工具，并在授权过期后重新获取、检查该工具是否仍获准，执行时透传授权版本与决策标识。

ppeng 的 [DomainBundle](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/domain.ts)、connectors、tool policy 和审批已经是扩展基础；[agent-erp](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/agent-erp/src/index.ts) 则提供 draft/submit/post/get 领域语义。它们与“外部业务系统实时下发当前用户的能力上限”不是同一层。

**建议引入：通用 BusinessHost adapter + 短期授权快照。**

原因：避免每接一个 CRM/ERP 都往 core 加特例；权限变更不必等 Agent 重建或进程重启才能反映。

完整范围：身份映射 → 从可信宿主获取能力/工具/skill → 求交装配 → 执行期过期/撤权重验 → 宿主再次授权与实际写操作 → 审计回显 → Lab 连接测试/配置。

前提：确有真实业务接入需要。不要照搬 node 的 edition/industry/特定 Cookie 身份轴。空权限、未声明权限和请求省略字段应分别规定，不能单凭注释推断一律同义。

**切片 7：子任务并行执行到需要独立扩容**

node 的 spawn-subagent/spawn-task-workers 可进入 [spawn-via-fission.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/fission/spawn-via-fission.ts)：身份快照 → 持久 job → worker 认领 → 心跳/租约 → 父会话事件回传 → 结果等待与取消传播。[worker-loop.ts](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/fission/worker-loop.ts) 有专门 worker 角色、slot 上限、过期租约处理，并接入 stop/steer 路由；底层有 Postgres job store。

ppeng 已有 [Teams executor](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/core/src/teams/executor.ts)、Swarm、Bot task 和工作区同步。这里的增量是“把执行面移到独立 worker，并保持用户看得到、停得下、身份不丢”，而不是再加一个 spawn 工具。

**建议引入：可选的持久子任务执行后端。**

适合条件：单 daemon 被 CPU/内存或长任务占满、需要跨主机容量/不同工具环境。先定义 job、claim/heartbeat、cancel/steer、result/event 的接口与本地实现，再考虑 PG/Redis；不要为了多 Agent 而提前引入整套云基础设施。

必须验证：父任务取消、worker 崩溃、重复认领、结果晚到、事件订阅断开、写操作未知结果。源码已有相关测试文件，但本次未验证多实例运行，更不据此承诺 exactly-once。

**切片 8：任务结束后，如何知道系统是真的可靠**

node [RunOutcome](/Users/penglei/xunmengkeji/agent-group-for-tango/ai-agent-node/src/node/src/observability/run-outcome.ts) 除终态和 failureStage，还携带 toolErrorCount、contextOverflowRetried、streamContinuations、streamIdleRetries、watchdogRetries 等 firefight 信息。它能表达“最后有输出，但过程救火很多”，并定义不同于 completed 的成功判据。

ppeng 已有 [RunOutcome](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/agent-loop/src/session/run-outcome.ts)，kernel、restart recovery 与 Langfuse 都有相应路径。新增价值在运行质量摘要与跨 sink 口径，而不是再引入一个终态类型。

**建议引入：每次 run 的恢复成本与质量摘要。**

完整范围：retry/watchdog/tool error 发出结构化计数 → run 结束汇总 → Langfuse/运行记录/UI 共用 → eval 按模型/任务类型比较。展示完成率、无恢复完成率、恢复额外 token/时间；业务正确性仍以验收或 verifier 判断，不能由“调用没抛错”替代。

不要照搬：node 的 dispatcher 仍有从事件重新计算 outcome 且使用 emptyFirefightCounts 的分支；因此“终态已在所有出口彻底统一”不能仅因模块注释就成立。应吸收指标设计，并沿 ppeng 现有权威终态做汇总。

---

**可以引入的功能清单与顺序**

P1 = 近期有明确收益；P2 = 建立在使用场景/前置能力上；P3 = 规模需求出现后。

| 编号 | 功能 | 优先级 | 相对成本 | 引入原因 |
|---|---|---|---|---|
| A | 完整表格资产与只读 book 接口 | P1 | 中高 | 直接提高表格任务正确性，减少反复取页和模型抄数据 |
| B | 删除记忆后的自动写回抑制 | P1 | 中 | 让用户纠错真正生效，避免自动记忆反复污染 |
| C | 逐条召回回执/实际轮次解释 | P1 | 中 | 让检索与预算问题可定位，而非凭感觉调参 |
| D | 严格预检协议与持久游标 | P1 | 中 | 错误输出不误唤醒，监控增量消费 |
| E | Routine 退避、故障冷却与恢复通知 | P1 | 中 | 长期无人值守任务节制运行、及时暴露硬故障 |
| F | 展示资产引用，接入现有 A2UI | P2 | 中 | 大结果可见但不要求模型复制全部明细 |
| G | Run 恢复成本与质量摘要 | P2 | 中 | 识别“勉强完成”，指导可靠性与成本优化 |
| H | 通用业务宿主能力授权契约 | P2 | 高 | 岗位权限与工具随业务变更，减少接入特例 |
| I | 持久、可替换的分布式子任务执行后端 | P3 | 高 | 将并发执行容量与交互进程解耦 |

按收益建议先落 B/D/E，再做 A/C；如果近期主场景是 Excel/业务数据，A 应提到第一项。A 与 F 可以组成后续完整的数据分析体验。H、I 不应挤占前述基础闭环。

成本只是相对工程判断，未完成实施设计，不是工期承诺。

**明确不重复引入**

- ingestion 五阶段、paged artifact：ppeng 已有。
- semantic gate/curator/dreamer、混合召回：ppeng 已有。
- Goal 实体、verify、steer 与 checkpoint/WAL：已有相应代码，不能沿用旧文档认定为缺口。
- RunOutcome、usage、request-id、复读/空转防护：已有；仅做具体差异补齐。
- 出站投递账本：ppeng 的 [delivery-ledger.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/capability-gateway/src/delivery-ledger.ts) 和 [outbound.ts](/Users/penglei/developer/self-test-grounding/ppeng-agent-core/packages/capability-gateway/src/outbound.ts) 已有 attempting、恢复前缀、草稿关联与人工放行；不能为了借鉴 node 取消当前审批边界。
- RunProfile/装配档位、多 Agent、Bot 产品形态：两边已有基础，本次未证实值得整体替换的增量。ai-agent-node 当前 Bot 未提交改动尤其不能直接当成稳定目标。
- 特定企业身份轴、K8s/Supabase/Redis 全套部署、业务专用 UI：不是通用底座必需能力。

**实施约束**

本次仅生成分析报告，没有新增/修改产品行为，也未创建待审批验收文件。选定实施范围后，按仓库 acceptance-first 流程先写 draft 验收标准并确认。配置通过 Lab UI + 持久化设置；新增 UI 文案同步 zh/en。若触及 packages/agent-loop，须同步 skills/agent-loop/SKILL.md 并执行 SDK test/build。保持 mini 无 Node 静态依赖，将表格/存储等重型 I/O 放在宿主或按需模块。

