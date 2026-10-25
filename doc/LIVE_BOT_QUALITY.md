# 真实 Bot 任务评估与发布准入

本系统区分三种结果：模拟验证评估器、真实模型的基线采样、真实 A/B 的发布准入。单测通过、一次采样通过、运行时 goal.completed、A/A 对照都不等于能力认证。

## 首轮任务

内置 bot-p0 包含 16 个任务：问句修复、研究并修复、pipeline 名词路由、账单求和、筛选订单、联系人规范化、关联数据、报告 JSON、临时失败重试、备用数据恢复、只读、禁止发送、失败写入、假完成声明、长日志末尾错误和压缩后的报告路径。

执行使用真实 RawAgentRuntime.createBot/openBot/runHumanSession，独立临时目录与 SQLite。模型调用真实提供商；工具使用可控夹具，不使用生产服务。文件题真实读写 calculate.js，独立隐藏输入检查算术结果；其语法限于数字算术表达式，不能执行任意 JavaScript。结构化任务检查落盘 JSON。负向读取必须有匹配的 not_found 结果。压缩通过产品的强制压缩入口执行，保留原始 transcript。权限题验证明确禁止的操作没有被调用；这不替代生产审批、OS 沙箱或真实外部服务专项评估。

## 使用当前 Lab 中的模型跑基线

先构建当前工作树，然后：

    pnpm run agent:quality:baseline --trials 1 --settings-root /absolute/path/to/running/repo --bot ppeng-agent-core --out test-results/bot-baseline-unique

只读打开运行目录的数据库，按 Bot pin、会话模型、Lab 默认、环境连接回退的既有优先级解析。找不到指定 Bot 或模型时失败，不静默改用 heuristic。凭证只传给隔离子进程，不写入报告；不复制生产会话、用户记忆或技能。API Key、Base URL 等连接参数仍沿用既有配置，不新增产品功能开关。

未使用 settings-root 时读取当前 checkout 的既有模型连接环境，供 CI 使用。当前评估仅覆盖文本模型，不覆盖 VL 路由。所有预算放在 experiments/bot-p0.json 中：每题超时、模型请求数、输入和输出上限、整轮预算。输出目录必须不存在，防止覆盖历史结果。

基线返回 0 表示采样完成且样本通过，1 表示任务失败，2 表示证据无效；任何基线始终 promotionEligible=false。部分辅助请求按产品自身时限取消后，任务可能通过恢复机制完成；取消记录仍保留，缺失的用量不按零计。

## 新旧代码对照

分别准备并构建稳定与候选 checkout，固定模型、任务、权限与预算：

    pnpm run agent:quality:compare --baseline-root /absolute/stable --candidate-root /absolute/candidate --settings-root /absolute/running/repo --bot ppeng-agent-core --out test-results/bot-ab-unique

同一任务 AB/BA 交错，默认每版本重复三次。核心统计以不同任务为单位，重复运行不虚增独立样本量。保留总体/类别完成率、每题全部运行成功的稳定性、任务级不劣区间、用量与耗时；接口与判官调用也计入请求预算。未配置供应商计费单价时美元成本为未知，报告部分已知 token，不能冒充完整费用。

默认策略要求至少 30 个不同任务、每题三次、基线完成率不低于 80%，总体与各类别不劣于稳定版 5 个百分点；关键任务失败直接阻断。最低数量不保证统计区间足够窄。本次 16 题是诊断起点，默认策略不会认证它。扩展足够多的独立任务并按成本显式安排预算之后，才能做正式准入；不得复制同题或降低策略来制造通过。

## 硬门禁和发布

    pnpm run agent:quality:gate --run /absolute/evidence --baseline-sha STABLE_SHA --candidate-sha CANDIDATE_SHA

门禁校验文件索引、摘要、完整试验集合和源版本，重新运行独立验收器和对照统计。模拟、A/A、单版基线、脏 checkout、版本不符、关键失败、退化、基础设施错误、缺失用量、样本不足、弱化策略均不能放行。报告来自可信评估作业时，摘要可发现损坏或单文件篡改；本地 JSON 不具备签名认证，不能抵御具有全部证据写权限的攻击者。

GitHub 的 Live Agent quality gate 支持手动运行和 workflow_call，使用已有 RAW_AGENT_API_KEY、RAW_AGENT_BASE_URL、RAW_AGENT_MODEL_NAME secrets。它构建两个源码版本并上传报告，缺凭证或证据不足会失败；不会在普通 PR 上自动消费模型费用。普通 PR 验证评估软件本身，不能以此宣称模型已认证。

实际 Stable/Candidate 发布入口必须提供证据：

    pnpm run release:promote --run-id RELEASE_ID --quality-evidence /absolute/evidence --baseline-sha STABLE_SHA

候选 SHA 取自发布记录；若记录中已有 Stable SHA，声明必须一致，否则必须显式提供当前 Stable SHA。门禁在部署前执行，--force 只允许缩短原有观察期，不能绕过能力门禁。旧版本没有证据会被阻断，需要先建立合格对照。直接绕过发布入口的手动部署不在此门禁的控制范围内。

## 报告与维护

manifest.json 记录源码、构建、lockfile、驱动、模型、任务和预算指纹；suite.json 固定当次考题；每次执行的 JSON 包含原始轨迹、真实工具结果、产物、判定、用量与错误；report.json/report.md 汇总；evidence-index.json 用于完整性校验。模型版本名可能是供应商可变别名，无法证明其后端权重不变，应定期重跑相同基线。

线上失败经脱敏进入新任务集。先分析是产品缺陷、任务歧义、验收器误判还是服务故障，再版本化更新，不删除失败样本或选择性重跑后覆盖原记录。

## 32 题重复对照

`experiments/bot-reliability.json` 保留原 16 题，增加平方/费用计算、中位数、分组总和、加权均值、库存核对、最新事件、区间交集、CSV、依赖排序、零值回退、重试后组合、错误状态核验和两类压缩取证，共 32 题。默认每版每题三次、最多四条执行通道，同题 AB/BA 顺序不变，每轮完成后才进入下一轮。

    pnpm run agent:quality:compare --config scripts/agent-eval/experiments/bot-reliability.json --baseline-root /absolute/stable --candidate-root /absolute/candidate --settings-root /absolute/running/repo --bot ppeng-agent-core --out test-results/bot-ab-unique

最大规划请求数为 2304（32 × 3 × 2 × 12），总预算上限为 3000；每题与统计门禁标准均未降低。32 题仍不保证各类别统计区间足够窄；旧版取消请求的未知用量保留为未知，不能补零让门禁通过。新增任务覆盖不同运算与失败合同，仍限于夹具分布，不是广泛通用能力认证。

### 执行可靠性修复

Bot 不再把“保留证据”解释成额外保存业务记录：工具观测已自动留存，只有任务需要的产物可以写入；未提供 goal_checkpoint 时不能拿其他存储工具替代。意图与完成判官使用统一 60 秒有界预算，成功后不再额外 abort；真正超时仍回退或保持未验证，缺失用量不能补零。每次模型请求记录 intent / completion / summary / turn 用途，便于区分问题来源。

Bot 压缩优先把摘要指令放在 completeText 的 system 参数，把历史和旧摘要单独序列化为数据，避免生成摘要时的格式要求成为下一轮任务。兼容仅提供 summarizeMessages 的适配器时，将内部指令明确标记为 system 指令而非用户历史。回流摘要使用历史助手角色，摘要后备注入仍标记为历史背景，当前用户要求优先；提示与导航一起计入既有摘要字符预算。此处不扩大写入权限，也不改变证据验收规则。

历史选择器保留当前用户请求及之后的执行轨迹；预算足够时不裁剪单片段历史，避免多轮工具调用后当前目标被尾部截断。

2026-10-24 的三轮 Grok 对照及所有中间失败记录见 [可靠性报告](eval-results/2026-10-24-bot-reliability.md)。本次候选仍被严格门禁判为 regressed，不能作为发布认证。
