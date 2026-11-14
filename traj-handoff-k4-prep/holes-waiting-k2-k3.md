# 必须等待第二刀或第三刀的洞

本预备可以写检查单、矩阵、夹具说明和 `test.skip` 骨架，但不能把下列洞填成已完成实现，也不能为填洞而打开入口或改公共类型。

## 等第二刀（#532 写者，本树禁止抢写）

第二刀按契约很可能改：`host-integration.ts`、`config.ts`、`persist.ts`、`session-turn.ts`、会话创建路径、agent-lab / 默认策略落点。本树已避开这些文件。

| 洞 | 为何要等 | 本预备怎么处理 |
| --- | --- | --- |
| 普通会话启用策略与「已持久化自动策略」的最终形状 | 第四刀合入/回退都不得破坏第二刀承诺；在 #532 合入前写死断言会打到错误接口 | 检查单 E-16 / 回退 §3 只留指针；不改启用策略测试 |
| 会话 metadata 上的启用字段稳定名 | 飞轮若要证明「组合打开不回退单会话策略」，需要第二刀落地后的字段 | skip，不在本树扩展 `types.ts` 公共形状 |

即使第二刀 Formal 已绿，在 FV 与同头 Main full health 按门禁通过并线性合入当前 tip 之前，本预备也不把 e992a814 / 后续写者头 squash 进本树，不把本树基线移离 `c67112bc`。

## 等第三刀（独立准备树，本树禁止抢写）

第四刀实现依赖：第三刀已打开获准 Swarm 宿主入口并完成真实调用/恢复路径上的 #516 再验。在此之前禁止解除「飞轮经 Swarm 不得自动启用交接」。

| 洞 | 为何要等 | 本预备怎么处理 |
| --- | --- | --- |
| 可信宿主上下文 / 来源 fail-closed 的字段与传递路径 | 飞轮 implement 必须**继承**第三刀入口资格，而不是在飞轮内再写循环或让 Worker 自报 | 夹具用测试双占位；不改 `swarm/executor.ts`，不写 Swarm 入口测试文件 |
| 独立 Swarm 可运行的回归夹具 | 第四刀回退验收「独立 Swarm 仍可运行」需要第三刀入口已存在 | skip；回退剧本引用「第三刀落地后的入口测试文件名」 |
| 真实 Swarm 调用与恢复路径 | 恢复后再完成仍过门、迟到恢复、结果未知不得重放，都要先有第三刀真实路径 | skip E-10；不把完整 yaml 当作第三刀已完成 |
| 补额 / 父级账本 / `refillId` / `planVersion` 恢复出口 | 这些是第三刀接口责任；飞轮只继承，不另立账本 | 本树不起草账本模块，不改 `CoordinatorResumeEvent` |
| 非 pipeline 仍失败关闭的 Swarm 策略回归 | 第三刀所有权；本刀不得重写策略 | 不改 executor；不把该回归写进飞轮测试文件的可执行部分 |

## 等第四刀实现（第三刀验收当天之后）

下列不是「现在缺一篇文档」，而是明确禁止本预备动手的实现：

- 打开飞轮组合入口，或解除来源限制。
- 改 `engine.ts` 生产阶段行为，使 implement 成功出口走证据门（包括去掉仅凭 `swarm.status === 'completed'` 完成步骤的缺口）。
- 给 research/review 接上阶段权限交集，使切角色不可写。
- 实现生产侧入口关闭原语（含 Pattern B 相关原语）。
- 把 `test.skip` 的组合用例改成默认可跑并宣称验收已过。

## 本预备刻意不碰的树与文件

- `/home/shinemo/wt/traj-handoff-knife2-ffe7556a`（#532 写者）
- `/home/shinemo/wt/traj-handoff-k3-prep-c67112bc`（第三刀准备池）
- `/home/shinemo/wt/traj-handoff-k34-prep-c67112bc`（已退役合并树，保持停放）
- 旧只读树与主仓 `/home/shinemo/penglei/ppeng-agent-core`（须保持 detached `71f752657e7e7ae04dc3b8ae18863a6d95c587f6`）
- `packages/core/src/quality/gate.ts`、`packages/core/src/swarm/executor.ts`、Formal / verifier / `#516` yaml 口径
