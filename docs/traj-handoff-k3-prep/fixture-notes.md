# 第三刀夹具说明（生产入口保持关闭）

## 原则

1. 夹具只存在于测试 / 本预备目录，**不得**改 `SwarmExecutor`、Swarm types、会话创建或 `types.ts` 公共形状来「顺便」放下入口开关。
2. 禁止实现 Pattern B 入口关闭基础原语，也禁止在生产路径加「关闭也能当入口」的新模块。
3. 可信来源必须是测试里显式传入的**只读宿主上下文替身**，永远不要从 teammate `metadata` 读取资格。
4. 本预备不打开入口：表征断言是「即使有人在 metadata 里自报，tip 上也不启用交接」。
5. 不要把互不依赖的准备写进第四刀文件或飞轮 hook。飞轮只作为「来源未开放」对照夹具出现。
6. 不要改既有 `swarm-executor.test.js` / delivery-mapping 的公共 fixture，以免和第二刀或回归打架。新文件、新临时目录。

## tip 上可直接观察的事实（无需新生产 API）

`packages/core/src/swarm/executor.ts` `dispatchTask`：

```ts
metadata: {
  swarmRunId: run.id,
  swarmTaskId: task.id,
  autoRun: true
}
```

夹具应记录并断言：

- 执行器不 import `trajectory-handoff`。
- 上述 metadata 键集合不含来源 / 资格 / `refillId` / `enable*`。
- 测试若在 `createTeammateSession` 里额外注入 `metadata.independent_swarm` 或 `metadata.handoffSource`，执行器既不会读它，本预备也不得把这种注入升级成合法资格。
- 非 `pipeline` 策略：run 失败并留下 review note（既有行为）。
- 飞轮：`SwarmRun.orchestrationRunId` 已存在；执行器不根据它启用交接。表征时给 run 带上 `orchestrationRunId`，断言仍无交接内核状态。

## 推荐的测试替身（仅 skeleton，不落地生产）

### 1. 只读宿主上下文（TrustedHostContext stub）

测试文件内局部定义，不要放到 `packages/core/src/`：

```ts
/** Test-only. Not a production entry primitive. */
export type HandoffSourceHint = 'independent_swarm' | 'flywheel';

export interface TrustedHostContext {
  readonly source?: unknown;          // may be missing / illegal
  readonly explicitOff?: boolean;     // §8.4 highest priority
  readonly parentRunId?: string;
}
```

解析规则（文档契约，本预备不提供生产实现；入口骨架用本地 `closedEntryDecision` 编码，见下）：

- `explicitOff === true` → 未开放。
- 无可信上下文对象 → 未开放。
- `source` 缺失 / 不是恰好 `'independent_swarm'` 或 `'flywheel'` → 未开放（不精确字符串失败关闭）。
- `'flywheel'`，或带 `orchestrationRunId` 且没有 source 字符串 → 飞轮关闭；第三刀未开放。
- `'independent_swarm'` 且未显式关闭 → 本预备仍返回 `open: false`，原因 `trusted-but-entry-still-closed`。仅在获准入口打开之后，那一条才可以改为开放。
- Worker `metadata` 永远不是资格。

### 本地 `closedEntryDecision`（仅入口骨架，不是生产入口）

`skeletons/trajectory-handoff-swarm-entry.test.js` 的本地规则表达「本预备入口仍关闭」。它不是生产解析器，不是入口门，也不是 Pattern B 原语。不要把它拷进 `packages/core/src/`。

在本预备上，该规则的结果是：

- 即使可信上下文的 `source` **恰好**是 `'independent_swarm'`，也返回 `{ open: false, reason: 'trusted-but-entry-still-closed' }`。可信且精确，仍然关闭。
- Worker `metadata`（或其它 Worker 可写载体）**永远不是资格**。自报 `independent_swarm` / `enabled: true` 不得打开。
- 运行带 `orchestrationRunId` 时原因是 `orchestrationRunId present`（飞轮关闭），**即使没有 source 字符串**。不得据此启用交接。飞轮来源解除属第四刀。
- 不精确字符串失败关闭：空串、大小写变体、非字符串、未知值、缺失字段、没有可信上下文。不得默认成 `independent_swarm`。
- `explicitOff === true` 优先于上述一切，仍为未开放。

「可信 `independent_swarm` 可以启用」那条用例保持 `{ skip: true }`，入口打开前不得改成绿灯。

### 2. 父级账本内存夹具（见 `parent-ledger-interface-draft.ts`）

用于补额骨架：

- 单进程内存 map，键：`parentRunId`。
- 挂起裁决键：`parentRunId + workerId + hangAttemptId`。
- 幂等键：`refillId`（全局或按 parentRunId 唯一，草稿要求跨父 run 也不可复用）。
- 调用内核 `checkDeadline` 做期限判断。补额骨架里的行为用例保持 `{ skip: true }`，**不得**在骨架内再长出第二套 `checkDeadline`（不要复制 `now >= deadline` 比较）。`describeDecisionOrder` 那条未 skip 的顺序断言只锁草稿文案，不是补额行为测试，也不是父账本。
- 用「单把锁 / 串行队列」模拟原子事务即可；存储技术可后选，测试要表现「两个并发申请最后一份只能成功一个」。本预备不提供该锁或扣减的生产实现。
- **不要**在本预备把该夹具接线到 `SwarmExecutor` 或 `host-integration.ts`。不新增生产 schema。

### 3. 内核驱动

已有 `applyTransition` / `checkHandoffCap` / `commitPlanRevision` / `checkDeadline` 可在骨架里直接驱动。不要为了测试去扩 `CoordinatorResumeEvent`。恢复指令的完整字段先放在账本草稿输入里。

### 4. 真实路径门禁夹具（入口打开后才可端到端）

- 复用 `qualityPassed` / `failedQuality`，不改 `gate.ts`。
- 三份证据夹具：缺失、不可用（抛错 / 空报告）、旧 `planVersion`。
- 恢复后再完成：必须重新出具绑定当前版本与任务范围的证据。
- **D6**（预留验收笔记，真实路径，`skip: true`）：恢复后再完成时，证据必须同时绑定当前版本（`planVersion`）**和**任务范围。缺一、绑错版本、或绑错任务，都不得过门。入口与恢复路径打开前保持跳过，不要写成绿灯，不要改 `gate.ts`。本预备没有跑 D6。
- 内核终态 `done` 等不得被测试辅助函数映射成 implement 成功（对照 `trajectory-handoff-delivery-mapping.test.js`，但要走 Swarm 调用路径而不是只查表）。

### 5. 已持久化自动会话夹具（回退）

第二刀合入前，普通会话自动策略的持久化形状可能还会变。**不要在本树发明生产 schema**，也不要发明 `auto_policy` 表。回退骨架只保留抽象记录，对应用例保持 `{ skip: true }`：

```ts
interface PersistedOrdinarySessionStub {
  readonly sessionId: string;
  readonly enablementSource: 'explicit_off' | 'explicit_on' | 'parser_default' | 'auto_policy';
  readonly enabled: boolean;
}
```

回退**不改写** enablement。关闭 Swarm 入口不得把这些记录改成开，也不得把它们改成关。

tip 上缺 `capabilityTiers`（`undefined` / `null`）解析为 `enabled: false`、`enablementSource: 'parser_default'`。这不是默认开，等第二刀期间不得翻成默认开。`parser_default` 与尚未落盘的 `auto_policy` 在 `handoffRuntimeEnabled` 上保持关闭；只有显式开启才为真。stub 等第二刀真实 persist 形状落地后再替换。

## 如何（以及何时）把骨架搬进 `packages/core/test/`

建议文件名（拆分稿 §5，实现阶段）：

- `packages/core/test/trajectory-handoff-swarm-entry.test.js`
- `packages/core/test/trajectory-handoff-swarm-refill.test.js`
- `packages/core/test/trajectory-handoff-swarm-gate-paths.test.js`

搬迁条件：

1. 第二刀已合入，且不再与第二刀争用公共 fixture / `types.ts`。在此之前，**不要**把骨架拷进 `packages/core/test/`。
2. 本 worktree 或合入后的 tip 已 build 出 `packages/core/dist`。此刻 `dist/` 不存在。未 build 时不要并入 `test:unit`。
3. 表征用例在入口关闭时也能绿（A3–A8、A2，以及本预备上 trusted exact 仍为 `trusted-but-entry-still-closed`）。
4. 「独立 Swarm 可开」（A1）在入口打开前必须 `skip` 或断言未启用，不得先写成绿灯。
5. 现有测试从 `../dist/swarm/executor.js` 导入。搬迁后先 `pnpm run build` 再跑单文件。
6. 不得在搬迁时改 executor 生产逻辑，不得顺手接生产 schema。

预备期唯一允许的本地跑法（**不要**接进 `test:unit`；本说明不声称已经跑过）：

```bash
node --experimental-strip-types --test docs/traj-handoff-k3-prep/skeletons/
```

该命令只覆盖本目录骨架。行为用例仍应保持 skip；不要为了让它变绿而实现父账本或打开入口。

## 禁止的夹具写法

- 为了让 A1 先绿，而在生产 executor 里默认 `source = independent_swarm`。
- 把来源放进 Worker `metadata` 再在生产代码读取。
- 新增生产模块「EntryGate（关闭原语）」——那是 Pattern B / 入口实现范围，等第二刀合入当天另开隔离树做，且生产入口仍关闭。
- 在本树改 `orchestrator/engine.ts` 以便测试飞轮。
- 共享第四刀 worktree 或改飞轮测试文件。
