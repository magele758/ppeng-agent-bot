# 10：Agent Eval Harness

当前 `scripts/agent-eval/runner.mjs` 是 HTTP 合约回归器，不是基于真实 LLM 的主观质量评判器。

## 它实际做什么

1. 要求 `apps/daemon/dist/server.js` 已存在。
2. 创建临时 state 目录和随机本地端口。
3. 使用 `envForEphemeralDaemon()` 清理宿主鉴权等干扰项。
4. 设置 `RAW_AGENT_E2E_ISOLATE=1`，daemon 强制使用 heuristic adapter。
5. 读取 `scripts/agent-eval/cases/<mode>/*.json`，依次发送 HTTP 请求。
6. 结束后关闭 daemon、删除临时 state，并把结果追加到 `doc/eval-results/YYYY-MM-DD.jsonl`。

## 运行

```bash
pnpm run build
pnpm run agent:eval:fast
node scripts/agent-eval/runner.mjs --case session-create
node scripts/agent-eval/runner.mjs --mode fast --exit-on-fail
```

## 退出码语义

- 默认 print-only 模式：case 失败后仍退出 0，便于收集结果。
- 带 `--exit-on-fail`：存在失败或 daemon 未正常启动时退出 1。
- dist 不存在时退出 2；找不到 case 时退出 1。

因此 CI 和合并门必须显式使用 `--exit-on-fail`。`pnpm run agent:eval:fast` 本身没有附带该参数。

## Case 能表达什么

当前 JSON schema 支持 method、path、期望状态码、顶层字段存在、字段是否为数组、请求 body，以及通过 `:newSession` 创建临时 session。它不能表达复杂 JSONPath、跨 case 依赖、模型质量 judge 或工具序列断言。

fast case 数量会变化，不在文档中手写固定数字；以 `scripts/agent-eval/cases/fast/` 为准。

继续 [11 Evolution / Self-Heal](11-evolution-and-self-heal.md)。
