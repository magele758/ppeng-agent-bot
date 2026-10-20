# @ppeng/agent-core

可嵌入的多智能体运行时 SDK：会话编排、工具循环、审批、任务工作区隔离、多模型适配、领域扩展点（Domain Bundle）、存储与追踪。是 [`ppeng-agent-core`](../../README.md) 仓库的核心包；`apps/daemon`（HTTP API）、`apps/cli`、`apps/desktop` 都只是它的消费者，不是使用前提——你可以在自己的 Node.js 进程里直接 `new RawAgentRuntime(...)`。

## 安装

```bash
npm install @ppeng/agent-core
```

（monorepo 内通过 workspace 引用：`"@ppeng/agent-core": "0.1.0"`。）

**Node 版本**：`>= 22`（依赖 `node:sqlite`）。

## 快速开始

```ts
import { RawAgentRuntime, HeuristicModelAdapter } from '@ppeng/agent-core';

const runtime = new RawAgentRuntime({
  repoRoot: '/path/to/your/workspace',
  stateDir: '/path/to/your/app-state',
  modelAdapter: new HeuristicModelAdapter() // 或 createModelAdapterFromEnv(process.env)
});

const session = runtime.createChatSession({ message: '你好' });
await runtime.runSession(session.id);
console.log(runtime.getLatestAssistantText(session.id));
```

更多可运行示例见 [`examples/`](examples/)（`01`–`07`，均用启发式/脚本化适配器，无需真实 API key）：

```bash
pnpm exec tsc -b packages/core   # 构建 dist/
node packages/core/examples/01-chat-session.mjs
node packages/core/examples/07-custom-agent.mjs
```

或在仓库根目录一次跑完全部示例：`pnpm run test:examples`。

## 文档

- **稳定公开面 + embed env 契约**：[`doc/EMBEDDING_SDK.md`](../../doc/EMBEDDING_SDK.md) —— 第三方嵌入场景应该从这里开始读，明确哪些符号可依赖、哪些是内部实现。
- 模块划分 / 内部架构：[`doc/ARCHITECTURE.md`](../../doc/ARCHITECTURE.md)
- 挂载领域 Persona（工具+提示词包）：[`doc/DOMAIN_AGENTS.md`](../../doc/DOMAIN_AGENTS.md)
- 环境变量完整索引：[`doc/ENV_REFERENCE.md`](../../doc/ENV_REFERENCE.md)

## 发布边界

`package.json` 的 `files` 仅打包 `dist/`（编译产物）、`examples/`、`README.md`、`CHANGELOG.md`；不含 `src/`、`test/`。`exports` 提供两个入口：

- `.`（主入口，Node-only，依赖 `node:sqlite`/`node:fs`）
- `./session-query`（再导出 `@ppeng/api-types`；新 Lab 代码请直接依赖 `@ppeng/api-types`）

变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。
