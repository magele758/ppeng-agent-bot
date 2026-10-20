# 08：跑通 Daemon HTTP / SSE

daemon 用 Node `http` 和自定义 `Router` 暴露 core runtime。路由只负责协议转换，不复制 agent loop。

## 启动

```bash
pnpm run dev:daemon
```

该命令先编译 `packages/core` 和 `apps/daemon`，再启动 `apps/daemon/dist/server.js`。监听地址以启动日志为准。下面 curl 示例假设地址为 `http://127.0.0.1:37070`，请替换为你的实际地址；若用 `pnpm run dev` 启动整套环境，也可查看 `.agent-state/dev-lab.ports.json`。

## 不调用模型的最小验证

```bash
curl -s http://127.0.0.1:37070/api/health

curl -s -X POST http://127.0.0.1:37070/api/sessions \
  -H 'content-type: application/json' \
  -d '{"mode":"chat","title":"from-zero","autoRun":false}'
```

记下响应中的 `session.id`，追加一条消息但不运行：

```bash
curl -s -X POST http://127.0.0.1:37070/api/sessions/SESSION_ID/messages \
  -H 'content-type: application/json' \
  -d '{"message":"hello","autoRun":false}'
```

把 `SESSION_ID` 换成真实值。

## Streaming

`POST /api/sessions/:id/stream` 可同时接收可选 message 并运行 session。SSE event 名为：

- `model`：一个 `ModelStreamChunk`；
- `result`：最终 session 和 latest assistant；
- `error`：运行异常信息。

`POST /api/chat/stream` 是自动创建或复用 session 的便捷入口。

## 鉴权

设置 `RAW_AGENT_AUTH_TOKEN` 后，除 `/api/health`、`/api/readiness`、`/api/version` 外的 `/api/*` 都要求：

```text
Authorization: Bearer <token>
```

具体豁免以 `apps/daemon/src/auth.ts` 的 `PUBLIC_PATHS` 为准。继续 [09 Web Console](09-web-console.md)。
