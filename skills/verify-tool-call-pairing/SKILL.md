---
name: verify-tool-call-pairing
description: Verify tool-call/result pairing when editing persistence, retry, cancellation, approval resume, fold recovery or the turn kernel. Run bounded model checking, real-source probes and isolated mutations; retain counterexamples and invalidate stale source/model reviews.
---

# 工具调用与结果配对验证

性质：运行结束后的有效记录中，每次调用恰好对应一个先前关联正确的结果；运行中和等待审批时允许未完成调用。
破坏后的影响：重复、缺失或串错结果会使后续模型请求失效，或把另一个工具的输出当成当前调用的结果。

## 运行

在仓库根目录执行 `npm ci`（Node 22+，锁定 TypeScript 5.9.3），然后：

```sh
npm run test:pairing
node --test scripts/test/tool-call-pairing-verification.test.mjs
```

不需模型密钥、Java 或已有 dist 构建。工具是仓库固定的 `pairing-explicit-state/1` 显式状态穷举器，不是 TLC。工具代码及模型随复核指纹固定，报告记录 Node 版本。

`coverage/formal/pairing/report.json` 和 `report.md` 包含范围、模型结果、真实代码探针、故障演练、复核状态。退出码 0=全部通过，1=约束违反/演练漏检/需要复核，2=工具缺失、超时或未完成。`npm run test:formal` 和发布门禁会执行此入口。不要把单测通过、模型通过或旧报告当作整体通过。

## 覆盖代码及模型对应

先读 `specs/formal/pairing-review.json` 的 mapping 和 sha256；每个抽象步骤对应可打开的源码文件：

- `packages/agent-loop/src/runtime/tool-loop.ts`：执行、审批结果和同步落盘；模型 success/failure/unknown/reject/deliver/duplicate-batch/duplicate-delivery。
- `packages/agent-loop/src/session/tool-wave-close.ts`、`recovery/pair-unmatched-tool-calls.ts`、`session/surface-invariants.ts`：取消与恢复；模型 cancel。
- `packages/agent-loop/src/turn/kernel.ts`、`packages/core/src/runtime/tool-loop.ts`：调用方和宿主接线，需人工复核，不能声称探针执行了整个 kernel。
- `scripts/formal/pairing-verifier.mjs`：独立、按调用出现次数核对的 oracle；模型及源代码探针。

模型以同一波的两个不同调用开始，穷举可用事件顺序；每个调用最多一次重试、一次审批等待和一次重复投递。等待审批允许 approve/reject；取消可在任意未结束状态关闭剩余调用。同步落盘是原子动作，不把跨 await 的工作合并成一个原子动作。单写者、无回调重入；不证明进程崩溃恢复、多写者和无限规模。真实源码探针额外覆盖先后复用调用 id；同名工具用不同输入标记核对结果来源。

## 失败时

1. 看 overall，然后分开看 model、source、mutations、review，未完成绝不能解释成通过。
2. 模型反例的 events 可交给 `replayModel` 重放；source 反例包含探针名称、事件顺序、真实记录、调用 id 和具体错误。
3. 用 mapping 核对：是实际实现违反已批准性质，还是抽象步骤/调用前提不符合真实代码？组件边界反例不等于已经证明生产调用方可达。
4. 保留真实发现，不弱化性质或移除用例。已有发现见 `doc/formal/tool-call-pairing-findings.md`；产品修复须另提验收。

## 代码改变后

内容指纹不同即 `needs-review`，不会沿用旧结论。检查受影响的抽象步骤、原子边界、探针和排除范围；必要时按 acceptance-first 重新确认标准。复核后只对实际读过并确认映射的文件更新 `specs/formal/pairing-review.json` 的 SHA-256，同时更新 reviewNote，记录映射变化及仍未解决的发现。禁止为过门禁批量刷新指纹。指纹是复核提醒，不能证明人已经审查。

验证器会从当前 TypeScript 源码编译独立临时副本，分别在真实持久化位置注入遗漏、重复、错误关联三种缺陷。只有原先通过的探针新增失败才算捕获变异；原有红灯不算。副本删除后重跑原始源码，结果必须与演练前一致。不得修改工作区产品代码进行演练。

## 交付

报告模型规模、源码探针结果、三种变异是否捕获、恢复是否一致、未覆盖范围和已知问题。按批准标准，只有真实行为测试也通过才将 acceptance 状态改为 implemented。
