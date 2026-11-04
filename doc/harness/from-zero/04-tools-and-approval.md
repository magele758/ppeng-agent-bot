# 04：工具、审批与结果配对

模型只提出 tool call；`packages/core/src/runtime/tool-loop.ts` 决定是否允许、是否审批、怎样执行以及怎样写回 transcript。

## 五阶段

```text
filterValidToolCalls
  → checkToolApprovals
  → executeToolCalls
  → processToolResults
  → 下一次 model turn
```

### 1. 筛选

先处理不存在的工具和 external AI gate。未知工具会得到结构化失败结果，其中包含稳定错误码、`did_you_mean` 和可用工具样例，不破坏 `toolCallId` 配对。

### 2. 审批

审批由多层共同决定：session permission mode、环境策略、仓库策略文件、工具副作用等级、lifecycle hook。需要人工确认时创建 approval record，并把 session 设为 `waiting_approval`。

### 3. 执行

`partitionForParallel` 按 `RAW_AGENT_MAX_PARALLEL_TOOLS`（未设置时 32）分块；块内 `Promise.all`，块之间串行。单个工具异常会转换成失败结果，不让整轮丢失其他工具结果。

### 4. 回流

每个结果先做敏感值脱敏和长度截断，再以 role=`tool` 的 `ToolResultPart` 落库。A2UI metadata 会额外形成 `SurfaceUpdatePart`，并可同步发出 stream chunk。

### 5. 继续循环

下一轮模型同时看到原 tool call 和配对 tool result，决定继续调用工具或返回最终文本。

## 验收问题

- 未知工具为什么不能直接从 assistant message 中删除？
- 为什么审批等待必须结束当前 dispatch？
- 并行执行时为什么仍逐个保存结果？

答案都能在 `runtime/tool-loop.ts` 找到。继续 [05 会话与压缩](05-session-and-compact.md)。
