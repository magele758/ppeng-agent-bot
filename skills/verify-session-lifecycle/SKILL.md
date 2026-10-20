---
name: verify-session-lifecycle
description: Verify lifecycle consistency when changing session cancellation, model retry, approval decisions/resumption, run outcomes, or runtime/kernel wiring. Preserve pairing verification; use real RawAgentRuntime and SQLite probes, bounded models and isolated product-source mutations.
---

# 会话生命周期验证

性质：会话状态、运行结束原因和实际可继续执行的工作一致；已结束运行不被旧事件改写，审批只恢复尚未执行的获准工作。
影响：失效会导致已完成任务被标成取消、等待审批的会话显示空闲，或取消后仍推进、重复执行操作。

## 一键运行

仓库根目录 `pnpm install --frozen-lockfile`（Node 22+，锁定 TypeScript 5.9.3），然后：

```sh
pnpm run test:lifecycle
pnpm run test:pairing
node --test scripts/test/session-lifecycle-verification.test.mjs
```

入口会先 `tsc -b packages/core` 更新真实实现构建；没有模型密钥要求，不读用户 .env。运行器子进程只保留必要进程环境，设置现有的模型重试次数为 1、禁用用户技能加载，仅限临时验证进程。每个场景使用独立临时仓库和 SQLite 状态目录，模型及工具由可控本地替身驱动。状态变化、取消、重试与审批均调用真实 RawAgentRuntime、默认 agent-loop 内核和 SQLite；没有用手写状态表替代真实执行。

报告：`coverage/formal/lifecycle/report.json` / `report.md`。0=全部通过，1=真实行为违约/模型失败/变异漏检/需要复核，2=构建失败、工具缺失、超时、执行未完成。模型通过不能盖过真实运行失败。`test:formal` 和发布门禁保留配对验证，再执行生命周期验证。

## 范围与原子边界

模型为 `session-lifecycle-explicit-state/1`：普通对话/任务，先后两次运行，每次至多两个审批、一次模型重试、一波工具。穷举 model return/error、retry tick、approve/reject/resume、cancel、start-next 和旧事件的允许顺序。单写者，记录一项决定或状态的同步动作作为一个原子步骤，等待模型、重试和审批分开建模。不证明无限规模、多进程写者、强杀/断电/存储损坏，不撤销已发生的外部副作用。

- `packages/core/src/runtime.ts`：真实运行入口、取消信号绑定/解绑和并发运行管理。
- `packages/core/src/runtime/session-control.ts`：主动/停驻取消，模型 cancel 及迟到取消。
- `packages/core/src/runtime/session-facade.ts`：审批决定，模型 approve/reject。
- `packages/core/src/runtime/session-complete.ts`：普通对话/任务完成。
- `packages/agent-loop/src/runtime/tool-loop.ts`：真实请求重试及可取消等待。
- `packages/agent-loop/src/turn/kernel.ts`、`session/interrupt.ts`、`session/run-outcome.ts`：运行状态、审批恢复和结束原因。
- `scripts/formal/lifecycle-model.mjs` 是设计模型；`lifecycle-runtime.mjs` 是独立真实执行场景，二者结果必须分开报告。

完整映射与内容指纹见 `specs/formal/lifecycle-review.json`。逻辑运行编号 run-1/run-2 代替随机数据库 ID；报告剔除时间戳而保留状态、结果、审批决定、执行次数和事件顺序。取消重试后的旧计时器探针实际等过原计时期限，不用固定延时猜测进入某个状态；进入等待点由可控事件或真实计时器注册来确认。

## 失败与复核

1. 先看报告是否 completed，再分开看 model、runtime、mutations、review。
2. 模型反例 events 交给 `replayLifecycle`；真实反例按场景名称运行主命令，检查 snapshots/checks 的 run、expected、actual。
3. 区分夹具错误和产品错误：控制输入必须合法、路径准备正确；运行前置条件失败不能冒充目标行为的反例。
4. 已知产品发现见 `doc/formal/session-lifecycle-findings.md`。不删场景、不弱化验收或把原红灯算变异捕获。产品修复另提验收。
5. 覆盖文件变化产生 needs-review。读改动、检查映射/原子边界/假设后，仅更新已复核文件指纹与 reviewNote；不得批量刷新来过门禁。新增相关依赖应扩展映射。指纹提醒复核，不证明人已经审查。

## 必须能发现故障

验证在隔离子进程的 ESM 加载边界，把当前真实 TypeScript 源码变异为：取消不再触发中止、重试失败后仍保存 running、审批恢复多执行一次。使用固定编译器编译替换模块，其余实现来自本轮新构建。工作区产品文件从不改写。必须确认变异模块实际加载，且原来通过的场景新增失败；恢复后重跑得到完全相同基线。超时或未加载不是捕获成功。

交付时说明范围、状态数、真实场景及验收通过/失败情况、变异捕获与恢复证据，并保留独立修复提案。只有批准标准的真实测试也通过才能标为 implemented。
