# 验收标准门禁（Acceptance gate）

`main` 发布卡点的一部分：把用户需求写成**可执行的验收标准**，负责人只评审标准（Given / When / Then），
不评审代码；门禁证明每一条已批准的标准都有一个**通过的**测试。

- 工作流（给 Coding Agent）：[`skills/acceptance-first/SKILL.md`](../skills/acceptance-first/SKILL.md)
- 纯逻辑：[`scripts/acceptance/acceptance-lib.mjs`](../scripts/acceptance/acceptance-lib.mjs)（单测
  [`scripts/test/acceptance-lib.test.mjs`](../scripts/test/acceptance-lib.test.mjs)、CLI 测试
  [`scripts/test/acceptance-gate-cli.test.mjs`](../scripts/test/acceptance-gate-cli.test.mjs)）
- CLI：[`scripts/acceptance/acceptance-gate.mjs`](../scripts/acceptance/acceptance-gate.mjs)
- 示例（门禁自身的规格，status `implemented`）：[`acceptance/acceptance-gate.yaml`](../acceptance/acceptance-gate.yaml)

## 规格文件

`acceptance/<feature-id>.yaml`，`feature-id` 为 kebab-case 且等于文件名（只认 `.yaml`）：

```yaml
id: skill-proposals
title: 技能提案审批
status: approved           # draft | approved | implemented | retired
requirement: |
  用户原话
criteria:
  - id: AC-1
    given: 已开启技能提案
    when: Agent 提交一个技能提案
    then: Lab「更多」页出现待审批卡片，批准后技能可被 load_skill 加载
```

必填：`id`、`title`、`status`、`requirement`、`criteria`（非空；每条 `id` / `given` / `when` / `then` 均为非空字符串，
`id` 在文件内唯一）。可选：`retiredReason`（retired 时应填写，否则告警）、`owner`、`notes`、`links`、criterion 的 `notes`；
其它字段告警但不失败。YAML 用仓库已有依赖 [`yaml`](https://www.npmjs.com/package/yaml) 解析，重复键视为错误。

## 测试如何关联标准

测试**标题**里写 `[AC:<feature-id>#<criterion-id>]`，一个测试可带多个标签；`describe` 标题上的标签作用于其中所有测试。
支持 node:test `test(...)`、vitest `it(...)` / `describe(...)`、Playwright `test(...)` / `test.describe(...)`。

**扫描范围 = 运行器真正执行的文件**，从各自配置读取，不另维护列表：

| 运行器 | 文件集合来源 |
|---|---|
| node:test（`npm run test:unit`） | `package.json` 中 `test:unit` 脚本 `--test` 之后的路径 / glob |
| vitest（agent-loop） | `packages/agent-loop/vitest.config.ts` 的 `include` |
| Playwright（`npm run test:e2e`） | `playwright.config.ts` 的 `testDir` 下 `*.spec.ts` / `*.test.ts` |

测试类文件（`*.test.*` / `*.spec.*` 或位于 `test/`、`e2e/` 目录）里出现 `[AC:` 却不在上述集合中 → **失败**（标签写了但测试永远不会跑）。
`test.skip` / `.todo` / `.fixme` 静态上不算覆盖。

## 判定规则

| status | 静态模式（无结果文件） | 结果模式（`--results`） |
|---|---|---|
| `draft` | 只列出「等待负责人确认」，永不失败 | 同左 |
| `approved` | 每条标准 ≥1 个带标签的有效测试，否则失败：`approved but not implemented — AC-x has no test tagged …` | 每条标准 ≥1 个带标签测试**通过**且**没有**带标签测试失败；skipped / todo / 没跑都不算 |
| `implemented` | 同 approved（报错不带 approved 字样） | 同 approved |
| `retired` | 不检查 | 不检查 |

此外一律失败：规格解析 / schema 错误、criterion id 重复、标签格式错误、标签引用不存在的规格或标准（含只在运行时才出现的动态标题）。
标签引用 retired 规格只告警。

**approved 与 implemented 的区别**：两者在 CI 里是同一条线——approved 的规格出现在 main 上就必须已经实现，
所以 approved 缺测试在 PR 上也失败（规格、测试、代码可以在同一个 PR 一起合入）。区别在人这一侧：
`approved` = 负责人已签字、实现中；`implemented` = 实现者声明已完成。approved 且全部通过时门禁给出提示，
建议改为 implemented。想先合入规格、之后再实现，就保持 `draft`。

**重试**：同一结果文件里同名测试多次出现（重试）时，任一次通过即算通过；flaky 是否判红由各测试 job 自己负责
（如 Playwright `failOnFlakyTests`）。

## 结果采集（JUnit）

三个运行器都原生输出 JUnit XML，门禁只需一个解析器；原有的人类可读输出保留：

| 运行器 | 方式 |
|---|---|
| node:test | CI：`scripts/ci/retry-failed-tests.mjs --junit <dir>/unit.xml`，首轮写 `unit.xml`，flaky 重跑写 `unit.retry-N.xml`，门禁把二者当同一用例的多次运行（任一次通过即通过）。本地 `test:acceptance:full`：`NODE_OPTIONS="--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=<dir>/unit.xml"`（node 只认文件列表之前的 reporter 参数；目标目录需先存在） |
| vitest | `vitest run --reporter=default --reporter=junit --outputFile.junit=<dir>/vitest.xml` |
| Playwright | `npm run test:e2e -- --reporter=dot,junit`，`PLAYWRIGHT_JUNIT_OUTPUT_FILE=<dir>/e2e.xml`（`scripts/e2e-run.mjs` 会把额外参数转给 `playwright test`） |

用例标题 = 祖先 `<testsuite>` 名 + `<testcase>` 名，所以 node:test 的 `describe` 标签也能对上。

## CI

[`release-gate.yml`](../.github/workflows/release-gate.yml)：

1. `crap` job 的 unit / vitest 步骤加 JUnit reporter，上传 artifact `acceptance-results-unit`；
   `tests` job 的 E2E 步骤加 JUnit reporter，上传 `acceptance-results-e2e`。
2. `acceptance` job（`Acceptance criteria gate`）在两者之后运行（测试红了也跑，便于看到哪些标准没有通过的测试），
   下载结果后执行 `acceptance-gate.mjs --results <dir>`；摘要写入 Step Summary，报告作为 artifact `acceptance-report` 上传。
3. 汇总 job **Main release gate** 的 `needs` 包含 `acceptance`，任一失败即失败。

## 本地使用

```bash
npm run test:acceptance             # 静态追踪（不跑测试，秒级；已包含在 npm run ci）
npm run test:acceptance:full        # 跑 unit + agent-loop vitest + e2e（带 JUnit），再基于结果判定；需先 npm run build
node scripts/acceptance/acceptance-gate.mjs --collect unit,vitest      # 只跑部分运行器
npm run test:acceptance:results     # 用 coverage/acceptance/results/ 下已有的 JUnit 文件判定
node scripts/acceptance/acceptance-gate.mjs --results a.xml --results dir/   # 任意结果文件 / 目录
```

输出：终端打印 Markdown 摘要；`coverage/acceptance/report.json`（完整报告）与 `summary.md`；设置了
`$GITHUB_STEP_SUMMARY` 时追加摘要。退出码：`0` 通过、`1` 门禁失败、`2` 无法判定（参数错误、结果路径不存在、不是 JUnit、没有任何用例）。
只跑部分运行器时，标签只在其它运行器里的标准会显示「not run」并失败——这是预期的。

## 失败怎么办

| 报错 | 处理 |
|---|---|
| `approved but not implemented — AC-x has no test tagged …` | 给该标准写测试并在标题加标签；还没开始实现就把规格保持 `draft` |
| `AC-x has failing tagged test(s)` | 修代码（不要改标准）；标准本身错了 → 找负责人重新确认后再改 |
| `no test tagged … passed in the supplied results` | 测试被 skip / todo，或所在运行器没跑（确认文件在 `test:unit` 列表 / e2e 目录） |
| `references unknown spec / criterion` | 标签拼错，或规格还没提交 |
| `not executed by any configured test runner` | 把测试文件加进 `package.json` 的 `test:unit`，或移到运行器目录 |

## 局限

- 静态扫描只认字面量标题；动态拼出的标题只能在结果模式里被识别。
- 门禁证明「有通过的带标签测试」，不证明测试真的验证了标准描述的行为——这由 PR 评审与
  [`acceptance-first`](../skills/acceptance-first/SKILL.md) 纪律保证（禁止给空测试打标签）。
- 结果模式按标题里的标签归集，不逐个核对静态扫到的带标签测试都出现在结果里：一条标准只要有一个通过、没有失败即可。

## 软件交付与现场验收阶段

2026-10-19用户明确批准第四阶段按8条本地软件标准单独交付，原40条原文与approved状态保留为现场验收。规格可选 `verificationStage: software | deployment`，省略为software。

- `npm run test:acceptance` 默认软件阶段；所有既有软件规格仍阻断。
- `npm run test:acceptance:deployment` 运行 `--stage all`，软件及现场规格全部参与，现场缺项仍阻断发布验收。
- 也可显式 `--stage software|deployment|all`；非法阶段拒绝。
- 软件报告完整保留现场标准、批准状态及未通过状态，标记 `applicable:false`，不得据软件通过宣称现场就绪。
- 已批准的软件基线不能通过改变verificationStage迁出软件门禁。新增/调整适用阶段同样必须经用户明确批准，不得用此字段规避验收。

阶段门禁仍只是自动化追踪；现场就绪还必须校验真实制品、实际入口和原始运行证据。静态标签、模拟用例或短时本地回归不能代替真实双机与24小时运行。
