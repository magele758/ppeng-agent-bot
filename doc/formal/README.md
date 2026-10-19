# Formal methods（可执行不变量，不是 TLC 证明）

对照 `ai-agent-node` 的 formal 方案与其 `docs/formal/2026-08-26-uncommitted-scheme-evaluation.md`：那边把 TLA / 运行时 LTL / Petri / 分析公式铺开后，**规格未对准实现、半接线进热路径、缺文件当绿、过称「已验证」**。本仓只吸收有用的核，并避开那些坑。

## 本仓做了什么

| 层 | 落点 | 诚实边界 |
|---|---|---|
| L1 可执行不变量 | `packages/core/src/formal/` | 谓词打在真实 transcript / Goal SM / Session 状态表上 |
| L1 PBT | `formal/pbt.ts` + `test/formal-invariants.test.js` | 固定种子随机走表；**不是**形式化证明 |
| L2 TLA 草稿 | `specs/formal/tla/*.tla` | 与 TS 转移表注释对齐；`test:formal` **不跑 TLC** |
| L2 配对有界模型检查 | `scripts/formal/pairing-verifier.mjs` | 穷举声明范围内的设计模型；真实实现由独立源码探针检查，不能以模型通过代替实现通过 |
| L3 MockLLM E2E | `MockLlmProvider` + `test/mock-llm-e2e.test.js` | 脚本化 adapter 驱动整条 `runSession`，结束后检查 pairing |

**不**把窗口启发式叫 LTL monitor，**不**挂进 AgentLoop / Recovery，**不**写 VERIFICATION PASSED。缺文件 = 失败。

## 命令

```bash
npx tsc -b packages/core
npm run test:formal
```

`test:formal` 会：执行配对 → 生命周期 → 重启恢复 → 多进程并发门禁 → 检查必存在文件及 TLA 草稿结构 → 跑 invariants / MockLLM / goal SM / surface 单测。任一门禁失败会阻止后续步骤。配对模型通过只代表其声明范围已穷举；未安装 JRE / 未跑 TLC **不能**解释成「TLA 规格已穷举」。

可选本机 TLC（非门禁）：

```bash
java -cp /path/to/tla2tools.jar tlc2.TLC specs/formal/tla/GoalStateMachine.tla
```

## MockLLM

```ts
import { RawAgentRuntime, createMockLlm, mockText, mockToolUse } from '@ppeng/agent-core';

const model = createMockLlm([
  mockToolUse({ name: 'read_file', input: { path: 'docs' } }),
  mockText('done')
]);
const runtime = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: model });
```

比 heuristic 更适合单测：无关键词猜测、回合顺序确定、可断言 `tool_call`↔`tool_result` 闭合。

## 工具调用配对试点（2026-10-19）

`npm run test:pairing` 现在执行仓库自带的有界显式状态模型检查、真实源码组件探针、隔离代码变异及代码/模型复核指纹检查。固定工具为 `pairing-explicit-state/1` 和锁文件中的 TypeScript 5.9.3；无需 Java、模型密钥或已有 dist。它不是 TLC，也不把设计模型通过当成真实系统证明。

`test:formal` 先执行该试点；发布门禁另有明确的无重试步骤及证据上传。查看 [专用技能](../../skills/verify-tool-call-pairing/SKILL.md)、[发现与修复记录](tool-call-pairing-findings.md)。F-1 同批重复结果已按独立验收修复，原反例探针继续执行；旧有 TLA 草稿仍只做结构检查。

## 会话生命周期扩展（2026-10-19）

`npm run test:lifecycle` 执行有界设计模型、真实 RawAgentRuntime/SQLite 运行、隔离源码变异以及内容指纹复核。`test:formal` 保留原配对门禁并追加此检查；CI 单独保存生命周期证据。工具与命令见 [生命周期技能](../../skills/verify-session-lifecycle/SKILL.md)。

迟到取消与部分审批状态缺陷已按三条独立批准标准修复，20 个真实场景、源码变异与完整门禁均通过。原始反例和验收标准保留，见 [发现及修复记录](session-lifecycle-findings.md)。这仍是有界验证，不代表全系统证明。

## 进程重启恢复扩展（2026-10-19）

`npm run test:restart` 执行独立有界模型、真实运行时子进程的正常退出/强制终止及同库重启、源码变异、指纹复核，并同时要求原生命周期和配对验证通过。结果保存在 `coverage/formal/restart/`；`test:formal` 与发布门禁已纳入检查及证据上传。

首次 43 个真实场景中 28 个失败；经用户批准四条独立修复标准后，旧运行状态/占用、审批决定冲突和取消后新运行受阻已修复，当前 **43/43**、源码变异及完整门禁通过，两份验收均为 implemented，原始反例保留。见 [发现与证据](session-restart-recovery-findings.md) 和 [运行指引](../../skills/verify-session-restart/SKILL.md)。这些子进程使用生产 RawAgentRuntime 启停路径，未覆盖 daemon HTTP 排空或完整调度启动链。

## 多进程并发扩展（2026-10-19）

`npm run test:concurrency` 在同库、真实并存的 OS 进程中检查占用争抢、旧结果/释放及审批恢复；模型与工具 I/O 可控，观察屏障只控制调度。独立有界设计模型不能代替实际进程结果。命令保留并运行重启恢复、生命周期和工具配对检查，加入 formal 与 CI 无重试门禁，并上传 `coverage/formal/concurrency/` 证据。

首次验证 58 个场景中 38 个失败；经用户独立批准五条修复标准，当前扩展后的 62 个真实场景、源码变异及原三组验证全部通过，两份验收均为 implemented，原始红例保留。仍不得以有界验证通过宣称全系统或跨系统恰好一次安全。见 [发现与证据](session-multiprocess-concurrency-findings.md) 和 [运行指引](../../skills/verify-session-concurrency/SKILL.md)。同机健康本地库、普通会话和固定有界调度之外的情形不在覆盖范围。
