# IM 控制 Agent 能力现状

本文档说明当前仓库内**即时通讯（IM）与 Agent 运行时**的集成范围：哪些平台可收消息驱动会话、哪些仅支持出站通知、哪些尚未内置。

## 已有能力

### 飞书（Lark / Feishu）— 双向（可控制 Agent）

- **入站**：`POST {gatewayPrefix}/providers/feishu/events`，事件订阅校验与挑战应答；消息经 [`packages/capability-gateway/src/im-handlers.ts`](../packages/capability-gateway/src/im-handlers.ts) 调用 `RawAgentRuntime` 执行轮次并回复。
- **出站**：`gateway.config.json` 的 `channels[]` 中 `type: "feishu_bot"`，配合环境变量 `RAW_AGENT_FEISHU_APP_ID` / `RAW_AGENT_FEISHU_APP_SECRET`，见 [`channels.ts`](../packages/capability-gateway/src/channels.ts)、[`feishu-api.ts`](../packages/capability-gateway/src/feishu-api.ts)。
- **配置示例**：[`gateway.config.example.json`](../gateway.config.example.json) 中 `providers.feishu` 与 `replyChannelId`。

### 入站安全（飞书 / 企微 / 通用 webhook）

配置走持久化设置（`daemon_control` KV `gateway_im_settings`），`GET/PATCH /api/gateway/settings`（管理员），保存即生效、无需重启；值覆盖 `gateway.config.json` 中同名字段；读取只返回 `*Set` 布尔，不回显密钥。

- **飞书验签**：消息事件必须带正确的 `verificationToken`（`header.token`）；配置 `encryptKey` 时另校验 `X-Lark-Signature`（sha256(timestamp+nonce+encryptKey+body)）。两者都未配置时消息事件一律 403（URL 验证握手仍可用）。
- **去重 + 立即 ack**：按 `event_id`（缺省用 `message_id`）去重（内存，6h）；校验通过后立即返回 200，Agent 在后台按会话串行执行。
- **sender 白名单**：`feishu.allowedSenders`（open_id/user_id/union_id/chat_id）、`wecom.allowedSenders`（userKey）、`webhook.allowedSenders`（通用渠道 senderId，缺发送者也拒绝）；空列表 = 不限制。
- **企微 bridge**：必须配置 `bridgeSecret`（未配置一律 403）。
- **Bot 路由**：`feishu.botId` / `wecom.botId` 让 IM 消息落进该 Bot 的 canonical 会话；`POST /chat`、`/channels/:id/webhook` 的 body 也可带 `botId`。

### 企业微信（WeCom）— 部分

- **出站群机器人**：`type: "wecom_group_bot"`，[`wecom-send.ts`](../packages/capability-gateway/src/wecom-send.ts) 向企业微信 webhook 发送 markdown。
- **入站**：`POST {gatewayPrefix}/providers/wecom/bridge`（必须配置 `bridgeSecret`），见 [`http.ts`](../packages/capability-gateway/src/http.ts)。用于**自建桥**将外部系统转发的消息 POST 进来再跑 Agent；**不是**完整的企业微信应用回调协议栈。
- **配置**：`providers.wecom` 见 `gateway.config.example.json`。

### 通用 Webhook（含 Slack Incoming 等）

- `type: "webhook"` + `payloadMode`（如 `json_text`）：主要用于**出站推送**（例如社媒定时发帖经 [`apps/daemon/src/social-schedule-deliver.ts`](../apps/daemon/src/social-schedule-deliver.ts) 投递）。
- **不是**从 Slack 等平台收事件、内置解析并驱动 Agent 的适配器。

## 未内置的平台

| 平台 | 状态 |
|------|------|
| 微信个人号机器人 | 无 |
| 钉钉机器人 | 无（仓库内无钉钉 API / channel 类型） |
| Telegram Bot | 无 |
| Slack Events API 入站 | 无（仅 webhook 出站形态） |

扩展方式：新增 `ChannelType` / `GatewayProvidersConfig` 与对应 handler，或在外部用桥接服务调用 Gateway 的 `POST .../agents/:agentId/invoke`（见 [`types.ts`](../packages/capability-gateway/src/types.ts) 中 `agentRoutes`）。

## 出站静默、投递账本、例行预检

### `[SILENT]` / `NO_REPLY`

整段回复若只是静默标记，网关不把标记发到 IM。会话里仍保留模型原文。顺带提到标记的普通句子照常发送。判定忽略大小写和空白，并允许外面套一层引号、反引号、星号或代码围栏。

标记：`[SILENT]`、`SILENT`、`NO_REPLY`、`NO REPLY`、`[NO_REPLY]`、`[NO REPLY]`、`[静默]`、`静默`、`[沉默]`、`沉默`。

- **人直接发来的消息**（飞书事件、企微 bridge）：不发标记，改发短确认。用户原文里有汉字时是「收到，没有更多要补充的。」，否则是「Got it. Nothing more to add.」（Lab 文案键 `play.imSilentAck`）。
- **渠道 webhook**：什么都不发，也不发这句确认。标成 cron 来源时同样丢弃；定时任务本身不把模型回复推到 IM。

### 投递账本（至少一次）

飞书回复，以及企微 / 渠道的 IM 出站，在真正发送前写入 `{stateDir}/gateway/delivery-ledger.json`。网关进程启动时重放尚未确认送达的记录。已确认送达的不再发。这是至少一次，允许重复，不是恰好一次。同一条最多再试 8 次，超过则放弃。

发送过程中重启，或发送失败后再次投递时，正文前加上下面前缀，再空一行接原文：

```text
♻️ Recovered reply — the gateway restarted during delivery, so this may be a duplicate:
```

### Bot 例行预检

Bot 定时任务可带 `precheck`，经 `POST` / `PATCH /api/cron/jobs` 或 Lab 定时任务面板写在该任务上（`metadata.precheck`）。不新增环境变量，保存后下次触发即生效，不必重启。到点后、把提示写入会话并调用模型之前执行。结果明确为不唤醒时，不开始模型回合，也不产生模型调用，并顺延下次时间。

```json
{ "kind": "predicate", "source": "{\"wakeAgent\":false}" }
{ "kind": "predicate", "source": "file:/path/to/flag" }
{ "kind": "script", "source": "printf '%s\\n' '{\"wakeAgent\":false}'" }
```

- 只有 JSON 里的 `wakeAgent` **就是布尔 `false`** 才跳过。脚本看标准输出最后一行非空内容。`0`、字符串 `"false"`、纯文本、脚本失败都仍然唤醒。
- `file:` 谓词：路径上的普通文件存在且非空才唤醒；没有文件或空文件则不唤醒。
- 脚本在宿主机执行（只剥离注入类环境变量，不进 OS 沙箱），超时 15 秒。`precheck: null` 清除预检。

## 控制 Agent 的其它入口（非 IM）

- **Web 控制台**：Next.js 经 `middleware` 代理到 daemon 的 `/api/sessions/*` 等。
- **Capability Gateway**：`POST .../agents/:agentId/invoke`（需配置 `agentRoutes`）。
- **CLI**：通过 HTTP 调用 daemon。

## 环境变量与索引

- 飞书相关：`RAW_AGENT_FEISHU_*` — 见 [`doc/ENV_REFERENCE.md`](ENV_REFERENCE.md)。
- Gateway：`RAW_AGENT_GATEWAY_*`、`RAW_AGENT_GATEWAY_CONFIG`（`gateway.config.json` 路径）。

## 小结

- **能通过 IM「控制 Agent」**（用户消息 → 创建/续跑 session）：当前主要是**飞书事件订阅**；**企业微信**依赖 **bridge** 入站，群机器人通道主要用于**发回复**。
- **钉钉 / Telegram / 个人微信**：需新增实现，或 **HTTP invoke + 外部桥**。
