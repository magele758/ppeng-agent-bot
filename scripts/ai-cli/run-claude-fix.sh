#!/usr/bin/env bash
# 使用 Claude Code CLI（需已安装并登录 `claude`）。非交互：--print / -p
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 未找到 claude。安装见 doc/EXTERNAL_AI_CLI.md" >&2
  exit 127
fi

PROMPT_FILE="${AI_FIX_PROMPT_FILE:-$SCRIPT_DIR/prompts/fix-ci-default.txt}"
if [[ -n "${AI_FIX_PROMPT:-}" ]]; then
  PROMPT="$AI_FIX_PROMPT"
else
  PROMPT="$(cat "$PROMPT_FILE")"
fi

echo "repo: $ROOT"
echo "using: claude -p（文档: doc/EXTERNAL_AI_CLI.md）"
# 透传参数在 -p 与提示词之间，例如: pnpm run ai:claude --model sonnet
exec claude -p "$@" "$PROMPT"
