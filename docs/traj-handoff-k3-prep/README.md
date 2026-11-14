# 第三刀（Swarm）预备稿 — 仅测试 / 评估 / 回退准备

- 工作树：`/home/shinemo/wt/traj-handoff-k3-prep-c67112bc`
- 分支：`feat/traj-handoff-k3-prep-c67112bc`
- 钉死 HEAD（本预备不得移动 tip）：`c67112bc5de284d3806bc399cf7289458021044f`（#533，单父 `ffe7556a`，作者时间 2026-11-14 08:58:12 +0000 = 16:58:12 Asia/Shanghai）
- 性质：隔离树未提交草稿。不是第三刀实现，不打开生产 Swarm 入口，不含 Pattern B 任何代码（包括入口关闭基础原语），不改冻结契约，不推仓、不开 PR。
- 起草：2026-11-14 17:07 Asia/Shanghai。
- 契约（只读，未改）：
  - `knife34-decomposition.md` sha256 `2f43e7342d8254cec78f831034da2cff1870c77ce974d60d70aef85d220cceba`
  - `trajectory-handoff-plan.md` v2.3 sha256 `f6090ce870b068a0aaa0ba99392b67f50a7db7af1f700fee45c519b33d0e5356`
  - `remaining-slices.md` v1.1 sha256 `9de26ca88333660bfe74cd07320fa0c97057f963a6fc9a325af553d6a36b66c8`
  - `pattern-b-extension-design.md` 只读且本目录写零行 Pattern B 代码；sha256 `fffdca2ac49e316e7d2bf2967ba60d707706cf95199ed6059dcac4f88061f140`

## 本目录放什么

| 文件 | 用途 |
| --- | --- |
| `checklist.md` | 第三刀实现日后的工作与验收清单（现只作准备） |
| `evaluation-matrix.md` | 评估矩阵：用例 × 期望账本 / 内核 / 调用 / 门禁 |
| `fixture-notes.md` | 夹具与测试替身约定；生产入口保持关闭 |
| `rollback-prep.md` | 回退准备，覆盖已持久化自动策略会话 |
| `parent-ledger-interface-draft.ts` | 父级账本接口草稿（不被生产代码 import） |
| `holes-waiting-for-knife2.md` | 必须等第二刀合入后才能做的洞 |
| `skeletons/` | 测试骨架；**不要**拷进 `packages/core/test/` 除非已确认不会误开入口且本机已 build |

`packages/core` 的 `test:unit` 会收集 `packages/core/test/**/*.test.js`。骨架放在本目录，避免未实现账本或未 build 的 `dist/` 让本机门禁误红。本 worktree 在起草时 `packages/core/dist` 不存在。

## 本预备明确不做

- 不改 `packages/core/src/swarm/executor.ts` / `store.ts` / `types.ts` 的生产逻辑，不给 `createTeammateSession` 加交接默认。
- 不改第二刀所有权面：`host-integration.ts`、`config.ts`、`persist.ts`、`session-turn.ts`、会话创建路径、agent-lab / 默认策略、`types.ts` 公共形状。
- 不改 `gate.ts`、不放宽 #516、不改名 Orchestrator、不重写 Swarm 策略。
- 不碰飞轮生产阶段（`orchestrator/engine.ts`）或第四刀文件。
- 不实现父级账本、不补 `CoordinatorResumeEvent` 缺字段并合入、不新增 `coordinator_rejected` 事件到内核（那是合入后的实现，可在草稿里描述形状）。

## tip `c67112bc` 只读实核（本树，不是第二刀脏树）

- 内核在 `packages/agent-loop/src/trajectory-handoff/`；core 仅适配 `packages/core/src/trajectory-handoff/`。
- `SwarmExecutor`（287 行）不 import 轨迹交接。`dispatchTask` 写入的 teammate `metadata` 只有 `swarmRunId` / `swarmTaskId` / `autoRun`。无来源 / 入口资格字段。
- 非 `pipeline` 策略已失败关闭（既有实现，须回归）。
- `CoordinatorResumeEvent` 仅有 `planVersion` / `grantedQuota` / `waitDeadline` / `countAgainstGrantedQuota`。零命中 `refillId`、`shared_scope_escalated`、`local_capped_escalated`、`coordinator_rejected`、父级账本、可信来源字段。
- `applyTransition` 不消费 `CoordinatorResumeEvent`；注释写明 granted quota 由宿主另扣。`coordinator_resumed` 边已计 +1，且已有 `coordinator_no_plan` / `coordinator_repair` / cap 3/6 单测。
- R1 原语 `checkDeadline({ persistedDeadline, now, timeoutTxnCommitted })` 已在 `recovery.ts`，尚未接到父级扣减/授额原子事务。
- 飞轮 `implement` 经 `startSwarmForRun`；`tryCompleteImplementStep` 目前以 Swarm 终态 `completed/failed/cancelled` 结束该步骤。第三刀不得经此路径自动启用交接。
