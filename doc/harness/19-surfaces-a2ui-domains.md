# 19 — 暴露面：Daemon API · Web Console · A2UI · Domain Agents

> **范围**：说明 `RawAgentRuntime` 的 HTTP/SSE、Web Console、A2UI 和 Domain Agent 接入面。本切片不重复 turn loop（见 [00](00-self-built-agent-loop.md) / [01](01-request-lifecycle.md)）。
>
> **深读手册**（实现细节以代码与下列专文为准）：[`A2UI.md`](../A2UI.md)、[`DOMAIN_AGENTS.md`](../DOMAIN_AGENTS.md)、[`AGENTIC_SAFETY_RUNTIME.md`](../AGENTIC_SAFETY_RUNTIME.md)。

---

## 为什么单独成章？

| 能力 | 在 harness 其它章的覆盖 | 缺口 |
|------|-------------------------|------|
| Daemon `/api/*` + Bearer + readiness | [01](01-request-lifecycle.md) / from-zero [08](from-zero/08-daemon-and-api.md) 有骨架 | 缺豁免路径、health vs readiness、SSE **wire** 事件名、cancel（非 stop） |
| Next 同源代理 + Lab UX | from-zero [09](from-zero/09-web-console.md) 有清单 | 缺乐观气泡 / SSE 消费 / 滚动保留的实现路径 |
| A2UI | [03](03-tool-execution.md) 仅工具名一行；chunk 类型在 01 | 缺 catalog、SurfaceUpdatePart、action 回灌全路径 |
| Domain Agents | [00](00-self-built-agent-loop.md) 提 DomainBundle | 缺 `RAW_AGENT_DOMAINS`、merge、allowedTools 过滤、sre/stock |
| Agentic safety appendix | [05](05-safety-and-recovery.md) 偏 LoopGuard | 缺与审批/最小权限/附录的控件映射（见专文） |

---

## 1. Daemon：鉴权、探针、路由边界

### 1.1 Bearer（`RAW_AGENT_AUTH_TOKEN`）

```
空 token          → 开发模式：不校验（降低本地摩擦）
有 token + /api/* → Authorization 必须精确等于 Bearer <token>，否则 401
豁免              → /api/health、/api/readiness、/api/version
非 /api/*         → 不校验（如 stub `/`）
```

实现：`apps/daemon/src/auth.ts` → `server.ts` 的 `handleApi` 在 router 之前调用 `checkAuth`。

当 Next 与 daemon 配置相同 token 时，token 只存在于服务端进程；浏览器经 Lab 同源 `/api/*` 时不持有该值。

### 1.2 Health vs Readiness

| 端点 | 含义 | 成功条件（摘要） |
|------|------|------------------|
| `GET /api/health` | 进程存活 | `{ ok, adapter, version }` |
| `GET /api/readiness` | 可接流量 | 临时文件可写 + `stateDir/runtime.sqlite` 可读写（库文件尚不存在仍可 ready） |

文件：`apps/daemon/src/routes/misc.ts`。K8s/Compose 探针应区分二者：健康≠就绪。

### 1.3 核心路由组（表面层）

| 组 | 路径要点 | 文件 |
|----|----------|------|
| sessions | CRUD、messages、run、**stream**、**cancel**、images、permission | `routes/sessions.ts` |
| chat | `POST /api/chat`、`/api/chat/stream`（自动建/复用 session） | 同上 |
| a2ui | `POST /api/sessions/:id/a2ui/action` | 同上 |
| approvals | `GET /api/approvals`；`POST .../:id/approve\|reject` | `routes/misc.ts` |
| domains | **无独立 HTTP 资源**；启动时注入 runtime extras；`GET /api/agents` 可见 | `domain-loader.ts` |

中断进行中的 run 用 **`POST /api/sessions/:id/cancel`**（`runtime.cancelSession`），不是 `/stop`（self-heal 另有 `.../stop`）。

Daemon **调用** `RawAgentRuntime.runSession`，不在路由里实现 turn loop。入口：`apps/daemon/src/server.ts`、`routing.ts`。

---

## 2. SSE：wire 事件 → ModelStreamChunk

### 2.1 发射路径

```
POST /api/sessions/:id/stream  或  POST /api/chat/stream
  → streamRun (routes/sessions.ts)
  → sseInit / sseSend (http-utils.ts)
  → runtime.runSession(id, { onModelStreamChunk })
```

**Wire 级 `event:` 名**（与 chunk `type` 分层）：

| SSE `event` | payload | 含义 |
|-------------|---------|------|
| `model` | `ModelStreamChunk` | 流式增量 |
| `result` | `{ session, latestAssistant }` | 本轮结束快照 |
| `error` | `{ message }` | 失败 |

`ModelStreamChunk.type`：`text_delta` | `reasoning_delta` | `tool_call_start` | `tool_call_delta` | `a2ui_message` | `done`。

无独立「session events」长订阅；对话流即上述 SSE。客户端侧（Lab）用 **fetch + 缓冲解析**（`apps/web-console/lib/sse.ts` 的 `feedSseBuffer`），不是浏览器 `EventSource`（因需 POST + 同源代理）。

### 2.2 与落库的关系

stream chunk 先推客户端，消息异步落 SQLite——首 token 不被 DB IO 拖慢（见 [01](01-request-lifecycle.md)）。A2UI 另见下文：工具结果同时写 `SurfaceUpdatePart` 并推 `a2ui_message`。

---

## 3. Web Console（Agent Lab）

### 3.1 同源代理 + 服务端补 Bearer

```
浏览器 → Next (apps/web-console) → middleware matcher /api/*
                              → DAEMON_PROXY_TARGET（默认 http://127.0.0.1:37070）
```

`middleware.ts`：`appendDaemonBearerIfConfigured`——若 Next 进程配置了与 daemon **相同**的 `RAW_AGENT_AUTH_TOKEN`，且出站请求尚无 `Authorization`，则注入 `Bearer`。浏览器永不看到 token。

开发：`pnpm run dev` / `dev:lab`（根 `.env` → 并行 daemon+Next）；Next 默认 `http://127.0.0.1:33815`。E2E（`pnpm run test:e2e`）临时随机 token，断言直连 daemon 401 / 经 Lab 200。

### 3.2 产品行为（实现路径）

| 约定 | 实现要点 |
|------|----------|
| 默认流式 | `usePlayChat.ts`：`useStream` 初始 `true`；PlayPanel checkbox 可关 |
| 乐观气泡 | 发送：`setOptimisticUser` + 流式 overlay / `waitTyping` → 滚底 → `clearComposerOnly()` → 再 `await` 请求 |
| 占位 `…` | 流式空段或等待中显示省略号（`PlayPanel` / `ChatTurnStreaming`） |
| thinking 折叠 | `ReasoningFold`：历史默认折叠；`streaming` 时展开 |
| 工具折叠 | `ToolCallFold` / `ToolResultFold`：`<details>` 默认折叠 |
| Markdown | `lib/markdown.ts`（marked + DOMPurify）→ 助手正文 HTML |
| 会话列表滚动 | `AgentLabApp`：`loadOverview` 前后 `scrollSnapshot` / `applyScrollSnapshot` |

入口：`app/page.tsx` → `components/AgentLabApp.tsx`；对话核心 `usePlayChat.ts` + `ChatTurns.tsx`。

### 3.3 SSE 消费（Lab）

`usePlayChat.readSseFetch` → `POST` `/api/sessions/:id/stream` 或 `/api/chat/stream` → `feedSseBuffer`：

- `model` + `text_delta` / `reasoning_delta` / tool_* → 追加 stream segments  
- `model` + `a2ui_message` → 按 `surfaceId` 合并 envelopes  
- `result` → 选中/刷新 session  

段类型：`lib/stream-segments.ts`。

---

## 4. A2UI：工具 → 校验 → 持久化 → 流式 → action 回灌

### 4.1 开关与工具

- Env：`RAW_AGENT_A2UI_ENABLED=1|true|yes`（默认关；**非**默认工具面）
- 工具：`a2ui_render` / `a2ui_delete_surface`（`builtin-tools.ts`，`approvalMode: 'never'`）
- Skill 速查：`skills/a2ui/SKILL.md`

### 4.2 协议与 catalog

`packages/core/src/a2ui/`：

| 模块 | 职责 |
|------|------|
| `protocol.ts` | v0.9 envelope：`createSurface` / `updateComponents` / `updateDataModel` / `deleteSurface` |
| `validator.ts` | `validateA2uiStream`（root、引用、catalogId；组件名默认 soft warn） |
| `catalog/basic.ts` | 标准 basic catalog |
| `catalog/agent-native.ts` | `https://ppeng.dev/agent-core/a2ui/v1`（TaskCard、ApprovalRequest、DiffView…） |

### 4.3 SurfaceUpdatePart + 流式

```
a2ui_render execute
  → metadata.a2uiMessages (+ surfaceId / catalogId)
  → tool-loop：parts += SurfaceUpdatePart { type:'surface_update', ... }
  → store.appendMessage(session, 'tool', parts)
  → 每个 envelope → onModelStreamChunk({ type:'a2ui_message', surfaceId, envelope })
  → SSE event:model → Lab A2uiSurface 折叠渲染
```

类型：`packages/core/src/types.ts`（`SurfaceUpdatePart`、`ModelStreamChunk`）。

### 4.4 Action 回灌

`POST /api/sessions/:id/a2ui/action`（body：`surfaceId`、`name`，可选 `context` / `dataModel` / `autoRun`）：

1. 合成用户消息：`[a2ui:action <name>] {...}`  
2. `sendUserMessage`；`autoRun !== false` 时 `runSession`  
3. 返回 JSON（非 SSE）：`{ session, latestAssistant }`  

Lab：`components/a2ui/actions.ts` → `postA2uiAction`；按钮等由 `A2uiSurface` 触发。

UI action 不另开一套 agent RPC：它回灌为 user message，再走现有 turn loop。

---

## 5. Domain Agents：按需挂载 + 最小权限

### 5.1 加载

```
RAW_AGENT_DOMAINS=sre,stock   # CSV
  → apps/daemon/src/domain-loader.ts（REGISTRY）
  → mergeDomainBundles (packages/core/src/domain.ts)
  → RawAgentRuntime({ extraAgents, extraTools, extraSkills })
```

`DomainBundle`：`{ id, label, agents, tools, skills? }`。合并按 `agent.id` / `tool.name` / `skill.name` **先到先得**；`agent.domainId ??= bundle.id`。未知 domain id 仅 warn 跳过。

### 5.2 内置包

| Bundle | 包 | Personas | Tools（摘要） |
|--------|-----|----------|---------------|
| `sre` | `@ppeng/agent-sre` | `sre-oncall` / `sre-postmortem` | `prom_query` / `loki_query` / `k8s_get` / `pagerduty_list`（只读观测） |
| `stock` | `@ppeng/agent-stock` | `stock-analyst` / `stock-screener` | `quote_get` / `fundamentals_get` / `news_search` |

新增包步骤见 [`DOMAIN_AGENTS.md`](../DOMAIN_AGENTS.md)。

### 5.3 `allowedTools` 过滤（运行时）

`_runSessionInner` 工具面组装顺序（摘要）：

1. external AI gate  
2. **`agent.allowedTools` 白名单求交**（有则收窄）  
3. `session.metadata.allowedTools`（子 agent 再收窄）  
4. optional tool groups（若启用）  

Domain persona 用 `allowedTools` 把「领域只读 API + 少量 repo 读 / load_skill」锁死，避免挂载 stock 工具后通用 bash 面无限放大。

---

## 6. Agentic safety：附录与控件映射（短章）

公开研究（如 Anthropic Agentic Misalignment、MSM / Teaching Why）主要对应**训练与模型方**。本仓库侧是**治理层**：

| 控件 | 作用 | 入口 |
|------|------|------|
| 审批 / 自主度 | 高风险工具挂起；Lab `permissionMode`（supervised/balanced/autonomous） | `/api/approvals`、`ApprovalBanner`、session chrome |
| 最小权限 | Domain `allowedTools`、optional groups、`RAW_AGENT_EXTERNAL_AI_TOOLS` | runtime 工具面 |
| 沙箱 | `sanitizeSpawnEnv` + OS sandbox | [12](12-sandbox-and-execution.md) |
| 系统附录 | `RAW_AGENT_AGENTIC_SAFETY_APPENDIX=1`（仅 `general`）或 `=all` | `prompt-builder.ts` |
| 审计 | trace / 会话落库 | [15](15-observability.md) |

完整映射与「不声称复现训练方法」边界 → [`AGENTIC_SAFETY_RUNTIME.md`](../AGENTIC_SAFETY_RUNTIME.md)。附录是弱提醒，**不能**替代审批与沙箱。

---

## 端到端故事（一条线）

```
用户在 Lab 发消息（乐观气泡 + …）
  → Next middleware 代理 /api/* 并补 Bearer
  → daemon checkAuth → POST .../stream
  → runSession →（可选 Domain allowedTools 收窄工具面）
  → 模型调 a2ui_render（若启用）→ SurfaceUpdatePart + SSE a2ui_message
  → Lab 渲染 surface；用户点按钮
  → POST .../a2ui/action → 合成 [a2ui:action …] user 消息 → 再跑自建 loop
```

---

## 关键文件

| 路径 | 职责 |
|------|------|
| `apps/daemon/src/auth.ts` | Bearer + 公开路径豁免 |
| `apps/daemon/src/server.ts` | HTTP 入口、domain 注入 |
| `apps/daemon/src/routes/sessions.ts` | chat/stream/cancel/a2ui action |
| `apps/daemon/src/routes/misc.ts` | health / readiness / approvals |
| `apps/daemon/src/domain-loader.ts` | `RAW_AGENT_DOMAINS` |
| `apps/daemon/src/http-utils.ts` | SSE 辅助 |
| `apps/web-console/middleware.ts` | 同源代理 + Bearer |
| `apps/web-console/components/usePlayChat.ts` | 流式默认、乐观发送、SSE 消费 |
| `apps/web-console/components/ChatTurns.tsx` | 折叠 / Markdown |
| `apps/web-console/components/a2ui/*` | Surface 渲染与 action |
| `packages/core/src/a2ui/*` | 协议、校验、catalog |
| `packages/core/src/domain.ts` | DomainBundle / merge |
| `packages/core/src/runtime.ts` | allowedTools 过滤 |
| `packages/agent-sre` / `packages/agent-stock` | 参考领域包 |

---

## 从 0 学习序对应

- Daemon 骨架：[from-zero/08](from-zero/08-daemon-and-api.md)  
- Lab 骨架：[from-zero/09](from-zero/09-web-console.md)  
- 请求主路径：[01-request-lifecycle](01-request-lifecycle.md)  
- 工具审批底座：[03-tool-execution](03-tool-execution.md)
