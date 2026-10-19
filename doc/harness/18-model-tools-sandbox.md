# 18 — 模型适配 · 工具面 · 沙箱安全（纵向切片 C）

> **定位**：把「模型边 + 工具边 + 执行隔离」串成一条可运维路径。  
> **前置**：[`00-self-built-agent-loop`](00-self-built-agent-loop.md)；循环骨架见 [`01`](01-request-lifecycle.md)。  
> **与已有章关系**：[`09`](09-model-adapters.md) / [`03`](03-tool-execution.md) / [`12`](12-sandbox-and-execution.md) / [`07`](07-skills-and-routing.md) 是专题参考；本章只负责把模型请求、工具暴露和执行隔离串成一条运维路径。默认值仍以对应源码为准。

---

## 1. 模型适配：chat / responses / hybrid-router

### 1.1 Adapter 树（runtime 只看统一接口）

```
ModelAdapter
├─ OpenAICompatibleAdapter   ← RAW_AGENT_MODEL_PROVIDER=openai-compatible
│    httpKind: chat_completions | responses
├─ AnthropicCompatibleAdapter
├─ HybridModelRouterAdapter  ← 配置了 RAW_AGENT_VL_MODEL_NAME 时包装 text+VL
└─ HeuristicModelAdapter     ← 测试 / 无 key
```

工厂：`createModelAdapterFromEnv`（`packages/core/src/model/model-adapters.ts`）。

### 1.2 Chat vs Responses（不是靠 URL 后缀猜）

| 项 | Chat Completions | Responses API |
|----|------------------|---------------|
| Env | `RAW_AGENT_OPENAI_HTTP_KIND` 缺省 / `chat_completions` | `=responses`（或 `response`） |
| Endpoint | `{base}/chat/completions` | `{base}/responses` |
| 流式 usage | `stream_options.include_usage` | 协议自带 usage 字段 |
| JSON mode | 可挂 `response_format`（见下） | **不**挂 `response_format`；摘要走纯文本 |

VL 可单独覆盖：`RAW_AGENT_VL_OPENAI_HTTP_KIND`（未设则继承主 adapter 的 kind）。

> **纠正**：旧文档写「URL 含 `/responses` 自动检测」——**当前实现以 env `RAW_AGENT_OPENAI_HTTP_KIND` 为准**，不是扫 path。

### 1.3 Hybrid Router（VL）

启用条件：`RAW_AGENT_VL_MODEL_NAME` 非空。

| Env | 作用 |
|-----|------|
| `RAW_AGENT_VL_MODEL_NAME` | VL 模型名（必填才启用 hybrid） |
| `RAW_AGENT_VL_BASE_URL` / `RAW_AGENT_VL_API_KEY` | 可选；缺省回落主 `BASE_URL` / `API_KEY` |
| `RAW_AGENT_VL_ROUTE_SCOPE` | `any`（默认：历史任意消息含 `ImagePart` 即走 VL）/ `last_user`（仅看最近 user） |
| `RAW_AGENT_VL_USE_JSON_MODE` | VL 侧 JSON mode，默认偏关（`0`） |

路由逻辑：`HybridModelRouterAdapter.needsVl` —— 含 `type: 'image'` 的 part 则委托 VL adapter，否则走 text。  
`vision_analyze` 工具另走 `runOpenAiVisionTurn`（同一套 VL 凭证），不经过 turn 路由。

### 1.4 `RAW_AGENT_USE_JSON_MODE`

| 值 | 行为 |
|----|------|
| 默认（未设或非 `0/false/off`） | Chat Completions 请求可带 `response_format: json_object`（用于 `completeText` / 部分摘要路径） |
| `=0` / `false` / `off` | 关闭——**第三方网关不支持 `response_format` 时必关**，否则 4xx |

Responses kind 下即使开关打开也不会挂 `response_format`（协议差异）。

---

## 2. 用量 / 截断 / 成本 / 上游 request-id（纯观测）

> **硬约束**：下列字段**不改循环控制**。截断轮仍可 `stopReason: 'end'`；不会因 `truncated` 强制 continue 或 abort。

### 2.1 `TokenUsage` / `finishReason` / `truncated`

归一化：`packages/core/src/model/usage.ts`

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  cachedInputTokens?: number;
}
```

| 来源 | 函数 | 要点 |
|------|------|------|
| OpenAI chat | `normalizeOpenAiUsage` | `prompt_tokens` / `completion_tokens`；cache → `prompt_tokens_details.cached_tokens` |
| OpenAI responses | 同上 | `input_tokens` / `output_tokens`；cache → `input_tokens_details` |
| Anthropic | `normalizeAnthropicUsage` | `cache_read_input_tokens` 折入 `inputTokens`，并暴露 `cachedInputTokens` |

`isTruncatedFinish(finishReason)` 识别 `'length'` / `'max_tokens'` / `'max_output_tokens'` / `'incomplete'` 等 → `ModelTurnResult.truncated`。

### 2.2 Trace 与会话累计

| 落点 | 内容 |
|------|------|
| `turn_end` | `usage`、`finishReason`、`truncated?`、`requestId?`、`costUsd?`、`stableSystemVersion` |
| `turn_truncated` | 截断时**额外**一条（`finishReason` + 可选 `outputTokens`）——避免和「干净结束」混读 |
| `session.metadata.usageTotals` | `mergeUsage` 跨轮累计 |
| `session.metadata.usageCostUsd` | 累计 USD 估算 |

累计 prompt 怪癖：网关若报「会话 running total」，runtime 用 `splitCumulativePromptTokens` 拆成**本轮份额**后再进 totals / 成本（见 [`09`](09-model-adapters.md)）。

### 2.3 Token → USD

`estimateUsageCostUsd`（`model/token-cost.ts`）→ 写入 `turn_end.costUsd`。  
定价：内置粗表 → 最长子串匹配 → `default`；可用 `RAW_AGENT_TOKEN_PRICE_JSON` 覆盖。非账单权威，仅观测。

### 2.4 Upstream request-id

`packages/core/src/model/upstream-request-id.ts`（纯函数，可单测）：

1. Header（先命中先得）：`x-request-id` / `openai-request-id` / `x-openai-request-id` / `x-maas-request-id`
2. JSON / SSE body：`request_id`，其次 `id`
3. 嵌套 error 字符串：网关常把上游 JSON 塞进 `error` 字符串 → `unwrapNestedUpstreamError` 最多剥 4 层

结果进 `ModelTurnResult.requestId` → `turn_end` 透传，便于和供应商工单对账。

---

## 3. Optional Tool Groups

实现：`packages/core/src/tools/optional-tool-groups.ts`。

| Env | 作用 |
|-----|------|
| `RAW_AGENT_OPTIONAL_TOOL_GROUPS=1` | **总开关**；关则组内工具按「非 optional」路径暴露（与旧行为兼容） |
| `RAW_AGENT_OPTIONAL_TOOL_GROUPS_PATH` | 可选 JSON `{ groups: [...] }` 覆盖默认分组 |
| `RAW_AGENT_DEFAULT_ENABLED_OPTIONAL_GROUPS` | CSV 服务端默认启用组，如 `shell,network` |

解析顺序：

```
serverDefaults (env CSV)
  ∪ session.enabledOptionalToolGroups（客户端/会话）
  → resolveOptionalToolGroups
  → filterToolsByOptionalGroups
```

默认组（节选）：`shell`（bash/bg_*）、`network`、`workspace_search`、`subagents`、`external_ai`、`browser`、`cron`。  
未启用的 optional 工具名对模型**不可见**（从 turnTools 滤掉），不是执行时再拒。

---

## 4. External AI Tools

实现：`packages/core/src/tools/external-ai-tools.ts`；说明见 `doc/EXTERNAL_AI_CLI.md`。

| 条件 | 说明 |
|------|------|
| `RAW_AGENT_EXTERNAL_AI_TOOLS=1` | 挂载工具定义 |
| 会话 `allowExternalAiTools` | 运行时二次门控（与 filter 阶段配合） |
| optional group `external_ai` | 若开了 optional groups，还需启用该组 |
| PATH 上有 CLI | `claude` / `codex` / `agent`（Cursor Agent CLI，不是编辑器 `cursor`） |

| 工具 | 命令形态 | 审批 |
|------|----------|------|
| `claude_code` | `claude -p <prompt>` | **始终** `needsApproval` |
| `codex_exec` | `codex exec [--full-auto\|--sandbox workspace-write] <prompt>` | 始终审批 |
| `cursor_agent` | `agent --print --model <m> <prompt>`；模型默认 `composer-2-fast`，可被 `RAW_AGENT_CURSOR_AGENT_MODEL` / `EVOLUTION_CURSOR_AGENT_MODEL` 覆盖 | 始终审批 |

Spawn 一律 `sanitizeSpawnEnv()`（Tier 0）；无 shell 拼接，prompt 只作 argv。仓库**未**集成 opencode。

---

## 5. 图片：ImagePart · ingest · contact sheet · warm

### 5.1 消息模型

`ImagePart`：`{ type: 'image', assetId, mimeType, …, retentionTier? }`。  
资产表 `ImageAssetRecord`：`hot | warm | cold`；`kind: 'original' | 'contact_sheet'`。文件落在 `stateDir/images/`。

### 5.2 Ingest API（daemon）

| 路由 | 作用 |
|------|------|
| `POST /api/sessions/:id/images/ingest-base64` | base64 → sha256 去重 → hot 原图 |
| `POST /api/sessions/:id/images/fetch-url` | URL 拉取（`RAW_AGENT_IMAGE_MAX_BYTES` / `RAW_AGENT_IMAGE_FETCH_TIMEOUT_MS`） |

服务：`ImageIngestService`（`services/image-ingest-service.ts`）→ `image-assets.ts`。

发消息时可带 `imageAssetIds`，runtime 拼进 user parts。

### 5.3 Retention / contact sheet / warm 注入

热图超过 `RAW_AGENT_IMAGE_HOT_LIMIT`（默认 3）→ `maintainImageRetention`：

1. 可选 LLM 选 keyframe（`RAW_AGENT_IMAGE_KEYFRAME_MODEL`）
2. 用 `sharp` 拼 contact sheet（网格 `RAW_AGENT_IMAGE_CONTACT_SHEET_GRID`）
3. 旧原图标 cold；contact sheet 为 warm
4. `session.metadata.imageWarmContactAssetId` + 可选 system note

**送模形状**：runtime 把 warm contact sheet **append 在最近 user 消息之前**（不 prepend 到整段历史），避免破坏 prompt-cache 前缀；文案类似 “Earlier screenshots (contact sheet…)”。

相关 env：`RAW_AGENT_IMAGE_WARM_KEYFRAME_LIMIT`、`RAW_AGENT_IMAGE_RETENTION_DAYS`。无 `sharp` 时降级跳过 sheet 生成。

---

## 6. Sandbox：两正交旋钮 + Tier 0/1

> **易混**：`RAW_AGENT_AGENT_SANDBOX_KIND`（native / remote_vm / microservice —— **agent 执行后端**）与 `RAW_AGENT_SANDBOX_MODE`（**Native 上 OS 隔离策略**）正交。本章聚焦后者 + 脱敏。

### 6.1 Tier 0 — `sanitizeSpawnEnv`

`packages/core/src/sandbox/env-sanitizer.ts`。**所有** `spawn`（bash、external AI、自愈子进程等）应走此函数。

剥离（节选）：

- 注入：`LD_PRELOAD`、`LD_LIBRARY_PATH`、`DYLD_INSERT_LIBRARIES`、`NODE_OPTIONS`、`PYTHONPATH` / `PYTHONSTARTUP`、`JAVA_TOOL_OPTIONS`、`BASH_ENV`、`ENV`、`IFS`、`PROMPT_COMMAND`、`BASH_FUNC_*` …
- 可选 `stripCredentials: true`：再剥 `AWS_SECRET_*`、`GITHUB_TOKEN`、`NPM_TOKEN` 等
- `SandboxManager` 对工具子进程默认打开这项。匹配 `RAW_AGENT_` 且以 `_API_KEY` / `_TOKEN` / `_SECRET` / `_PASSWORD` / `_BEARER` 等结尾的名字会去掉，包括 `RAW_AGENT_API_KEY`、`RAW_AGENT_AUTH_TOKEN`、`RAW_AGENT_FEISHU_APP_SECRET`

这些 `RAW_AGENT_*` 密钥**没有**代码白名单。模型、VL、embedding、飞书、OAuth、daemon 鉴权都在宿主进程读 `process.env`，不经过 bash。自愈子进程走 `enrichSpawnEnv`，默认不剥凭证。把密钥加回 bash 环境会让 `printenv` 进会话。`RAW_AGENT_BASE_URL`、`RAW_AGENT_MODEL_NAME`、`*_TOKENS`、`TOKEN_BUDGET`、`TOKEN_PRICE_JSON` 不是密钥，会留下。`GH_TOKEN` / `NPM_TOKEN` / `GITHUB_TOKEN` 仍按原精确名单剥掉；`gh` / `git` 用磁盘上的凭证助手，不靠这些环境变量。

Tier 0 **不**限制文件系统/网络——那是 Tier 1。

### 6.2 Tier 1 — `SandboxManager`

`packages/core/src/sandbox/os-sandbox.ts`。`bash` / `bg_run` / `work_evidence` 每次调用都可以带 `isolation`：`os`（本机 seatbelt / bwrap）、`direct`（只做环境消毒，必须先审批，未批准不执行）、`remote`（已接通的远程电脑；没接通则本次不执行，不退回本机）。省略时用本机当前最强可用隔离，不需要人先设模式。`container` 未实现，传了也不会跑，更不会悄悄当成 direct。

`RAW_AGENT_SANDBOX_MODE` 只给没传当次隔离的旧调用做回退，不是模型要用某种隔离的前提。

| `RAW_AGENT_SANDBOX_MODE`（仅回退） | 行为 |
|-------------------------|------|
| `auto`（默认） | 有则用 macOS `sandbox-exec` 或 Linux `bwrap`；否则 Direct（仅 Tier 0） |
| `os` | 强制尝试 OS 沙箱；不可用则仍降级 Direct |
| `direct` | 仅 Tier 0 |
| `container` | 预留 Tier 2（当前同 Direct；模型侧不可选） |

**macOS seatbelt**：deny `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker` 读写；显式 allow workspace。未传 `allowNetwork: true` 时 `(deny network*)`。  
**Linux bwrap**：namespace 隔离同类敏感路径；未传 `allowNetwork: true` 时 `--unshare-net`。  
`bash`、`bg_run`、`work_evidence` 显式传 `allowNetwork: true`，auto 模式下 `curl`、`npm install`、`git fetch`、`gh` 保持能联网。其它调用点不传就是断网。remote_vm 与 microservice 同样只有显式 `true` 才在请求体里放行。  
不可用 → **fail-open 降级 Tier 0**（不阻塞本地开发；Direct 没有网络命名空间，命令仍能出网）。

### 6.3 Result redaction（回流脱敏）

> **纠正**：[`12`](12-sandbox-and-execution.md) / [`03`](03-tool-execution.md) 里「AKIA… / ghp_… 正则替换」**不是**当前主路径。实现是 **按进程 env 的敏感值做子串替换**。

`packages/core/src/sandbox/result-redaction.ts`：

1. 收集敏感名（精确表 + `_API_KEY|_TOKEN|_SECRET|…` 后缀；豁免 `PATH`/`HOME`/…）
2. 值长度 ≥ 6
3. 在 tool result（含嵌套对象）中把该值换成 **`[REDACTED:<ENV_NAME>]`**
4. 长值优先匹配，避免子串互伤

目的：`printenv` / 误 dump **不会**把密钥原样写进会话库、trace、下一轮 prompt。  
不是访问控制（用户本机仍有密钥），是 **return-path containment**。每个工具结果在归档前都走 `redactSecrets`（产品宿主接到 `redactToolContent`），不限 shell。`read_file` / `grep_files` 对 `isBlockedPath` 以及文件名 `.env`、`id_rsa`、`credentials` 直接拒绝，不把正文放进结果。

链路：

```
tool execute
  → redactToolContent
  → archive / truncate
  → persist + 回灌模型
```

---

## 7. Skills（与工具面交界）

专题仍以 [`07`](07-skills-and-routing.md) 为准；切片 C 只钉契约：

| 能力 | Env / 规则 |
|------|------------|
| 发现合并 | 仓库 `skills/**/SKILL.md` ⊕ 默认递归 `~/.agents/**/SKILL.md`；同名 **agents 覆盖仓库** |
| 关闭用户目录 | `RAW_AGENT_AGENTS_SKILLS=0` |
| 改目录 | `RAW_AGENT_AGENTS_SKILLS_DIR` |
| 路由 | `RAW_AGENT_SKILL_ROUTING_MODE=legacy\|hybrid`（另有 lexical 实现路径）；`RAW_AGENT_SKILL_ROUTING_TOP_K` |
| 严格加载 | `RAW_AGENT_SKILL_LOAD_STRICT=1` → `load_skill` **仅限当轮 shortlist** |

基线：`doc/skill-router-baseline.md`。

---

## 8. 端到端一张图

```
User (+ imageAssetIds?)
  → ingest / retention（hot→contact sheet warm）
  → PromptBuilder + skill shortlist
  → ModelAdapter
       ├ chat_completions | responses
       └ hybrid: ImagePart? → VL : text
  → ModelTurnResult { usage, finishReason, truncated?, requestId? }
  → turn_end (+ turn_truncated?) / usageTotals / costUsd
  → tool_use?
       → optional groups ∪ external_ai gates
       → approval
       → sandbox Tier0/1 + redact [REDACTED:NAME]
       → next turn
```

---

## 9. 关键文件速查

| 路径 | 职责 |
|------|------|
| `model/model-adapters.ts` | chat/responses/hybrid 工厂与流消费 |
| `model/usage.ts` | TokenUsage / truncate / merge / cumulative split |
| `model/token-cost.ts` | costUsd 估算 |
| `model/upstream-request-id.ts` | request-id 提取 |
| `tools/optional-tool-groups.ts` | optional groups + 默认启用并集 |
| `tools/external-ai-tools.ts` | claude_code / codex_exec / cursor_agent |
| `sandbox/env-sanitizer.ts` | Tier 0 |
| `sandbox/os-sandbox.ts` | SandboxManager / sandbox-exec / bwrap |
| `sandbox/result-redaction.ts` | env 值 → `[REDACTED:NAME]` |
| `image-assets.ts` + `services/image-ingest-service.ts` | ingest / contact sheet / retention |
| `skills/skill-registry.ts` + `skill-router.ts` | ~/.agents 合并与路由 |

---

## 10. 常见误解（对照实现）

| 误解 | 实际 |
|------|------|
| URL 带 `/responses` 自动切换协议 | 看 `RAW_AGENT_OPENAI_HTTP_KIND` |
| 截断会改 stopReason / 逼续写 | 只发 `turn_truncated`，控制流不变 |
| Redaction = 正则扫 AKIA/ghp | 扫 **env 敏感值** → `[REDACTED:NAME]` |
| `AGENT_SANDBOX_KIND` = OS seatbelt | 那是执行后端；OS 隔离是 `SANDBOX_MODE` |
| External AI 开 env 即暴露 | 还需会话 gate；若开 optional groups 还需 `external_ai` 组 |
| Skills 只扫仓库 | 默认还合并 `~/.agents`，同名覆盖 |
