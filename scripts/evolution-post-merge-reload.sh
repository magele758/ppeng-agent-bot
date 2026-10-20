#!/usr/bin/env bash
# 在 evolution:run-day 合并到主分支后（或任意需要加载新 dist 时）：
# 1) 执行 EVOLUTION_POST_MERGE_BUILD_CMD（默认 pnpm run build）
# 2) 若 EVOLUTION_RELOAD_DAEMON=1：向 RAW_AGENT_DAEMON_PORT 上监听进程发 SIGTERM，
#    配合 `pnpm run start:supervised` 时 supervisor 会拉起新进程加载新编译产物。
#
# 用法：由 scripts/evolution-pipeline.sh 在 EVOLUTION_POST_MERGE_RELOAD=1 时调用，或手动执行。

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"
[[ -f .env ]] && set -a && source .env && set +a

is_truthy() {
  case "${1:-}" in
    1 | true | True | yes | Yes | on | ON) return 0 ;;
    *) return 1 ;;
  esac
}

BUILD_CMD="${EVOLUTION_POST_MERGE_BUILD_CMD:-pnpm run build}"
echo "[evolution-post-merge-reload] $BUILD_CMD"
eval "$BUILD_CMD"

if is_truthy "${EVOLUTION_RELOAD_DAEMON:-}"; then
  PORT="${RAW_AGENT_DAEMON_PORT:-37070}"
  PID=""
  if command -v lsof >/dev/null 2>&1; then
    PID=$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  fi
  if [[ -n "${PID:-}" ]]; then
    echo "[evolution-post-merge-reload] SIGTERM pid=$PID (listener on :$PORT); supervisor should respawn"
    kill -TERM "$PID" || true
  else
    echo "[evolution-post-merge-reload] no TCP listener on :$PORT (skip daemon reload)"
  fi
fi
