# 必须等第二刀合入（或合入当天）才能做的洞

本预备按 remaining-slices v1.1 §4 只做「不打开生产入口、不改默认、不碰第二刀写入面」的准备。下面把两类缺口分开：**本目录已经写明、但还没实现**的验收笔记，以及**仍未规定、不能在本树发明**的洞。

表征基线是 tip `c67112bc`。本预备树当前提交是 `fecc8daa`（基于该 tip）。不要把本树从这两处切走。

## 本预备已经写明，但仍未实现

下列材料是规定，不是完成。不要把它们汇报成「父账本已落地」「入口已打开」或「#516 已再验」。

- `evaluation-matrix.md`：A1–A8、B1–B6、C1–C15、D1–D5、E1–E6 的期望已经写在矩阵里。另外预留 **A9–A10、B7、C16–C22、D6、E7** 作为验收笔记，仍然 blocked。本预备没有跑这些用例，也不要把编号当成已实现或已再验。
- `rollback-prep.md`、`checklist.md`：回退检查项与实现清单已写明。没有实施回退，没有改生产开关。
- `skeletons/`：入口、补额、门禁骨架已列用例。行为用例仍是 `skip: true`，或只做源码表征。没有父账本，没有真实 Swarm 调用加恢复。
- `parent-ledger-interface-draft.ts`：接口与裁决顺序草稿已写。它不是生产模块，没有 store、锁或扣减实现，生产代码不得 import 它。

## 仍未规定，或规定了也不能在等第二刀时动手的硬洞

1. **打开获准的 Swarm 宿主入口**，或让 `createTeammateSession` 走交接。本树必须继续证明入口关闭。
2. **生产父级权威账本**接到 agent-loop 并做条件提交。草稿不能当已完成模块提交。
3. **扩大公共 `CoordinatorResumeEvent`**。tip `c67112bc` 上该类型仍只有 `planVersion` / `grantedQuota` / `waitDeadline` / `countAgainstGrantedQuota`。没有 `refillId` / `runId` / `workerId` / `dedupeId` / `attemptId` / `planId`，也没有 `coordinator_rejected`。不要把草稿字段抄进 `packages/agent-loop/src/trajectory-handoff/types.ts`。
4. **第二刀写入面**：`host-integration.ts`、`config.ts`、`persist.ts`、`session-turn.ts`、会话创建、agent-lab。显式关闭优先、角色预算耗尽后的恢复拒绝、启用策略落点都属于这里。本预备不得改这些文件。
5. **#516 真实 Swarm 调用与恢复路径再验**。现在只有 DM 终态表，以及执行器在独立 Swarm 任务完成路径上已有的 `qualityPassed`。骨架列了 D1–D5 与预留的 D6，不能声称已再验。
6. **把测试骨架搬进 `packages/core/test/` 并纳入 `test:unit`**。至少要等第二刀不再争公共 fixture，并且本树或合入后的 tip 已 build 出 `dist/`。此刻 `packages/core/dist` 不存在。
7. **Pattern B，包括入口关闭基础原语**。即使生产入口仍关闭，也要等第二刀验收合入当天另开隔离树。本预备写零行。完整 Swarm Pattern B 还要等第三刀复验之后。
8. **飞轮来源解除（第四刀的洞，不是第三刀的编辑）**。`tryCompleteImplementStep`（`packages/core/src/orchestrator/engine.ts`，约 146 行）按 Swarm 终态 `completed` / `failed` / `cancelled` 完成或失败 implement 步骤，**不调用** `qualityPassed`。review / test 路径别处会调用 `qualityPassed`。第三刀不得启用交接来盖住这个缺口，也不得改 `engine.ts` 或 `gate.ts`。本树不写飞轮 hook。

另两条在等第二刀期间不得发明或翻转：

- tip 上 `parseCapabilityTiers(undefined | null)` 得到 `enabled: false`（`enablementSource: 'parser_default'`）。`handoffRuntimeEnabled` 对 `parser_default` 与 `auto_policy` 保持关闭，只有显式开启才为真。**缺 `capabilityTiers` => `enabled: false` 不得翻成默认开。**
- 已持久化 `auto_policy` 会话是第二刀的落盘形状。不要在本文件或本目录发明那张表。回退只锁行为：关闭 Swarm 入口不得改写普通会话的启用结论。

## 不要把内核帮手误报成已完成的父账本

- `checkDeadline` / `checkHandoffCap` / `commitPlanRevision` / `coordinator_no_plan` / `coordinator_repair` 已在内核。它们**不是**父账本，也不是入口。不要把已有单测当成补额守恒已落地。
- `applyTransition` 不消费 resume 事件对象；granted quota 需宿主另记。本预备只在草稿里写清，不改状态机签名。
- `checkDeadline`（`recovery.ts`）在 `timeoutTxnCommitted` 时拒绝；否则当 `now >= persistedDeadline` 时拒绝。父账本事务还没接上这支原语。崩溃恢复（R2 reservation / reconcile）也不是父账本上的方法。

## 第二刀合入当天建议的开工顺序（不是本预备的工作）

1. 线性以当时 tip 为基，另开第三刀**实现**树。不要把本预备树当成那个实现树的写者，也不要为了开工把本树从 `fecc8daa` / tip `c67112bc` 切走。
2. 同日另开隔离树做 Pattern B 入口关闭原语，生产入口仍关闭。
3. 改代码与刷新 Formal 指纹同一次推送；推前本机跑会踩到的 Formal 相关用例。
4. 绿且同头 Main full health 为「pass: 这个版本自己的完整验证已经通过」后再按当时门禁 squash。
