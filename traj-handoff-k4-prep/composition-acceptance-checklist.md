# 第四刀组合验收检查单

基线：`c67112bc5de284d3806bc399cf7289458021044f`。依据 v2.3 §11–§14、v1.1 §5、拆分稿 §3 / §5。  
标记：`NOW` = 在入口关闭前提下现在就能核或能写成表征；`WAIT-K2` / `WAIT-K3` / `WAIT-K4-IMPL` = 解阻前不得当成已完成，也不得为此打开生产入口。

## A. 入口与组合边界

- [ ] `NOW` 生产飞轮组合入口仍关闭：`engine.ts` / `collaborators.ts` 未把飞轮来源标为交接准入，也未解除「飞轮经共用 Swarm 不得自动启用交接」。
- [ ] `NOW` 未改名、未替换飞轮 Orchestrator；阶段顺序仍为 `classify → research → implement → review → test`，implement executor 仍为 `'swarm'`。
- [ ] `NOW` core / 飞轮目录没有第二套交接状态机或父级预算账本。
- [ ] `WAIT-K3` 然后 `WAIT-K4-IMPL`：打开飞轮组合入口，并解除第三刀的来源限制；入口资格仍须由**可信宿主上下文**传递，不得由 Worker 自报。
- [ ] `WAIT-K4-IMPL` 入口必须可关，以便回退到「飞轮入口关闭，且不能经 Swarm 间接重开」。
- [ ] `WAIT-K2` + `WAIT-K3` 打开组合后，普通会话与独立 Swarm 的既有启用策略不回退（含已持久化自动策略的会话）。

## B. 阶段权限（v2.3 §11 / §4.3）

- [ ] `WAIT-K4-IMPL` research：内核只读规划与调研，可用规划层模型；阶段权限只读；切入 executor 角色也不能写。
- [ ] `WAIT-K4-IMPL` implement：阶段内测试失败可重规划，不跨出交付边界；成功必须过现有证据门；内核 `done` 不是交付成功。
- [ ] `WAIT-K4-IMPL` review：保持只读，并用规划层模型；权限交集仍生效。
- [ ] `NOW`（缺口记录）当前 `tryCompleteImplementStep` 仅凭 `swarm.status === 'completed'` 完成 implement，且接线 `qualityGate: ['completed']`。第四刀必须证明成功出口仍过门，不得把该缺口固化成验收通过。
- [ ] `WAIT-K3` 间接泄权用例要落到真实宿主（research/review 切角色），不能只做类型层口头保证。可信来源字段形状以第三刀落地为准，本预备不发明第二套权限系统。

## C. #516 门禁（完整 yaml，本刀必须跑完）

必须跑：`acceptance/collaboration-quality-gates.yaml`（AC-1…AC-5）与 `packages/core/test/collaboration-quality-gates.test.js`。不得删减既有口径，不得改 `gate.ts` 迁就终态。

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

- [ ] 完整 yaml 绿，且有「解除组合限制后行为提升」的正向证据。
- [ ] 阶段只读与 implement 成功出口过门的正向证据。
- [ ] 第三刀独立 Swarm、第二刀单会话、delivery-mapping、`orchestration-engine.test.js` 无回退。
- [ ] 无提升证据不得合。能力不回归。

## F. 明确禁止（任何阶段）

- 不放宽 #516；不改 `gate.ts` / verifier / 成功映射来换绿灯。
- 不改名或替换飞轮 Orchestrator；不重写 Swarm 策略（仍仅 pipeline，其他失败关闭）。
- 不在 agent-loop 之外另立交接状态机或预算账本。
- 不写 Pattern B 任何代码（含入口关闭原语）。
- 不打开生产飞轮入口、不接线飞轮来源，直到第三刀验收且进入第四刀实现。
- 不用云 Cloud Agent；不 force-push main；不放松同头必过门。
