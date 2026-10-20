#!/usr/bin/env bash
# evolution-run-day：Codex 版（pnpm run ai:codex）。更常用 Claude 见 scripts/evolution-agent-claude.sh。
set -euo pipefail
EX="${EVOLUTION_SOURCE_EXCERPT_FILE:-}"
CO="${EVOLUTION_AGENT_CONSTRAINTS_FILE:-}"
PROMPT=$(
  printf '%s\n\n' "Based on the source excerpt below, implement a REAL, MEANINGFUL improvement to this
TypeScript/Node.js repository. You MUST modify at least one non-test source file under packages/ or apps/.
Tests-only changes will be rejected by the pipeline — always pair functional changes with tests, not the
other way around. Do not add unrelated features. If no safe functional improvement is possible, output
SKIP: <reason> and exit without modifying files."
  if [[ -n "${CO:-}" && -f "$CO" ]]; then printf '## Constraints\n%s\n\n' "$(cat "$CO")"; fi
  if [[ -n "${EX:-}" && -f "$EX" ]]; then printf '## Source excerpt\n%s\n' "$(cat "$EX")"; fi
  PL="${EVOLUTION_PLAN_FILE:-}"
  if [[ -n "${PL}" && -f "$PL" ]]; then printf '\n## Development plan (follow this)\n%s\n' "$(cat "$PL")"; fi
)
WT="${EVOLUTION_WORKTREE:-$PWD}"
cd "$WT"
# run-day 在解决 merge/rebase 冲突时注入 AI_FIX_PROMPT，优先于实现类摘录任务
if [[ -n "${AI_FIX_PROMPT:-}" ]]; then
  if [[ "${AI_CODEX_FULL_AUTO:-}" == "1" ]]; then
    exec codex exec --dangerously-bypass-approvals-and-sandbox "$AI_FIX_PROMPT"
  else
    exec codex exec --full-auto "$AI_FIX_PROMPT"
  fi
fi
# --full-auto：低摩擦自动模式（sandbox workspace-write + 自动审批），不再弹确认。
# 若需完全不沙箱（如需要 pnpm run test），设 AI_CODEX_FULL_AUTO=1 改用 --dangerously-bypass-approvals-and-sandbox。
if [[ "${AI_CODEX_FULL_AUTO:-}" == "1" ]]; then
  exec codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT"
else
  exec codex exec --full-auto "$PROMPT"
fi
