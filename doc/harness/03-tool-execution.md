# 03 — 工具执行管线

> **设计目标**：把模型提出的 tool call 转成可审批、可审计、可配对的 tool result。工具数量和默认暴露面会随 feature flag、domain、plugin 与 MCP 配置变化。

---

## 为什么需要一条"管线"而不是直接执行？

LLM 输出的 tool_call 不能直接跑，因为：

1. **模型会幻觉工具名**——不存在的工具必须优雅降级，而不是抛异常
2. **模型可能提出有副作用的操作**——必须经过 permission mode 和审批策略
3. **工具输出可能含当前进程的敏感环境变量值**——shell-like 工具回流前需要脱敏
4. **工具可能抛异常**——异常需要变成结构化失败结果

所以我们设计了五阶段管线，每个阶段都有明确的安全职责：

```
tool_call → 筛选 → 审批 → 执行 → 处理 → 下一轮
```

---

## 五阶段详解

### 阶段 1：筛选 (filterValidToolCalls)

**做什么**：当前主要挡「不应执行的 external 工具」，**不是**未知名主路径。

| 情况 | 处理 |
|------|------|
| External AI 工具未开 (`isExternal` 且会话/env 未放行) | 立即写 `tool_result`（`TOOL_DISABLED_IN_SESSION`），不进后续执行 |
| 其它名字（含未注册） | **仍放行**进审批/执行；未知名在 `executeSingleTool` 里结构化自愈 |

**未知工具自愈**（`recovery/unknown-tool-result.ts`，在执行阶段）：

- 仍按同一 `toolCallId` 写 `ok: false` 的 `tool_result`（协议配对不破）
- `content` 为 JSON：`error_code: UNKNOWN_TOOL`、`did_you_mean`（normalize + Levenshtein，见 `find-similar-tool-name.ts`）、`available_tools_sample`（最多 20）、`hint`
- 循环不抛崩；模型下一轮可按建议改名

叠层与接线见 [16-runtime-governance](16-runtime-governance.md)。

### 阶段 2：审批 (checkToolApprovals)

五层策略叠加，**首个决策生效**：

```
Permission Mode → Env Policy → File Policy → Tool 自身 approvalMode → Idempotency
```

| 层 | 说明 | 典型场景 |
|----|------|----------|
| Permission Mode | `plan` / `ask` / `acceptEdits` / `auto` / `bypass` | 用户在 UI 选择的安全级别 |
| Env Policy | JSON array 配置 | 运维层面的全局规则 |
| File Policy | `.ppeng-policy.json` | 项目级策略（bash 模式 + 路径白名单） |
| Tool approvalMode | `'always'` / `needsApproval(ctx, input)` | 工具自己声明"我需要审批" |
| Idempotency | 同参数 + 未过期 → 复用上次审批 | 避免反复确认同一操作 |

审批是异步状态：session 转为 `waiting_approval`，外部 approve / reject API 处理后再调用 `runSession` 续跑。

### 阶段 3：执行 (executeToolCalls)

- **并行批次**：`maxParallelToolCalls`（默认 32，`RAW_AGENT_MAX_PARALLEL_TOOLS`）——模型一次可能输出多个 tool_call，按上限分块，块内 `Promise.all` 并行、块间串行
- **生命周期钩子**：`pre_tool_use` → execute → `post_tool_use`，外部脚本可拦截/注入
- **故障隔离**：单个工具超时/异常 → 该工具返回 `ok: false` + error content，**其余工具不受影响**

### 阶段 4：结果处理 (processToolResults)

| 步骤 | 作用 | 为什么需要 |
|------|------|-----------|
| 脱敏 | shell-like 工具把当前敏感 env 值替换为 `[REDACTED:NAME]` | 避免已知值回流到 transcript 与模型 |
| 截断 | 超限内容由 `truncateToolContent` 缩短 | 控制单条结果大小 |
| 落库 | 写入 session_messages | 保存的是脱敏、截断后的结果，不是工具原始 stdout |
| 扩展 | after_tool extension 回调 | 第三方可注入 system message |
| Artifact | 收集工具产出的文件/链接 | 结构化产物管理 |
| Risk | 通知 RiskEngine 工具成功/失败 | 多信号评估的输入源 |

### 阶段 5：回到下一轮

tool_result 作为新的 message 加入上下文，模型在下一轮看到结果后决定继续还是完成。

---

## 工具清单与分组

| 组 | 工具 | 默认可用？ |
|----|------|-----------|
| 文件 | `read_file`, `write_file`, `edit_file`, `glob_files`, `grep_files` | ✅ |
| Shell | `bash`, `bg_run`, `bg_check` | ✅ |
| 网络 | `web_fetch`, `web_search` | ✅ |
| 视觉 | `vision_analyze` | ✅（需 VL 模型） |
| 内存 | `memory_set`, `memory_get` | ✅ |
| 大结果 | `spill_tool_result`, `retrieve_tool_result` | ✅ |
| 任务 | `task_create/get/update/list` | ✅ |
| Skill | `load_skill` | ✅ |
| 协作 | `spawn_subagent`, `spawn_teammate`, `list_team`, `send_message`, `read_inbox` | 需 optional group |
| 产物 | `work_evidence`, `record_summary`, `harness_write_spec` | ✅ |
| 代码 | `lsp_request`, `notebook_edit` | ✅ |
| UI | `a2ui_render`, `a2ui_delete_surface` | 需 `RAW_AGENT_A2UI_ENABLED=1`（见 [19](19-surfaces-a2ui-domains.md)） |

**Optional Tool Groups**（`RAW_AGENT_OPTIONAL_TOOL_GROUPS=1`）的内置组以 `tools/optional-tool-groups.ts` 为准，当前包括 shell、network、workspace_search、subagents、external_ai、browser 与 cron。也可通过 `RAW_AGENT_OPTIONAL_TOOL_GROUPS_PATH` 提供自定义定义。

---

## 实现保证

1. **协议自愈**：未知工具 → 结构化 `did_you_mean` result，配对不破
2. **异步审批**：session 可暂停等待外部审批，支持企业级 workflow
3. **五层策略叠加**：从全局到单个工具粒度的精确控制
4. **Idempotency 复用**：同样的操作不需要反复审批
5. **脱敏在落库前**：shell-like 工具先 redact 再 truncate/persist
6. **分块并行**：`partitionForParallel`，无隐式串行分区（依赖调用顺序）

---

这些是代码契约，不等同于线上成功率。未知工具能否被模型纠正、并行能加速多少、脱敏是否覆盖全部秘密格式，都需要对应 eval 或安全测试证明。

---

## 关键文件

| 路径 | 说明 |
|------|------|
| `runtime/tool-loop.ts` | 管线主逻辑 + repetition guard |
| `tools/builtin-tools.ts` | 内置工具定义；实际暴露集合还会经过 feature / agent / optional group 过滤 |
| `tools/tool-orchestration.ts` | 截断 / 查找 / 并行分块（按 `maxParallelToolCalls`） |
| `sandbox/result-redaction.ts` | 输出脱敏 |
| `recovery/unknown-tool-result.ts` | 未知工具友好降级 |
| `approval/` | 策略加载 + permission mode + policy 执行 |
