# Evolution 速查

## npm / bash 入口

| 命令 | 作用 |
|------|------|
| `pnpm run evolution --help` | 统一 CLI 全部参数 |
| `pnpm run evolution:learn` | 仅 RSS/本地源 → inbox + digest skill |
| `pnpm run evolution:run-day` | 仅跑 run-day（需已有 inbox） |
| `pnpm run evolution:pipeline` | bash 一键：build→learn→run-day→可选重载 |
| `pnpm run evolution:drain-showcase [opts]` | drain-showcase 包装：`--research` / `--agent` / `--review` / `--test-agent` 等 |
| `bash scripts/evolution-drain-showcase.sh --help` | 同上脚本内帮助 |

## evolution-cli 常用参数（以 `--help` 为准）

- `--learn` / `--learn-only` / `--pipeline-build`
- `--agent`：`cursor|claude|codex|full|multi`
- `--review`：`cursor|codex|none`
- `--model` / `--review-model`（Cursor）
- `--research`：`cursor|generic|none`（评估/研究阶段）
- `--test-agent`：`gemini|none`（单测前补强）
- `--concurrency`：1–5；`--items`：每轮最多条数（上限，不是强制跑满）
- `--until-empty`：循环 run-day 直至当前 inbox 规则下待处理为 0
- `--merge` / `--target-branch` / `--skip-rebase`

## 行为提示

- 并发只并行**不同 inbox 条目**的 worktree，不是「多轮 run-day 并行」。
- 单日轮次：`EVOLUTION_ROUNDS_PER_DAY`；`--until-empty` 子进程会抬高有效上限以防 drain 被截断。
- 质量链/env 片段：`.env.example`、`scripts/evolution-quality-pipeline.env.example`；研究提示与解析见 `scripts/evolution/research-eval-prompt.mjs`、`research-gate.mjs`（`EVOLUTION_RESEARCH_STRICTNESS` / `EVOLUTION_RESEARCH_UNPARSED_DEFAULT`）。
