# 第四刀夹具说明（入口关闭前提下的骨架）

## 原则

- 只用 `OrchestrationEngine` 的 deps 注入（与既有 `orchestration-engine.test.js` 相同）：`store`、`startSwarmForRun`、`tickSwarm`、`getSwarmForOrchestrationRun`、`runResearch`、`runReview`、`runTest`。不另接生产接线。
- 使用临时 SQLite：`SqliteStateStore` + `orchestrator()` / 如需对照再用内存里的假 `SwarmRun`。不要去改生产 `collaborators.ts` 接线。
- 不打开生产飞轮入口，不把飞轮来源写进 Swarm 执行器，不进口第三刀未冻结的生产模块来「顺便接线」。
- 不修改 `gate.ts`。需要证据门时调用现有 `qualityPassed` / `validateQualityReport`。不改交付成功映射，不改证据复用。
- 不改名、不替换飞轮 Orchestrator（类名仍是 `OrchestrationEngine`）。
- 不实现生产侧入口关闭原语。Pattern B 零代码（含关闭原语）。本说明不是执行回退的授权。
- 测试从 `packages/core/dist/...` 进口，与仓库既有 core 测试一致。本隔离树当前**没有**现成 `dist/`；跑运行时用例前需在本树构建 `packages/core`。源码表征用例只读 `.ts`，不依赖 dist。
- 夹具里的 `compositionEntry` 是**测试双**，不是获准的生产 API，不得提升为第四刀之前的合入接口。`trustedHostContext` 若在测试双里出现，同样不是生产 API，预备阶段不得把它接进 `collaborators.ts` / `engine.ts` / `swarm/executor.ts`。
- **每个可执行预备用例必须 `compositionEntry: 'closed'`。** `'open'` 不是预备模式。不要再写 `compositionEntry: 'closed' | 'open'` 当作本阶段可切换的入口。

## 建议的 harness 形状

见 `packages/core/test/trajectory-handoff-flywheel-phases.test.js` 的 `createFlywheelPhaseHarness`（表征测试由另一写者持有，本说明只定契约，不改那个文件）。没有 `makeRun()` / `linkSwarm()` 这两个名字。

```text
createFlywheelPhaseHarness(t, {
  compositionEntry = 'closed',
  persistedAutoEnablement = null
})
```

- `compositionEntry` 在**任何** `packages/core/dist` 进口之前就被断言为 `'closed'`。传入 `'open'` 必须失败，且失败发生在 dist 进口之前。`'open'` 不是预备模式。
- `persistedAutoEnablement` 默认 `null`。它是测试双，不是生产 API。供给非空值时，原样挂在 harness 返回值上，**不**抄进 Swarm。
- `startSwarmForRun` 测试双只记下调用，并造一个假 Swarm：`compositionEntry: 'closed'`、`handoffEnabled: false`。即使测试双里写了 `handoffEnabled: true`，stub 仍保持 `false`。
- `currentSwarm()`：Swarm 已启动后返回该假 Swarm，用来核对 `handoffEnabled === false` 且 `compositionEntry === 'closed'`，以及 `capabilityTiers` / `trustedSource` / `trajectoryHandoff` 不在 Swarm 上。
- `setSwarmStatus(status)`：只改假 Swarm 的 status。
- `startImplementRun(title)`：`classify` 可走真实引擎；其后阶段由测试安排步骤或让 bootstrap 自己建步。`flywheels: ['A']` 只是产品分类 `FlywheelType`，不是组合入口。
- `reports.good` / `reports.missingEvidence` / `reports.staleVersion` / `reports.kernelDoneShaped`：复用门禁结构，不发明新的成功映射。内核 `done` 形状的报告不是交付成功。
- `phaseHost.tryWriteAs({ phase, role })`：给 research/review 切角色用例预留。当前为 stub，等到第四刀把阶段权限接到现有 `adapter.ts` / `tool-entry.ts` 交集后再填。不要在夹具里新写一套权限系统。

该 harness 只存在于测试文件，**不得**被 `collaborators.ts`、`engine.ts` 或 `swarm/executor.ts` 进口。

## 已持久化自动启用（测试双；飞轮 stub 必须忽略）

「已经持久化的自动启用」只指第二刀已经落下的记录：`capabilityTiers.enablementSource === 'auto_policy'`。`capabilityTiers` 与 `enablementSource` 归第二刀所有。本夹具不发明除此之外的第二刀字段名，也不把第二刀存储形状提前写死进生产类型。

回退对照用的测试双可以带诱骗字段。stub 必须全部忽略，不得当成飞轮准入，也不得把 `handoffEnabled` 设为 `true`：

```text
persistedAutoEnablement = {
  source: 'auto_policy',
  capabilityTiers: { enabled: true, enablementSource: 'auto_policy' },
  explicit_on: true,
  handoffEnabled: true,
  trustedSource: 'persisted-auto',
  trajectoryHandoff: { enabled: true },
  note: 'test double only; not a production API and not flywheel admission'
}
```

契约：

- 默认不传时 `persistedAutoEnablement` 为 `null`。
- 飞轮 stub **忽略**这块记录，包括其中的 `enabled: true`、`handoffEnabled: true`、`explicit_on`、`trustedSource`、`trajectoryHandoff`。这些键是测试双噪音，不是生产字段，也不是新的第二刀字段名。
- `currentSwarm()` 上 `handoffEnabled` 仍为 `false`，`compositionEntry` 仍为 `'closed'`，且没有 `capabilityTiers` / `trustedSource` / `trajectoryHandoff`。
- harness 返回的 `persistedAutoEnablement` 与传入对象同一引用，回退演练不得翻转、删除或改写它的 `enablementSource`。
- `auto_policy` 不打开交接。缺块对照是另一条：没有 `capabilityTiers`（或值为 `null`）分类为 `parser_default`，且 `enabled: false`。测试双不得把缺块填成默认开启。
- 这个对象只活在测试文件里。禁止进口到 `collaborators.ts`、`engine.ts`、`swarm/executor.ts`。

启用词汇只引用 `packages/agent-loop/src/trajectory-handoff` 已有定义，不另造：

| 名字 | 含义（引用，不改生产） |
| --- | --- |
| `EnablementSource` | `'explicit_off' \| 'explicit_on' \| 'parser_default' \| 'auto_policy'` |
| 缺失 / `null` `capabilityTiers` | `classifyEnablement` → `parser_default`；`parseCapabilityTiers` → `enabled: false` |
| `auto_policy` | 为后续刀持久化；本身不打开交接 |
| `handoffRuntimeEnabled` | 仅 `explicit_on` 为真；或来源不是 `explicit_off` 且 `metadata.trajectoryHandoffExplicit === true` 时为真。`parser_default` 与 `auto_policy` 本身都不因此打开交接 |

`trajectoryHandoffExplicit` 只作为上述运行时谓词的既有 metadata 条件被引用。飞轮预备夹具不得新造同名生产字段，也不得用它把 `auto_policy` 解释成飞轮准入。

## 当前 tip 对照点（写测试时不要改这些生产文件）

| 点 | 文件 | 观察 |
| --- | --- | --- |
| 阶段表 | `engine.ts` `BOOTSTRAP_STAGES` | classify, research, implement, review, test |
| Orchestrator | `engine.ts` `OrchestrationEngine` | 不改名、不替换 |
| implement 完成 | `engine.ts` `tryCompleteImplementStep` | 只看 `TERMINAL_SWARM`；`completed` 不过 `qualityPassed`（缺口，不是验收） |
| 生产启动 Swarm | `runtime/collaborators.ts` | `goal`、`orchestrationRunId`、`strategy: 'pipeline'`、`qualityGate: ['completed']`；无 `trajectoryHandoff` / `handoffEnabled` / `trustedSource` / `capabilityTiers` / `explicit_on` |
| research | `runtime/spawn-host.ts` `runOrchestrationResearch` | `ResearchPipeline`，无阶段只读锁 |
| review/test | `engine.ts` + `quality/gate.ts` | 已用 `qualityPassed`；本预备不改 `gate.ts` |
| 门禁 yaml | `acceptance/collaboration-quality-gates.yaml` | AC-1…AC-5，不得删减 |
| 交付映射 | `acceptance/delivery-mapping.yaml` + 对应测试 | DM-1…DM-9；内核 `done` / `answered` / `capped` / `failed` / `cancelled` / `timed_out` / `awaiting_coordinator` 不得映射成功 |
| 启用分类 | `packages/agent-loop/src/trajectory-handoff/config.ts` | 缺块 → `parser_default` + `enabled: false`；`auto_policy` 不打开交接。第二刀所有，本树不抢写 |

注意：类型里的 `FlywheelType = 'A'…'H'` 是既有产品飞轮分类字段，不要和「飞轮组合入口 / 轨迹交接」混名。

## 与第三刀夹具的边界

- 不要在本树新增 `trajectory-handoff-swarm-entry.test.js` / `...-swarm-refill.test.js` / `...-swarm-gate-paths.test.js`。
- 不要改 `packages/core/src/swarm/executor.ts` 或既有 `swarm-executor.test.js` 的公共 fixture。
- 回退后「独立 Swarm 仍可运行」的断言，等到第三刀入口测试文件落地后，从本文件引用或再跑，而不是复制一套 Swarm 入口实现。不宣称第三刀已验收。
- 关闭飞轮组合入口的测试双，不得被写成「顺便关掉独立 Swarm」或「顺便禁用 `auto_policy`」。

## 故障注入（实现阶段再启用）

- implement：Swarm `completed` 但无证据 / 证据不可用 / 证据属于旧 planVersion 或旧任务范围。
- implement：内核 `done` 或 `answered` / `capped` / `failed` / `cancelled` / `timed_out` / `awaiting_coordinator` 被错误当作成功。
- implement：恢复路径漏跑门禁；重规划后再完成。
- research/review：把角色切到 executor 后尝试写工具、Shell、子 Agent、在途写。
- 回退：`compositionEntry: 'closed'` 时飞轮来源进入共用 Swarm，交接必须仍关闭。
- 回退：旁边放着 `enablementSource: 'auto_policy'` 的测试双时，飞轮 stub 仍保持 `handoffEnabled: false`，且不改写该记录。
- 回退：会话没有 `capabilityTiers` 时仍是 `enabled: false`，不得变成默认开启。

## 明确不做

- 不写生产关闭原语，不写 Pattern B 任何代码。
- 不改 `gate.ts`，不改交付成功映射，不改证据复用。
- 不改名或替换 `OrchestrationEngine`；不重写 Swarm 策略（仍仅 pipeline，其他失败关闭）。
- 不把 `'open'` 做成预备可运行模式。
- 不把测试双进口到 `collaborators.ts`、`engine.ts`、`swarm/executor.ts`。
- 不把 `WAIT-K2` / `WAIT-K3` / `WAIT-K4-IMPL` 标成完成。
