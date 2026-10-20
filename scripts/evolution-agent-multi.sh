#!/usr/bin/env bash
# evolution-run-day：多 Agent 路由脚本。
# 根据策略把每条 Evolution 任务分配给不同 AI CLI（claude / codex / cursor agent / gemini）。
#
# ── 策略（EVOLUTION_AGENT_STRATEGY）──────────────────────────────────────────
#   rotate     (默认) 按权重轮转：基于来源 URL hash 确定性分配，可安全并发。
#   difficulty         按摘录关键词推断任务复杂度后路由。
#
# ── 相关环境变量 ─────────────────────────────────────────────────────────────
#   EVOLUTION_AGENT_STRATEGY=rotate|difficulty
#     (默认: rotate)
#
#   EVOLUTION_AGENT_WEIGHTS=claude:2,codex:1,cursor:1,gemini:1
#     rotate 策略：格式 cli名:整数权重，逗号分隔。权重越大分配比例越高。
#     cli 名称: claude | codex | cursor | gemini
#     (默认: claude:2,codex:1,cursor:1)
#
#   EVOLUTION_AGENT_DIFFICULTY_MAP=simple:codex,medium:cursor,complex:claude
#     difficulty 策略：三档 (simple/medium/complex) 各自对应的 cli。
#     (默认: simple:codex,medium:cursor,complex:claude)
#
#   AI_CODEX_FULL_AUTO=1
#     codex：使用 --full-auto 而非 --sandbox workspace-write。
#
#   EVOLUTION_AGENT_QUOTA_FALLBACK=cursor
#     可选。主选 CLI 已安装但运行失败（额度用尽、429、进程非零退出等）时，再尝试该 CLI。
#     常用: cursor（本机 `agent`）。不设则行为与旧版一致：主 CLI 失败即整条失败。
#     勿与主选重复；若 rotate 已选中 cursor，不会二次调用。
#
#   EVOLUTION_CURSOR_AGENT_MODEL=composer-2-fast
#     走 Cursor `agent` 时固定模型（`agent --model`），避免误用更贵模型。默认 composer-2-fast。
#
# ── 用法 ─────────────────────────────────────────────────────────────────────
#   在 .env 中设置：
#     EVOLUTION_AGENT_CMD=bash scripts/evolution-agent-multi.sh
# 跑 pnpm run evolution:pipeline 且要用本配置时还需：
#     EVOLUTION_PIPELINE_USE_ENV_AGENT=1
#
#   可选只用部分 CLI（未安装的自动跳过 fallback）：
#     EVOLUTION_AGENT_WEIGHTS=claude:1,codex:1
#
#   套餐分流 + 额度用尽时换 Cursor 示例：
#     EVOLUTION_AGENT_WEIGHTS=claude:2,codex:2,gemini:1
#     EVOLUTION_AGENT_QUOTA_FALLBACK=cursor
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WT="${EVOLUTION_WORKTREE:-$PWD}"

STRATEGY="${EVOLUTION_AGENT_STRATEGY:-rotate}"
WEIGHTS_STR="${EVOLUTION_AGENT_WEIGHTS:-claude:2,codex:1,cursor:1}"
DIFF_MAP_STR="${EVOLUTION_AGENT_DIFFICULTY_MAP:-simple:codex,medium:cursor,complex:claude}"
CURSOR_MODEL="${EVOLUTION_CURSOR_AGENT_MODEL:-composer-2-fast}"

EX="${EVOLUTION_SOURCE_EXCERPT_FILE:-}"
CO="${EVOLUTION_AGENT_CONSTRAINTS_FILE:-}"
SOURCE_URL="${EVOLUTION_SOURCE_URL:-}"

# ── 构建统一 PROMPT ───────────────────────────────────────────────────────────
PROMPT=$(
  printf '%s\n' "You are working inside a git worktree of a TypeScript/Node.js project at: $WT

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
)

# ── 工具函数 ──────────────────────────────────────────────────────────────────

# 检查 CLI 是否可用
cli_available() {
  local cli=$1
  case "$cli" in
    claude)  command -v claude  >/dev/null 2>&1 ;;
    codex)   command -v codex   >/dev/null 2>&1 ;;
    cursor)  command -v agent   >/dev/null 2>&1 ;;
    gemini)  command -v gemini  >/dev/null 2>&1 ;;
    *)       return 1 ;;
  esac
}

# 运行指定 CLI；返回其退出码（便于主 CLI 失败后再做额度回退）
invoke_cli() {
  local cli=$1
  echo "evolution-agent-multi: 使用 $cli (strategy=$STRATEGY)" >&2
  cd "$WT"
  case "$cli" in
    claude)
      claude --dangerously-skip-permissions -p "$PROMPT"
      ;;
    codex)
      if [[ "${AI_CODEX_FULL_AUTO:-}" == "1" ]]; then
        codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT"
      else
        codex exec --full-auto "$PROMPT"
      fi
      ;;
    cursor)
      agent --print --yolo --model "$CURSOR_MODEL" "$PROMPT"
      ;;
    gemini)
      gemini -p "$PROMPT" --yolo
      ;;
    *)
      echo "evolution-agent-multi: 未知 cli=$cli" >&2
      return 1
      ;;
  esac
}

# 先跑主选 CLI；失败且配置了 EVOLUTION_AGENT_QUOTA_FALLBACK 时再试一次（通常 cursor）
try_with_quota_fallback() {
  local chosen=$1
  local qfb="${EVOLUTION_AGENT_QUOTA_FALLBACK:-}"
  qfb="${qfb//[[:space:]]/}"
  local ec=0
  invoke_cli "$chosen" || ec=$?
  [[ $ec -eq 0 ]] && exit 0
  if [[ -z "$qfb" ]] || [[ "$chosen" == "$qfb" ]]; then
    exit "$ec"
  fi
  if ! cli_available "$qfb"; then
    echo "evolution-agent-multi: 主 CLI 退出 $ec；QUOTA_FALLBACK=$qfb 未安装，放弃" >&2
    exit "$ec"
  fi
  echo "evolution-agent-multi: 主 CLI 退出 $ec，按 EVOLUTION_AGENT_QUOTA_FALLBACK 重试 → $qfb" >&2
  invoke_cli "$qfb"
  exit $?
}

# 找可用的 fallback CLI，按给定顺序尝试
find_available() {
  for cli in "$@"; do
    if cli_available "$cli"; then
      echo "$cli"
      return 0
    fi
  done
  echo ""
}

# ── rotate 策略：基于 URL hash 权重分配 ──────────────────────────────────────
strategy_rotate() {
  # 解析权重字符串 → 展开为有序列表 (e.g. claude claude codex cursor)
  local -a cli_list=()
  local total=0
  IFS=',' read -ra pairs <<< "$WEIGHTS_STR"
  for pair in "${pairs[@]}"; do
    local name weight
    name="${pair%%:*}"
    weight="${pair##*:}"
    # 跳过权重 ≤0 的项
    if [[ "$weight" -gt 0 ]] 2>/dev/null; then
      for (( i=0; i<weight; i++ )); do
        cli_list+=("$name")
        (( total++ )) || true
      done
    fi
  done

  if [[ ${#cli_list[@]} -eq 0 ]]; then
    echo "evolution-agent-multi: EVOLUTION_AGENT_WEIGHTS 解析失败，回退 claude" >&2
    cli_list=(claude)
    total=1
  fi

  # 用 URL hash 做确定性选择（不需要共享计数器，并发安全）
  local seed="${SOURCE_URL:-$WT}"
  local hash_val
  hash_val=$(printf '%s' "$seed" | cksum | awk '{print $1}')
  local idx=$(( hash_val % total ))
  local chosen="${cli_list[$idx]}"

  echo "evolution-agent-multi: rotate 选中 $chosen (hash=$hash_val, idx=$idx/$total)" >&2

  # fallback：若所选 CLI 未安装，按权重顺序找下一个可用
  if ! cli_available "$chosen"; then
    echo "evolution-agent-multi: $chosen 未安装，尝试 fallback..." >&2
    # 去重后按顺序查找
    local -a seen=()
    local fallback=""
    for c in "${cli_list[@]}"; do
      local already=0
      for s in "${seen[@]+"${seen[@]}"}"; do [[ "$s" == "$c" ]] && { already=1; break; }; done
      [[ $already -eq 1 ]] && continue
      seen+=("$c")
      if cli_available "$c"; then fallback="$c"; break; fi
    done
    if [[ -z "$fallback" ]]; then
      echo "evolution-agent-multi: 所有 CLI 均未安装 (${cli_list[*]})，退出" >&2
      exit 127
    fi
    chosen="$fallback"
    echo "evolution-agent-multi: fallback → $chosen" >&2
  fi

  try_with_quota_fallback "$chosen"
}

# ── difficulty 策略：关键词推断复杂度后路由 ───────────────────────────────────
strategy_difficulty() {
  # 解析 DIFFICULTY_MAP → 三个变量
  local cli_simple="" cli_medium="" cli_complex=""
  IFS=',' read -ra pairs <<< "$DIFF_MAP_STR"
  for pair in "${pairs[@]}"; do
    local level cli
    level="${pair%%:*}"
    cli="${pair##*:}"
    case "$level" in
      simple)  cli_simple="$cli"  ;;
      medium)  cli_medium="$cli"  ;;
      complex) cli_complex="$cli" ;;
    esac
  done
  cli_simple="${cli_simple:-codex}"
  cli_medium="${cli_medium:-cursor}"
  cli_complex="${cli_complex:-claude}"

  # 扫描摘录关键词（不区分大小写）
  local excerpt_text=""
  if [[ -n "${EX:-}" && -f "$EX" ]]; then
    excerpt_text="$(cat "$EX")"
  fi
  # 也把 URL 拼入供检测
  local scan_text="${excerpt_text} ${SOURCE_URL:-}"

  # 复杂度信号词
  local complex_words="architect security refactor concurren async stream multi.agent MCP inference dispatch orchestrat design.pattern pipeline"
  local simple_words="fix bug typo minor small patch fmt format lint"

  local level="medium"
  for w in $complex_words; do
    if echo "$scan_text" | grep -qiE "$w"; then
      level="complex"
      break
    fi
  done
  if [[ "$level" == "medium" ]]; then
    for w in $simple_words; do
      if echo "$scan_text" | grep -qiE "$w"; then
        level="simple"
        break
      fi
    done
  fi

  local chosen
  case "$level" in
    simple)  chosen="$cli_simple"  ;;
    medium)  chosen="$cli_medium"  ;;
    complex) chosen="$cli_complex" ;;
  esac

  echo "evolution-agent-multi: difficulty=$level → $chosen" >&2

  # fallback 顺序：complex > medium > simple > 任意可用
  local -a fallback_order=("$cli_complex" "$cli_medium" "$cli_simple" claude codex cursor gemini)
  if ! cli_available "$chosen"; then
    echo "evolution-agent-multi: $chosen 未安装，尝试 fallback..." >&2
    local fallback=""
    for c in "${fallback_order[@]}"; do
      if cli_available "$c"; then fallback="$c"; break; fi
    done
    if [[ -z "$fallback" ]]; then
      echo "evolution-agent-multi: 所有 CLI 均未安装，退出" >&2
      exit 127
    fi
    echo "evolution-agent-multi: fallback → $fallback" >&2
    chosen="$fallback"
  fi

  try_with_quota_fallback "$chosen"
}

# ── 入口 ──────────────────────────────────────────────────────────────────────
case "$STRATEGY" in
  rotate)     strategy_rotate     ;;
  difficulty) strategy_difficulty ;;
  *)
    echo "evolution-agent-multi: 未知 EVOLUTION_AGENT_STRATEGY=$STRATEGY，回退 rotate" >&2
    strategy_rotate
    ;;
esac
