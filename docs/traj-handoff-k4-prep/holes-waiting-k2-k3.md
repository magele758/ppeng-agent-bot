# 必须等待第二刀或第三刀的洞

本预备可以写检查单、矩阵、夹具说明和 `test.skip` 骨架，但不能把下列洞填成已完成实现，也不能为填洞而打开入口或改公共类型。下面每条都仍是**入口关闭**下敞开的洞：写明为何仍开、本预备允许做什么。本文不授权生产改动。检查单上的 `WAIT-K2` / `WAIT-K3` / `WAIT-K4-IMPL` 不得在本文件标成完成，也不得把第三刀写成已验收。

启用词汇只使用 `packages/agent-loop/src/trajectory-handoff` 里已有的名字，不另造一套：`EnablementSource = 'explicit_off' | 'explicit_on' | 'parser_default' | 'auto_policy'`。`handoffRuntimeEnabled` 在 `handoffSuspended === 'session_cap'` 时为假；否则仅当来源为 `explicit_on`，或来源不是 `explicit_off` 且 `trajectoryHandoffExplicit === true` 时为真。`parser_default` 与 `auto_policy` 本身不打开交接。

## 等第二刀（#532 写者，本树禁止抢写）

第二刀按契约很可能改：`host-integration.ts`、`config.ts`、`persist.ts`、`session-turn.ts`、会话创建路径、agent-lab / 默认策略落点。本树已避开这些文件。

| 洞 | 为何要等 | 本预备怎么处理 |
| --- | --- | --- |
| 已持久化自动启用记录（`auto_policy`）的形状 | 该记录归第二刀（#532）。`auto_policy` 是留给后续刀持久化的来源，**不会**打开交接。回退必须原样保留这些记录，且不得把它们当成飞轮准入。在 #532 合入前写死断言会打到错误接口 | 检查单 E-16 / 回退 §3 只留指针。不把 `auto_policy` 写成飞轮准入，不改启用策略测试，不改 `host-integration.ts` / `config.ts` / `persist.ts` / `session-turn.ts` |
| 会话 metadata 上的启用字段稳定名 | 最终字段名与 metadata schema 归第二刀。本预备发明最终 schema，或把已持久化记录提升为飞轮准入，都会抢写 #532 | skip。不发明最终 schema，不在本树扩展 `types.ts` 公共形状，不改上述四个文件 |
| 缺失或 `null` 的 `capabilityTiers` ⇒ `parser_default` 且 `enabled: false` | 这是关闭态（closed-as-off），不是待填的开启。缺字段、`parser_default`、`auto_policy` 都不得被重新解释成默认打开；三者本身不使 `handoffRuntimeEnabled` 为真 | 保持该规则，不得标成已填。本树不改这条判定，不把缺省、`parser_default` 或 `auto_policy` 写成 `explicit_on` 或飞轮默认准入 |

即使第二刀 Formal 已绿，在 FV 与同头 Main full health 按门禁通过并线性合入当前 tip 之前，本预备也不把 e992a814 / 后续写者头 squash 进本树。契约对照基线仍是 origin/main `c67112bc5de284d3806bc399cf7289458021044f`。分支预备提交 `a857ee98`（`a857ee9833a8e0055e9f227d0784e1628366848d`）不是第四刀实现，不得被描述成已经移动该基线。

## 等第三刀（独立准备树，本树禁止抢写）

第四刀实现依赖：第三刀**已验收**（准备树或未合入 PR 都不算），并完成真实调用/恢复路径上的 #516 再验。在此之前，飞轮经共用 Swarm 不得自动启用交接；本预备不得解除该组合限制。

| 洞 | 为何要等 | 本预备怎么处理 |
| --- | --- | --- |
| 组合限制：飞轮经共用 Swarm 不得自动启用交接 | 限制保持到第三刀验收为止。仅有准备树或开放 PR 不算验收。提前解除会在入口未获准时自动打开交接 | 本预备不解除。检查单与矩阵只记录关闭态。可执行夹具保持 `compositionEntry === 'closed'`，测试双只设 `handoffEnabled: false`，且不得被生产进口 |
| 可信宿主上下文 / 来源 fail-closed 的字段与传递路径 | 仍是第三刀；第四刀只继承入口资格，不在飞轮内再写循环或让 Worker 自报 | 夹具用测试双占位；不改 `swarm/executor.ts`，不把 Swarm 入口测试抄进本树 |
| 独立 Swarm 可运行的回归夹具 | 「回退后独立 Swarm 仍可运行」要等第三刀入口已验收。第四刀继承该夹具，不在本树另写一套 | skip；回退剧本只引用「第三刀落地后的入口测试文件名」，不抄 Swarm 入口测试 |
| 真实恢复 / 重规划过门路径 | 恢复后再完成仍过门、迟到恢复、结果未知不得重放，都要先有第三刀真实路径；第四刀继承该路径 | skip E-10；不把完整 yaml 当作第三刀已完成，不抄 Swarm 入口测试 |
| 补额 / 父级账本 / `refillId` / `planVersion` 恢复出口 | 这些是第三刀接口责任；飞轮只继承，不另立账本 | 本树不起草账本模块，不改 `CoordinatorResumeEvent`，不抄 Swarm 入口测试 |
| 非 pipeline 仍失败关闭的 Swarm 策略回归 | 第三刀所有权；本刀不得重写策略。第四刀不得借飞轮测试把该回归变成可执行入口 | 不改 executor；不把该回归写进飞轮测试文件的可执行部分，也不把 Swarm 入口测试抄进本树 |

## 等第四刀实现（第三刀验收当天之后）

下列不是「现在缺一篇文档」，而是入口仍关闭时明确禁止本预备动手的实现。每一条都仍开着。

| 洞 | 为何仍开 | 本预备怎么处理 |
| --- | --- | --- |
| 不打开生产飞轮入口，不接线飞轮来源，不打开 Swarm 生产入口，不改名或替换 Orchestrator | 这些属于第四刀实现，且须等第三刀验收。`FlywheelType` A–H 是既有产品分类，不是组合开关。`BOOTSTRAP_STAGES` 仍是 classify → research → implement → review → test，implement executor 仍是 `'swarm'`。`startSwarmForRun` 只写 `goal`、`orchestrationRunId`、`strategy: 'pipeline'`、`qualityGate: ['completed']`，不附带 `trajectoryHandoff`、`handoffEnabled`、`trustedSource`、`capabilityTiers` 或 `explicit_on` | 只在检查单、矩阵和夹具说明里记下这些关闭事实与分类差异。不改生产接线，不改 Orchestrator 名字，不把 A–H 当成入口 |
| 不写生产侧入口关闭原语，也不写任何 Pattern B 代码 | 即使为了「把回退做实」也不授权。Pattern B 在本预备是零代码 | 回退只预演。关闭态用测试双（`compositionEntry === 'closed'`）表达，不新增生产关闭原语，不让该双被生产文件进口 |
| implement 出口缺口仍在：`tryCompleteImplementStep` 在 `swarm.status === 'completed'` 时完成步骤，不看 `qualityPassed`；生产接线 `qualityGate: ['completed']` | 这是已记录缺口，不是验收通过。补洞会改 `engine.ts` 的生产阶段行为，并可能放宽 #516 | 只记录。不改 `engine.ts` / `gate.ts`，不放宽 `acceptance/collaboration-quality-gates.yaml` AC-1…AC-5，也不放宽 delivery-mapping DM-1…DM-9 |
| research/review 尚未接上阶段权限交集，切角色仍可能可写 | 这是第四刀实现；可信来源形状还在第三刀 | skip。不在本树新写一套权限系统 |
| `test.skip` 的组合用例还不能改成默认可跑 | 取消跳过并宣称验收已过，等于把未打开的入口写成已通过 | 保持 skip。可执行断言只覆盖当前关闭行为 |

## 本预备刻意不碰的树与文件

- `/home/<user>/wt/traj-handoff-knife2-ffe7556a`（#532 写者）
- `/home/<user>/wt/traj-handoff-k3-prep-c67112bc`（第三刀准备池）
- `/home/<user>/wt/traj-handoff-k34-prep-c67112bc`（已退役合并树，保持停放）
- 旧只读树与主仓 `/home/<user>/penglei/ppeng-agent-core`（须保持 detached `71f752657e7e7ae04dc3b8ae18863a6d95c587f6`）
- `packages/core/src/quality/gate.ts`、`packages/core/src/orchestrator/engine.ts`、`packages/core/src/runtime/collaborators.ts`、`packages/core/src/swarm/executor.ts`、Formal / verifier / `#516` yaml 口径

上述工作树与文件保持不碰。本文不授权生产编辑。
