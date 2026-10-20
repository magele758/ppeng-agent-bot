# 上下文可靠性验证

验收对应 `context-reliability#AC-14`。必须分别报告确定性软件契约和真实模型语义质量；任何模拟、跳过、未执行或不完整运行均不构成真实模型通过。

## 样例与观察对象

`scripts/agent-eval/quality-cases/context-reliability.json` 是版本化的 10 个样例，由 `buildContextSuite()` 生成并由测试检查两者一致。五类场景各运行普通会话与 canonical Bot：

| 场景 | 对话行为 | 最终检查 |
|---|---|---|
| 约束保留 | 用户明确目标和环境限制，插入长历史并重复压缩 | 当前允许的环境 |
| 用户纠正 | 用户先设置负责人，再明确替换 | 当前负责人，不接受旧负责人 |
| 任务切换 | Atlas → Birch → Atlas，各自不同约束 | 恢复 Atlas 的预算 |
| 压缩后事实查找 | 原始检查留下精确标识，随后重复压缩 | 原始标识，不接受近似答案 |
| 跨会话找回 | 前一个会话包含唯一关键词与决策；新会话查找 | 最终标识且实际成功执行 history_search、history_read，读取内容确实来自前一会话并包含目标事实 |

每例先通过真实 `RawAgentRuntime` 接收任务消息，再分两次各注入 64 条已完成检查的对话记录、调用产品已有的强制压缩入口，最后发送不包含答案的追问。工具、存储、搜索和压缩使用对应版本的生产实现。`contextEvidence` 记录注入条数与两次替换范围；未发生压缩不算有效语义验证。这验证的是强制压缩后的语义保留；20% / 50% / 85% 自然触发阈值由确定性集成测试另行覆盖。

这是定向诊断集，不是统计代表性样本。普通与 Bot 的同类题不能当成独立业务场景来夸大样本量。成功报告只能称“样例通过”，不能声称模型永不出错或达到统计非劣。

## 确定性检查

批准的标准先写带 AC 标签的失败测试，再实现。构建完成后运行：

```bash
node --test scripts/test/context-reliability-eval.test.mjs
node --test scripts/test/harness-quality.test.mjs
pnpm run test:acceptance
```

第一项检验样例覆盖、样例版本一致性、证据分类和召回失败判断；它不运行 LLM，也不验证运行时本身。运行时的任务状态、摘要、历史检索、权限隔离、召回降级测试以及普通/Bot 既有预算回归由对应模块的测试负责。需附真实输出或 JUnit 文件，不能由样例存在推导为运行时通过。

## 模拟运行

```bash
node scripts/build-workspace.mjs
pnpm run agent:eval:compare --config scripts/agent-eval/experiments/context-reliability.json --simulation --trials 1 --out test-results/context-simulation-<run-id>
node scripts/context-reliability-eval.mjs --results test-results/context-simulation-<run-id> --out test-results/context-simulation-summary-<run-id>
```

模拟使用预置模型响应，仍运行真正的会话、搜索和压缩链路；仅验证驱动与可观测性。报告分类为 `not_validated`，摘要命令非零退出是有意行为。底层 comparison 也可能因小样本、缺失成本或统计区间而返回非零；查看 artifacts 中逐例结果，不能把非零统一解释为软件崩溃。

## 真实模型运行

需要已有的 `RAW_AGENT_API_KEY`、`RAW_AGENT_BASE_URL`、`RAW_AGENT_MODEL_NAME`；不新增产品开关。配置检查只输出存在与否，不打印值。无密钥时使用下方 inventory 命令保存 `not_run`：

```bash
node scripts/context-reliability-eval.mjs --out test-results/context-readiness-<run-id>
```

冻结 baseline 和 candidate，分别完成构建后运行；不要在评估期间改构建产物：

```bash
pnpm run agent:eval:compare --config scripts/agent-eval/experiments/context-reliability.json --baseline-root /absolute/path/to/frozen-baseline --candidate-root . --out test-results/context-live-<run-id>
node scripts/context-reliability-eval.mjs --results test-results/context-live-<run-id> --out test-results/context-live-summary-<run-id>
```

experiment 默认 3 次重复，每条限 16 次模型请求/180 秒，整体预计算上限 1,000 次。长历史摘要成本不可忽略。上游摘要接口不一定提供 usage，缺失成本必须标为缺失，不能填 0。10 个样例未达到通用 comparison 默认 30 个独立任务门槛，预期统计结论可能为 `inconclusive`；不要放宽 policy 只为了得到绿色。

保留 `manifest.json`（版本、构建、数据及配置指纹）、逐例 JSON（原始对话、工具调用、结果、失败原因）、比较报告和上下文摘要。摘要重新执行客观评分，不盲信记录里的 `pass`；模拟、未执行、缺少试验、缺少真实 provider 或压缩证据均不能变成 `passed_samples`。无参数的 inventory 创建成功退出 0 仅代表清单写成功，其 semanticStatus 仍为 `not_run`。

## 既有压缩 A/B 的解释

`test:compact-ab` 现在必须所有实际执行的样例 `recalled=true` 且无执行错误才能退出 0；heuristic 跳过退出 2，召回失败退出 1。它用于验证工具结果占位策略，不代替完整长期上下文质量集。输出中的 `summary.failed` 仍表示执行错误数量；事实召回看 `recalled`，不要混淆。

## 本次执行记录

AC-14 的测试先以缺少实现模块 `ERR_MODULE_NOT_FOUND` 失败，再完成实现转绿。

| 检查 | 本次结果 | 证据 |
|---|---|---|
| 专用样例/分类测试 | 3/3 通过 | `node --test scripts/test/context-reliability-eval.test.mjs` |
| 既有 quality 驱动回归 | 15/15 通过，含 mock network/真实 runtime 链路 | `node --test scripts/test/harness-quality.test.mjs`；这些不是远程真实模型语义评测 |
| 稳定构建模拟长对话 | 10 例 × A/A 两侧 × 1 trial，共 20/20 脚本链路通过 | `test-results/context-reliability/simulation-final/report.md` 与同目录逐例 JSON |
| 模拟语义分类 | `not_validated`；comparison 为 `inconclusive`，无发布资格 | `test-results/context-reliability/summary-final/context-evidence.json` |
| Compact A/B 无真实模型 | 明确 skipped，exit 2 | `RAW_AGENT_MODEL_PROVIDER=heuristic node scripts/compact-ab-eval.mjs` |
| 真实模型 | 未执行，三项配置不存在 | `test-results/context-reliability/readiness/context-evidence.json` |

模拟的两侧使用同一构建，是 A/A 驱动校准，不是新旧版本质量提升证据。每例均发生两次实际压缩；跨会话两例调用并读取真正的历史工具。最初一次模拟恰逢其他构建改变产物，驱动正确判为 `invalid`，证据保留在 `test-results/context-reliability/simulation`；最终使用 `simulation-final`。上表中的通过只表示确定性或预置模型脚本链路检查，不表示真实语义通过。

完整运行时模块、SDK、HTTP/E2E 和验收门禁结果由集成人员在此继续补充。

当前真实模型准备检查：API key、base URL、模型名均未配置；真实语义评测未执行。机器可读证据：`test-results/context-reliability/readiness/context-evidence.json`（`semanticStatus=not_run`）。

## 集成后的最终回归（2026-10-13）

在各模块完成后重新构建，再运行 unit/vitest；下面是实际执行结果。

| 检查 | 结果 | 可复查证据 |
|---|---|---|
| 工作区 TypeScript 构建 | 通过 | `test-results/context-reliability/logs/build.log` |
| 单元测试 | 2,975 通过，0 失败，4 跳过；共 2,979 项 | `test-results/context-reliability/logs/unit-vitest.log`、`acceptance/results/unit.xml` |
| agent-loop SDK 全量 | 362 通过，0 失败；SDK build 通过 | 同上 `acceptance/results/vitest.xml`；SDK 技能已同步 |
| 本次 AC-1 至 AC-14 | 全部 passing | `test-results/context-reliability/acceptance/report.json` |
| 前端生产构建 | 通过 | `test-results/context-reliability/logs/web-build.log` |
| HTTP 回归 | 通过（heuristic 模型） | `test-results/context-reliability/logs/regression.log` |
| HTTP 集成 | 通过（heuristic 模型） | `test-results/context-reliability/logs/integration.log` |
| 快速评估 | 22 通过，0 失败，0 跳过（heuristic 模型） | `test-results/context-fast/2026-10-13.jsonl` |
| transcript/formal regression | 25 通过，0 失败；单测/性质测试/MockLLM，不代表形式化证明 | `test-results/context-reliability/logs/formal.log` |
| 长对话模拟 | 20/20 脚本执行链路通过；语义 not_validated | `test-results/context-reliability/simulation-final/report.md` |
| 真实模型语义评测 | not_run：现有 key、base URL、model name 均未配置 | `test-results/context-reliability/readiness/context-evidence.json` |
| 浏览器 E2E | 未执行：缺少 Chromium，安装下载返回 403 Domain forbidden | `test-results/context-reliability/logs/browser-install.log` |

单元测试的 4 个跳过属于既有平台/环境条件，未当作通过。静态验收门禁通过；**全项目结果门禁未通过**，原因是本轮只采集 unit/vitest，浏览器标准缺少执行结果。新 `context-reliability` 的 14 条标准全部有实际通过结果，不能由此声称全项目 Release gate 已通过。

第一轮集成暴露了旧 Bot 记忆 fixture 依赖压缩唯一最新问题、以及旧摘要重复注入问题。已经修复：fixture 增加后续用户问题，继续验证压缩前记忆写入、失败降级和同区间重试幂等；产品压缩失败保留历史并记录原因；SDK 的摘要回调抛错契约仍保留。以上数字来自修复后的最终完整运行。

## 设计与适用边界

- 任务保护采集发生在用户消息实际写入时，保留目标、约束、决策、待办、进度及来源，区分有效、替代和完成状态。当前有效要求进入受保护的动态 system；Task 描述、Goal 和 Todo 同时接入。明确切换任务时隔离和恢复专属状态。
- 明确语句使用保守规则识别，例如 `目标：…`、`当前目标是…`、`只改…`、`还需要…`、`把“旧要求”改为“新要求”`、`切换到任务 A`。它不能保证理解任意自然语言任务切换或纠正，也没有对旧会话的所有用户声明自动做语义回填。
- 普通会话与 Bot 使用相同的任务保护、来源和检索契约，默认触发策略分别仍为 20% 和 50%/85%。受保护内容本身超预算时记录原因并保留；摘要失败不静默删除要求。
- 滚动摘要按更新语义替换，不再次拼接整个旧摘要；模型请求存在 `compact-summary` 时不重复注入 `session.summary`。来源导航有界并计入预算；极小预算可省略整条导航，历史原文仍能通过关键词搜索。
- `history_search` 扫描授权会话的原始 WAL append 文本/工具结果，提供片段与引用；`history_read` 按引用或 `session_id + seq + part` 分页读取。当前实现是精确关键词/短语扫描，尚无历史向量索引或 FTS 索引；大规模历史的检索延迟需要后续单独测量。
- 历史跨会话访问要求相同且非空的用户、相同租户与 Bot 命名空间；未知用户只访问当前会话，搜索及每页读取均重验。记忆搜索/读取也使用最新身份，兼容同用户的无租户历史记忆，具体外租户记录在 FTS/LIKE 的 LIMIT 之前排除。
- 记忆预览和实际发送共享异步编译：身份、持久设置、向量融合、工作日志、legacy session backend、Jev 选择及格式。向量服务不可用降级词法检索，原因使用脱敏固定诊断记录在会话 metadata 和预览 pack。
- 本次可证明确定性的保护、隔离和取回链路。模型是否主动搜索、是否正确解释取回内容，需要真实模型样例验证；本环境尚未完成这部分验证。

交叉复查再补两项实际失败测试并修复：任务状态逐字段规范化，异常数据不会导致消息已落库后报错，有效要求不会因其他坏项被丢弃；fast 模式的 `persistentMemory=off` 放入共享编译入口，使预览与真实请求同样为空。精确纠正只忽略前导“请”，不扩大为模糊替代；可选记忆读取 host 的租户过滤也与搜索对齐。最终完整 unit/vitest 和 HTTP 回归在这些修复后的构建上重新运行。

`acceptance/context-reliability.yaml` 已从 approved 标为 implemented；最终 `pnpm run test:acceptance` 静态检查通过，日志在 `test-results/context-reliability/logs/acceptance-static.log`。结果报告保存的是标记前实际测试记录，14 条标准均 passing；全局 28 条浏览器标准仍为 not-run，保持失败门禁不作伪。

## 提交前 Review

Review 复现了连续强制压缩而没有新对话时的摘要叠加：新范围未包含上一次摘要，fold 中出现两个 `compact-summary`。新增 SQLite 普通/Bot 回归先断言失败（第二次压缩出现 2 份摘要），再修复共享 surface fold：保留最新成功的滚动摘要，旧摘要保留在 WAL；隐藏最新摘要不会复活旧摘要，其他 key 的语义不变。SDK 增加三项 fold 回归，两份 SDK 技能同步。任务声明解析提取为独立 helper，降低单函数复杂度，行为由既有测试保持。

提交前覆盖率回归再次通过：单元测试 2,976 通过、0 失败、4 跳过；SDK 365 通过。CRAP gate PASS（未更新或放宽 baseline），本地包安装/导出/类型/mini 可移植性检查通过，formal regression 25/25，静态验收门禁通过。证据保存在 `test-results/context-reliability/review/`。浏览器与真实模型的本地限制仍如前述，PR 通过远端 CI 补足浏览器结果后再合并。
