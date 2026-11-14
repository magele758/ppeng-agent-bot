# 第四刀评估矩阵

基线 HEAD：`c67112bc5de284d3806bc399cf7289458021044f`（2026-11-14 16:58:12 Asia/Shanghai）。  
只读实核范围：本隔离树的 `packages/core/src/orchestrator/{engine,types,store,index}.ts`、`packages/core/src/quality/gate.ts`、`packages/core/src/runtime/collaborators.ts`（`startSwarmForRun` 片段）、`acceptance/collaboration-quality-gates.yaml`、既有相关测试。未读取、未改动第三刀树或 #532 写者树。

图例：`表征` = 骨架里针对当前关闭行为的可执行断言；`skip` = `test.skip`，等解阻后取消跳过并接到真实现；`回归` = 已有测试，本刀必须继续跑。

| ID | 契约条目 | 当前 tip 实核（c67112bc） | 预备骨架 / 回归 | 解阻 |
| --- | --- | --- | --- | --- |
| E-01 | 飞轮阶段顺序不改名、不打乱 | `BOOTSTRAP_STAGES = classify → research → implement → review → test`；implement executor 为 `'swarm'` | 表征：`keeps bootstrap stage order and implement executor` | 现在 |
| E-02 | 不在 core/飞轮另起交接状态机 | `engine.ts` 无 `trajectory-handoff` 导入；飞轮类型里的 `FlywheelType A–H` 是产品飞轮分类，不是交接入口 | 表征：引擎源码不导入交接模块 | 现在 |
| E-03 | 生产飞轮组合入口关闭 | `startSwarmForRun` 只写 `goal` / `orchestrationRunId` / `strategy: 'pipeline'` / `qualityGate: ['completed']`，无交接启用或可信来源字段 | 表征：生产接线源码无手过来源/启用字段 | 现在 |
| E-04 | 飞轮经共用 Swarm 不得自动启用交接 | tip 上飞轮尚未把来源传入 Swarm；也还没有「解除该限制」的实现。第三刀落地后仍必须维持此限制，直到第四刀实现显式解除 | 表征（关闭态）+ skip：解除限制后的正向行为 | 解除限制：`WAIT-K3` 后 `WAIT-K4-IMPL` |
| E-05 | implement 成功出口必须过证据门 | **缺口**：`tryCompleteImplementStep` 在 `swarm.status === 'completed'` 时直接 `step.status = 'completed'`，不调用 `qualityPassed`。接线 `qualityGate: ['completed']` 与缺口一致 | 表征（标注为 gap，第四刀实现后必须翻转）；skip：过门成功 / 缺证据失败 | `WAIT-K4-IMPL`（翻转 gap 断言） |
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
| E-16 | 回退不破坏第二刀单会话 / 已持久化自动策略 | 第二刀写者仍在 #532，本树不得抢 `host-integration.ts` / `config.ts` / `persist.ts` / `session-turn.ts` | skip：策略回归指针 | `WAIT-K2` 合入后才能钉最终断言 |
| E-17 | 入口资格由可信宿主上下文传递，Worker 自报无效 | tip 无来源字段；第三刀负责 Swarm 侧来源 fail-closed | 不在本树写 Swarm 入口测试（避免与第三刀抢文件） | `WAIT-K3`；飞轮继承该上下文：`WAIT-K4-IMPL` |
| E-18 | 不放宽 `gate.ts` | `packages/core/src/quality/gate.ts` 94 行，本预备未改；合入时须保持文件与口径 | 检查单 + 回归；实现阶段对比该文件不得为换绿灯而改 | 全程 |

补充说明：

- 「不修改 `gate.ts`」是必要但不足够的。E-05 证明当前调用路径已经可以绕过 implement 门禁。
- 完整 §14 其他验收组（配置回落、状态预算、Swarm 补额、路由等）不是第四刀首次引入的责任：共享内核与第三刀已应分别回归。第四刀合入时仍须整表可跑，但本预备不把第三刀补额/真实调用测试写进本树。
- 建议按拆分稿新增的实现阶段测试文件仍是：`packages/core/test/trajectory-handoff-flywheel-phases.test.js`。不要创建 `trajectory-handoff-swarm-*.test.js`（第三刀所有权）。
