#!/usr/bin/env bash
# evolution-nightly-wrap.sh — PM2（cron_restart）或手动单次：evolution CLI + 可选 showcase-deploy
# 环境变量见仓库根目录 .env.example「PM2 定时 evolution」。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

is_truthy() {
  case "${1:-}" in
    1 | true | True | yes | Yes | on | ON) return 0 ;;
    *) return 1 ;;
  esac
}

run_payload() {
  # shellcheck disable=SC1091
  source "$ROOT/scripts/evolution/refuse-if-hidden.sh"
  evolution_refuse_if_hidden "$ROOT"

  [[ -f .env ]] && set -a && source .env && set +a

  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

  if [[ -z "${EVOLUTION_PM2_EVOLUTION_ARGS:-}" ]]; then
    npm run evolution -- --pipeline-build --learn --agent cursor --review codex --concurrency 5 --items 200
  else
    # shellcheck disable=SC2086
    npm run evolution -- ${EVOLUTION_PM2_EVOLUTION_ARGS}
  fi

  if is_truthy "${EVOLUTION_PM2_RUN_SHOWCASE:-1}"; then
    npm run evolution:showcase-deploy
  fi
}

if [[ "${1:-}" == "--__internal_after_timeout__" ]]; then
  shift
  run_payload
  exit 0
fi

if [[ -n "${EVOLUTION_PM2_TIMEOUT:-}" ]]; then
  if command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout "$EVOLUTION_PM2_TIMEOUT" "$0" --__internal_after_timeout__
  fi
  if command -v timeout >/dev/null 2>&1; then
    exec timeout "$EVOLUTION_PM2_TIMEOUT" "$0" --__internal_after_timeout__
  fi
  echo "[evolution-nightly-wrap] EVOLUTION_PM2_TIMEOUT 已设置但未找到 timeout/gtimeout，将不设上限运行。" >&2
fi

run_payload
