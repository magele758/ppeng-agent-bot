# 第四刀夹具说明（入口关闭前提下的骨架）

## 原则

- 只用 `OrchestrationEngine` 的 deps 注入（与既有 `orchestration-engine.test.js` 相同）：`store`、`startSwarmForRun`、`tickSwarm`、`getSwarmForOrchestrationRun`、`runResearch`、`runReview`、`runTest`。
- 使用临时 SQLite：`SqliteStateStore` + `orchestrator()` / 如需对照再用内存里的假 `SwarmRun`。不要去改生产 `collaborators.ts` 接线。
- 不打开生产飞轮入口，不把飞轮来源写进 Swarm 执行器，不进口第三刀未冻结的生产模块来「顺便接线」。
- 不修改 `gate.ts`。需要证据门时调用现有 `qualityPassed` / `validateQualityReport`。
- 测试从 `packages/core/dist/...` 进口，与仓库既有 core 测试一致。本隔离树当前**没有**现成 `dist/`；跑运行时用例前需在本树构建 `packages/core`。源码表征用例只读 `.ts`，不依赖 dist。
- 夹具里出现的 `compositionEntry` / `trustedHostContext` 是**测试双**。不是获准的生产 API，不得提升为第四刀之前的合入接口。

## 建议的 harness 形状

见 `packages/core/test/trajectory-handoff-flywheel-phases.test.js` 中的 `createFlywheelPhaseHarness`：

- `makeRun()`：`classify` 可走真实引擎；其后阶段由测试安排步骤或让 bootstrap 自己建步。
- `linkSwarm({ status })`：记录一次 `startSwarmForRun` 调用，并返回可更新 status 的假 Swarm。默认**不**附带交接启用字段，以保持「入口关闭」表征。
- `reports.good` / `reports.missingEvidence` / `reports.staleVersion` / `reports.kernelDoneShaped`：复用门禁结构，不发明新的成功映射。
- `phaseHost.tryWriteAs({ phase, role })`：给 research/review 切角色用例预留。当前为 stub，等到第四刀把阶段权限接到现有 `adapter.ts` / `tool-entry.ts` 交集后再填。不要在夹具里新写一套权限系统。
- `compositionEntry: 'closed' | 'open'`：只影响测试双对「飞轮来源是否自动启用交接」的判断。预备阶段所有可执行用例必须走 `'closed'`。

## 当前 tip 对照点（写测试时不要改这些生产文件）

| 点 | 文件 | 观察 |
| --- | --- | --- |
| 阶段表 | `engine.ts` `BOOTSTRAP_STAGES` | classify, research, implement, review, test |
| implement 完成 | `engine.ts` `tryCompleteImplementStep` | 只看 `TERMINAL_SWARM`；`completed` 不过 `qualityPassed` |
| 生产启动 Swarm | `runtime/collaborators.ts` | `strategy: 'pipeline'`，`qualityGate: ['completed']`，无交接来源字段 |
| research | `runtime/spawn-host.ts` `runOrchestrationResearch` | `ResearchPipeline`，无阶段只读锁 |
| review/test | `engine.ts` + `quality/gate.ts` | 已用 `qualityPassed` |
| 门禁 yaml | `acceptance/collaboration-quality-gates.yaml` | AC-1…AC-5，不得删减 |
| 交付映射 | `acceptance/delivery-mapping.yaml` + 对应测试 | DM-1…DM-9，内核态不得映射成功 |

注意：类型里的 `FlywheelType = 'A'…'H'` 是既有产品飞轮分类字段，不要和「飞轮组合入口 / 轨迹交接」混名。

## 与第三刀夹具的边界

- 不要在本树新增 `trajectory-handoff-swarm-entry.test.js` / `...-swarm-refill.test.js` / `...-swarm-gate-paths.test.js`。
- 不要改 `packages/core/src/swarm/executor.ts` 或既有 `swarm-executor.test.js` 的公共 fixture。
- 回退后「独立 Swarm 仍可运行」的断言，等到第三刀入口测试文件落地后，从本文件引用或再跑，而不是复制一套 Swarm 入口实现。

## 故障注入（实现阶段再启用）

- implement：Swarm `completed` 但无证据 / 证据不可用 / 证据属于旧 planVersion 或旧任务范围。
- implement：内核 `done` 或 `answered/capped/failed/cancelled/timed_out/awaiting_coordinator` 被错误当作成功。
- implement：恢复路径漏跑门禁；重规划后再完成。
- research/review：把角色切到 executor 后尝试写工具、Shell、子 Agent、在途写。
- 回退：`compositionEntry: 'closed'` 时飞轮来源进入共用 Swarm，交接必须仍关闭。
