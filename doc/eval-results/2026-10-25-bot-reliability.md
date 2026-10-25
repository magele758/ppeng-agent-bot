# Bot 完成判官对照（2026-10-25）

**结论：正式门禁判为 `inconclusive`，不合并、不部署、不认证。** 候选 96/96、旧版 90/96，两边用量完整，没有分类回退，也没有缺失用量。32 个独立任务的 Wilson-Bonferroni 区间约为 [-19.9%, +29.8%]，宽于既有 5% 非劣边界，所以通过率更高不能晋级。PR #251 保持打开。

本页不改写 [2026-10-24 历史记录](2026-10-24-bot-reliability.md)。那次是旧版 `ea4de04a` 对候选 `905e6307`，门禁为 `regressed`，不能用来证明 `d73c9f1a`。

## 本次对照

模型为当前 Bot 配置选出的 `grok/grok-4.7`（openai-compatible，temperature 0，JSON mode）。旧版 `2fa16dd62a2313ab25b300330c8c095f155a1ea5`，候选 `d73c9f1a68d61f114629469189f1cb525298384f`。两边采样时工作区干净，lockHash 相同。32 题 × 3 次 × 2 版 = 192 次，记录齐全。没有为补齐样本再跑真实模型。

| 指标 | 旧版 | 候选 |
|---|---:|---:|
| 任务执行通过 | 90/96 | 96/96 |
| 三次全部通过的独立任务 | 30/32 | 32/32 |
| 用量完整的执行 | 96/96 | 96/96 |
| 平均 token | 18182 | 18000 |
| token 比 | — | 0.990（上限 1.2） |
| 平均耗时 | 18.264 秒 | 17.417 秒 |
| 耗时比 | — | 0.954（上限 1.5） |
| 回退 | — | 0 |

旧版失败全部保留，没有改题、改预期答案或把缺失用量补零：

- `compact-revision` 三次目标状态不合格；第一次同时不是要求的最终答案。
- `parse-csv` 三次工具副作用不合格：第一次和第三次缺少 `lookup_record` 与 `save_result`，第二次缺少 `save_result`。

候选没有失败。完成判官原始输入、原始返回和错误已留在执行记录的 `auxiliaryRequests[].raw`。统计脚本按「判官先拒绝、最后一次接受」计修正轮，本次两边都是 0。这不删除判官原文。

## 为什么门禁拒绝

policy 与既有默认相同：最少 30 题、每题 3 次、基线通过率至少 0.8、非劣边界 5%、分类下降上限 5%、token 比 1.2、耗时比 1.5、必须有用量。整体与六个类别都是「非劣未建立」，因为区间超过 5%，不是因为出现回退。重复同一套 32 题不会增加独立任务数，也不能把这个区间收进 5%。

门禁命令实际返回非零：

```text
LIVE QUALITY GATE BLOCKED: quality not established: inconclusive
```

命令：

```text
node scripts/agent-eval/quality-gate.mjs --run test-results/grok-completion-wire-ab-d73c9f1a-20261025 --candidate-sha d73c9f1a68d61f114629469189f1cb525298384f --baseline-sha 2fa16dd62a2313ab25b300330c8c095f155a1ea5
```

## 合入 main 之后

`1c573a38` 把 `origin/main` 的 `8238b210`（PR #253）合进本分支，用来消除 PR #251 与 main 的冲突。保留 60 秒判官预算，成功返回后不 abort。这次合入改变了分支 SHA，**不重新认证**上面的 `d73c9f1a` 样本。质量门禁仍绑定采样时的两个 SHA。

## 验证

合入后定向测试 59 项通过（完成判官、意图判官、调度、稳定系统版本、质量脚本、完成审计、嵌套批准）。`pnpm exec tsc -b packages/core` 通过。验收门禁静态模式通过，1267/1267；`acceptance/bot-completion-reliability.yaml` 标为 `implemented`。四份正式审查状态为 `reviewed`、无漂移。本会话没有重跑全仓 `pnpm run test:unit`；接手时记录约为 5165 通过 / 0 失败 / 4 跳过。

## 证据

- [机器可读审计](2026-10-25-bot-reliability-audit.json)：身份、policy、判决、每次失败、测试记录。
- [证据索引](2026-10-25-bot-reliability-evidence-index.json)：197 份 JSON/Markdown 的 sha256。其中 195 份与采样目录里的 `evidence-index.json` 一致；索引自身和 `report.md` 是伴随文件。
- 原始轨迹留在 gitignore 的 `test-results/grok-completion-wire-ab-d73c9f1a-20261025`（约 6.8MB）。密钥扫描 197 个文件、0 命中。未把原始轨迹提交进仓库。
