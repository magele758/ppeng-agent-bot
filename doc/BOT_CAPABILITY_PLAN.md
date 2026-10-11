# Bot 能力开发计划（Phase A）

**Implementation status**：Lab 对话 / Bot 双模式并存（已落地）。Bot 固定对话里的 `/new`、`/stop`、`/model` 已落地。  
对照调研：`/opt/cursor/artifacts/hermes-grok-bot-research.md`（Hermes Bot Mode / Grok Bot）。

## 目标

给本仓库加一等公民 **Bot**：命名持久队友，每人一个永远续上的对话。  
**v1 用户可见结果**：Lab 对话区能选 Bot / 新建 Bot，选中后进入该 Bot 的 canonical session，而不是再 `POST /api/sessions` 开一条新 chat。

薄产品层叠在已有 `AgentSpec` + `createChatSession` 上，**不另起循环、不加 `RAW_AGENT_*` 开关**。

## 刻意不做（本 PR）

- 云 VM / Teach-a-task / X API
- 组群房间、`@`、`message_agent`、用 Swarm 冒充组群
- 新 IM adapter（飞书已有，Phase C）
- 独立 Bots 管理页、分享链接、跨机 roster
- teammate 后台循环冒充 Bot Chat（对话走普通 `mode: 'chat'`，以便沿用现有发送/流式）

## 数据模型

`bots` 表（schema **v15**），不塞 `daemon_control` KV。

```ts
interface BotRecord {
  id: string;                    // 优先 name slug；冲突则 createId('bot')
  name: string;                  // 展示名，库内唯一
  title: string;
  description: string;
  agentId: string;               // 1:1，v1 等于 id
  canonicalSessionId: string;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}
```

创建时：

1. `ensureAgent({ id, name, role: title || 'Bot', instructions, capabilities: ['bot','tool-use'], domainId: 'bot' })`
2. `createChatSession({ title: 'Bot Chat · ${name}', agentId, metadata: { botId, canonicalBotChat: true } })`
3. 写入 `bots` 行

`open`：session 缺失则重建并回写 `canonicalSessionId`。隐藏只改 `hidden`，不删 session / agent。

## HTTP

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bots` | 名册；`?includeHidden=1` 含隐藏 |
| POST | `/api/bots` | `{ name, title?, description? }` |
| GET | `/api/bots/:id` | 单条 |
| PATCH | `/api/bots/:id` | name/title/description/hidden |
| POST | `/api/bots/:id/open` | 保证 canonical session，返回 `{ bot, session }` |

`POST /api/sessions`、`POST /api/chat`、`POST /api/chat/stream` 可带 `botId`：打开 canonical，有 message 则写入该 session，**禁止再 fork 一条 chat**。

## Lab

Lab 侧栏 **对话 / Bot** 两个表面并存（默认对话，写入 `localStorage`）：

- **对话**：旧 chat 会话列表；「+」新建普通会话；可选 Agent / Chat|Task；不显示 Bot 下拉
- **Bot**：只列 canonical Bot Chat；下拉选 Bot +「新建 Bot」；选中后锁定 Agent；「+」再 open，不 fork
- 点侧栏某条会话会自动切到对应表面
- 选中 Bot 且没有附件时，输入框里的 `/new`、`/stop`、`/model` 走下面的命令，不发给模型

## 固定对话命令

只认整句命令（`/new` 可以，`/new 一下` 仍是普通消息）。只作用在该 Bot 的 canonical 对话上。未选中 Bot 的普通对话、以及没绑定 Bot 的网关入站，不会被改写成这些命令。不新增 `RAW_AGENT_*`。

| 命令 | 效果 |
|------|------|
| `/new` | 不新开对话。强制压缩**同一条** canonical 对话；没有可压缩内容时也留在这条对话里 |
| `/stop` | 中止这条对话上正在进行的回合 |
| `/model <模型>` | 换成已在 Lab 模型列表里的模型。可写唯一的模型 id，或 `供应商/模型`（也接受 `供应商::模型`） |
| `/model default` | 取消固定模型，改回跟随全局默认（`follow` / `clear` / `跟随默认` 相同） |

名字不存在或对应多个模型时拒绝，原来的模型不变。`/model` 单独发送只提示用法，不改模型。列表不含仅从环境变量回退出来的模型，与 Bot 设置里的可选范围一致。

网关入站在该渠道已绑定 `botId` 时同样认这三条（飞书、企微、通用 webhook，以及 `POST /gateway/v1/chat` 只带 `botId`）。普通文本仍在同一条 canonical 对话里跑一轮。

## 文件分工

| Agent | 范围 |
|-------|------|
| Core | `packages/core/src/bots/*`、migration v15、`SqliteStateStore`/`RawAgentRuntime` 包装、`ApiBotInfo`、单测 |
| Daemon | `apps/daemon/src/routes/bots.ts` + `server.ts` 挂载；sessions/chat 认 `botId` |
| Lab | `PlayPanel` / `usePlayChat` / `AgentLabApp` 选型与新建；`lib/types.ts` |

## 后续（不在本 PR）

| 期 | 内容 |
|----|------|
| B | Room + @ + 轮次帽 + 仅 Bot Chat 挂 `message_agent` |
| C | 飞书群路由 + Routine 绑 `botId` |
| D | peer/relay、分享配置 |
