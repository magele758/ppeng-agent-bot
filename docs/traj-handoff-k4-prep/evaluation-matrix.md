# 第四刀评估矩阵

对照基线：origin/main tip `c67112bc5de284d3806bc399cf7289458021044f`（2026-11-14 16:58:12 Asia/Shanghai）。本分支 HEAD `a857ee9833a8e0055e9f227d0784e1628366848d`（`a857ee98`）只是预备材料，不移动该基线，也不接受第四刀。
第三刀验收才算解阻：Formal + FV + 同头 Main full health，并线性落在当前 tip。第三刀准备树或未合入写者不是验收。本预备不打开组合入口。
只读实核范围：本隔离树的 `packages/core/src/orchestrator/{engine,types,store,index}.ts`、`packages/core/src/quality/gate.ts`、`packages/core/src/runtime/collaborators.ts`（`startSwarmForRun` 片段）、`acceptance/collaboration-quality-gates.yaml`、既有相关测试。未读取、未改动第三刀树或 #532 写者树。

图例：`表征` = 骨架里针对当前关闭行为的可执行断言；`skip` = `test.skip`，等解阻后取消跳过并接到真实现；`回归` = 已有测试，本刀必须继续跑。

| ID | 契约条目 | 当前 tip 实核（c67112bc） | 预备骨架 / 回归 | 解阻 |
| --- | --- | --- | --- | --- |
| E-01 | 不改名、不替换飞轮 Orchestrator；阶段顺序不改、不打乱 | `BOOTSTRAP_STAGES = classify → research → implement → review → test`；implement executor 仍为 `'swarm'` | 表征：`keeps bootstrap stage order and implement executor` | 现在；本预备不改名、不替换 |
| E-02 | 不在 core/飞轮另起交接状态机 | `engine.ts` 无 `trajectory-handoff` 导入；飞轮类型里的 `FlywheelType A–H` 是产品飞轮分类，不是交接入口 | 表征：引擎源码不导入交接模块 | 现在 |
| E-03 | 生产飞轮组合入口关闭 | 直到第三刀验收且第四刀实现开工前，生产飞轮不得挂交接启用字段、可信来源或组合开关。关闭表征：`startSwarmForRun` 只写 `goal` / `orchestrationRunId` / `strategy: 'pipeline'` / `qualityGate: ['completed']`，且不含 `trajectoryHandoff` / `handoffEnabled` / `trustedSource` / `capabilityTiers` / `explicit_on`。测试双不是生产 API | 表征：生产接线源码无上述字段。夹具里的 `compositionEntry: 'closed'` 与桩上 `handoffEnabled: false` 只属于测试双 | 现在，并保持到第三刀验收且第四刀实现开工之前 |
| E-04 | 飞轮经共用 Swarm 不得自动启用交接 | 该限制仍然有效。tip 上飞轮尚未把来源传入 Swarm，也没有解除实现。第三刀准备树或未合入写者不是验收。不得写成已经解除，也不得由本预备解除 | 表征（关闭态）+ skip：解除后的正向行为（skip 不是通过） | 解除只属于第三刀验收之后的 `WAIT-K4-IMPL`；本预备不可解除 |
| E-05 | implement 成功出口必须过证据门 | **缺口（记录，不是验收通过）**：`tryCompleteImplementStep` 在 `swarm.status === 'completed'` 时直接 `step.status = 'completed'`，不调用 `qualityPassed`。接线 `qualityGate: ['completed']` 与缺口一致。不改 `gate.ts` 必要但不足够；不得放宽 #516 | 表征（标注为 gap，第四刀实现后必须翻转，不得当成通过）；skip：过门成功 / 缺证据失败 | `WAIT-K4-IMPL`（翻转 gap 断言）；本预备不修、不放宽 |
| E-06 | 非成功 Swarm 终态不得完成 implement | `failed` / `cancelled` 会把步骤和 run 标失败；`completed` 才会放行。`timed_out` 等交接态未接入该出口 | 表征：`failed`/`cancelled` 不完成 implement；skip：交接非成功态不得经飞轮出口冒充成功 | 终态映射飞轮路径：`WAIT-K4-IMPL` |
| E-07 | 内核 `done` ≠ 交付成功 | delivery-mapping DM-4 / DM-1 已覆盖目录映射；飞轮 implement 出口尚未接到该分类 | 回归：`trajectory-handoff-delivery-mapping.test.js`；skip：飞轮出口拒绝内核 `done` | 飞轮出口：`WAIT-K4-IMPL` |
| E-08 | `answered/capped/failed/cancelled/timed_out/awaiting_coordinator` 不得交付成功 | 同上，目录映射已有 DM-2/DM-3；飞轮路径未接 | 回归 delivery-mapping；skip：飞轮路径再验 | `WAIT-K4-IMPL` |
| E-09 | 缺失 / 不可用 / 旧版本证据不得过门 | review/test 已由 `validateQualityReport` + AC-3/AC-5 覆盖；implement 成功出口未走该门 | 回归 `collaboration-quality-gates.test.js`；skip：implement 出口同等口径，证据绑定版本与任务范围 | implement 出口：`WAIT-K4-IMPL` |
| E-10 | 恢复后再完成、重规划后再完成仍过门 | 飞轮 implement 尚无交接恢复/重规划后再完成的过门路径 | skip：恢复漏跑与重规划后再完成 | `WAIT-K3`（真实恢复路径）+ `WAIT-K4-IMPL` |
| E-11 | research 只读；切 executor 也不能写 | `runOrchestrationResearch` 走 `ResearchPipeline`，无阶段权限交集，无角色锁定 | skip：research 宿主上切角色不可写 | `WAIT-K4-IMPL`（阶段权限接线）；可信来源形状 `WAIT-K3` |
| E-12 | review 只读 + 规划层模型；切角色不能写 | review 已过 `qualityPassed`，但阶段权限/角色交集未在飞轮宿主验收 | 回归 AC-3/4/5；skip：review 切角色不可写 | 同 E-11 |
| E-13 | implement 阶段内测试失败可重规划，不跨交付边界 | 当前引擎没有「implement 内测试失败 → 重规划仍不过交付门」的路径 | skip | `WAIT-K4-IMPL` |
| E-14 | 完整 `collaboration-quality-gates.yaml` AC-1…AC-5 | 文件与测试已在 tip，覆盖审查/测试门禁与 Swarm 审查失败；**不是**飞轮组合验收本身 | 回归：必须整文件跑完，不得当可选加测 | 现在跑回归；组合场景补齐 `WAIT-K4-IMPL` |
| E-15 | 回退后独立 Swarm 仍可运行，飞轮不能经它间接重开 | 第三刀入口尚未打开，无法做真实回退演练 | skip：回退夹具（测试双，不实现生产关闭原语） | `WAIT-K3` + `WAIT-K4-IMPL` |
| E-16 | 回退不破坏第二刀单会话 / 已持久化自动策略 | 已持久化自动启用是存下的 `enablementSource: 'auto_policy'`，不是交接已开，也不是飞轮组合凭证（见 E-20）。第二刀写者仍在 #532，本树不得抢 `host-integration.ts` / `config.ts` / `persist.ts` / `session-turn.ts` | skip：策略回归指针 | `WAIT-K2` 合入后才能钉最终断言；本预备不把该记录当成准入 |
| E-17 | 入口资格由可信宿主上下文传递，Worker 自报无效 | tip 无来源字段；第三刀负责 Swarm 侧来源 fail-closed | 不在本树写 Swarm 入口测试（避免与第三刀抢文件） | `WAIT-K3`；飞轮继承该上下文：`WAIT-K4-IMPL` |
| E-18 | 不放宽 `gate.ts`，也不放宽 #516 | `packages/core/src/quality/gate.ts` 94 行，本预备未改。不改文件必要但不足够（见 E-05）。AC-1…AC-5、`gate.ts`、delivery-mapping DM-1…DM-9 都不得放宽 | 检查单 + 回归；实现阶段对比该文件不得为换绿灯而改 | 全程；本预备不改口径 |
| E-19 | 缺失 `capabilityTiers` ⇒ `enabled: false` | 缺失或 `null` 归类为 `parser_default`，`parseCapabilityTiers` 置 `enabled: false`。该规则保持不变，不是默认开启。`handoffRuntimeEnabled`：`handoffSuspended === 'session_cap'` 或来源 `explicit_off` 为假；来源 `explicit_on` 为真；`parser_default` 与 `auto_policy` 仅当 `metadata.trajectoryHandoffExplicit === true` 才可能为真，本身不打开交接。飞轮组合与本预备不得把缺失层、`parser_default` 或 `auto_policy` 重新解释成飞轮准入或默认开启 | 关闭入口表征见 E-03：生产 `startSwarmForRun` 不挂 `capabilityTiers`。本预备不改解析规则 | 全程；不得改成 default-on |
| E-20 | 已持久化的自动启用不是飞轮组合凭证 | 已持久化自动启用指 `enablementSource: 'auto_policy'` 记录。`auto_policy` 为日后的刀持久化，此处不打开交接，也不是交接已开。日后打开或关闭组合，都不得写成由这些记录授予 | 不在本树改 `persist.ts` 或会话策略；字段回归指针仍见 E-16 | `WAIT-K2` 合入后才能钉字段回归；本预备不把该记录当成准入 |

补充说明：

- 「不修改 `gate.ts`」是必要但不足够的。E-05 证明当前调用路径已经可以绕过 implement 门禁。
- 对照基线是 origin/main tip `c67112bc`，不是本分支 `a857ee98`。本预备不接受第四刀。
- 「飞轮经共用 Swarm 不得自动启用交接」在第三刀验收前一直有效。本预备不能解除，也不得写成已经解除。
- 测试双（`createFlywheelPhaseHarness` 的 `compositionEntry: 'closed'`，桩上 `handoffEnabled: false`）不是生产 API，生产不得进口，也不是关闭原语。
- 缺失或 `null` 的 `capabilityTiers` 仍是 `parser_default` 且 `enabled: false`（E-19）。已持久化 `auto_policy` 不是组合凭证（E-20）。
- 完整 §14 其他验收组（配置回落、状态预算、Swarm 补额、路由等）不是第四刀首次引入的责任：共享内核与第三刀已应分别回归。第四刀合入时仍须整表可跑，但本预备不把第三刀补额/真实调用测试写进本树。
- 建议按拆分稿新增的实现阶段测试文件仍是：`packages/core/test/trajectory-handoff-flywheel-phases.test.js`。不要创建 `trajectory-handoff-swarm-*.test.js`（第三刀所有权）。
