#!/usr/bin/env bash
# learn → 循环 run-day 直至 inbox 待处理清空 →（可选）展示站 deploy
#
# 用法:
#   bash scripts/evolution-drain-showcase.sh [选项]
#   npm run evolution:drain-showcase -- [选项]
#
# 可选参数（未传则沿用下列默认，与旧版硬编码一致）:
#   --research <cursor|generic|none>   研究/评估阶段 CLI（对应 EVOLUTION_RESEARCH_CMD；省略=与 evolution-cli 一致：仅 agent=cursor 时默认 cursor）
#   --agent <cursor|claude|codex|full|multi>  实现/改代码阶段（EVOLUTION_AGENT_CMD）
#   --review <cursor|codex|none>        审查与 refine 链路（EVOLUTION_REVIEW_CMD 等）
#   --test-agent <gemini|none>         单测前测试补强（EVOLUTION_TEST_AGENT_CMD；none=显式关闭；省略=不改 .env）
#   --model <name>                      Cursor 实现/研究模型（默认 composer-2-fast）
#   --review-model <name>               Cursor 审查模型（默认同 --model）
#   --concurrency <n>                  并发 worktree（未设 EVOLUTION_CONCURRENCY_MAX 时 CLI 默认上限 32；硬顶 200）
#   --items <n>                         每轮最多处理条数（默认 200）
#   --merge                             传入 evolution-cli（自动合并）
#   --target-branch <b>                 合并目标分支
#   --skip-rebase                       传入 evolution-cli
#   --pipeline-build                    learn 前先编译 gateway
#   --no-showcase                       跳过 npm run evolution:showcase-deploy
#   -h, --help                          打印本说明
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RESEARCH_FLAG=()
TEST_AGENT_FLAG=()
AGENT=(--agent cursor)
REVIEW=(--review codex)
MODEL=(--model composer-2-fast)
REVIEW_MODEL_FLAG=()
CONCURRENCY=(--concurrency 5)
ITEMS=(--items 200)
MERGE_FLAG=()
TARGET_BRANCH_FLAG=()
SKIP_REBASE_FLAG=()
PIPELINE_BUILD_FLAG=()
SHOWCASE=1

usage() {
  awk '/^set -e/ { exit } NR == 1 && /^#!/ { next } /^#/ { sub(/^# ?/, ""); print }' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --research)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --research 需要值"; exit 1; }
      RESEARCH_FLAG=(--research "$2")
      shift 2
      ;;
    --agent)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --agent 需要值"; exit 1; }
      AGENT=(--agent "$2")
      shift 2
      ;;
    --review)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --review 需要值"; exit 1; }
      REVIEW=(--review "$2")
      shift 2
      ;;
    --test-agent)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --test-agent 需要值"; exit 1; }
      TEST_AGENT_FLAG=(--test-agent "$2")
      shift 2
      ;;
    --model)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --model 需要值"; exit 1; }
      MODEL=(--model "$2")
      shift 2
      ;;
    --review-model)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --review-model 需要值"; exit 1; }
      REVIEW_MODEL_FLAG=(--review-model "$2")
      shift 2
      ;;
    --concurrency)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --concurrency 需要值"; exit 1; }
      CONCURRENCY=(--concurrency "$2")
      shift 2
      ;;
    --items)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --items 需要值"; exit 1; }
      ITEMS=(--items "$2")
      shift 2
      ;;
    --merge)
      MERGE_FLAG=(--merge)
      shift
      ;;
    --target-branch)
      [[ $# -lt 2 ]] && { echo "evolution-drain-showcase: --target-branch 需要值"; exit 1; }
      TARGET_BRANCH_FLAG=(--target-branch "$2")
      shift 2
      ;;
    --skip-rebase)
      SKIP_REBASE_FLAG=(--skip-rebase)
      shift
      ;;
    --pipeline-build)
      PIPELINE_BUILD_FLAG=(--pipeline-build)
      shift
      ;;
    --no-showcase)
      SHOWCASE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "evolution-drain-showcase: 未知参数: $1（见 --help）" >&2
      exit 1
      ;;
  esac
done

# shellcheck disable=SC1091
source "$ROOT/scripts/evolution/refuse-if-hidden.sh"
evolution_refuse_if_hidden "$ROOT"

npm run evolution -- \
  "${PIPELINE_BUILD_FLAG[@]}" \
  --learn \
  "${AGENT[@]}" \
  "${REVIEW[@]}" \
  "${MODEL[@]}" \
  "${REVIEW_MODEL_FLAG[@]}" \
  "${CONCURRENCY[@]}" \
  "${ITEMS[@]}" \
  "${RESEARCH_FLAG[@]}" \
  "${TEST_AGENT_FLAG[@]}" \
  "${MERGE_FLAG[@]}" \
  "${TARGET_BRANCH_FLAG[@]}" \
  "${SKIP_REBASE_FLAG[@]}" \
  --until-empty

if [[ "$SHOWCASE" -eq 1 ]]; then
  npm run evolution:showcase-deploy
fi
