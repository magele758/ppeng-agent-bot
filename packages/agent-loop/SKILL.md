---
name: agent-loop
description: Embeddable agent loop core SDK (@ppeng/agent-loop / @mage-ai-lab/agent-loop) providing turn kernel, model adapters, streaming watchdogs, loop guards, session state, and assembly presets (mini, normal, full, max). Use when: (1) Integrating or embedding the agent loop into an application or service, (2) Developing, modifying, or testing packages/agent-loop, (3) Assembling an agent loop using createAssembledLoop or createMiniAssembledLoop, (4) Managing mid-run steering, step-level control, or event folding via AgentLoopHandle, (5) Adding or configuring loop modules, watchdogs, or model adapters.
---

# @ppeng/agent-loop SDK 指南

`@ppeng/agent-loop`（公开发布名 `@mage-ai-lab/agent-loop`）是无外部服务端依赖的可嵌入 Agent 循环内核，提供**单轮 Turn 推进、模型适配器调用、流式退化守卫（Watchdog）、故障自愈与人工审批（HITL）、以及会话步进转向（Steering）**。

Bot 模式不在这个包里（它在 daemon / RawAgentRuntime 上）。

源码目录：`packages/agent-loop`。外部项目读 `node_modules/@mage-ai-lab/agent-loop/SKILL.md`（与本文件相同）。

---

## 1. 装配档位与分层规范

SDK 提供 4 个组装档位（高档位包含所有低档位模块）：

| 档位 | 运行平台 | 模块包含 | 入口子路径 |
|:---|:---|:---|:---|
| **`mini`** | 浏览器 / WebWorker / 插件 / Node | **纯静态、零 Node 内置依赖**。含 kernel、内存 store、故障恢复、HITL 门闩、上下文打包。 | `@ppeng/agent-loop/mini` |
| **`normal`** | Node.js | + 默认工具循环、权限模式、脏输入拦截、内存补偿、模型适配器、自动微压缩。 | `@ppeng/agent-loop/normal` |
| **`full`** | Node.js | + 审计事件流（event-log/stepTx）、working-log、富文本视图裁剪（prepare-view）、上下文附录、L4 句柄。 | `@ppeng/agent-loop/full` |
| **`max`** | Node.js (产品默认) | + PTC（动态代码编排/vm）、Shell 策略守护、超长工具结果拦截归档（guardian）、Vault/OTel/CBOM。 | `@ppeng/agent-loop/max` |

> 完整 26 个模块矩阵与 `AssembledLoopIo` 注入端口定义见 [modules-and-ports.md](references/modules-and-ports.md)。

### 开发者红线（Hard Constraints）
- **Mini 纯净性**：`src/mini.ts` 及其依赖链路中**绝对禁止引入任何 Node 内置模块**（`node:fs`、`node:sqlite`、`node:child_process`、`node:vm` 等）。所有 Node 重模块必须标记 `nodeOnly: true` 并使用动态 `import()` 加载。
- **类型单一切实来源（SSOT）**：循环层的类型以 `src/types.ts` 为唯一真源，上层（如 `packages/core`）只做 re-export，禁止重复声明导致类型分叉。
- **Watchdog 守卫正交性**：轮内复读（repetition）与思考空转（reasoning-spin）Watchdog 统一包裹在 `runtime/tool-loop.ts` 的 `runTurnWithRetries` 外层，**严禁将 Watchdog 逻辑塞进各具体的 ModelAdapter 中**。
  - `runTurnWithRetries(host, adapter, input, onStream, opts?)` 的可选 `opts.maxRetries` 只能**下调**（取 `min(RAW_AGENT_MODEL_MAX_RETRIES, opts.maxRetries)`，可为 0）；产品层的模型备选链用它限制备选前的叠加重试，不传则行为不变。

---

## 2. 嵌入使用范式（Consumer Usage）

### 2.1 组装式调用（`createAssembledLoop` + `createHandle`）

会话入口是 `createAssembledLoop({ preset })`，再 `createHandle(sessionId)`。`createHandle` 只在 `full` / `max` 上提供。不要把 `createAgentLoop` 当作会话入口（它是这两个档位内部用来造句柄的工厂）。

```ts quickstart
import { createAssembledLoop, OpenAiChatAdapter } from '@mage-ai-lab/agent-loop';
import { createDefaultMemoryStore, DEFAULT_EMBED_AGENT } from '@mage-ai-lab/agent-loop/mini';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('Set OPENAI_API_KEY');

const { store, surface } = createDefaultMemoryStore({ agent: DEFAULT_EMBED_AGENT });
const session = surface.createSession({
  title: 'weather',
  mode: 'chat',
  agentId: DEFAULT_EMBED_AGENT.id,
});
surface.appendMessage(session.id, 'user', [
  { type: 'text', text: 'What is the weather in Shanghai?' },
]);

const loop = await createAssembledLoop({
  preset: 'full',
  io: {
    store,
    model: new OpenAiChatAdapter({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      useJsonMode: false,
    }),
    tools: [
      {
        name: 'fetch_weather',
        description: 'Query weather for a city',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
        approvalMode: 'never',
        sideEffectLevel: 'none',
        execute: async (_ctx, args) => ({
          ok: true,
          content: `${String(args.city)}: Sunny, 22°C`,
        }),
      },
    ],
  },
});

if (!loop.createHandle) throw new Error('createHandle requires preset full or max');
const handle = loop.createHandle(session.id);
await handle.run();
console.log(await handle.fold());
```

同一句柄也可以 `for await (const event of handle)`。`event.type === 'model_done'` 之后可以 `handle.steer(...)`。

### 2.2 浏览器 / 扩展轻量级嵌入（`createMiniAssembledLoop`）

```ts
import { createMiniAssembledLoop } from '@mage-ai-lab/agent-loop/mini';

// customWebWorkerModelAdapter / inBrowserTool 由宿主提供，不是本包导出。
const miniLoop = createMiniAssembledLoop({
  io: {
    model: customWebWorkerModelAdapter,
    tools: [inBrowserTool],
  },
});

const sessionRecord = await miniLoop.run('session-web-1');
```

### 2.3 可选宿主钩子

- `checkToolApprovals` / `resolveTurnTools` 可以返回同步结果，也可以返回 `Promise`。内核会 `await`。
- `buildMemoryAppendix` 也可以返回 `string | Promise<string>`（附录编译含异步 I/O 时）。
- `beforeModelTurn?`（mini 可不实现）：主模型调用前；返回 `skip_goal_done` 时跳过深模型并以目标已完成收尾（不伪造 assistant 正文）。
- `chooseRecovery?`（mini 可不实现）：在内核已有的离散恢复动作中择一；返回 `null`/非法 id 则保持硬编码路径。
- **PTC `resolveJevHooks?`（`createPtcExecTool` 依赖，仅 max/`node:vm` 路径）**：宿主可在每次 `ptc_exec` 时返回 `{ noul(instructions), choice(instructions, options) }`，注入到沙箱全局 `jev`；返回 `undefined` 则**完全不注入** `jev`。SDK **禁止**静态 import Jev HTTP 客户端（尤其 mini 链路）。产品侧仅在 Jev `profile=custom` 且勾选 `ptcDecide`、已保存 baseUrl 时由 `packages/core` 提供实现（复用 `askJev`）。

Jev 不是 SDK 模块：未配置入口时宿主不调用它，SDK 接入参数里也不出现 Jev 客户端。

### Responses 流终止与回归契约

- `OpenAiResponsesAdapter.runTurnStream` 接受 `response.completed` / `response.done` / `response.incomplete`；不完整响应保留已有文本、`usage`、`finishReason` 与 `truncated`。兼容网关终止帧省略 `output` 时，继续使用累计分片，不能丢掉终止帧的用量与截断信息。
- `response.failed` / `response.cancelled`（以及终止帧中的对应 status）必须抛错，不能伪装成成功的空回答。重试仍由上层 tool-loop 负责，不在 adapter 内新增重试。
- 与共享适配器重构合并后，上述处理集中在 SDK 的 Responses 事件 handler / `finishResponsesStream`；core 保持薄 shim。终止帧有实际内容（含兼容字段 `output_text`）时优先采用，否则保留累计分片并合并终止元数据。
- `rewindUncommittedTail` 以带 `seq` 的折叠可见消息判断是否仍有尾部；不能把 `hideRange` 自己追加的 WAL 控制行当成新尾部，重复恢复必须幂等。不提供消息 `seq` 的自定义宿主保留物理 WAL head 的保守回退。
- SDK 单测包含 `src/model/responses-terminal.test.ts`。跨 SDK/core 的分片、工具参数、重复终止帧、HTTP 错误和取消契约由根目录 `scripts/test/responses-protocol.test.mjs` 检查（先构建，随后 `npm run test:unit`）。
- 公开 npm 包另跑 `npm run test:package`：改 scope 后打 tarball、隔离安装、校验所有 exports/类型解析、mini 静态依赖闭包和实际 mini 会话。发布脚本只发布同一批验证过的 tarball；不以 workspace 内导入成功代替产物验收。

观测也在宿主侧。内核只调用 `emitTrace`。`packages/core` 把这些事件镜像到 Langfuse（Lab「更多 → Langfuse」；没保存入口不会上报），并把真正发出的 Jev HTTP 记成 `jev_call`，在 Langfuse 里是当前轮下面的 `jev.<切入点>`。没发出 HTTP 的切入点不会出现。不要为了 Langfuse 或 Jev 在 mini 里静态 import Node。

### 2.4 审批记录上的可选过期字段

`ApprovalRecord`（`src/types.ts`）可带 `expiresAt` / `expireReason` / `wakeSource`。这三个字段只描述产品层的无人值守审批：cron、Bot routine、调度等唤醒会写入截止时间；人坐在 Lab 对话里提起的审批不写。到点后由产品层把审批拒绝并记上 `expireReason`，且不执行该工具。循环内核创建审批时只透传字段，不解释超时、也不因为超时改控制流。

### 2.5 L4 句柄控制契约（`AgentLoopHandle`）
- `handle.step()`：执行单个细粒度步骤（单步调试或受控推演）。
- `handle.run()`：连续循环运行直到会话挂起（waiting_approval / ended / error）。
- `for await (const event of handle)`：流式消费生命周期事件（`turn_prepared` -> `model_done` -> `tools_done` -> `ended`）。
- `handle.steer(message, options)`：向正在运行或即将运行的轮次注入用户修正指令。返回 `started`（已入队下一轮）、`steered`（已并入当前可转向轮次）、`not_submitted`（空文本、无会话或会话已结束等原因被拒）。daemon 的 HTTP 投影才把 `not_submitted` 写成 `rejected`。
- `handle.abort()`：软中断当前轮次。
- `handle.fold()`：获取经过投影和折叠处理后的结构化消息历史。
- 可见历史：折叠结果在 token 预算内时，不会按 `MAX_VISIBLE_MESSAGES`（24）从尾部硬切，条数上限也不会丢掉最新用户消息。需要裁切时保留最初的系统提示和最新用户消息，并且只在闭合的工具回合（助手 `tool_calls` 加上对应工具结果）边界下刀。超过 token 预算时仍走 `autoCompact` 摘要；摘要失败则退回上述钉住规则，不再盲目切片。

### 2.5 会话状态 `unknown`

`SessionStatus` 包含 `unknown`。委派子会话（`mode: 'subagent'`）在进程退出时若仍是 `running`，宿主启动时把它写成 `unknown`：外部副作用是否已经发生无法判断，所以这是终态，不能再跑一遍并记成成功。`decideSteerAdmission` 把 `unknown` 与 `completed` / `failed` 一样视为已结束。SDK 不另建子任务监督器；心跳或超时只接已有钩子，当前没有这类钩子。

### 2.6 模型适配器、重试与流重置（`@ppeng/agent-loop/model`、`streaming`）

- **唯一实现**：OpenAI Chat / Responses（`OpenAICompatibleAdapter`，`httpKind`）与 Anthropic（`AnthropicMessagesAdapter`）只在本包实现。`packages/core/src/model/model-adapters.ts` 只是薄 shim（继承并默认 `env: process.env`），**不要**在 core 里再复制一份解析逻辑。
- **失败要响亮**：非 2xx 抛 `UpstreamHttpError`（`status`、`retryAfterMs`、`requestId`）；流内 `error` 事件、`response.failed`、无终止事件的 EOF、连接重置抛 `UpstreamStreamError`。不要把半截流当成正常结束返回。
- **重试**：`runTurnWithRetries` 用 `retryDelayMs(error, attempt)`：优先尊重 `Retry-After`（`parseRetryAfterMs` / `retryAfterMsOf`），上限 `MAX_RETRY_AFTER_MS`（20s），否则指数退避；等待可被 `signal` 中断。
- **`stream_reset` 契约**：同一轮重新开始出流（重试、或宿主切到 fallback 模型）前，内核先发 `{ type: 'stream_reset', reason: 'retry' | 'fallback' }`。消费者必须丢弃**上一个 `done` 之后**累积的增量文本 / 推理 / 工具参数，再接收新流，否则会出现半截答案 + 完整答案的重复。宿主自己做 fallback 时用 `createStreamResetTracker(onStream)`：把增量交给 `tracker.onChunk(chunk)`，换下一个模型前调 `tracker.resetIfDirty('fallback')`（上一次尝试没出过字就不发）。core 的 `l5-bindings.ts` 中 `fallbackStream().forAttempt(i)` 就是这样接的。
- **取消**：`ModelTurnInput.signal` 一路传到 `fetch`；宿主（如 daemon SSE）在客户端断开时 abort，即可同时放弃上游请求。

### 2.7 上游回放测试工具（`src/testing/upstream-replay.ts`）

- 用随机端口的 `node:http` 服务器按 JSON fixture 回放真实上游的 SSE / JSON 响应，驱动**真实**适配器（不 mock fetch）。fixture 字段：`provider`（`openai-chat|openai-responses|anthropic`）、`mode`（`stream|json`）、`responses[]`（`status`、`headers`、`events[]`（`event`/`data`/`raw`）、`split`（`event|whole|{bytes}`，用于切断 JSON / UTF-8）、`delayMs`、`end`（`end|destroy|hang`））、`abortAfterMs`（轮次超时，模拟上游卡死）、`expect`（文本、推理、工具调用、`stopReason`、`usage`、`requestId`、错误正则与字段、命中次数、请求体等）。
- fixture 在 `src/testing/upstream-fixtures/*.json`；vitest 回放全部 fixture，`packages/core/test/upstream-replay.test.js` 再经 core shim 回放一遍并核对错误分类。新增上游异常时**先加 fixture 复现**，再改适配器。
- 测试里的假 key 用 `replayApiKey()`（运行时拼接），不要在 fixture 里写像真实格式的密钥。

---

## 3. SDK 开发者开发与扩展规范

当修改 `packages/agent-loop` 时，遵循以下 7 步标准开发流程：

1. **实现功能**：在子目录（`turn/`、`session/`、`model/`、`streaming/`、`recovery/` 等）中实现纯逻辑。
2. **注册模块元数据**：若新增了模块，必须在 `packages/agent-loop/src/assembly/presets.ts` 的 `LOOP_MODULES` 中登记最低档位与 Node 依赖标志：
   ```ts
   { id: 'my-feature', minPreset: 'normal', nodeOnly: false, load: 'static' }
   ```
3. **装配挂载**：在对应档位的 host 文件（`mini-host.ts`、`normal-host.ts`、`full-host.ts`、`max-host.ts`）中接入该模块。
4. **导出接口**：在 `src/index.ts` 以及 `package.json` 的 `exports` 中暴露对应的子路径。
5. **单测覆盖**：在同级目录建立 `*.test.ts`，覆盖典型分支与边界条件。
6. **验证构建与测试**：
   ```bash
   cd packages/agent-loop
   npm run build   # tsc -b 检查
   npm run test    # vitest 测试
   ```
7. **同步更新 Skill**：**核心指令——任何对 API 导出、档位或核心契约的改动，必须同步更新本文件（`skills/agent-loop/SKILL.md`）与 `references/`**。
