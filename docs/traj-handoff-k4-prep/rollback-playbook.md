# 第四刀回退预备（不在本阶段执行）

适用：v1.1「回退总规则」+ §5.6，以及拆分稿 §3.4。本文是演练清单与**日后**验证指针，不是操作批准。预备阶段不执行回退，不关闭、不打开任何生产入口，也不实现生产侧入口关闭原语（Pattern B 仍禁止，含关闭原语本身）。

不把任何 `WAIT-K2` / `WAIT-K3` / `WAIT-K4-IMPL` 标成完成。不宣称第三刀已验收。`FlywheelType = 'A'..'H'` 是既有产品飞轮分类，不是轨迹交接的组合入口；回退不得把二者混成同一个开关。

启用词汇只引用 `packages/agent-loop/src/trajectory-handoff` 已有名字，不另造第二套：

- `EnablementSource = 'explicit_off' | 'explicit_on' | 'parser_default' | 'auto_policy'`。
- 缺失或 `null` 的 `capabilityTiers` 分类为 `parser_default`，`parseCapabilityTiers` 得到 `enabled: false`。回退不得把这个缺块翻成默认开启。
- `auto_policy` 为后续刀持久化，**不**因此打开交接。`handoffRuntimeEnabled` 仅在来源为 `explicit_on` 时为真；或在来源不是 `explicit_off` 且 `metadata.trajectoryHandoffExplicit === true` 时为真。`parser_default` 与 `auto_policy` 本身都不打开交接。
- 「已经持久化的自动启用」指库存里 `enablementSource: 'auto_policy'` 的记录。`capabilityTiers` / `enablementSource` 归第二刀所有；本预备不发明除此之外的第二刀字段名。

## 0. 回退必须到达的终态

回到本刀之前，下列都是终态，不是可选项：

1. **已持久化自动启用原样留下。** 第二刀已经写入的 `enablementSource: 'auto_policy'` 记录（以及其所在会话 metadata）在第四刀回退后保持不变：不删除、不改写、不翻转 `enablementSource`、不把该记录重新解释成 `explicit_on` / `explicit_off` / `parser_default` 或其他来源。
2. **该记录不是飞轮组合凭证。** 回退不得把它变成交接开启，也不得拿它当后门，经共用 Swarm 重新打开飞轮交接。飞轮来源仍不得仅因进入共用 Swarm 就自动启用轨迹交接。
3. **缺 `capabilityTiers` 仍是关闭。** 缺失或 `null` 继续分类为 `parser_default`，且 `enabled: false`。回退不得把「没有这块」改成默认开启。
4. **关闭飞轮组合入口不得株连。** 不得顺便关掉已验收的独立 Swarm 入口（第三刀；本预备不宣称第三刀已验收，也不在本树写它的入口测试）。同时不得株连禁用第二刀已持久化的 `auto_policy`。
5. **不放宽 #516。** 回退不得改 `packages/core/src/quality/gate.ts`、交付成功映射、证据复用路径，也不得为了让回退变绿而把内核 `done` / `answered` / `capped` / `failed` / `cancelled` / `timed_out` / `awaiting_coordinator` 当成交付成功。未验证产物与旧证据同样不得因此获得交付成功身份。
6. **不改名、不换飞轮 Orchestrator。** 类名仍是 `OrchestrationEngine`。回退只恢复本刀之前的阶段行为：阶段顺序仍是 `classify → research → implement → review → test`；implement 的 executor 仍是 `'swarm'`；Swarm 策略仍只接受 `pipeline`，其他策略失败关闭。不得重写 Swarm 策略。
7. **在途运行受控收尾或取消。** 结果未知失败关闭。不得把未完成的飞轮 implement 放到旧路径上重放。本文不是现在执行回退的授权，也不实现生产关闭原语。

对照用的关闭事实（记录缺口，不在回退里修成验收通过）：

- `BOOTSTRAP_STAGES` = classify → research → implement → review → test；implement executor 为 `'swarm'`。
- `tryCompleteImplementStep` 在 `swarm.status === 'completed'` 时结束步骤，且不经过 `qualityPassed`。这是已记录缺口，不是验收通过。
- 生产 `startSwarmForRun` 只写 `goal`、`orchestrationRunId`、`strategy: 'pipeline'`、`qualityGate: ['completed']`（另有运行簿记字段 `id` / `status` / `budget` / 时间戳）。它不附带 `trajectoryHandoff`、`handoffEnabled`、`trustedSource`、`capabilityTiers` 或 `explicit_on`。

## 1. 触发与前置

- 触发例：第四刀合入后发现阶段泄权、implement 绕门、组合限制解除把飞轮来源做成自动准入、把已持久化 `auto_policy` 当成飞轮凭证或交接开启、把缺失 `capabilityTiers` 做成默认开启，或回归红。
- 前置：确认要回退的是第四刀组合，不是第二刀已持久化自动策略，也不是第三刀独立 Swarm。不要把这三件事当成同一个开关。
- 前置：登记当时 HEAD、同头 Formal / FV / Main full health 结论；回退提交不得 squash 进无关分支，不得放宽 verifier。
- 本文件写完不等于可以现在回退。

## 2. 动作顺序（实现阶段执行，现在只预演）

1. **立即关闭飞轮组合入口**，阻止新的飞轮侧交接准入。本预备不实现该生产原语，只要求未来实现保留可关闭的单一控制点（可信宿主来源 / 组合开关）。关闭手段不是改 Swarm 策略，不是改名 Orchestrator，也不是删第二刀记录。
2. **在途运行受控收尾或取消。** 不得把未完成的飞轮 implement 直接放到旧路径上重放。结果未知失败关闭；保留已用预算、计划版本、未决调用与等待裁决。迟到事件不得重新启动任务。
3. **恢复 research / implement 的既有阶段实现**（tip `c67112bc` 行为可作为回退对照：implement 仍经 `startSwarmForRun`，来源限制重新生效）。阶段表与 `OrchestrationEngine` 类名保持不动；策略仍只接受 pipeline。
4. **重新施加来源限制：** 飞轮经共用 Swarm 不得自动启用交接。已持久化的 `enablementSource: 'auto_policy'` 原样保留，不得当作飞轮准入或交接开启。独立 Swarm 准入不受株连。缺失 `capabilityTiers` 仍是 `parser_default` + `enabled: false`。
5. **禁止顺手改** `gate.ts`、delivery-mapping、证据复用或 verifier，禁止把内核终态改写成交付成功。
6. 只有在没有需新协议处理的活动运行、或已有兼容处理能力时，才回滚到不理解这些运行记录的程序版本。这一步仍不得重写或丢弃已持久化的 `auto_policy` 记录。

## 3. 回退后必须再跑的验证（现在不跑）

下列指针留给实现阶段的回退 PR / 回退提交。本预备不执行这些命令，也不把 skip 骨架当成已绿。

```text
# (a) 已持久化自动启用：回退前后字节稳定 / 字段稳定
#     第二刀回归文件名以其落地为准，本树不抢写 host-integration / config / persist / session-turn。
#     日后断言（同一批回退前已存在的会话）：
#     - metadata 中 capabilityTiers 整块字节不变
#     - enablementSource 仍为 'auto_policy'，不得被改成 explicit_on / explicit_off / parser_default
#     - 不删除、不改写、不重新解释该记录
#     - 该记录不被当成飞轮组合准入，也不被当成交接开启
#
# (b) 缺失 capabilityTiers 仍关闭
#     classifyEnablement(undefined | null) === 'parser_default'
#     parseCapabilityTiers(undefined | null).resolved.enabled === false
#     回退不得把缺块改成默认开启（enabled: true / explicit_on）
#
# (c) 飞轮路径仍关闭
node --test packages/core/test/trajectory-handoff-flywheel-phases.test.js
#     断言：可执行预备用例 compositionEntry === 'closed'（'open' 不是预备模式）
#     测试双 handoffEnabled === false，且不得因 auto_policy 记录被置成 true
#     生产 startSwarmForRun 仍不匹配
#     trajectoryHandoff|handoffEnabled|trustedSource|capabilityTiers|explicit_on
#     飞轮不能经共用 Swarm 间接重开交接
#
# (d) #516 与交付映射仍绿（不得改 gate.ts / 成功映射 / 证据复用来换绿灯）
node --test packages/core/test/collaboration-quality-gates.test.js
node --test packages/core/test/trajectory-handoff-delivery-mapping.test.js
#     acceptance/collaboration-quality-gates.yaml AC-1..AC-5 整文件
#     acceptance/delivery-mapping.yaml DM-1..DM-9
#     内核 done / answered / capped / failed / cancelled / timed_out / awaiting_coordinator
#     不得映射为交付成功
#
# (e) Orchestrator 类名与阶段表不变
node --test packages/core/test/orchestration-engine.test.js
#     类名仍为 OrchestrationEngine，不改名、不替换
#     BOOTSTRAP_STAGES 仍为 classify → research → implement → review → test
#     implement executor 仍为 'swarm'
#     Swarm strategy 仍仅 'pipeline'，其他策略失败关闭；不重写策略
#
# 以及第三刀入口隔离与独立 Swarm 回归（文件名以第三刀落地为准，本树不抢写）
# 第二刀单会话 / enablementSource:'auto_policy' 回归（文件名以第二刀落地为准）
```

验收要点（日后，不是现在）：

- 新的飞轮侧交接准入被拒绝；`auto_policy` 记录不能充当后门。
- 独立 Swarm 仍能按第三刀策略进入交接（仅当第三刀未被同时回退；未验收前不要宣称这条已绿）。
- 飞轮 implement 再进入共用 Swarm 时，交接保持关闭。
- 已持久化 `auto_policy` 会话的 metadata 与回退前一致，仍按第二刀策略运行，且不被翻成交接开启。
- 没有 `capabilityTiers` 的会话仍是 `enabled: false`。
- delivery-mapping 与完整 `collaboration-quality-gates.yaml` 仍绿。
- `OrchestrationEngine` 与阶段表未被改名或重排。

## 4. 回退夹具（测试双，不是生产原语）

见 `fixture-notes.md`。运行时夹具是测试文件里的 `createFlywheelPhaseHarness`，不是生产 API，也没有 `createFlywheelCompositionHarness({ compositionEntry: 'closed' | 'open' })` 这种预备模式。

- 每个可执行预备用例必须 `compositionEntry: 'closed'`。`'open'` 不是预备模式。
- 该 harness 只存在于测试文件，**不得**被 `collaborators.ts` / `engine.ts` / `swarm/executor.ts` 进口。
- 已持久化自动启用用测试双表示（`enablementSource: 'auto_policy'`）。飞轮 stub 必须忽略它：不得把 `handoffEnabled` 设为 `true`，不得把它抄进 Swarm 运行。
- 不要在本预备实现「入口关闭基础原语」的生产代码。Pattern B 与第四刀实现都还没被授权写这些。

## 5. 明确不要做的回退方式

- 不要删除、改写、翻转或重新解释已持久化的 `enablementSource: 'auto_policy'`。
- 不要把该记录、或缺失的 `capabilityTiers`，变成交接开启 / 默认开启。
- 不要关闭已验收的独立 Swarm 入口来「顺便」挡住飞轮，也不要株连禁用第二刀自动策略。
- 不要改 `gate.ts`、交付成功映射或证据复用，来掩盖放宽过的成功映射。
- 不要把内核 `done` / `answered` / `capped` / `failed` / `cancelled` / `timed_out` / `awaiting_coordinator` 当成交付成功。
- 不要回放结果未知的在途调用。
- 不要改 Swarm 策略，不要改名或替换 `OrchestrationEngine`。
- 不要把本剧本当成现在就可以执行回退的授权。


## 已落地的关闭原语（第四刀实现）

生产开关：`FLYWHEEL_HANDOFF_ENTRY_CONTROL_KEY`（`trajectory-handoff.flywheel-entry`），经 `readFlywheelHandoffEntrySwitch` / `rollbackFlywheelEntry(mode)` 读写。

- `stop_new_admission`：写入显式关闭，立即阻止新的飞轮侧交接准入。独立 Swarm 开关 `trajectory-handoff.swarm-entry` 不变。已准入、仍在途的飞轮运行按 `inFlightPolicy: controlled_finish` 受控收尾，仍须经过证据门，不得因 `swarm.status === 'completed'` 在旧路径上宣布交付成功。
- `cancel_in_flight`：同样先停新准入，并将 `inFlightPolicy` 设为 `cancel`。宿主对在途飞轮编排调用 `shouldCancelInFlightFlywheel`，以失败收尾，而不是把未完成的 implement 重放到关闭交接后的旧路径。

缺失存储值表示获准飞轮入口仍打开。不得用关闭独立 Swarm 入口来顺便挡住飞轮。
