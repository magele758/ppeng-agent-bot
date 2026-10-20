# 09：Web Console 如何接入 Runtime

Agent Lab 是 Next.js App Router 应用。它只调用 daemon API，不在浏览器或 Next 组件中运行模型循环。

## 启动整套开发环境

```bash
pnpm run dev
```

`scripts/dev-lab.mjs` 加载根 `.env`（若存在），编译后并行启动 daemon 与 Next，并自动设置代理。请打开日志打印的 Agent Lab 地址：

- 无覆盖配置时首选 Web 23000 / daemon 27070；冲突时自动后移。
- 实际地址记录在 `.agent-state/dev-lab.ports.json`，不要把首选端口当成固定契约。
- 模型服务商优先在对话区「配置模型」中保存；日常配置不要求先编辑 `.env`。

## 请求路径

```text
browser
  → Next 同源 /api/*
  → apps/web-console/middleware.ts
  → DAEMON_PROXY_TARGET
  → daemon
```

如果 Next 进程配置了与 daemon 相同的 `RAW_AGENT_AUTH_TOKEN`，middleware 在服务端补 Bearer header；浏览器无需持有 token。

## 发送消息的实现

从 `components/usePlayChat.ts` 开始读：

1. 乐观加入 user turn 和 assistant 占位；
2. 清空 composer；
3. 通过 `lib/api.ts` 发请求；
4. `lib/sse.ts` 解析 fetch response 中的 SSE；
5. `lib/stream-segments.ts` 合并 text、reasoning、tool 与 A2UI 增量；
6. `ChatTurns.tsx` 渲染最终消息。

浏览器原生 `EventSource` 只支持 GET，所以这里使用 fetch POST 加自定义 SSE parser。

## E2E

```bash
pnpm run test:e2e
```

默认模式会启动随机端口的临时 daemon 和 Next，并使用随机同源 token 验证：直连受保护 daemon 返回 401，经 Web Console 代理可访问。

继续 [10 Eval Harness](10-eval-harness.md)。
