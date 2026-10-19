# Harness 实现指南

这组文档解释 ppeng-agent-core 如何把一次模型调用组织成可持续运行的 Agent 会话。内容以当前代码为准，重点回答三个问题：循环在哪里、每一层在何时介入、出问题时从哪里查。

返回 [项目首页](../../README.zh.md) · [文档总目录](../README.md) · [SDK 接入指南](../../skills/agent-loop/SKILL.md)

## 按问题进入

- **先运行产品**：读 [README 快速开始](../../README.zh.md#快速开始)，不用先读完全部原理。
- **第一次学习循环**：按 [from-zero 教程](from-zero/README.md) 顺序，从请求追到模型、工具与持久化。
- **准备嵌入 SDK**：读 [Agent Loop 指南](../../skills/agent-loop/SKILL.md)，明确档位与宿主 I/O；完整产品宿主另见 [Core 嵌入指南](../EMBEDDING_SDK.md)。
- **已有具体问题**：直接查下面的专题表；16–20 是跨模块切片，不是另一套入门课。

## 当前源码入口

入口地图按当前默认 SDK 路径整理。部分专题保留了较早的 core 路径与 env 说明；阅读时区分参考实现、兼容导出和默认执行路径，配置以对应 settings API 为准。

| 层 | 当前入口 | 负责什么 |
|----|----------|----------|
| HTTP / SSE | [`routes/sessions.ts`](../../apps/daemon/src/routes/sessions.ts) | 请求、流与会话操作 |
| 产品宿主 | [`runtime.ts`](../../packages/core/src/runtime.ts) 的 `runSession` | 运行并发控制、选择内核与档位、注入产品能力 |
| I/O 桥接 | [`l5-bindings.ts`](../../packages/core/src/runtime/l5-bindings.ts) | `l5ToAssembledIo` 连接 SDK 与产品服务 |
| SDK 装配 | [`create-assembled-loop.ts`](../../packages/agent-loop/src/assembly/create-assembled-loop.ts) | `mini / normal / full / max`，产品默认 max |
| 循环内核 | [`turn/kernel.ts`](../../packages/agent-loop/src/turn/kernel.ts) | turn 推进与模型/工具生命周期 |
| 设置 | [`routes/loop.ts`](../../apps/daemon/src/routes/loop.ts) | `GET/PATCH /api/loop/settings`，持久化选择与插话策略 |

## 先统一“ Harness ”的含义

仓库里有三组容易混淆的概念：

| 名称 | 代码入口 | 职责 |
|---|---|---|
| Agent runtime | `packages/core/src/runtime.ts` + `packages/agent-loop` | 产品宿主与可复用循环共同完成模型、工具、审批、恢复与持久化 |
| Long-running harness | `packages/core/src/types.ts`、`prompt-builder.ts` | planner / generator / evaluator 通过 `.raw-agent-harness/` 文件交接 |
| Agent eval harness | `scripts/agent-eval/runner.mjs` | 拉起隔离 daemon，用 JSON case 检查 HTTP 能力 |

本目录主要讲第一项；[20](20-orchestration-evolution-eval.md) 和 [from-zero/10](from-zero/10-eval-harness.md) 再解释后两项。

## 代码里的最短主线

```text
HTTP POST /api/sessions/:id/stream
  apps/daemon/src/routes/sessions.ts
        │
        ▼
RawAgentRuntime.runSession(sessionId)
  packages/core/src/runtime.ts（产品宿主）
        │
        ▼
createAssembledLoop({ preset, io, hooks, config }).run(...)
  packages/agent-loop（默认 agent-loop / max）
        │
        ▼
runSessionKernel（turn/kernel.ts）
        │
        ├─ 读取会话、agent、task 与可见历史
        ├─ autoCompact / prepareMessagesForModel
        ├─ PromptBuilder.buildSystemPrompt
        ├─ ModelAdapter.runTurn 或 runTurnStream
        ├─ 保存 assistant parts
        ├─ 无 tool_call：完成或进入 Goal Gate
        └─ 有 tool_call：筛选 → 审批 → 执行 → 保存 tool_result → 下一轮
```

这套循环由项目自己实现并抽为 SDK。模型适配器直接调用 OpenAI-compatible、OpenAI Responses 或 Anthropic HTTP API；MCP SDK 只用于接入外部工具，不接管会话循环。只有显式选择 `kernelVariant=ppeng` 才走 core 内的参考内核。

## 怎么读

如果第一次接触项目，从 [从零理解并跑通 Agent Runtime](from-zero/README.md) 开始。它是一条按依赖排序的教程，并在 daemon、Web Console 和 eval 章节给出可执行验证。

如果正在定位代码，按问题跳转：

| 你要找什么 | 文档 | 主要实现 |
|---|---|---|
| Jev 配置、语义决策与观测 | [Jev 接入指南](../JEV_INTEGRATION.md) | core `jev/`、`runtime/l5-bindings.ts`、daemon `routes/jev.ts` |
| 循环入口、停止条件 | [00 自建 Agent Loop](00-self-built-agent-loop.md) | core `runtime.ts` → agent-loop `turn/kernel.ts` |
| HTTP 到 runtime 的请求路径 | [01 请求生命周期](01-request-lifecycle.md) | `apps/daemon/src/server.ts`、`routes/sessions.ts` |
| system prompt 与 user appendix | [02 Prompt 组装](02-prompt-assembly.md) | `model/prompt-builder.ts`、`runtime.ts` |
| 工具筛选、审批、执行与落库 | [03 工具执行](03-tool-execution.md) | `runtime/tool-loop.ts` |
| 长会话预算与压缩 | [04 上下文管理](04-context-economics.md) | `session/*`、`model/episodic-selection.ts` |
| 复读、空转、工具循环 | [05 安全与恢复](05-safety-and-recovery.md) | `streaming/*`、`recovery/*` |
| 软完成判断 | [06 Goal Gate](06-goal-gate.md) | `goal/*` |
| Skill 发现、路由与加载 | [07 Skills](07-skills-and-routing.md) | `skills/*`、`prompt-builder.ts` |
| Memory 与经验案例 | [08 Memory / Evolving](08-memory-and-evolving.md) | `memory/*`、`evolving/*` |
| 模型协议、usage、成本 | [09 Model Adapters](09-model-adapters.md) | `model/model-adapters.ts`、`model/usage.ts` |
| 自动修复 | [10 Self-Heal](10-self-heal.md) | `self-heal/*`、`scripts/self-heal-flow.sh` |
| 子会话、队友与 Swarm | [11 Subagents / Swarm](11-subagents-and-swarm.md) | `runtime.ts`、`swarm/*` |
| 命令执行隔离与回流脱敏 | [12 Sandbox](12-sandbox-and-execution.md) | `sandbox/*` |
| SQLite、文件资产与云存储接口 | [13 Storage](13-storage-and-state.md) | `storage.ts`、`stores/*`、`storage/*` |
| Hooks、Extensions、Plugins | [14 扩展点](14-hooks-extensions-plugins.md) | `hooks/*`、`extensions/*`、`plugins/*` |
| Trace、OTEL 与诊断 | [15 可观测性](15-observability.md) | `stores/trace.ts`、`otel.ts`、`doctor/*` |

## 端到端切片

16–20 不是另一套实现。它们把上面的专题按一次真实执行重新串起来：

- [16 运行时治理叠层](16-runtime-governance.md)：轮内 watchdog、跨轮恢复、RiskEngine、Goal Gate 的先后关系。
- [17 上下文 / Memory / 压缩](17-context-memory-compaction.md)：落库历史与送模视图为何分开。
- [18 模型 / 工具 / 沙箱](18-model-tools-sandbox.md)：模型边界到本机执行边界的一条链。
- [19 Daemon / Lab / A2UI / Domain](19-surfaces-a2ui-domains.md)：用户可见表面如何接入 runtime。
- [20 编排 / Evolution / Eval](20-orchestration-evolution-eval.md)：runtime 之上的长任务能力和质量门。

## 阅读时要守住的边界

- SQLite transcript 是事实源；micro-compact 只改变送给模型的视图。
- `SessionLoopGuard` 观察跨轮工具行为；流式复读 watchdog 观察单次模型流，两者不是同一机制。
- `GoalGate` 是软完成门，不是安全授权系统；异常时按代码选择 fail-open。
- `RAW_AGENT_AGENT_SANDBOX_KIND` 选择执行后端。本机命令隔离由模型每次自选；`RAW_AGENT_SANDBOX_MODE` 只是没传当次隔离时的回退。
- daemon 负责 HTTP、鉴权、SSE 和调度；core 是产品宿主，默认 turn loop 在 agent-loop SDK。
- 文档没有配套结果文件时，不声称成功率、成本节省比例或与其他框架的优劣。

## 文档与代码发生冲突时

按下面的顺序查证：

1. 类型、默认值与装配边界：对应模块源码、`packages/agent-loop/src/assembly/presets.ts` 与产品 settings 实现。
2. HTTP 方法和路径：`apps/daemon/src/routes/*.ts` 与 `apps/daemon/src/routing.ts`。
3. 配置：先查 Lab UI 与对应 settings API 的有效值/覆盖顺序，再查必要的 env 回退及 `.env.example`。
4. 可观察行为：`packages/agent-loop/src/**/*.test.ts`、`packages/core/test/`、`scripts/agent-eval/cases/`、`scripts/e2e-run.mjs`。
5. 总体入口：[项目手册索引](../README.md) 与 [架构文档](../ARCHITECTURE.md)。
