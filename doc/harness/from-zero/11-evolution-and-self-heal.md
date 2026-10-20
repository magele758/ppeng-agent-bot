# 11：Runtime 之上的 Evolution 与 Self-Heal

这两类能力都会调用 Agent，但它们解决的是仓库级工作流，不属于单个 model/tool turn。

## Self-Heal

入口包括 `POST /api/self-heal/start` 和 `pnpm run self-heal:flow`。核心调度器在 `packages/core/src/self-heal/self-heal-scheduler.ts`：创建隔离 worktree、运行白名单测试、创建 self-healer session、重试并按配置合并。`scripts/supervisor.mjs` 负责 daemon 请求重启时的进程握手。

`self-heal:flow` 还处理主工作区 stash / pop；执行前先阅读脚本参数，确认是否允许它暂存当前改动。

## Evolution

统一 CLI 是：

```bash
pnpm run evolution --help
```

`scripts/evolution-cli.mjs` 负责解析 preset 和参数；`evolution-run-day.mjs` 负责工作树、实现 agent、build、test、review/refine 和可选 merge。高风险合并、harness gate 与 release gate 都是额外开关，不应假设默认开启。

## 编排能力的边界

| 能力 | 主要代码 | 作用 |
|---|---|---|
| Orchestrator | `packages/core/src/orchestrator/` | 按阶段推进 run / step / event |
| Swarm | `packages/core/src/swarm/` | 拆任务、启动 teammate session、检查完成与超时 |
| DeepResearch | `packages/core/src/deepresearch/` | 保存 task / source / evidence / claim |
| Self-Heal | `packages/core/src/self-heal/` | 对测试失败执行受控修复循环 |
| Evolution | `scripts/evolution*` | 从来源学习到实现、验证和可选合并 |

这些组件最终仍通过 `RawAgentRuntime.runSession` 执行具体 agent session。

## 下一步

- 回看 [Harness 实现指南](../README.md)，按专题深入。
- 阅读 [20 编排 / Evolution / Eval](../20-orchestration-evolution-eval.md) 查看 HTTP API 和端到端接线。
- 实际运行 Evolution 或 Self-Heal 前，先阅读各自专题文档和 `.env.example`，因为它们会创建 worktree，且可按配置合并或推送代码。
