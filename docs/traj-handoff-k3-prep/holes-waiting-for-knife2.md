# 必须等第二刀合入（或合入当天）才能做的洞

本预备按拆分稿 §4 只做「不打开生产入口、不改默认、不碰第二刀写入面」的准备。下列事项现在开工会打架或违约。

## 仍须等第二刀合入后才能做

1. **打开获准的 Swarm 宿主入口**，或让 `createTeammateSession` 走交接。本树表征必须继续证明入口关闭。
2. **改生产文件接线**：`packages/core/src/swarm/executor.ts`、必要时 `store.ts` / Swarm `types.ts`（加来源/资格字段）、`packages/agent-loop/src/trajectory-handoff/types.ts` 公共形状（补 `refillId` / `runId` / `workerId` / `dedupeId` / `attemptId` / `planId`，以及 `coordinator_rejected` 事件）。#531 已改 `types.ts`，第二刀仍可能再改启用相关类型；现在合入会冲突。
3. **落地父级权威账本**到 agent-loop 生产模块并接线条件提交。接口草稿可以先写（本目录已写），不能当已完成模块提交。
4. **行为接线依赖「普通会话交接已走通」**：显式关闭优先、已持久化 `auto_policy` 会话、角色预算耗尽后的恢复拒绝、启用策略落点。这些是第二刀所有权（`host-integration.ts`、`config.ts`、`persist.ts`、`session-turn.ts`、会话创建、agent-lab）。本预备不得改这些文件。
5. **#516 真实 Swarm 调用与恢复路径再验**：需要入口和恢复指令真正从宿主走到内核。现在只有 DM 终态表与执行器既有 `qualityPassed`。骨架已列 D1–D4，不能声称已再验。
6. **把测试骨架搬进 `packages/core/test/` 并纳入 `test:unit`**：至少要等（a）第二刀不再争公共 fixture；（b）本树或合入后的 tip 已 build 出 `dist/`。此刻 `packages/core/dist` 不存在。
7. **Pattern B 入口关闭基础原语**：即使生产入口仍关闭，也要等第二刀验收合入当天另开隔离树、与第三刀实现并行。本预备写零行。
8. **完整 Swarm Pattern B、飞轮来源解除**：分别等第三刀复验后、第四刀组合验收后。第四刀实现等第三刀验收后再开。本树不写飞轮 hook。

## 第二刀合入前不要误报为「已完成」的缺口

- tip 上 `CoordinatorResumeEvent` 仍缺 v2.3 §10 字段；`coordinator_rejected` 不存在。这是已知缺口，不是本预备已补上的接口。
- `applyTransition` 不消费 resume 事件对象；granted quota 需宿主另记。本预备只在草稿里写清，不改状态机签名。
- `checkDeadline` / `checkHandoffCap` / `commitPlanRevision` / `coordinator_no_plan` / `coordinator_repair` 已在内核。它们**不是**父账本，也不是入口。不要把已有单测当成补额守恒已落地。
- 飞轮 `tryCompleteImplementStep` 以 Swarm 终态完成 implement 步骤：这是第四刀主责的门禁风险；第三刀只需保证飞轮来源不得启用交接，并在独立 Swarm 路径坚持 `qualityPassed`。不要在本树改 `engine.ts`。

## 第二刀合入当天建议的开工顺序（不是本预备的工作）

1. 线性以当时 tip 为基，另开第三刀**实现**树（不要用本预备树直接当唯一写者，除非明确 rebase 并专权）。
2. 同日另开隔离树做 Pattern B 入口关闭原语，生产入口仍关闭。
3. 改代码与刷新 Formal 指纹同一次推送；推前本机跑会踩到的 Formal 相关用例。
4. 绿且同头 Main full health 为「pass: 这个版本自己的完整验证已经通过」后再按当时门禁 squash。

本预备树 HEAD 在 tip 移动前必须保持 `c67112bc5de284d3806bc399cf7289458021044f`。
