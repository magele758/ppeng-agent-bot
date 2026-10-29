# 外部 Agent 任务交接

部署的 daemon 或 Lab 提供通用 JSON HTTP 接口。外部 Agent 能发 HTTP 请求、访问服务地址并持有接入凭证，即可委托任务和查询结果。接口不依赖外部 Agent 使用的模型或框架。

这是通用任务交接接口；Grok Bot 等来源系统的历史会话、记忆、定时任务与运行中状态迁移需另做适配。本接口也不宣称兼容 A2A 或 MCP 协议。

## 在 Lab 授权

打开 **设置 → 集成与可观测 → 外部 Agent 任务交接**（`#/settings/integrations`）：

1. 启用外部任务交接，添加接入方。
2. 填写独立且固定的接入方标识、名称和至少 32 字符的随机凭证。
3. 填写允许的执行者标识及默认执行者（界面显示可用标识，例如 `general`）。
4. 保存，将接入地址和凭证交给外部 Agent。

配置保存在 SQLite，保存立即生效，无需修改 `.env` 或重启。凭证仅存 SHA-256 摘要，读取配置不会返回原文或摘要；请在保存前保管凭证。编辑时留空保留，填入新凭证即轮换。关闭总开关、关闭接入方或移除接入方，会立即拒绝其后续请求；已经接收的任务继续执行。接入方标识决定任务归属，不要把同一标识复用于不同信任主体。

设置接口为 `GET/PATCH /api/external-agents/settings`，沿用 Lab 的管理员权限与 daemon 认证。外部任务凭证仅用于下列两个任务接口，不授予控制台管理权限。

## 提交任务

```sh
curl -i 'https://your-lab.example/api/external-agent/v1/tasks' \
  -H 'Authorization: Bearer <接入凭证>' \
  -H 'Content-Type: application/json' \
  --data '{
    "source": "my-bot",
    "sourceTaskId": "upstream-task-123",
    "goal": "分析下面的需求并给出实现建议",
    "context": "已有背景、约束、前序任务结论等",
    "agentId": "general",
    "title": "需求分析"
  }'
```

| 字段 | 约束 |
|------|------|
| `source` | 必填，来源系统标识，最多 160 字符 |
| `sourceTaskId` | 必填，来源任务唯一标识，最多 256 字符；重试时保持不变 |
| `goal` | 必填，任务目标，最多 32,000 字符 |
| `context` | 可选，非空文本，最多 64,000 字符；传递继续任务所需的背景 |
| `agentId` | 可选，执行者标识，必须在此接入方允许列表内；省略使用当前默认执行者 |
| `title` | 可选，最多 160 字符；省略取任务目标前 160 字符 |

新任务返回 **202 Accepted** 及 `statusUrl` 相对查询路径，任务在后台执行，请求连接断开不会取消已接收的任务：

```json
{
  "task": {
    "id": "task_...",
    "title": "需求分析",
    "agentId": "general",
    "source": "my-bot",
    "sourceTaskId": "upstream-task-123",
    "status": "queued",
    "result": null,
    "progress": [],
    "artifacts": [],
    "createdAt": "2026-10-18T00:00:00.000Z",
    "updatedAt": "2026-10-18T00:00:00.000Z"
  },
  "duplicate": false,
  "statusUrl": "/api/external-agent/v1/tasks/task_..."
}
```

同一接入方的 `(source, sourceTaskId)` 构成幂等标识，映射与任务一起持久化。并发重试或重启后重试，返回 **200**、`duplicate: true` 和已有任务，不重复创建或启动。已有任务使用首次接收的内容；要执行新的目标或失败后重新执行，请使用新 `sourceTaskId`。若已接收任务被管理员删除，旧标识返回 **410**，不会悄悄重跑。

## 查询进度和结果

```sh
curl 'https://your-lab.example/api/external-agent/v1/tasks/task_...' \
  -H 'Authorization: Bearer <接入凭证>'
```

成功返回 **200** 和 `{ "task": { ... } }`：

| `status` | 含义 / 后续动作 |
|----------|-----------------|
| `queued` | 已接收，等待启动 |
| `running` | 正在执行，可继续查询 |
| `completed` | 完成，`result` 为助手回复，`artifacts` 为任务产物记录 |
| `waiting_approval` | 等待人工审批，`reason` 为 `human_approval_required`；在 Lab 中处理后继续查询 |
| `waiting_input` | 等待人工补充，`reason` 为 `human_input_required`；在 Lab 中回复后继续查询 |
| `failed` | 失败，查看 `reason`；`execution_failed` 表示执行宿主失败 |
| `cancelled` | 已中断或取消，查看 `reason` |
| `unknown` | 执行结果暂时无法确认，`reason` 为 `execution_state_unknown`；在 Lab 核查后再决定后续操作，不按“仍在运行”持续等待，也不要自动重复执行 |

`progress` 为任务当前的待办列表，`result` 在任务结束前也可能包含已产生的助手文本；完成以 `status` 为准。返回值不包含内部会话、系统提示词、工具调用或接入配置。通常每隔 1–3 秒查询一次即可。外部调用者只能查看相同接入方标识提交的任务；不同接入方即使使用相同来源任务编号，也各自创建独立任务。

| HTTP 状态 | 含义 |
|-----------|------|
| `400` | 字段格式错误或执行者不存在 |
| `401` | 凭证无效、已撤销、接入方关闭或总开关关闭 |
| `403` | 请求的执行者不在此接入方的允许列表中 |
| `404` | 任务不存在或属于其他接入方，两种情况返回相同错误 |
| `410` | 幂等标识对应的已接收任务被删除 |

任务接口始终要求独立的 `Authorization: Bearer <接入凭证>`，即使部署没有配置 daemon token 或 Lab 登录也不例外。Lab 登录 Cookie 和 daemon 管理凭证不能代替接入凭证。可以通过 Lab 同源代理访问，也可以直接访问 daemon 暴露的这两个路径；部署需让外部 Agent 能访问相应服务地址。

## 交给外部 Agent 的最小调用说明

```text
任务服务地址：https://your-lab.example
凭证：<单独安全提供>
提交：POST /api/external-agent/v1/tasks
请求头：Authorization: Bearer <凭证>，Content-Type: application/json
请求体：{source, sourceTaskId, goal, context?, agentId?, title?}
接收成功后保存 task.id；网络失败时保持 source/sourceTaskId 不变重试。
查询：GET /api/external-agent/v1/tasks/<task.id>，使用相同凭证。
轮询到 completed 后读取 result；failed/cancelled 时读取 reason 并报告。
waiting_approval/waiting_input 时提示用户在 Lab 处理，稍后继续查询。
```

## 指定 Bot 的入站任务

Lab 同一设置卡片中可填写接入方的「允许的 Bot」。外部请求使用 `botId`，与 `agentId` 二选一：

```json
{
  "source": "other-app",
  "sourceTaskId": "report-001",
  "botId": "report-bot",
  "goal": "生成本周报告",
  "context": "报告范围和必要材料"
}
```

任务以目标 Bot 身份在独立会话中执行，继承该授权主体的 Bot 权限模式、工具/技能范围、模型设置和工作区；不会把主对话历史复制给调用方。返回的 `task.botId` 表明 Bot 路由。暂停或禁用的 Bot 拒绝新任务。Bot 标识不能通过 `agentId` 绕过 Bot 白名单。

仅授权 Bot 时，可以将「允许的执行者」和「默认执行者」同时留空；请求必须明确指定 `botId`。Bot 白名单撤销后，该接入方不能继续查询或控制该 Bot 的任务；关闭接入方或总开关则撤销全部任务接口访问。撤销访问不会自动取消已经接收的工作。

新增两个任务操作，均使用原接入凭证且只允许操作该接入方自己的任务：

- `POST /api/external-agent/v1/tasks/:id/cancel`，body `{}`。取消尚未结束的任务；已结束的任务返回已有状态。
- `POST /api/external-agent/v1/tasks/:id/input`，body `{ "inputId": "reply-001", "message": "补充材料" }`。仅适用于 `waiting_input`；相同 `inputId` 重试只接收一次，同一标识不能换内容。补充信息不会批准工具；若仍有工具审批，需在 Lab 处理。

## 本地 Bot 主动委派到远端

在 **设置 → 集成与可观测 → 外部 Agent 连接** 添加连接：

1. 设置连接标识、名称、服务根地址（例如 `https://peer.example.com`）。
2. 填入远端在「外部 Agent 任务交接」中为本应用创建的接入凭证。
3. 填写「允许调用的本地 Bot」；连接绑定保存者身份，其他用户不能借用。
4. 选择远端目标类型（Bot / 执行者），填写远端目标标识。
5. 本机或内网连接显式开启「允许访问私有网络」，保存即可使用。

凭证进入现有密钥库，设置与工具结果不回显。网络请求固定在配置的服务地址，校验 DNS 并绑定实际连接地址，不跟随重定向；响应最多 1 MB，单次 HTTP 请求限时 30 秒。私有网络默认不允许。连接设置接口为管理员 `GET/PATCH /api/external-agents/connections`；保存立即生效，无需 `.env` 或重启。

授权 Bot 使用以下统一工具；写操作沿用会话的工具审批策略，计划模式不能派工或改变远端任务：

| 工具 | 输入与行为 |
|------|------------|
| `external_agent_list` | 列出此 Bot 可使用的连接和最近 100 个派工记录 |
| `external_agent_delegate` | `{connectionId, idempotencyKey, goal, context?}`，返回本地跟踪记录 `id` 和 `remoteTaskId` |
| `external_agent_status` | `{taskId}`；这里使用本地跟踪记录 `id`，查询远端状态与结果 |
| `external_agent_cancel` | `{taskId}`，请求远端取消 |
| `external_agent_input` | `{taskId, inputId, message}`，向等待输入的远端任务补充材料 |

例如对 Bot 说：「用 peer-report 连接，让远端报告 Bot 分析这份材料。派工标识使用 report-20261028，查到完成后汇总结果。」Bot 应先查看连接，再派工、使用返回的本地 `id` 查询结果；`queued`、`running`、`unknown` 都不等于完成。

同一本地身份、Bot、连接下的派工标识持久化去重。断线导致接收结果不明时返回 `unknown`，使用原 `idempotencyKey` 和原参数重试，将发送相同的远端任务身份；远端须遵守本项目协议的持久化幂等约定。不同应用需实现此 JSON HTTP 协议或做适配；不自动兼容任意 A2A/MCP Agent。取消与补充输入要求远端提供相应接口，旧版本仅支持提交和查询时会明确报错。

禁用连接、撤销本地 Bot 授权或删除连接立即阻止后续调用。轮换凭证不改变任务关联；修改服务地址或远端目标后，旧任务禁止继续访问，避免操作到另一个服务的同名任务。需要继续旧任务时恢复原地址和目标；可重新添加同一标识的连接并保留原服务身份。

Bot 入站任务保留“外部委派”的来源身份，不视为人在 Lab 直接输入的操作授权。Bot 已保存的来源策略（含精确工具与参数授权）通过同一主体的主会话解析；范围不足时需在 Lab 保存相应授权或批准具体调用。外部任务的正文和后续补充文本不能扩大该范围。
