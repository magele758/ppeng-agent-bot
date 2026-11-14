# 第四刀组合验收检查单

对照基线：origin/main tip `c67112bc5de284d3806bc399cf7289458021044f`。本分支 HEAD `a857ee9833a8e0055e9f227d0784e1628366848d`（`a857ee98`）只是预备，不移动该基线，也不接受第四刀。依据 v2.3 §11–§14、v1.1 §5、拆分稿 §3 / §5。
标记：`NOW` = 在入口关闭前提下现在就能核或能写成表征；`WAIT-K2` / `WAIT-K3` / `WAIT-K4-IMPL` = 解阻前不得当成已完成，也不得为此打开生产入口。`WAIT-K3` 指第三刀验收（Formal + FV + 同头 Main full health，线性落在当前 tip），不是准备树或未合入写者。

## A. 入口与组合边界

- [ ] `NOW` 生产飞轮组合入口仍关闭，直到第三刀验收且第四刀实现开工：生产飞轮不得挂交接启用字段、可信来源或组合开关。关闭表征是 `startSwarmForRun` 不含 `trajectoryHandoff` / `handoffEnabled` / `trustedSource` / `capabilityTiers` / `explicit_on`。测试双（含 `compositionEntry: 'closed'` 与桩上的 `handoffEnabled: false`）不是生产 API。
- [ ] `NOW` 「飞轮经共用 Swarm 不得自动启用交接」仍然有效。不得写成已经解除，也不得由本预备解除。第三刀准备树或未合入写者不是验收。
- [ ] `NOW` 缺失或 `null` 的 `capabilityTiers` 仍归类为 `parser_default`，且 `parseCapabilityTiers` 置 `enabled: false`。不得改成默认开启。飞轮组合与本预备不得把缺失层、`parser_default` 或 `auto_policy` 读成飞轮准入。`handoffRuntimeEnabled`：`handoffSuspended === 'session_cap'` 或来源 `explicit_off` 为假；来源 `explicit_on` 为真；`parser_default` 与 `auto_policy` 仅当 `metadata.trajectoryHandoffExplicit === true` 才可能为真，本身保持关闭。
- [ ] `NOW` 已持久化自动启用（存下的 `enablementSource: 'auto_policy'`）不是交接已开，也不是飞轮组合凭证。日后打开或关闭组合，都不得写成由这些记录授予。
- [ ] `NOW` 未改名、未替换飞轮 Orchestrator；阶段顺序仍为 `classify → research → implement → review → test`，implement executor 仍为 `'swarm'`。`FlywheelType A–H` 是产品分类，不是交接组合入口。
- [ ] `NOW` core / 飞轮目录没有第二套交接状态机或父级预算账本。
- [ ] `WAIT-K3` 然后 `WAIT-K4-IMPL`：只有第三刀验收之后、第四刀实现开工，才打开飞轮组合入口并解除来源限制。本预备不打开、不解除。入口资格仍须由**可信宿主上下文**传递，不得由 Worker 自报。
- [ ] `WAIT-K4-IMPL` 入口必须可关，以便回退到「飞轮入口关闭，且不能经 Swarm 间接重开」。
- [ ] `WAIT-K2` + `WAIT-K3` 打开组合后，普通会话与独立 Swarm 的既有启用策略不回退（含已持久化 `enablementSource: 'auto_policy'` 的会话）。这些记录不是打开或关闭组合的凭证。

## B. 阶段权限（v2.3 §11 / §4.3）

- [ ] `WAIT-K4-IMPL` research：内核只读规划与调研，可用规划层模型；阶段权限只读；切入 executor 角色也不能写。
- [ ] `WAIT-K4-IMPL` implement：阶段内测试失败可重规划，不跨出交付边界；成功必须过现有证据门；内核 `done` 不是交付成功。
- [ ] `WAIT-K4-IMPL` review：保持只读，并用规划层模型；权限交集仍生效。
- [ ] `NOW`（缺口记录，不是验收通过）当前 `tryCompleteImplementStep` 仅凭 `swarm.status === 'completed'` 完成 implement，不调用 `qualityPassed`，且接线 `qualityGate: ['completed']`。第四刀必须证明成功出口仍过门。不得把该缺口固化成验收通过。不改 `gate.ts` 必要但不足够。不得放宽 #516。
- [ ] `WAIT-K3` 间接泄权用例要落到真实宿主（research/review 切角色），不能只做类型层口头保证。可信来源字段形状以第三刀验收后的落地为准；准备树或未合入写者不是验收。本预备不发明第二套权限系统。

## C. #516 门禁（完整 yaml，本刀必须跑完）

必须跑：`acceptance/collaboration-quality-gates.yaml`（AC-1…AC-5）与 `packages/core/test/collaboration-quality-gates.test.js`。不得删减既有口径，不得改 `gate.ts` 迁就终态。不修改 `gate.ts` 必要但不足够。#516（AC-1…AC-5、`gate.ts`、delivery-mapping DM-1…DM-9）不得放宽。缺失 `capabilityTiers` ⇒ `enabled: false` 不得改成默认开启。

- [ ] `NOW` 既有 yaml 测试在构建 `packages/core/dist` 后必须继续绿（回归，不放宽）。
- [ ] `WAIT-K4-IMPL` 缺失或不可用证据不得过门（含 implement 成功出口，不只 review/test）。
- [ ] `WAIT-K4-IMPL` 旧版本证据不得复用；证据绑定实际被验证的版本和任务范围。
- [ ] `WAIT-K4-IMPL` / 回归 `NOW`：`answered` / `capped` / `failed` / `cancelled` / `timed_out` / `awaiting_coordinator` 不得映射为交付成功（既有 `delivery-mapping` DM-1…DM-9 必须继续绿；飞轮路径上再验一次）。
- [ ] `WAIT-K4-IMPL` 恢复路径、重规划后再完成，一律过门，不得漏跑。
- [ ] `WAIT-K4-IMPL` 内核 `done` 不被当成交付成功（飞轮 implement 出口，不只目录映射）。
- [ ] `NOW` 不修改 `gate.ts`、成功映射或证据复用路径来换绿灯。不修改不算充分条件。

## D. 入口隔离与回退验收

- [ ] `WAIT-K3` + `WAIT-K4-IMPL` 第四刀回退后，独立 Swarm 仍可运行（除非另行显式回退第三刀）。
- [ ] `WAIT-K4-IMPL` 回退后重新施加「来自飞轮的调用不得仅因进入共用 Swarm 就自动启用交接」；飞轮不能经它间接重开。
- [ ] `WAIT-K2` 回滚本刀不得破坏第二刀单会话承诺，包括已经持久化自动策略的会话。
- [ ] 回退不能使未验证产物、旧证据或内核 `done` 获得交付成功身份。
- [ ] 已有运行受控收尾或取消，不得直接在旧路径重放；结果未知仍失败关闭。

## E. 合入证据（实现阶段，不是本预备的合入条件）
本分支 `a857ee98` 不是合入证据，也不接受第四刀。下列各项在实现阶段之前保持未完成。

- [ ] 完整 yaml 绿，且有「解除组合限制后行为提升」的正向证据。
- [ ] 阶段只读与 implement 成功出口过门的正向证据。
- [ ] 第三刀独立 Swarm、第二刀单会话、delivery-mapping、`orchestration-engine.test.js` 无回退。
- [ ] 无提升证据不得合。能力不回归。

## F. 明确禁止（任何阶段）

- 不放宽 #516（AC-1…AC-5、`gate.ts`、delivery-mapping DM-1…DM-9）；不改 `gate.ts` / verifier / 成功映射来换绿灯。不改 `gate.ts` 必要但不足够。缺失 `capabilityTiers` ⇒ `enabled: false` 不得改成默认开启。
- 不改名或替换飞轮 Orchestrator；不重写 Swarm 策略（仍仅 pipeline，其他失败关闭）。
- 不在 agent-loop 之外另立交接状态机或预算账本。
- 不写 Pattern B 任何代码（含入口关闭原语）。
- 不打开生产飞轮入口、不接线飞轮来源、不挂交接启用字段 / 可信来源 / 组合开关，直到第三刀验收（Formal + FV + 同头 Main full health，线性落在 tip）且进入第四刀实现。准备树或未合入写者不是验收。本预备不解除「飞轮经共用 Swarm 不得自动启用交接」。
- 不把缺失或 `null` 的 `capabilityTiers`（`parser_default`，`enabled: false`）、`parser_default` 或 `auto_policy` 重新解释成飞轮准入或默认开启。不放宽 `handoffRuntimeEnabled` 的开条件。
- 不把已持久化的 `enablementSource: 'auto_policy'` 当成飞轮组合凭证或交接已开。打开或关闭组合都不得写成由这些记录授予。
- 测试双不是生产 API。不实现生产关闭原语。
- 不用云 Cloud Agent；不 force-push main；不放松同头必过门。
