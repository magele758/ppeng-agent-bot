#!/usr/bin/env bash
# 自进化一键编排：委托 evolution-cli.mjs（learn → run-day → 可选 post-merge-reload）
#
# 环境变量（见 .env.example「自进化一键管线」）：
#   EVOLUTION_SKIP_PIPELINE_BUILD — 跳过管线开头的编译
#   EVOLUTION_PIPELINE_BUILD_CMD — 默认 npx tsc -b packages/capability-gateway
#   EVOLUTION_PIPELINE_LEARN_ONLY — 仅跑 learn
#   EVOLUTION_POST_MERGE_RELOAD — 跑完 run-day 后执行 evolution-post-merge-reload.sh
#   EVOLUTION_PIPELINE_USE_ENV_AGENT — 为 1 时 evolution-cli 沿用 .env 的 agent；否则默认 Claude preset
#
# 用法：npm run evolution:pipeline

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/evolution/refuse-if-hidden.sh"
evolution_refuse_if_hidden "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[[ -f .env ]] && set -a && source .env && set +a

is_truthy() {
  case "${1:-}" in
    1 | true | True | yes | Yes | on | ON) return 0 ;;
    *) return 1 ;;
  esac
}

CLI_ARGS=()

if ! is_truthy "${EVOLUTION_SKIP_PIPELINE_BUILD:-}"; then
  CLI_ARGS+=(--pipeline-build)
fi

if is_truthy "${EVOLUTION_PIPELINE_LEARN_ONLY:-}"; then
  CLI_ARGS+=(--learn-only)
else
  CLI_ARGS+=(--learn)
fi

if is_truthy "${EVOLUTION_PIPELINE_USE_ENV_AGENT:-}"; then
  echo "[evolution-pipeline] 使用 .env / evolution-cli 默认 agent 配置"
else
  CLI_ARGS+=(--agent claude)
  echo "[evolution-pipeline] 默认 --agent claude（设 EVOLUTION_PIPELINE_USE_ENV_AGENT=1 沿用 .env）"
fi

node "$ROOT/scripts/evolution-cli.mjs" "${CLI_ARGS[@]}"

if is_truthy "${EVOLUTION_POST_MERGE_RELOAD:-}"; then
  bash "$ROOT/scripts/evolution-post-merge-reload.sh"
fi
