# Harness 能力评估与提示词回归

单测证明的是**约定行为没有坏**，不是“Agent 更聪明”。真实模型、同一批任务、冻结基线与候选版本的配对实验，才是能力变化证据。两层都必须保留；不把 heuristic、脚本模型或一次冒烟的绿灯当成能力提升。

## 已实现的入口

```bash
# 不调用模型：验证真实 runtime、隔离、评分器和报告链路
pnpm run agent:eval:verify

# 真模型：先分别构建两个可信 checkout，再比较；输出目录必须不存在
pnpm run agent:eval:compare --config scripts/agent-eval/experiments/starter.json \
  --baseline-root /absolute/path/to/baseline --candidate-root /absolute/path/to/candidate \
  --out test-results/harness-quality-example
```

连接沿用已有 `RAW_AGENT_API_KEY`、`RAW_AGENT_BASE_URL`、`RAW_AGENT_MODEL_NAME`，本地可读取根 `.env`；不新增功能开关 env。实验 JSON 指定 `model.provider/httpKind/temperature`，上游须与之匹配。比较器不自动构建，记录实际 `dist` 哈希，并拒绝运行中构建变化；启动前须构建两个版本。

配置样例：[starter.json](../scripts/agent-eval/experiments/starter.json)。改变行为使用 `baseline/candidate.daemonControl`（与 Lab 相同的持久化配置 key），例如 `compact_settings`；提示词使用 `systemAppendix`。后者在实际模型请求的 system 位置注入，而非仅写入报告。生产系统提示词本身的改动通过两个源码版本比较。不要把多项无关功能和提示词修改混成一个实验。

每个任务 × 重复 × 版本都用独立进程和临时数据库；AB/BA 交替运行，保持同模型、数据、预算、评分器。评估器只给模型安全的 `lookup_record` / `save_result` 工具，检查实际写入状态，而非相信“我已经完成”。请求只允许配置的模型 origin；设置调用次数、输出、输入长度和超时上限。实验任务、配置与输出可能包含业务数据，使用脱敏数据；不要把密钥放进 prompt 或 fixtures。

## 怎样判断加分、减分

| 判断层 | 检查 | 不允许的捷径 |
|---|---|---|
| 有效性 | 配对完整、模型身份一致、无基础设施错误、usage 可用 | 把 429、超时、缺失数据当成成功或 0 成本 |
| 红线 | 关键任务、未授权写入、工具结果配对、会话完成状态 | 总分上升掩盖安全或关键流程倒退 |
| 能力 | 总体和分类型任务成功率、所有重复均成功的可靠性 | 用重复次数冒充独立任务数 |
| 成本 | token 与延迟比值 | 多花数倍资源却只展示成功率 |
| 置信度 | 任务级近似 Wilson-Bonferroni 区间 | 差异不显著就宣称“相同” |

默认至少 30 个不同任务、每版本每任务 3 次；基线成功率下限 80%，非劣容忍 5 个百分点，分类退化上限 5 个百分点，token 比不超过 1.2、延迟比不超过 1.5。这些是**可审查的初始策略，不是统计充分性保证**：分类样本少时，即使全对也可能仍无法证明非劣。区间是保守近似，结论仅适用于该任务集和采样条件，不覆盖真实世界所有输入。

报告状态：`improved` / `non_inferior` 才有晋级资格；`regressed` 拒绝；`blocked` 表示基线本身存在关键失败等阻断；`invalid` 表示实验无效；`inconclusive` 表示证据不足。预先存在的失败不能归因于候选。真模型退出码：合格 0，退化/阻断 1，无效/证据不足/A/A 控制 2。simulation 即使退出 0，也始终 `promotionEligible=false`。

## 每次功能或提示词变化的工作流

1. **冻结题目与基线**：选已知良好 commit/tag，锁定模型版本、配置、预算、评分器和任务集；不要每天自动更新及格线。
2. **A/A 校准**：同一版本同配置重复比较，了解模型和延迟噪声，检查评分器是否误判。默认 starter 配置正是 A/A，不能认证新功能。
3. **单变量 A/B**：先仅开一个功能或加一段 system appendix。记录任务级赢/输，不只看汇总。
4. **消融复验**：从候选移除该项，检查收益是否消失；多功能交互另开组合实验。当前 CLI 每次比较两个版本，消融是独立实验，不会自动枚举组合。
5. **留出集验收**：开发集定位问题，未用于调 prompt 的留出集作最终门禁。失败修复后整批重跑，不能只重试失败题直到变绿。
6. **合格才提升基线**：保存证据并审查任务覆盖；经明确接受后再更新 baseline，不自动覆盖历史。

`manifest.json` 保存源码/build/配置/任务/driver 指纹；每条 trial JSON 保存 transcript、实际工具结果、prompt 形状、模型身份、usage 与评分；`report.json` / `report.md` 保存结论和阻断原因。报告默认在 `test-results/harness-quality-*`，不覆盖旧目录。完整 transcript 可能含敏感业务内容，不应随意公开 artifact。

## 当前边界与启用线上门禁

内置 [starter 12 题](../scripts/agent-eval/quality-cases/starter.json) 覆盖指令、工具、恢复、信任边界、多轮上下文；它是引擎自检与初始探针，**有意不足以自动晋级**。当前 fixture 工具不代表生产 bash、浏览器、外部系统、长仓库任务；短上下文题也不能证明大窗口压缩有效。不要复制题目凑数量。需要从实际工作中补充不同的脱敏任务、客观验收器和独立留出集；需要真实工具的新领域必须先扩展隔离 driver，再谈相应能力保证。

已提供手动 [Harness quality comparison workflow](../.github/workflows/harness-quality.yml)：输入冻结基线，独立 checkout/build 两边。配置 Secret `HARNESS_EVAL_API_KEY`，Variables `HARNESS_EVAL_BASE_URL`、`HARNESS_EVAL_MODEL_NAME`。只跑可信代码，不能把密钥交给未审查 fork。失败或证据不足不通过，报告保留 14 天。

常规 release gate 已跑 `agent:eval:verify`，但**真实能力比较尚未设为强制发布依赖**：须先校准代表性任务集并配置 CI 上游连接。当前没有真实上游实验结果，也没有据此宣称任何提示词有正收益。后续可将校准后的比较 job 接入同 SHA 发布依赖；不能把默认 12 题/A/A 当生产质量门禁。

方法参考：[Anthropic：Agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[OpenAI：Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)。项目的具体实现、默认阈值与统计方法以代码为准，不等同于这些文档的官方背书。
