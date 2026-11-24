# 外部 AI CLI（可选）：跑 CI 并尝试修复

本仓库**不捆绑** Claude Code、Codex、Cursor Agent 的安装与订阅；提供两种方式：（1）**npm + bash** 人工或 CI 触发；（2）**Agent 工具**（会话内模型自主选用）。与 **Self-heal**（`POST /api/self-heal/start`、内置 `self-healer` 会话、白名单测试命令）可并行使用：硬问题仍可由模型在审批后调用 `claude_code` / `codex_exec` / `cursor_agent`。

**安全风险**：这些工具会读写仓库并可能执行终端命令。仅在信任的目录中使用；勿在脚本里塞 API 密钥。

## Agent / Bot 内自主调用（推荐通过 Lab 设置开启）

在 Lab **设置 → 工具 → 本机编程助手** 中打开总开关（`GET/PATCH /api/external-ai/settings`，持久化到 `daemon_control`，保存后下一轮立即生效，**无需改 `.env` 或重启 daemon**）；若从未在界面保存过，则回退读取既有环境变量 **`RAW_AGENT_EXTERNAL_AI_TOOLS=1`**。界面同时展示本机 PATH 上检测到的 CLI（绝不因检测到 CLI 而自动开启）。

开启后提供三个工具：

| 工具名 | 行为 |
|--------|------|
| `claude_code` | `claude -p <prompt>`，默认工作区 cwd（支持可选 `cwd` 指定授权工作区子目录） |
| `codex_exec` | `codex exec --sandbox workspace-write`（可选 `full_auto`、`cwd`） |
| `cursor_agent` | `agent`（若 PATH 无 `agent` 则回退 `cursor-agent`）`--print --model <id> <prompt>`（模型优先取 Lab 设置，其次 `RAW_AGENT_CURSOR_AGENT_MODEL` / `EVOLUTION_CURSOR_AGENT_MODEL`，默认 `composer-2-fast`；支持可选 `cwd`） |

- **Bot 深度编码委派**：开启总开关且保留「允许 Bot 聊天自动使用」（默认开启）时，Bot 主对话在渐进加载模式下首轮即可直接看到本机**已安装**的编程助手工具，并在系统提示中获知本机可用 CLI、偏好工具及委派原则——多文件重构、深度调试、复杂编码与修构建/单测优先交给本机编程助手，简单小改动仍由内置工具直接完成。普通非 Bot 聊天会话仍保持默认隔离（需显式 `session.metadata.allowExternalAiTools: true`）。
- **边界与审批不放松**：
  - 使用 **`spawn` 传 argv**，不经过 shell，避免提示词注入；输出做长度截断与敏感值脱敏。
  - 可选 `cwd` 必须位于当前会话授权工作区目录内，越界路径直接拒绝。
  - 严格遵守 Bot 工具白名单与关闭开关。
  - 默认 **`needsApproval: true`**，自动/询问模式下每次调用仍需人工审批。
  - 默认超时 **600s**；可在工具参数里传 `timeout_ms`。
  - 仍需本机 **PATH** 已安装并登录对应 CLI；未安装时返回错误并列出本机检测到的其它可用 CLI。

## 检查本机是否已安装

```bash
pnpm run ai:tools
```

或手动：`command -v claude`、`command -v codex`、`command -v agent`。

## 统一入口（默认任务：跑 `pnpm run ci` 直到绿）

| npm 脚本 | 底层 CLI | 说明 |
|----------|-----------|------|
| `pnpm run ai:claude` | `claude -p`（`--print`） | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) |
| `pnpm run ai:codex` | `codex exec --sandbox workspace-write` | [Codex CLI](https://developers.openai.com/codex/cli/) |
| `pnpm run ai:cursor` | `agent --print` | [Cursor Agent CLI](https://cursor.com/docs/cli/overview) |

自定义提示词（覆盖默认「修 CI」说明）：

```bash
AI_FIX_PROMPT='只运行 pnpm run test:unit 并修复失败' pnpm run ai:claude
```

使用自定义提示词文件：

```bash
AI_FIX_PROMPT_FILE=./my-prompt.txt pnpm run ai:codex
```

默认提示词文件：[`scripts/ai-cli/prompts/fix-ci-default.txt`](../scripts/ai-cli/prompts/fix-ci-default.txt)。

## 安装指引（官方，需自行跟进版本）

### Claude Code

- 推荐：官方安装脚本或 Homebrew（见 [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)）。
- 旧方式：`npm i -g @anthropic-ai/claude-code`（可能已不推荐，以文档为准）。

首次使用需在终端完成登录；**非交互**自动化可使用 `claude --print`（部分环境若仍询问确认，需人工介入）。

### OpenAI Codex CLI

- `npm i -g @openai/codex` 或 [官方文档](https://developers.openai.com/codex/cli/) 中的安装方式。

本仓库脚本默认 `codex exec --full-auto`（沙箱可写工作区 + 自动审批，不再弹确认）。若你希望完全绕过沙箱（**更危险**，仅用于外部已隔离的环境）：

```bash
AI_CODEX_FULL_AUTO=1 pnpm run ai:codex
```

### Cursor Agent CLI

- 与「用 `cursor` 打开工程」**不是**同一个命令；Agent 一般装好后为 **`agent`**。
- 安装：`curl https://cursor.com/install -fsS | bash`（以 [Cursor CLI 文档](https://cursor.com/docs/cli/overview) 为准）。

若你安装的版本将 print 模式记为 `-p` 而非 `--print`，可编辑 [`scripts/ai-cli/run-cursor-agent-fix.sh`](../scripts/ai-cli/run-cursor-agent-fix.sh) 一行，或直接在仓库根目录运行：

```bash
agent -p "$(cat scripts/ai-cli/prompts/fix-ci-default.txt)"
```

## 与 `pnpm run ci` 的关系

| 命令 | 作用 |
|------|------|
| `pnpm run ci` | 仅**检查**（build + unit + regression + e2e），不调用外部 AI。 |
| `pnpm run ai:*` | 把「跑 CI + 按提示修问题」交给**已安装的**外部 CLI；**不会**自动安装 CLI。 |

## Windows

脚本为 bash。可在 **Git Bash** / **WSL** 下运行，或把 `scripts/ai-cli/*.sh` 里的逻辑翻译成 PowerShell 自用。
