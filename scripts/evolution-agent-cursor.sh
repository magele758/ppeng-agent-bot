#!/usr/bin/env bash
# evolution-run-day：实现 / 精炼 / 审查 / 冲突修复 — 全部走 cursor-agent CLI。
# 用法：EVOLUTION_AGENT_CMD=bash scripts/evolution-agent-cursor.sh
#       EVOLUTION_REFINE_CMD=bash scripts/evolution-agent-cursor.sh
#       EVOLUTION_REVIEW_CMD=bash scripts/evolution-agent-cursor.sh
#       EVOLUTION_REBASE_CONFLICT_CMD=bash scripts/evolution-agent-cursor.sh
#
# 行为：
#   - 若 run-day 注入了 AI_FIX_PROMPT（rebase/merge 冲突修复 或 review 精炼 或 review 本身），
#     直接执行该提示词，模型用 EVOLUTION_CURSOR_AGENT_REVIEW_MODEL（默认与实现模型一致）。
#   - 否则按 EVOLUTION_SOURCE_EXCERPT_FILE/EVOLUTION_AGENT_CONSTRAINTS_FILE/EVOLUTION_PLAN_FILE
#     拼装实现阶段的 prompt，模型用 EVOLUTION_CURSOR_AGENT_MODEL（默认 composer-2-fast）。
#
# 环境变量：
#   EVOLUTION_CURSOR_AGENT_MODEL         — 实现阶段模型（默认 composer-2-fast）
#   EVOLUTION_CURSOR_AGENT_REVIEW_MODEL  — 审查 / 精炼 / 冲突修复（默认 composer-2-fast；可改为 claude-opus-4-7-thinking-max 等）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="${EVOLUTION_WORKTREE:-$PWD}"
CURSOR_MODEL="${EVOLUTION_CURSOR_AGENT_MODEL:-composer-2-fast}"
CURSOR_REVIEW_MODEL="${EVOLUTION_CURSOR_AGENT_REVIEW_MODEL:-$CURSOR_MODEL}"

if ! command -v agent >/dev/null 2>&1; then
  echo "error: 未找到 cursor-agent CLI（命令名 \`agent\`）。安装见 doc/EXTERNAL_AI_CLI.md" >&2
  exit 127
fi

# cursor agent 自带提示式更新，不在此处检测，避免污染调用方 set -u 等

cd "$WT"

# run-day 在 review / refine / rebase-conflict 阶段都会注入 AI_FIX_PROMPT —
# 这些场景固定走 REVIEW_MODEL（可与实现模型相同，或单独设为更强模型）。
if [[ -n "${AI_FIX_PROMPT:-}" ]]; then
  echo "evolution-agent-cursor: review/refine/conflict → model=$CURSOR_REVIEW_MODEL" >&2
  exec agent --print --yolo --model "$CURSOR_REVIEW_MODEL" "$AI_FIX_PROMPT"
fi

echo "evolution-agent-cursor: implement → model=$CURSOR_MODEL" >&2

EX="${EVOLUTION_SOURCE_EXCERPT_FILE:-}"
CO="${EVOLUTION_AGENT_CONSTRAINTS_FILE:-}"
PL="${EVOLUTION_PLAN_FILE:-}"

PROMPT=$(
  printf '%s\n\n' "You are working inside a git worktree of a TypeScript/Node.js project at: $WT

Your task: read the source excerpt (and any inbox title/URL context in the excerpt file) and implement a REAL, MEANINGFUL improvement to the repository
based on what you learn. This must be a functional code change — new capability,
improved behavior, better error handling, or a fixed edge case — in source files under packages/ or apps/.
If several improvements are plausible, pick the single highest-leverage, best-bounded change that still passes tests.

Rules:
- You MUST modify at least one non-test source file under packages/ or apps/ (e.g. a .ts or .mjs file
  that is NOT *.test.* and NOT inside a test/ or __tests__/ directory).
- You MAY add tests as a companion to the feature change, but tests alone are NOT sufficient.
- Do NOT add unrelated features, do NOT change build configs, do NOT modify .env or secrets.
- The change must be small enough to be safe: prefer adding a useful helper, improving an existing
  function's robustness, or implementing a clearly useful missing feature suggested by the excerpt.
- After making changes, run: pnpm run test:unit to verify they pass.
- Do NOT commit — the pipeline will commit for you.

If you cannot find a meaningful, safe feature improvement inspired by the excerpt, output a single line:
SKIP: <reason>
and exit 0 without modifying any files."
  if [[ -n "${CO:-}" && -f "$CO" ]]; then printf '\n## Project Constraints\n%s\n' "$(cat "$CO")"; fi
  if [[ -n "${EX:-}" && -f "$EX" ]]; then printf '\n## Source Excerpt (inspiration)\n%s\n' "$(cat "$EX")"; fi
  if [[ -n "${PL:-}" && -f "$PL" ]]; then printf '\n## Development plan (follow this)\n%s\n' "$(cat "$PL")"; fi
)

exec agent --print --yolo --model "$CURSOR_MODEL" "$PROMPT"
