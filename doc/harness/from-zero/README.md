# 从零理解并跑通 Agent Runtime

这是一条代码导读教程。读完后，你应该能从一个 HTTP 请求追到模型调用和工具结果落库，并能在本地跑起 daemon、Web Console 与 fast eval。

返回 [项目首页](../../../README.zh.md) · [Harness 地图](../README.md) · [文档总目录](../../README.md)

只想使用产品，先读 [README 快速开始](../../../README.zh.md#快速开始)；只想嵌入循环，直接读 [SDK 指南](../../../skills/agent-loop/SKILL.md)。本教程沿产品默认的 `core → agent-loop（max）` 路径解释原理，不要求先理解全部可选集成。

## 前置条件

- Node.js 22 或更高版本，SQLite 需支持 FTS5；版本约束见根 `package.json`。
- 已执行 `npm install`。
- 真实模型优先通过 Lab 配置服务商与模型；必要的 CI/连接回退才使用 `.env`。fast eval 不需要真实模型。

## 先建立一张地图

```text
apps/web-console / CLI      用户入口
        │
        ▼
apps/daemon                 HTTP / SSE / auth / scheduler
        │
        ▼
packages/core               产品宿主
  RawAgentRuntime           内核选择、并发与产品服务
  l5ToAssembledIo            注入 model / tools / storage / hooks
        │
        ▼
packages/agent-loop         可嵌入循环 SDK（产品默认 max）
  assembly                  mini / normal / full / max
  turn/kernel               上下文 → 模型 → 工具 → 下一轮
  session                   fold、inbox、checkpoint 等会话机制
```

## 学习顺序

| 章 | 读完能回答的问题 | 建议验证 |
|---|---|---|
| [01 目标与边界](01-goals-and-boundaries.md) | 哪一层负责什么？“Harness”有哪些含义？ | 找到各入口文件 |
| [02 自建循环](02-self-built-loop.md) | 一个 dispatch 为什么可能包含多个 model turn？ | 追 `runSession` |
| [03 模型适配器](03-model-adapters.md) | runtime 如何屏蔽不同模型协议？ | 查看 adapter factory |
| [04 工具与审批](04-tools-and-approval.md) | tool_call 如何保证有配对结果？ | 追 tool-loop 五阶段 |
| [05 会话与压缩](05-session-and-compact.md) | 落库历史和送模历史有什么区别？ | 跑 micro-compact 单测 |
| [06 Skills 路由](06-skills-routing.md) | 为什么先 shortlist 再 load？ | 查看 routing trace |
| [07 沙箱与恢复](07-sandbox-and-safety.md) | 执行隔离和循环治理分别在哪？ | 跑 sandbox / recovery 单测 |
| [08 Daemon API](08-daemon-and-api.md) | 如何建会话、发消息、流式运行？ | 用 curl 跑通 |
| [09 Web Console](09-web-console.md) | 浏览器如何在不拿 token 的情况下访问 daemon？ | `pnpm run dev` |
| [10 Eval Harness](10-eval-harness.md) | fast eval 实际验证什么、退出码是什么？ | `pnpm run agent:eval:fast` |
| [11 Evolution / Self-Heal](11-evolution-and-self-heal.md) | 哪些能力会改代码，哪些只编排会话？ | 查看入口与状态文件 |

## 最短实践路径

```bash
pnpm run build
pnpm run test:unit
pnpm run agent:eval:fast --exit-on-fail
```

`agent:eval:fast` 会拉起一个临时 daemon，强制使用 heuristic adapter，写入临时 state 目录，结束后清理进程和 state。结果追加到 `doc/eval-results/YYYY-MM-DD.jsonl`。

`--exit-on-fail` 使失败返回非零退出码。若修改循环 SDK，另跑 `pnpm run test --workspace=@ppeng/agent-loop` 与 `pnpm run build --workspace=@ppeng/agent-loop`，根目录单测不包含这套 Vitest 测试。

要看真实 UI：

```bash
pnpm run dev
```

打开启动日志中的 Agent Lab 地址。开发启动器当前首选 daemon 27070 / Lab 23000，允许配置覆盖，端口冲突时后移；实际地址记录在 `.agent-state/dev-lab.ports.json`。

## 完成标准

不要以“读完文件”为完成。至少确认：

- 能指出 `apps/daemon/src/routes/sessions.ts` 调用 `RawAgentRuntime.runSession` 的位置。
- 能从 `runSession` 追到 `l5ToAssembledIo`、`createAssembledLoop` 和 SDK `turn/kernel.ts`，区分产品默认 max 与 SDK 工厂默认 mini。
- 能说明 assistant 没有 tool call、等待审批、超过 turn 上限时的不同结果。
- 能说明 micro-compact 为什么不会删 SQLite 中的原始 tool result。
- 能说出 fast eval 默认失败是否会返回非零退出码，以及 CI 应加哪个参数。
- 能区分 runtime、long-running harness 交接文件与 agent eval harness。

更细的专题参考见 [Harness 实现指南](../README.md)。
