# 00 — Agent Loop 的所有权与执行路径

> **一句话结论**：本仓库 **不依赖** `@openai/agents` / openai-agents-sdk-js。  
> 自建循环已抽取为 `packages/agent-loop` SDK。L5 `RawAgentRuntime` 是产品宿主，默认通过 `createAssembledLoop`（max 档）注入 I/O，再由 SDK 的 L3 `runSessionKernel` 推进 **turn → prepareTurnInput(fold) → model → tool_call ↔ tool_result → 再 turn**。

这是 Harness 文档的**主叙事起点**。后面所有切片（压缩、审批、Skills、自愈…）都是叠在这条自建循环上的层，而不是 SDK 插件。

返回 [Harness 地图](README.md) · [从零教程](from-zero/README.md) · [SDK 契约与装配指南](../../skills/agent-loop/SKILL.md)

产品默认 `kernelVariant=agent-loop`、`assemblyPreset=max`；只有显式选择 `ppeng` 才走 `packages/core/src/turn/kernel.ts` 参考路径。选择保存在 `loop_settings`，通过 Lab / `GET/PATCH /api/loop/settings` 修改。直接使用 SDK 工厂时默认档位是 mini，与产品默认不同。

---

## 1. 代码事实：SDK 还是自建？

| 检查项 | 结果 |
|--------|------|
| `packages/core/package.json` 依赖 | **无** `@openai/agents`；有 `@modelcontextprotocol/sdk`（MCP 客户端，不是 agent runner） |
| 根 / workspaces `package.json` | **无** openai-agents 相关包 |
| 模型调用 | `packages/core/src/model/model-adapters.ts` 内 `fetch(.../chat/completions)` 或 `fetch(.../responses)` |
| 主循环 | 默认 `packages/agent-loop/src/turn/kernel.ts`（`runSessionKernel`）；core `runtime.ts` 选择档位并委托 |
| 组包 | `turn/prepare-turn-input.ts`：**只在枪前** `autoCompact → claim inbox → fold → view → appendix` |
| 工具环 | `packages/core/src/runtime/tool-loop.ts`（filter → approve → execute → redact → persist）；L3 出口 `turn/tool-dispatch.ts` |
| 停止语义 | 自有 `ModelTurnResult.stopReason`；`truncated` / `finishReason` 经 `turn/turn-recovery.ts` **改控制流** |
| 历史真源 | `session_messages` 是只追加 WAL；发给模型的数组 = `fold(surface)`，不是 `listMessages().slice(-N)` |

MCP SDK 用于接入外部工具。可选 `claude_code` / `codex_exec` / `cursor_agent` 也是 ToolContract，仍通过本项目的 tool-loop 执行。

---

## 2. 所有权边界

从当前代码能确认的是实现边界，而不是当初没有记录下来的选型过程：

| 能力 | 本仓库中的所有者 |
|---|---|
| Session WAL + surface | `SessionStore`（`append` / `replace` / `hide` / `foldMessages`） |
| 枪前组包 | `prepareTurnInput`（唯一缝；adapter 禁止自己 `listMessages`） |
| Step inbox（插话） | SDK `session/step-inbox.ts`、`steer-drain.ts`、`steer-interrupt.ts`；产品提供 `POST /api/sessions/:id/steer` |
| Turn 上限、停止与取消 | `RawAgentRuntime` + `AgentLoopHandle` |
| 工具筛选、审批与配对 | `runtime/tool-loop.ts` |
| 协议转换与 streaming | `ModelAdapter` 实现 |
| Compact | `session/auto-compact.ts`：fold token 阈值 + 闭区间 `appendReplacement` |
| 协议恢复 | `runtime/turn-recovery.ts` |

如果未来引入第三方 runner，这些状态机仍需要明确由谁拥有，不能同时推进同一 session。

---

## 3. 自建循环如何工作

```
POST 消息 / runSession(sessionId)  或  createAgentLoop(sessionId).step()
        │
        ▼
┌──────────────── 同一 step 内核 ────────────────┐
│  claim next-run inbox（run 开头一次）            │
│  for turn in 0 .. maxTurnsPerRun                 │
│    prepareTurnInput:                             │
│      autoCompact → claim next-step → fold        │
│      → 视图像 / 拒答 / micro-compact → appendix   │
│    yield turn_prepared                           │
│    ModelAdapter.runTurn(fold 数组, tools)        │
│    turn-recovery(stopReason / finishReason)      │
│         │                                        │
│         ├─ retry-after-nudge / retry-same-input  │
│         │     → 不把 truncated 当 end            │
│         ├─ stopReason === 'tool_use'             │
│         │     → tool-loop；yield tools_done      │
│         │     → waiting_approval 则退出 dispatch │
│         │                                        │
│         └─ end → hooks / goal gate / idle|done   │
│  yield ended                                     │
└──────────────────────────────────────────────────┘
```

### 3.1 WAL + fold（真源）

- `session_messages` **只追加**。`id` 仍是行主键；单调 `seq` 是 surface 顺序。
- `append`：新可见节点。`replace {startSeq,endSeq}`：阴影该区间并挂一条新可见节点。`hide`：关可见性，不删 WAL。
- **发给模型的唯一入口**是 `store.foldMessages(sessionId)`（经 `prepareTurnInput`）。`listMessages` 只给审计 / UI。
- Compact 后 WAL 条数不少；fold token 下降。打开的 tool 波次禁止 replace。

### 3.2 组包只在枪前

`prepareTurnInput(sessionId)` 是组包边界。`ModelAdapter.runTurn` 接收准备好的数组，不原地修改已经发出的 HTTP 请求。插话何时生效取决于消费策略与中断策略：`steerInterruptPolicy` 区分 `queue / steer / disabled`，`steerDrainPolicy` 区分 `next_shot_only / tool_launch`；不要把全部行为概括成“等 response_done 后下一枪”。具体优先级见 SDK `session/steer-interrupt.ts` 与 `steer-drain.ts`。

同 `key` 两次 steer：后写覆盖，fold 只见后者。Lab 可打开 inbox overflow（`inboxOverflowCap`，默认关/无限）：unclaimed 超过上限时把最旧合成一条 system inbox（确定性拼接，不改飞行中 HTTP）。

### 3.3 truncated 会改控制流

`truncated` / `finish_reason=length` **不得当 end**。无 tool 则续写 nudge（最多 2 次）；残缺 `tool_call` 不执行、重打。`tool_use` 但 `tool_calls` 空视为协议错误。用户 abort 仍是 `failed`/`idle`，与协议 retry 分开。

### 3.4 SDK step 级控制

```ts
const loop = runtime.createAgentLoop(sessionId);
for await (const ev of loop) { /* turn_prepared | model_done | tools_done | … */ }
await loop.step();   // 每枪边界交还控制权
await loop.steer('insert for next shot');
await loop.fold();   // 只读当前 fold 视图
```

Lab/HTTP 继续 `runSession`；两者走同一内核。不要为 SDK 加 `RAW_AGENT_*`。

### 3.5 tool_call ↔ tool_result 配对

- 模型产出 `ToolCallPart`（含 `toolCallId`）。
- tool-loop 最终必须为**每一个** call 写回成功或失败结果。等待审批时当前 dispatch 先退出；批准后再 `runSession` 会先 claim inbox 再 fold，配对不变量仍成立。
- 未知工具名：**不抛崩循环**，结构化错误进 result。

### 3.6 停止条件（控制面）

| 条件 | 行为 |
|------|------|
| recovery `end` | 本轮无工具且非截断；走完成路径 |
| `stopReason === 'tool_use'` | 执行工具后继续 turn |
| `signal.aborted`（stop API） | session → `failed` |
| `maxTurnsPerRun` 用尽 | → `idle`，可续跑 |
| `waiting_approval` | **退出**本次 dispatch，审批后再 `runSession` |
| LoopGuard critical 第二次 | terminate（不是无限 advisory） |

---

## 4. 关键代码入口

| 层级 | 路径 | 符号 / 说明 |
|------|------|-------------|
| 产品宿主 | `packages/core/src/runtime.ts` | `RawAgentRuntime.runSession`：内核选择与并发控制 |
| 装配接线 | `packages/core/src/runtime/l5-bindings.ts` | `l5ToAssembledIo`：产品 I/O 注入 SDK |
| 默认循环 | `packages/agent-loop/src/turn/kernel.ts` | `runSessionKernel`；档位在 SDK `assembly/` 组装 |
| 枪前组包 | `turn/prepare-turn-input.ts` | `prepareTurnInput`（旧路径 `runtime/` 再导出） |
| Step 内核 | `runtime/agent-loop.ts` | `AgentLoopHandle.step` / async iterator / `steer`；`@ppeng/agent-core/loop` |
| 协议恢复 | `turn/turn-recovery.ts` | `decideTurnRecovery` |
| Compact | `session/auto-compact.ts` | `runAutoCompact` + range replace |
| Surface | `session/surface-invariants.ts` + `stores/session-store.ts` | `foldMessages` |
| Inbox | `session/step-inbox.ts` | `enqueue` / `claim` |
| 工具环 | `runtime/tool-loop.ts` | 审批、并行、脱敏、落库 |
| 模型适配 | `model/model-adapters.ts` | `fetch` → chat 或 `/responses` |
| HTTP | `apps/daemon/src/routes/sessions.ts` | `/run` `/stream` `/steer`；不含 turn loop |

---

## 5. 快速核验

不要靠文档标题判断依赖关系。运行 `rg '"@openai/agents"' --glob package.json` 核对依赖。先确认宿主默认分支，再追 SDK 组包中的 fold：

```
rg -n 'kernelVariant|assemblyPreset|createAssembledLoop' packages/core/src/runtime.ts
rg -n 'foldMessages|prepareTurnInput' packages/agent-loop/src/turn/prepare-turn-input.ts
```

内核单测（优先于再加 e2e）：

- SDK：`pnpm run test --workspace=@ppeng/agent-loop`；构建：`pnpm run build --workspace=@ppeng/agent-loop`。
- 以下 core 测试用于产品侧回归，不代替 SDK 的 Vitest 测试：
- `packages/core/test/session-surface.test.js`
- `packages/core/test/prepare-turn-input.test.js`
- `packages/core/test/turn-recovery.test.js`
- `packages/core/test/auto-compact-replace.test.js`

---

## 6. 接下来读什么

| 目的 | 文档 |
|------|------|
| 按实现顺序学（from-zero） | [`from-zero/README.md`](from-zero/README.md)（第 2 章即本循环展开） |
| HTTP→循环→SSE | [01-request-lifecycle](01-request-lifecycle.md) |
| 工具管线细节 | [03-tool-execution](03-tool-execution.md) |
| **运行时治理叠层**（watchdog / LoopGuard / Risk / Goal / turn_end） | [16-runtime-governance](16-runtime-governance.md) |
| 多模型/usage | [09-model-adapters](09-model-adapters.md) |

返回总纲：[`README.md`](README.md)。
