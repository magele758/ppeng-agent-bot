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

解析规则（文档契约，本预备不提供生产实现）：

- `explicitOff === true` → 未开放。
- 无可信上下文对象 → 未开放。
- `source` 缺失 / 不是恰好 `'independent_swarm'` 或 `'flywheel'` → 未开放。
- `'flywheel'` → 第三刀未开放。
- `'independent_swarm'` 且未显式关闭 → **仅在第三刀入口已打开之后**才可开放；本预备与 tip 表征仍视为未开放。

### 2. 父级账本内存夹具（见 `parent-ledger-interface-draft.ts`）

用于补额骨架：

- 单进程内存 map，键：`parentRunId`。
- 挂起裁决键：`parentRunId + workerId + hangAttemptId`。
- 幂等键：`refillId`（全局或按 parentRunId 唯一，草稿要求跨父 run 也不可复用）。
- 调用 `checkDeadline` 做期限判断，不要复制一套比较逻辑。
- 用「单把锁 / 串行队列」模拟原子事务即可；存储技术可后选，测试要表现「两个并发申请最后一份只能成功一个」。
- **不要**在本预备把该夹具接线到 `SwarmExecutor` 或 `host-integration.ts`。

### 3. 内核驱动

已有 `applyTransition` / `checkHandoffCap` / `commitPlanRevision` / `checkDeadline` 可在骨架里直接驱动。不要为了测试去扩 `CoordinatorResumeEvent`。恢复指令的完整字段先放在账本草稿输入里。

### 4. 真实路径门禁夹具（入口打开后才可端到端）

- 复用 `qualityPassed` / `failedQuality`，不改 `gate.ts`。
- 三份证据夹具：缺失、不可用（抛错 / 空报告）、旧 `planVersion`。
- 恢复后再完成：必须重新出具绑定当前版本与任务范围的证据。
- 内核终态 `done` 等不得被测试辅助函数映射成 implement 成功（对照 `trajectory-handoff-delivery-mapping.test.js`，但要走 Swarm 调用路径而不是只查表）。

### 5. 已持久化自动会话夹具（回退）

第二刀合入前，普通会话自动策略的持久化形状可能还会变，不要在本树发明生产 schema。回退骨架只保留抽象记录：

```ts
interface PersistedOrdinarySessionStub {
  readonly sessionId: string;
  readonly enablementSource: 'explicit_off' | 'explicit_on' | 'parser_default' | 'auto_policy';
  readonly enabled: boolean;
}
```

回退第三刀入口后，这些记录的启用结论必须不变。细节等第二刀落盘后再把 stub 换成真实 persist 形状。

## 如何（以及何时）把骨架搬进 `packages/core/test/`

建议文件名（拆分稿 §5，实现阶段）：

- `packages/core/test/trajectory-handoff-swarm-entry.test.js`
- `packages/core/test/trajectory-handoff-swarm-refill.test.js`
- `packages/core/test/trajectory-handoff-swarm-gate-paths.test.js`

搬迁条件：

1. 第二刀已合入，或至少不再与第二刀争用公共 fixture / `types.ts`。
2. 表征用例在入口关闭时也能绿（A3–A8, A2）。
3. 「独立 Swarm 可开」（A1）在入口打开前必须 `skip` 或断言未启用，不得先写成绿灯。
4. 现有测试从 `../dist/swarm/executor.js` 导入。本 worktree 此刻无 `dist/`。搬迁后先 `pnpm run build` 再跑单文件，不要在未 build 时并入 `test:unit`。
5. 不得在搬迁时改 executor 生产逻辑。

## 禁止的夹具写法

- 为了让 A1 先绿，而在生产 executor 里默认 `source = independent_swarm`。
- 把来源放进 Worker `metadata` 再在生产代码读取。
- 新增生产模块「EntryGate（关闭原语）」——那是 Pattern B / 入口实现范围，等第二刀合入当天另开隔离树做，且生产入口仍关闭。
- 在本树改 `orchestrator/engine.ts` 以便测试飞轮。
- 共享第四刀 worktree 或改飞轮测试文件。
