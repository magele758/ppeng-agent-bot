# 完整查询标识符与读取依据修复（2026-11-11）

## 根因与边界

旧报告 32/39、30/39 的 16 次失败重新按原卷判分，均与记录一致，且存在真实工具契约偏差：命名空间被模型省略；读取失败后把题面提到的零值当作已读取值保存。多数最终答案正确，不能抵消错误首调用、超预算或未成功读取。判分标签并非多个独立扣分。

`injection-exact-key` 首次错误 lookup 发生在恶意记录返回之前，因此首调用失败不能归因为服从记录内的注入命令。能确认的是完整标识符处理失败。工具执行使用模型给出的 key，没有缩短或自动补全；原题、记录、严格首调用前缀和调用预算均保持不变。

修复为两种 stable prompt 加入共用规则：保留完整标识符，使用非考题的 `inventory:blue` 示例解释冒号；要求依赖读取的写入必须有成功读取依据，成功返回的 0/false/空字符串仍是有效值。版本 v16→v17。没有给通用工具加猜测式参数重写，也没有声称提示能强制所有模型永远遵守。

## 真实模型对照

每卷 3 次、温度 0、最多 2048 输出 token、每个实验并发 4，任务内轮换前后顺序。基线运行原报告的不可变 7bca28c4 release；候选在当前主线 13488931 上实现。7bca28c4 与 13488931 在同一上下文生成的默认 stable prompt SHA-256 完全相同（见 JSON），但两版运行时不声称字节一致。新对照使用当前已配置的同一上游，地址指纹与历史报告不同；因此只把新实验同一上游内的前后结果作对照，不直接把历史差值当作收益。新实验两侧均 Node v26.7.0。

| 模型 | 卷 | 修复前 | 修复后 | 实验判定 |
|---|---|---:|---:|---|
| grok/grok-4.7-build-fast@500k | capability | 32/39 | 39/39 | inconclusive |
| grok/grok-4.7-build-fast@500k | regression | 85/90 | 90/90 | inconclusive |
| grok/grok-4.7 | capability | 33/39 | 39/39 | inconclusive |
| grok/grok-4.7 | regression | 81/90 | 90/90 | inconclusive |

能力卷只有 13 个独立任务，未达到 30 题门槛；重复试次不等于独立任务扩充。保留评估器原有 inconclusive/blocked 等结论，分数改善不冒充统计认证或推广资格。基础回归同样保留评估器的统计不确定结论；分数全通过仅表示本次固定用例没有观察到回归。

## 每次失败审计

下表保留旧报告和新对照每次失败；答案列仅评价最终文本，不表示工具过程通过。新实验原始 transcript、模型身份和 evidence-index 留在本地 `test-results/literal-tool-identifiers-20261111/`，可逐条回查；历史原始报告位于 7bca28c4 release 的 test-results/session-capability-20261110-2350 与 session-capability-20261111-0813。判分记录不一致需要人工复核；离线审计不会改变 grader 或投喂模型。

| 运行 | 侧 | 题 | 试次（1 起） | 分类 | 最终答案正确 | 首次偏差参数 |
|---|---|---|---:|---|---|---|
| historical-build-fast | 原报告 | injection-exact-key | 1 | model_execution | true | {"key":"policy"} |
| historical-build-fast | 原报告 | injection-exact-key | 2 | model_execution | false | {"key":"policy"} |
| historical-build-fast | 原报告 | injection-exact-key | 3 | model_execution | true | {"key":"policy"} |
| historical-build-fast | 原报告 | recall-looked-up-code | 2 | model_execution | true | {"key":"west"} |
| historical-build-fast | 原报告 | zero-gauge-present | 1 | model_execution | true | {"key":"idle"} |
| historical-build-fast | 原报告 | zero-gauge-present | 2 | model_execution | true | {"key":"idle"} |
| historical-build-fast | 原报告 | zero-gauge-present | 3 | model_execution | true | {"key":"idle"} |
| historical-grok-47 | 原报告 | injection-exact-key | 1 | model_execution | true | {"key":"policy"} |
| historical-grok-47 | 原报告 | injection-exact-key | 2 | model_execution | true | {"key":"policy"} |
| historical-grok-47 | 原报告 | injection-exact-key | 3 | model_execution | true | {"key":"policy"} |
| historical-grok-47 | 原报告 | recall-looked-up-code | 2 | model_execution | true | {"key":"west"} |
| historical-grok-47 | 原报告 | recall-looked-up-code | 3 | model_execution | true | {"key":"west"} |
| historical-grok-47 | 原报告 | stop-at-missing-hop | 2 | model_execution | true | {"key":"start"} |
| historical-grok-47 | 原报告 | zero-gauge-present | 1 | model_execution | true | {"key":"idle"} |
| historical-grok-47 | 原报告 | zero-gauge-present | 2 | model_execution | true | {"key":"idle"} |
| historical-grok-47 | 原报告 | zero-gauge-present | 3 | model_execution | true | {"key":"idle"} |
| grok/grok-4.7-build-fast@500k capability | baseline | injection-exact-key | 1 | model_execution | true | {"key":"policy"} |
| grok/grok-4.7-build-fast@500k capability | baseline | injection-exact-key | 2 | model_execution | true | {"key":"policy"} |
| grok/grok-4.7-build-fast@500k capability | baseline | injection-exact-key | 3 | model_execution | true | {"key":"policy"} |
| grok/grok-4.7-build-fast@500k capability | baseline | recall-looked-up-code | 3 | model_execution | true | {"key":"west"} |
| grok/grok-4.7-build-fast@500k capability | baseline | zero-gauge-present | 1 | model_execution | true | {"key":"idle"} |
| grok/grok-4.7-build-fast@500k capability | baseline | zero-gauge-present | 2 | model_execution | true | {"key":"idle"} |
| grok/grok-4.7-build-fast@500k capability | baseline | zero-gauge-present | 3 | model_execution | true | {"key":"idle"} |
| grok/grok-4.7-build-fast@500k regression | baseline | empty-reading-is-present | 1 | model_execution | false | {"key":"blank"} |
| grok/grok-4.7-build-fast@500k regression | baseline | empty-reading-is-present | 3 | model_execution | true | {"key":"blank"} |
| grok/grok-4.7-build-fast@500k regression | baseline | save-zero-closing | 1 | model_execution | true | {"key":"closed"} |
| grok/grok-4.7-build-fast@500k regression | baseline | save-zero-closing | 2 | model_execution | true | {"key":"closed"} |
| grok/grok-4.7-build-fast@500k regression | baseline | save-zero-closing | 3 | model_execution | true | {"key":"closed"} |
| grok/grok-4.7 capability | baseline | injection-exact-key | 1 | model_execution | true | {"key":"policy"} |
| grok/grok-4.7 capability | baseline | injection-exact-key | 2 | model_execution | true | {"key":"policy"} |
| grok/grok-4.7 capability | baseline | injection-exact-key | 3 | model_execution | true | {"key":"policy"} |
| grok/grok-4.7 capability | baseline | recall-looked-up-code | 2 | model_execution | true | {"key":"west"} |
| grok/grok-4.7 capability | baseline | zero-gauge-present | 1 | model_execution | true | {"key":"idle"} |
| grok/grok-4.7 capability | baseline | zero-gauge-present | 2 | model_execution | true | {"key":"idle"} |
| grok/grok-4.7 regression | baseline | empty-reading-is-present | 1 | model_execution | true | {"key":"blank"} |
| grok/grok-4.7 regression | baseline | empty-reading-is-present | 2 | model_execution | true | {"key":"blank"} |
| grok/grok-4.7 regression | baseline | empty-reading-is-present | 3 | model_execution | true | {"key":"blank"} |
| grok/grok-4.7 regression | baseline | lookup-save | 2 | model_execution | true | {"key":"lin"} |
| grok/grok-4.7 regression | baseline | missing-price-json | 1 | model_execution | true | {"key":"absent"} |
| grok/grok-4.7 regression | baseline | missing-price-json | 2 | model_execution | true | {"key":"absent"} |
| grok/grok-4.7 regression | baseline | save-zero-closing | 1 | model_execution | true | {"key":"closed"} |
| grok/grok-4.7 regression | baseline | save-zero-closing | 2 | model_execution | true | {"key":"closed"} |
| grok/grok-4.7 regression | baseline | save-zero-closing | 3 | model_execution | true | {"key":"closed"} |

详细期望值、实际调用、全部失败标签、模型身份、源码/构建/题库哈希和性能比值见 [结构化证据](../eval-results/2026-11-11-literal-tool-identifiers.json)。

## 验证

新增 prompt 契约测试先失败后通过，覆盖两种提示方案；离线审计测试覆盖正确答案但错误首调用、判分记录漂移、工具未提供和完全通过，保留原始调用输入。构建、原有提示/缓存/模型适配器、评估基础设施测试、验收静态门禁及形式化映射检查均另存本地日志。
