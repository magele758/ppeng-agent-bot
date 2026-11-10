# Prompt Cache 设计文档

本文档说明 Raw Agent SDK 如何组织 prompt 上下文以最大化 provider 侧 KV cache 的命中率，并记录相关实现细节、provider 支持矩阵和观测方法。

## 1. 核心原则：稳定前缀 + 动态后缀

Provider（Anthropic、OpenAI 等）的 prompt cache 机制依赖请求前缀的字节稳定性。同一会话的连续请求，如果 system prompt 前面几千字符完全相同，provider 可以直接复用已缓存的 KV 状态，显著降低首 token 延迟和计费 token 数。

**策略**：把 system prompt 分为两段，用 `\n\n---\n\n` 分隔：

```
[稳定前缀]               ← 跨轮不变，provider 可缓存
---
[动态上下文]             ← 每轮更新，变化集中在后部
```

### 稳定前缀包含（`buildStableSystemPrefix`）

- Agent 身份：`You are <name> (<role>).`
- `agent.instructions`（静态文本）
- `Repository root` / `Workspace root`（会话内不变）
- `Conversation mode`（会话创建时确定）
- 固定规则说明（5 条操作准则）
- Harness 角色描述（由 `agent.harnessRole` 决定，会话内不变）

**禁止放入稳定前缀**：时间戳、运行态状态、顺序不稳定的枚举、summary、todos、memory。

### 动态上下文包含（`buildDynamicContextBlock`）

- `Task`：当前任务 ID / 标题 / 状态 / 阻塞关系
- `Todos`：当前 todo 列表 JSON
- `Compressed summary`：compaction 后的滚动摘要（仅在有摘要时出现）
- `Handoff scratch`：scratch scope 的 session_memory（上限 20 条）
- `Long-term memory`：long scope 的 session_memory（上限 20 条）
- Skill routing shortlist（基于当前用户消息动态计算）

### Chat Completions 请求里动态上下文的位置

按请求开头做缓存的服务（OpenAI 兼容的 Chat Completions）只复用完全相同的开头。动态上下文和运行时通知（会话里的 `system` 消息）如果留在开头那条 system 消息里，每来一条新用户消息，整段历史都要重新计费、重新读一遍。

调用方传了 `cacheStablePrefix`，并且请求里有用户消息时，Chat Completions 的排布是：

```
system:  [稳定前缀] --- [一句固定说明：每轮上下文在最新用户消息最前面的 <runtime_context> 里，出自运行时]
...更早的对话，逐字节不变...
user:    <runtime_context>[动态上下文][运行时通知]</runtime_context>  [记忆附录]  [用户原文]
```

模型收到的内容不变，只是位置变了。没有 `cacheStablePrefix`、它不是系统提示的开头、或请求里没有用户消息时，仍然全部放在开头的 system 消息里。Anthropic 和 Responses 请求不受影响。

可复用的开头到上一条用户消息之前为止：记忆附录、工作日志、来源清单和时钟提示仍挂在最新用户消息上，下一轮它们会移到新的用户消息。工具清单变化（例如目标执行期间多出的工具）是否影响命中取决于服务方把工具定义排在哪里。

## 2. Summary 单一注入原则

**问题**：原实现中 `session.summary` 同时出现在：
1. `buildSystemPrompt()` 的 `summaryLine`
2. `visibleMessages()` 注入的合成 `role: system` 消息

这导致 summary 被 OpenAI 适配器见到两次，并且合成 system 消息出现在消息数组开头，改变了历史消息的相对位置，破坏缓存前缀。

**修复**：
- `visibleMessages()` 不再注入合成 `system` 消息，只返回最近 24 条原始消息。
- Summary 仅出现在动态上下文块（`buildDynamicContextBlock` 中的 `summaryLine`）。
- `autoCompact` 逻辑不变：归档旧消息、合并 summary、写入 `session.summary`。

## 3. 消息数组稳定性

### Contact Sheet 注入位置

热图 contact sheet（`session.metadata.imageWarmContactAssetId`）原来以前置 `user` 消息注入到消息数组开头，导致所有历史消息索引 +1，即使 contact sheet 未变化也会破坏缓存。

**修复**：contact sheet 注入到消息数组尾部，位于最后一条 `user` 消息之前：

```
旧：[SHEET, msg1, msg2, ..., user_current]
新：[msg1, msg2, ..., SHEET, user_current]
```

如果消息数组只有一条用户消息，则 contact sheet 追加到末尾。

### Cold Image 替换

cold（已归档）图片 asset 替换为文本占位符 `[archived image <id>]`，固定模板，不随时间变化。

## 4. Tool Payload 稳定性

### 工具定义排序

`toolDefinitions()` 在生成 tool schema 数组前按工具名称字母序排序：

```typescript
[...tools].sort((a, b) => a.name.localeCompare(b.name))
```

同一工具集下，多轮请求的 tools payload 字节稳定。`ensureMcpTools` 动态添加的 `mcp_invoke` 工具在下次生成时也会按名称插入到正确位置。

### Canonical JSON 序列化

工具调用参数（`tool_call.function.arguments`）使用 canonical JSON（**每一层**普通对象的键按字典序排序，嵌套对象与数组内的对象同样递归处理）替代裸 `JSON.stringify`：

```typescript
function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (!isPlainObject(value)) return value;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj).sort().reduce((acc, key) => {
    acc[key] = canonicalize(obj[key]);
    return acc;
  }, {} as Record<string, unknown>);
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
```

相同语义的参数对象，无论各层键的插入顺序如何，都产生相同的字符串。这对 tool result 与 history replay 的缓存一致性尤为重要。

**注意**：Anthropic 适配器的 `tool_use` 消息中 `input` 字段是对象，不经过 canonical JSON；上述修复仅作用于 OpenAI 兼容路径的 `arguments` 字符串字段。

## 5. Provider 支持矩阵

| Provider | 缓存机制 | 实现方式 | 说明 |
|----------|----------|----------|------|
| Anthropic API | `cache_control: { type: "ephemeral" }` | `system` 字段从字符串改为 content 块数组，最后一块加 `cache_control` | 需 `anthropic-version: 2023-06-01` 及以上；有最小 1024 token 缓存阈值 |
| OpenAI（官方） | 自动缓存（≥ 1024 tokens） | 无需额外字段；确保稳定前缀足够长即可 | 不支持显式标记；Responses API 支持 `input_tokens.cached_tokens` 统计 |
| OpenRouter（Anthropic 路由） | 同 Anthropic | 本项目当前未对 OpenRouter 路径额外处理；可手动通过 proxy 层注入 | 参考 `openclaw` 的 `proxy-stream-wrappers.ts` 模式 |
| 其他 openai-compatible | 不保证支持 | 无注入；稳定前缀仍有助于 provider 侧任何自动缓存 | 若 provider 不支持，只影响缓存效率，不影响正确性 |

## 6. 观测方法

### Stable Prefix Hash

每轮 `turn_start` trace 事件的 `payload` 中写入 `stablePrefixHash`（SHA-256 取前 16 位 hex）：

```json
{
  "kind": "turn_start",
  "payload": {
    "turn": 1,
    "adapter": "openai-compatible",
    "stablePrefixHash": "a3f1c2d09e7b4581"
  }
}
```

同一会话内连续两轮的 `stablePrefixHash` 相同，说明稳定前缀未发生变化，provider 有机会命中缓存。

读取 trace 事件：
```typescript
import { readSessionTraceEvents } from './read-traces.js';
const events = await readSessionTraceEvents(stateDir, sessionId);
const hashes = events
  .filter(e => e.kind === 'turn_start')
  .map(e => e.payload.stablePrefixHash);
```

### Anthropic Cache 命中统计

Anthropic API 响应中的 `usage` 字段包含 `cache_read_input_tokens` 和 `cache_creation_input_tokens`。目前 SDK 不自动上报，但可在 adapter 层的响应处理中提取并写入 trace。

### 验证 Summary 无双写

检查某轮请求的 `messages` 数组中是否有 `role: system` 的合成摘要消息：

```js
const syntheticSummary = messages.find(
  m => m.role === 'system' && m.parts.some(p => p.text?.includes('Compressed summary'))
);
assert.ok(!syntheticSummary, 'summary must not appear as synthetic system message');
```

## 7. 已知限制与后续演进

### 当前限制

- **Skill routing 变化**：每轮基于最后一条 user 消息计算 skill shortlist，不同用户消息产生不同的动态上下文。稳定前缀命中，但动态后缀每轮变化。
- **Memory 上限**：每个 scope 最多注入 20 条 memory，超出部分静默截断。暂无优先级排序。
- **Anthropic `cache_control` 仅放在系统块**：未对 tools 数组加 `cache_control`，Anthropic 文档建议 tools 也可加。后续可扩展。
- **OpenRouter 路径**：暂未为 OpenRouter Anthropic 路由添加 proxy-level `cache_control` 注入（参考 openclaw 模式）。

### 后续 Phase

1. **Memory retrieval-only**：将 session_memory 从全量注入改为向量检索后选取 top-K 相关条目，减少动态上下文体积。
2. **Tools cache_control**：对 Anthropic 路径的 tools 数组也加 `cache_control`，参考 Anthropic 文档的 tools cache 模式。
3. **Skill routing 稳定化**：当 skill shortlist 与上一轮相同时，跳过重新路由，进一步减少动态上下文变化。
4. **Cache 命中率指标**：在 trace 中记录 Anthropic 返回的 `cache_read_input_tokens`，供 `/api/evolution/overview` 等 API 上报。
