---
name: ppeng-agent-core workspace
description: Work effectively in the ppeng-agent-core (Raw Agent SDK) monorepo—Node.js multi-agent runtime, HTTP daemon, Next.js Agent Lab, SQLite state, Evolution (RSS→inbox→worktree→tests), self-heal, skills, MCP/gateway, sandboxed spawn. Use when tasks touch this repository, packages/core, apps/daemon, apps/web-console, evolution scripts, RAW_AGENT_* / EVOLUTION_* configuration, tools approvals, or onboarding another coding agent to this codebase.
---

# 在本仓库中工作的 Agent 指引

## 必读顺序

1. 根目录 [`AGENTS.md`](../../AGENTS.md) — 环境变量、前端/自愈/Evolution 行为、沙箱、技能加载等**约定与事实**（优先于凭印象猜）。
2. [`README.md`](../../README.md) 或 [`README.zh.md`](../../README.zh.md) 中 **「给 AI 编码 Agent 的指引」** 小节 — 与 AGENTS 互补的速查。
3. 架构与 API 面：[`doc/ARCHITECTURE.md`](../../doc/ARCHITECTURE.md)。配置模板：[`.env.example`](../../.env.example)。

## 仓库地图（摘要）

| 区域 | 路径 | 职责 |
|------|------|------|
| 运行时 | `packages/core` | `RawAgentRuntime`、工具、存储、worktree/自愈策略、trace、skills |
| 网关 | `packages/capability-gateway` | 可选桥接；Evolution learn 拉 feed |
| API | `apps/daemon` | HTTP API、调度；`/` 仅为 stub |
| 控制台 | `apps/web-console` | Next.js 15 App Router；业务走 `/api/*` 代理到 daemon |
| CLI | `apps/cli` | `chat`、`self-heal` 等 |
| 自进化 | `scripts/evolution-cli.mjs`、`scripts/evolution-run-day.mjs`、`scripts/evolution-drain-showcase.sh` | 详见下文 |

更细的目录说明见 [`references/layout.md`](references/layout.md)。

## 改代码后怎么验

- 逻辑/核心包：`pnpm run test:unit`
- 全量 TS：`pnpm run build`
- 回归/E2E：见 [`doc/TESTING.md`](../../doc/TESTING.md)

不要提交 `.env`；改模型或运行相关变量后需**重启 daemon** 才生效。

## Evolution（持续学习管线）

- 统一入口：`pnpm run evolution --help`（含 `--learn`、`--agent`、`--review`、`--until-empty`、`--research`、`--test-agent` 等）。
- 一键 learn + 排空 inbox + 可选展示站：`pnpm run evolution:drain-showcase --help` 或 `bash scripts/evolution-drain-showcase.sh --help`。
- **默认** `run-day` 只处理当日 inbox 的 **「今日新条目」** 分段；`--items` 是每轮上限而非「总轮数」。
- 常用命令表：[`references/evolution.md`](references/evolution.md)。

## 硬约束

- **子进程**：新增 `spawn` 须走 `sanitizeSpawnEnv()` / `SandboxManager`（`packages/core/src/sandbox.ts`），勿裸用父进程完整环境。
- **Skills**：仓库 `skills/**/SKILL.md`；可与 `~/.agents/**/SKILL.md` 合并（规则见 AGENTS.md）。
- **外部 AI 工具**：`RAW_AGENT_EXTERNAL_AI_TOOLS`、CLI 说明见 [`doc/EXTERNAL_AI_CLI.md`](../../doc/EXTERNAL_AI_CLI.md)。

## 何时读 references

- 目录与包边界细节 → [`references/layout.md`](references/layout.md)
- Evolution/脚本速查 → [`references/evolution.md`](references/evolution.md)
