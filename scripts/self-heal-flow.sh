#!/usr/bin/env bash
# 一键：主仓有未提交改动则 stash → 调用 daemon 自愈 → 轮询到结束 → stash pop
# 依赖：daemon 已运行（pnpm run start:supervised 或 start:daemon）
#
# 用法：
#   pnpm run self-heal:flow
#   pnpm run self-heal:flow sheal_xxx          # 只 resume 指定 run
#   pnpm run self-heal:flow --new              # 强制新开一条（忽略可恢复的 blocked/stopped/failed）
#   SELF_HEAL_FLOW_NO_STASH=1 pnpm run self-heal:flow   # 不自动 stash（主仓必须已干净）
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

HOST="${RAW_AGENT_DAEMON_HOST:-127.0.0.1}"
PORT="${RAW_AGENT_DAEMON_PORT:-37070}"
BASE="http://${HOST}:${PORT}"

FORCE_NEW=0
NO_STASH=0
EXPLICIT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --new|--force-new) FORCE_NEW=1; shift ;;
    --no-stash) NO_STASH=1; shift ;;
    -h|--help)
      sed -n '1,15p' "$0" | tail -n +2
      exit 0
      ;;
    *)
      if [[ "$1" == sheal_* ]]; then
        EXPLICIT_ID="$1"
      else
        echo "unknown arg: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

die() { echo "self-heal-flow: $*" >&2; exit 1; }

need_python() {
  command -v python3 >/dev/null 2>&1 || die "need python3 for JSON"
}

curl_json() {
  local url=$1
  curl -sS --connect-timeout 3 --max-time 120 "$url"
}

curl_post() {
  local url=$1
  local body=${2:-{}}
  curl -sS --connect-timeout 3 --max-time 120 -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d "$body"
}

STASHED=0
stash_if_needed() {
  if [[ "$NO_STASH" == 1 ]]; then
    if git rev-parse --git-dir >/dev/null 2>&1 && [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
      die "main repo has uncommitted changes; commit/stash or omit SELF_HEAL_FLOW_NO_STASH"
    fi
    return 0
  fi
  if [[ -n "${SELF_HEAL_FLOW_NO_STASH:-}" ]]; then
    NO_STASH=1
    stash_if_needed
    return 0
  fi
  if git rev-parse --git-dir >/dev/null 2>&1 && [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    echo "self-heal-flow: stashing uncommitted changes..." >&2
    git stash push -u -m "self-heal-flow $(date +%Y%m%d-%H%M%S)"
    STASHED=1
  fi
}

stash_pop() {
  if [[ "$STASHED" -eq 1 ]]; then
    echo "self-heal-flow: git stash pop..." >&2
    if ! git stash pop; then
      echo "self-heal-flow: stash pop failed; resolve conflicts then: git stash pop" >&2
    fi
  fi
}

trap stash_pop EXIT

need_python
stash_if_needed

if ! curl -sf --connect-timeout 2 --max-time 5 "$BASE/api/health" >/dev/null; then
  die "daemon not reachable at $BASE — start: pnpm run start:supervised (or start:daemon)"
fi

pick_run_id() {
  need_python
  curl_json "$BASE/api/self-heal/runs?limit=15" | python3 -c "
import json, sys
d = json.load(sys.stdin)
runs = d.get('runs') or []
for r in runs:
    s = r.get('status')
    if s in ('blocked', 'stopped', 'failed'):
        print(r.get('id', ''))
        raise SystemExit(0)
print('')
"
}

begin_or_resume() {
  local rid=$1
  if [[ -n "$rid" ]]; then
    echo "self-heal-flow: resuming $rid" >&2
    local code out
    out=$(curl -sS -w '\n%{http_code}' --connect-timeout 3 --max-time 60 \
      -X POST "$BASE/api/self-heal/runs/$rid/resume" -H 'Content-Type: application/json' -d '{}')
    code=$(echo "$out" | tail -n1)
    body=$(echo "$out" | sed '$d')
    if [[ "$code" != "200" ]]; then
      die "resume failed HTTP $code: $body"
    fi
    echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['run']['id'])"
    return 0
  fi

  if [[ "$FORCE_NEW" == 1 ]]; then
    local code out body
    out=$(curl -sS -w '\n%{http_code}' --connect-timeout 3 --max-time 30 \
      -X POST "$BASE/api/self-heal/start" -H 'Content-Type: application/json' -d '{}')
    code=$(echo "$out" | tail -n1)
    body=$(echo "$out" | sed '$d')
    if [[ "$code" == "201" ]]; then
      echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['run']['id'])"
      return 0
    fi
    die "start failed HTTP $code: $body"
  fi

  local auto
  auto=$(pick_run_id)
  if [[ -n "$auto" ]]; then
    echo "self-heal-flow: latest resumable run $auto — resuming" >&2
    begin_or_resume "$auto"
    return 0
  fi

  echo "self-heal-flow: starting new self-heal run" >&2
  local code out body
  out=$(curl -sS -w '\n%{http_code}' --connect-timeout 3 --max-time 30 \
    -X POST "$BASE/api/self-heal/start" -H 'Content-Type: application/json' -d '{}')
  code=$(echo "$out" | tail -n1)
  body=$(echo "$out" | sed '$d')
  if [[ "$code" == "201" ]]; then
    echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['run']['id'])"
    return 0
  fi
  if [[ "$code" == "409" ]]; then
    echo "self-heal-flow: start returned 409 — following active run" >&2
    local aid
    aid=$(curl_json "$BASE/api/self-heal/status" | python3 -c "import json,sys; a=json.load(sys.stdin).get('active')or[]; print(a[0]['id'] if a else '')")
    [[ -n "$aid" ]] || die "409 but no active run in /api/self-heal/status"
    echo "$aid"
    return 0
  fi
  die "start failed HTTP $code: $body"
}

RUN_ID=""
if [[ -n "$EXPLICIT_ID" ]]; then
  RUN_ID=$(begin_or_resume "$EXPLICIT_ID")
else
  RUN_ID=$(begin_or_resume "")
fi

echo "self-heal-flow: watching run $RUN_ID (poll every 3s, max ~2h)..." >&2

deadline=$((SECONDS + 7200))
last_print=""

while true; do
  if [[ "$SECONDS" -gt "$deadline" ]]; then
    die "timeout waiting for run $RUN_ID"
  fi
  raw=""
  if ! raw=$(curl_json "$BASE/api/self-heal/runs/$RUN_ID" 2>/dev/null); then
    echo "self-heal-flow: (daemon restarting?) waiting..." >&2
    sleep 3
    continue
  fi

  status=$(echo "$raw" | python3 -c "import json,sys; print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")

  if [[ "$status" != "$last_print" ]]; then
    echo "self-heal-flow: status=$status" >&2
    last_print="$status"
  fi

  case "$status" in
    completed)
      echo "self-heal-flow: done (completed)." >&2
      trap - EXIT
      stash_pop
      exit 0
      ;;
    failed|blocked|stopped)
      br=$(echo "$raw" | python3 -c "import json,sys; print(json.load(sys.stdin).get('run',{}).get('blockReason') or '')" 2>/dev/null || true)
      echo "self-heal-flow: ended with status=$status" >&2
      [[ -n "$br" ]] && echo "self-heal-flow: blockReason: $br" >&2
      trap - EXIT
      stash_pop
      exit 1
      ;;
  esac
  sleep 3
done
