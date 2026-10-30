# Agent Loop 模块清单与 I/O 契约参考

本文档提供 `@ppeng/agent-loop` 的 26 个分层模块矩阵及 `AssembledLoopIo` 注入端口详细定义。

---

## 1. 模块矩阵（`LOOP_MODULES`）

| 模块 ID | 最低档位 (`minPreset`) | Node 专属 (`nodeOnly`) | 加载方式 (`load`) | 职责描述 |
|:---|:---|:---|:---|:---|
| `kernel` | mini | 否 | static | L3 单轮 Turn 核心驱动（`runSessionKernel`） |
| `memory-store` | mini | 否 | static | 纯内存会话与消息状态存储（`createMemorySurfaceStore`） |
| `recovery` | mini | 否 | static | 基础故障恢复、未匹配工具调用合成补齐、AdvisoryQueue |
| `hitl` | mini | 否 | static | 人工介入门闩（HITL Latch），在执行前拦截挂起 |
| `pack` | mini | 否 | static | 基础消息装包与上下文裁剪 |
| `tool-loop` | normal | 否 | static | 默认工具调用循环驱动与重试退避 |
| `permission-mode` | normal | 否 | static | 运行时权限档位解析与鉴权策略 |
| `dirty-input-gate` | normal | 否 | static | 工具脏入参检测与阻断门禁 |
| `memory-compensation` | normal | 是 | static | 内存状态变更的逆向补偿事务支持 |
| `model-adapters` | normal | 否 | static | OpenAI Chat / Responses / Anthropic 消息适配器 |
| `auto-compact` | normal | 否 | static | 跨轮自动微压缩与超长上下文精简 |
| `working-log` | full | 是 | static | 会话工作日志 append-only 写入与状态追踪 |
| `step-tx` | full | 否 | static | 单步事务作用域保护（`createMemoryStepTx`） |
| `event-log` | full | 否 | static | 审计事件流驱动与边界闭合管理 |
| `event-log-sqlite` | full | 是 | dynamic | 基于 SQLite 的事件流持久化适配器 |
| `prepare-view` | full | 否 | static | 富上下文裁剪、滚动摘要与会话视图优化 |
| `context-appendix` | full | 否 | static | 用户侧上下文附录注入（保持 Prompt Cache 命中） |
| `run-profile` | full | 否 | static | 动态任务模式（Fast/Research 等）与工具权限画像计算 |
| `l4-agent-loop` | full | 否 | static | 具备 `step()` / `steer()` / `abort()` 的 L4 循环句柄 |
| `file-compensation` | full | 是 | dynamic | 文件系统变更的自动回滚与补偿 |
| `ptc` | max | 是 | dynamic | 代码化工具编排（Programmatic Tool Composition/vm） |
| `shell-policy` | max | 否 | static | Shell 命令执行频率与高危模式策略防护 |
| `guardian` | max | 否 | static | 超长工具返回截断、落盘与摘要预览保护 |
| `vault` | max | 是 | dynamic | 动态密钥安全解析与引用脱敏 |
| `otel` | max | 是 | dynamic | OpenTelemetry Span 遥测。Langfuse 不是这个模块，由产品宿主读 `emitTrace` 再上报 |
| `cbom` | max | 否 | dynamic | 密码学物料清单与工具签名校验 |
| `case-governance` | max | 否 | dynamic | 案例治理、衰减、归档与容量控制 |
| `dyn-tools` | max | 否 | dynamic | 运行时动态挂载与卸载工具契约 |

---

## 2. 外部 I/O 注入端口（`AssembledLoopIo`）

通过 `createAssembledLoop({ io: { ... } })` 传入：

```ts
export interface AssembledLoopIo {
  // 基础能力（模型与工具）
  model?: ModelAdapter;                                    // 核心模型适配器
  tools?: ToolContract<Record<string, unknown>>[];         // 注册的工具契约列表
  store?: TurnKernelStore;                                 // 会话状态存储（缺省为内存 Store）
  
  // 运行环境与配置
  env?: Record<string, string | undefined>;                // 环境变量
  repoRoot?: string;                                       // 仓库根路径
  stateDir?: string;                                       // 状态落盘目录
  loopConfig?: LoopConfig;                                 // 循环轮次与超时预算
  maxTurns?: number;                                       // 最大轮次限制
  maxParallelToolCalls?: number;                           // 并行工具执行上限

  // 观测与钩子
  emitTrace?: (event: TraceEvent) => void;                 // 宿主落盘。产品宿主可再镜像到 Langfuse；Jev HTTP 由宿主记为 jev_call，不在 SDK 内
  hooks?: KernelHookRegistry;                              // 轮次各阶段监听钩子
  runToolLifecycleHook?: ToolLoopHost['runLifecycleHook']; // 工具执行生命周期拦截

  // 审批与安全策略
  envApprovalPolicy?: ApprovalPolicy;                      // 工具审批策略（auto / strict / manual）
  filePolicy?: FileApprovalPolicy;                         // 文件写入/修改审批策略
  redactSecrets?: (content: string) => string;             // 每个工具结果在归档前都经过它

  // 存储与资源解析
  archiveToolResult?: (input: { sessionId: string; toolName: string; content: string }) => string;
  resolveWorkspacePath?: (context: RunContext, rel: string) => string;
}
```

另有可选宿主端口（见 `TurnKernelHost`）：`resolveTurnTools`（可 `Promise`）、`beforeModelTurn?`（主模型前软跳过）、`chooseRecovery?`（离散恢复择一）。mini 可不实现后两者。Jev 仅由产品宿主在这些端口内调用，不进入 SDK 静态依赖。

PTC 工具宿主（`createPtcExecTool` / `PtcExecToolDependencies`，max 动态模块）：可选 `resolveJevHooks?({ context, signal })` → `{ noul, choice } | undefined`。有返回值才把全局 `jev` 注入 `node:vm` 沙箱；未提供则与旧行为一致。Jev HTTP 客户端留在产品宿主（`packages/core`），不要静态带进 `@ppeng/agent-loop`。

### 媒体文件与解析端口

- `readMediaFile` 是 `model` 子路径的 Node 文件辅助 API，不是自动装配模块；不加入 mini 依赖树。
- `AssembledLoopIo.resolveMediaDataUrl(part: MediaPart, sessionId: string, signal?: AbortSignal)` 返回 `Promise<string | undefined>`（data URL / HTTPS URL）。内核绑定会话后注入 `ModelTurnInput.resolveMediaDataUrl(part, signal?)`；旧 `resolveImageDataUrl` 是图片回退。
- `ToolExecutionResult` / `ToolExecResult` / `ToolLoopResult` 支持 `media?: MediaPart[]`，旧 `images` 保留；mini 和 normal 工具执行路径都转交媒体观察。
- full/max 对带 `source` 的图片直接保留；引用图片继续遵守 `getImageAsset` 留存策略。
- `OpenAICompatibleAdapterOptions.mediaProfile` 仅声明 Chat Completions 方言：默认 `openai`，全模态使用 `qwen-omni`。能力矩阵与示例见上级 SKILL.md。
