# 07：执行沙箱与运行时恢复

这里有两条互相独立的安全线：工具到底在哪里执行，以及模型循环异常时何时提醒或停止。

## 执行边界

`RAW_AGENT_AGENT_SANDBOX_KIND` 选择 agent sandbox 后端：`native`、`remote_vm`、`microservice`。本机 shell 工具的隔离由模型在每次命令里选（`os` / `direct` / `remote`）；省略时用最强可用隔离。`direct` 要审批。`container` 未实现。`RAW_AGENT_SANDBOX_MODE` 只是没传当次隔离时的回退。

无论使用哪种隔离方式，启动子进程都应经过 `sanitizeSpawnEnv()` 清除 `NODE_OPTIONS`、`LD_PRELOAD`、`DYLD_INSERT_LIBRARIES` 等注入变量。工具输出回到模型前再由 `result-redaction.ts` 替换已知敏感环境变量值。

## 循环治理

| 观察范围 | 实现 | 命中后的核心行为 |
|---|---|---|
| 单次 streaming turn 的文本 / reasoning 复读 | `streaming/repetition-watchdog.ts` | 中止流；runtime 只允许一次干净重答 |
| 连续 turn 只有 reasoning 或空输出 | `streaming/reasoning-spin-watchdog.ts` | 保存已有产出并收尾，不做通用重试 |
| 多轮工具失败、同工具连调、重复工具窗口 | `recovery/session-loop-guard.ts` | 先经过 AdvisoryGrace，再决定继续或停止 |
| 多信号风险 | `recovery/risk-engine.ts` | advisory 入队，在后续轮次注入 |
| 无工具完成但目标条件未满足 | `goal/goal-gate.ts` | 软判断继续或完成 |

不要把 watchdog 和 LoopGuard 合并理解：前者包住一次 provider stream，后者观察多个 turn 的工具轨迹。

## 验证入口

```bash
node --test packages/core/test/repetition-watchdog.test.js packages/core/test/reasoning-spin-watchdog.test.js packages/core/test/session-loop-guard.test.js
```

先用 `rg --files packages/core/test | rg 'watchdog|loop-guard|sandbox|redaction'` 确认当前测试文件名。继续 [08 Daemon API](08-daemon-and-api.md)。
