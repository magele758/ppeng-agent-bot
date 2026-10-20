#!/usr/bin/env bash
# 示例：`evolution:run-day` 在 pnpm install --frozen-lockfile 之后、构建之前执行 EVOLUTION_AGENT_CMD。
# 环境变量（节选）：
#   EVOLUTION_WT_ROOT / EVOLUTION_WORKTREE — worktree 绝对路径
#   EVOLUTION_SOURCE_TITLE / EVOLUTION_SOURCE_URL
#   EVOLUTION_SOURCE_EXCERPT_FILE — 抓取的正文摘录（.evolution/source-excerpt.txt）
#   EVOLUTION_AGENT_CONSTRAINTS_FILE — 约束文本（.evolution/constraints.txt，来自 EVOLUTION_AGENT_CONSTRAINTS*）
# 复制本文件后改成你的 agent/CLI 调用；此处仅打印并 exit 0。
set -euo pipefail
echo "[evolution-agent-hook.example] WT=${EVOLUTION_WT_ROOT:-}"
echo "[evolution-agent-hook.example] EXCERPT=${EVOLUTION_SOURCE_EXCERPT_FILE:-}"
echo "[evolution-agent-hook.example] CONSTRAINTS=${EVOLUTION_AGENT_CONSTRAINTS_FILE:-}"
if [[ -n "${EVOLUTION_SOURCE_EXCERPT_FILE:-}" && -f "${EVOLUTION_SOURCE_EXCERPT_FILE}" ]]; then
  echo "--- excerpt (first 5 lines) ---"
  head -n 5 "${EVOLUTION_SOURCE_EXCERPT_FILE}" || true
fi
exit 0
