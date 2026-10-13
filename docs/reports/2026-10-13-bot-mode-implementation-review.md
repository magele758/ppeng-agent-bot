# Bot 模式纵向切片实施与验收记录

本轮新增提交前 Review 与主线整合修复，见 [PR Review](2026-10-13-bot-mode-pr-review.md)。暂停交接是此前时间点的记录；最新合并验证以关联 PR 和提交检查为准，商业级发布结论仍为 No-Go。

最新状态：用户要求先修复失败回归后暂停，round15 相关复验已通过；准确范围和仍未完成的门禁见 [暂停交接](2026-10-13-bot-mode-paused-handoff.md)。以下 round12 全量证据属于旧候选，不是 round15 全量验收结论。

本文件记录 `/workspace/ppeng-agent-core` 的实现与验证，不能视为 Mac 本地 checkout 已升级、已部署或已发布。范围以 `docs/plans/2026-10-13-bot-mode-multi-agent-development.md` 的 G01–G19/W0–W8 为准。用户已授权多 Agent 补齐开发及评估。

## 候选与证据口径

- 开发基线：`96d55dc449c776ae4627c570d3fa561cfdd70893`，分支 `work`。
- 当前开发成果位于工作区；测试报告中的 `workspaceDirty` 不能被解读为已验证某个不可变发布 SHA。
- 用户提供的 Mac checkout：`a1d77ecec553540158a42a50e361795c2fb98b04`。本记录没有验证、改动或重启 Mac 环境。
- 局部测试通过不等于整个切片通过；静态验收标签覆盖不等于实际执行；短时 smoke 不等于 24h soak；本机存储查询耗时不等于标准硬件 API p95。
- 发布负载配置：`scripts/bot-release/workload.v1.json`。证据检查器：`scripts/bot-release/evidence.mjs`，缺少完整证据拒绝放行。

## 实现映射

| 范围 | 纵向实现与入口 | 验收规格 | 状态 |
|---|---|---|---|
| G01/G02，W0 | bots/bot-identity、bot-facade、持久安装身份及 Bot 定义归属；会话和记忆统一 principal | bot-identity-continuity / bot-history-memory | 本地功能已验收 |
| G03/G04，W2/W6 | session-store 原文索引、history 工具/API、主聊天游标分页和原文检索 UI | bot-history-memory | 功能已验收；完整规模协议待验收 |
| G05，W2 | 模型 contextWindow 配置、实际 primary/fallback 窗口预算及重打包 | bot-history-memory | 本地功能已验收 |
| G06，W2/W6 | 自动提取、来源引用、记忆编辑删除与 embedding 失效、Room 独立记忆范围 | bot-history-memory | 确定性测试通过；真实模型质量待验收 |
| G07/G08，W1 | SQLite 收件与任务、接收幂等、租约、背压、审批等待、结果回报和任务关联 | bot-reliable-messaging | 功能与三轮故障验证通过 |
| G09/G10/G11/G12，W3/W6 | cron/once/interval/event、IANA 时区与 DST、missed policy、独立运行会话、结果通知、重试取消及 UI | bot-routine-lifecycle | 本地功能已验收 |
| G13，W4/W6 | 默认 Super、保留选择、状态/派工/联系/结果汇总；不替用户批准 | default-super-bot | 本地功能与浏览器已验收 |
| G14，W5/W6 | Room 成员与主持、共享消息附件、@、轮数/工具/费用预算、停止恢复、上下文隔离 | bot-rooms | 独立审阅与浏览器验收通过 |
| G15/G16/G17，W7/W6 | 插件 HTTP/MCP/OpenAPI executor、按 Bot 授权/凭据/健康、导入与撤权 UI | bot-software-execution | 本地受控软件验收通过；真实软件矩阵待验收 |
| G18，W1/W7 | durable attempt、unknown 不自动重放、人工核对、部分输出与任务终态区分 | bot-reliable-messaging / bot-software-execution | 故障与权限回归通过 |
| G19，W8 | schema25 升级与旧快照、真实 SIGKILL、固定种子序列、规模/soak runner、完整门禁和证据报告 | bot-release-readiness | 进行中；尚未满足发布门槛 |

表中 core 源码根目录为 `packages/core/src/`；API 在 `apps/daemon/src/routes/`；UI 在 `apps/web-console/components/`。具体可执行范围见 `doc/BOT_ROUTINES.md`、`doc/BOT_SOFTWARE_EXECUTION.md`。

## 最终本地验证（2026-10-13，Asia/Shanghai）

生产源码在 round12 统一构建后冻结。浏览器前后十个目录指纹一致，见 test-results/bot-round12-fingerprint-{before,after}.json。工作区未提交，不能声明不可变发布 SHA 已验收。下表 R12 指 test-results/bot-round12-gates/。

| 层级 | 实际命令 | 结果与报告 |
|---|---|---|
| 构建 | node scripts/build-workspace.mjs | exit 0；test-results/bot-validation/build-round-12.log |
| Node 单测 | TMPDIR=/workspace/.bot-test-tmp NODE_V8_COVERAGE=... NODE_OPTIONS=... npm run test:unit | stdout：3062 项、3058 pass、0 fail、4 skip；R12/unit.log、junit/unit.xml。JUnit 含 5 个 skipped 节点（含 macOS suite），验收解析为 3057 pass/5 skip；保留两种统计口径 |
| SDK 单测 | npx --no-install vitest run --coverage.enabled --coverage.provider=v8 --coverage.reporter=json --coverage.reportsDirectory=... --reporter=default --reporter=junit --outputFile.junit=... | 36 文件 360/360；test-results/bot-final-gates/vitest.log。SDK 未变，复用该通过结果，JUnit 复制至 R12 |
| HTTP 回归 | TMPDIR=/workspace/.bot-test-tmp RAW_AGENT_MODEL_PROVIDER=heuristic npm run test:regression | pass；R12/regression.log |
| HTTP 集成 | 同环境 npm run test:integration | pass；R12/integration.log |
| 浏览器 | 实际 daemon + Lab + Chromium，Playwright 全量及关键流程三连，retries=0 | 114/114、11/11 × 3；test-results/bot-round12-full-junit.xml、bot-round12-critical-{1,2,3}-junit.xml |
| 故障恢复 | 三次 BOT_RELEASE_SEQUENCES=10000 BOT_RELEASE_RUN_ID=candidate12_N npm run test:bot:faults | 每轮 3/3，共 30000 转换、6 次真实 SIGKILL；test-results/bot-validation/faults-candidate12_{1,2,3}.log |
| 迁移/回滚 | scripts/test/bot-migration-rollback.test.mjs（Routine 组合执行）及全量快照测试 | pass；test-results/bot-validation/routine-and-rollback-round11.log；doc/BOT_ROLLBACK_DRILL.md。旧二进制及备份恢复演练，不声明新 schema 原地降级 |
| 确定性评估 | npm run test:formal；npm run agent:eval:fast -- --exit-on-fail --out test-results/bot-round12-gates/fast-eval | 25/25、22/22；R12/formal.log、fast-eval.log；formal 是 PBT/MockLLM，不是数学证明 |
| 包检查 | npm run test:package | pass；R12/package.log；没有发布 |
| CRAP | node scripts/crap/crap-gate.mjs --node-cov test-results/bot-round12-gates/node-coverage --vitest-cov test-results/bot-final-gates/vitest-coverage/coverage-final.json | pass；6655 函数、191 既有基线项，未降低阈值或修改基线；R12/crap.log、crap-report.json、crap-summary.md |
| 验收结果映射 | node scripts/acceptance/acceptance-gate.mjs --results test-results/bot-round12-gates/junit --out test-results/bot-round12-gates/acceptance | 226/226；R12/acceptance.log、acceptance/；映射通过不代表长期/真实服务验收通过 |
| 性能探索 | node scripts/bot-release/history-benchmark.mjs | 50 Bot、100 万历史；store page/search/status p95 约 0.611/119.22/0.157ms；test-results/bot-history-benchmark.json。仅 1000 查询约 27 秒、非标准硬件、无完整 API 协议，待验收 |
| 最终短时运行 | node scripts/bot-release/soak.mjs --smoke --smoke-seconds 10 --out test-results/bot-validation/soak-smoke-round12-quiet.json | exit 0，functionalPassed/runnerPassed=true，24 接收/24 完成，44 HTTP、15 写入；丢失/重复副作用/错误均 0。RSS 比 1.01476，但窗口不足，稳定性 acceptanceStatus=not-evaluated；不是 24h 证据 |
| 真实模型/软件/OS | 未运行模型每种三次及真实软件平台矩阵 | 待验收；受控模型/软件不代表真实质量，无相应凭据和 Mac/Windows 环境 |

Node 跳过项为 Agent Room MCP 两项外部集成、macOS sandbox suite、无 FTS5 专用 Node 环境、打包 Electron daemon 健康项。没有宣称这些环境通过。

故障九份 JSON 在 test-results/bot-release-faults/{seed-10000,sigkill-recovery,sigkill-bot-work}-candidate12_{1,2,3}.json。九份报告及当前执行文件指纹一致 dcd09b53a1636a6a9fdb1bf1fd42c8ba1d4cffc6f941c63129495ea099d667c3。固定 seed 539365395，configHash f59d3f785702866f234ea47d0a36c7f1188913dc34e554a0ab279ad94f7ef107；每轮 1974 Bot 输入、1103 Room 输入、1995 tasks、5200 runs，未发现已接受工作丢失或 unknown 盲重放。故障套件使用高容量测试状态机；实际默认 1000/Bot、10000/principal 容量另有边界测试，不将故障耗时作为性能放行证据。

专项证据位于 test-results/bot-validation/：通信 130/130（a-round12-specialized.log、a-round12-runtime-compatibility.log）；历史/身份 59/59（w2-final-round11.log）；Routine+回滚 59/59（routine-and-rollback-round11.log）；软件 27/27（software-final-round12.log）。Room 专项 19/19。专项与全量重叠，不累加成独立测试总数。

## 最后一轮纵向复核

- BotWork、Routine、Room 统一事务内容量约束；满队列仍可返回已接收的幂等回执；Routine 补跑保留剩余计划，事件未接收不提前记去重。
- 审批等待或运行中的执行上下文缺失进入 unknown，不盲目重放。部分文本、工具失败、取消、预算耗尽不能伪装 completed。
- Routine 私聊忙碌时保留结果通知；Room 恢复重新同步权限和预算，动态/PTC 派工工具不能逃逸预算。
- status SQL 先过滤当前 principal 的 canonical；一万后台会话回归只读两个 canonical，避免随后台历史线性增长。
- 记忆归属和来源保持一致，无效修改返回 400 并保留原记录；schema25 兼容最小合法旧表。
- 软件未知写入不能换幂等键绕过人工核对；SQLite 调用账本分页验证 10011 条记录；撤权/探测避免旧结果覆盖新状态。
- 软件凭据绑定及每次读取均禁止操作员 RAW_AGENT_AUTH_TOKEN / RAW_AGENT_HUMAN_RELEASE_SECRET，覆盖旧绑定/vault 引用；合成 token 复现后验证修复，普通软件凭据仍可用。
- Bash 非零/信号退出返回工具失败并保留输出。证据检查器模块冲突修复后重新验证缺证据拒绝放行。

具体实现入口：packages/core/src/bots/{bot-work,bot-identity,bot-facade}.ts；session/history/；memory/bot-memory-scope.ts；cron/{routine-runtime,event-routine}.ts；rooms/{index,tool-policy}.ts；connectors/software-execution.ts；apps/daemon/src/routes/{bot-history,bot-work,bot-rooms,cron,connectors,memory}.ts；apps/web-console/components/ 下的对应 UI。OpenAPI 为已实现的 OpenAPI 3 支持子集，不声明全规范兼容。独立审阅见 docs/reports/bot-final-independent-review.md。

## 工作包与发布判定

| 工作包 | 当前状态 |
|---|---|
| W0 | 身份/状态/错误/迁移契约和八组规格已登记，本地验证通过 |
| W1 | 通信、委派、审批、结果、恢复及背压本地验收完成 |
| W2 | 历史/记忆功能已实现并通过本地验证；完整规模、真实模型质量待验收 |
| W3 | 四类触发、时区、运行历史、隔离、重试/取消/恢复本地验收完成 |
| W4 | 默认 Super 的状态、派工、联系任意有权 Bot、汇总闭环本地验收完成 |
| W5 | Room 成员、共享输入、预算、停止/恢复、隔离本地验收完成 |
| W6 | 界面、zh/en、实际后端浏览器 E2E 本地验收完成；computer-use 未执行 |
| W7 | 软件执行及授权/未知写入本地受控服务验收完成；真实软件/平台矩阵待验收 |
| W8 | 故障、迁移、局部门禁完成；完整性能、24h soak、真实质量证据未完成 |

固定负载 scripts/bot-release/workload.v1.json 未缩减：标准 4 CPU/8 GiB/SSD、API 5 分钟预热+15 分钟测量、20 客户端/40 RPS、30 分钟预热+24h soak、真实模型质量三次及真实软件平台矩阵仍需执行。剥离外部依赖后，长期稳定性和完整性能仍是内部待验收项。

scripts/bot-release/evidence.mjs 是 manifest 证据检查器，缺门槛拒绝放行；它不等于已接通生产发布编排。上述为实际本地命令结果，没有宣称远端 CI 已运行。

当前工具清单没有 computer-use 或所需 Node REPL 浏览器控制工具，因此用户要求的 computer-use 未执行。实际 Chromium 的 Playwright E2E 已执行，但不能冒充该工具验收，也不能把受控模型/软件当作真实第三方。

结论：本轮发现的功能缺口已实现并完成上述本地复核；不能声称原计划全部完成。商业发布 No-Go，W8 仍待验收。没有部署或升级 Mac。

浏览器实际 runner 命令（见 test-results/bot-round12-full.log 和 bot-round12-critical-{1,2,3}.log）：

- 全量：node scripts/e2e-run.mjs --workers=1 --retries=0 --reporter=line,junit
- 三连每次：node scripts/e2e-run.mjs e2e/bot-workspace.spec.ts --workers=1 --retries=0 --reporter=line,junit
- Chromium 路径通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium 配置；JUnit 分别输出上述 round12 文件。


后续验收继续进行，完整性能/24h/真实环境阻塞、长测运行状态及CUA交接见 [剩余验收记录](2026-10-13-bot-mode-remaining-acceptance.md)。前述round12“最终”仅指该轮本地功能验证，不表示W8结束。
