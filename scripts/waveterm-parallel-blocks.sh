#!/usr/bin/env bash
# Open one Wave Terminal block per session id, each running an interactive CLI repl.
# Requires: Wave Terminal with `wsh` on PATH; daemon running; `pnpm run build` (CLI dist).
#
# Usage:
#   export RAW_AGENT_PARALLEL_SESSION_IDS="sess1,sess2"
#   pnpm run waveterm:parallel
#
# Or space-separated:
#   RAW_AGENT_PARALLEL_SESSION_IDS="sess1 sess2" pnpm run waveterm:parallel
#
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

IDS_RAW="${RAW_AGENT_PARALLEL_SESSION_IDS:-}"
if [[ -z "${IDS_RAW// /}" ]]; then
  echo "Set RAW_AGENT_PARALLEL_SESSION_IDS to comma or space separated session ids." >&2
  echo "Create idle sessions: pnpm run start:cli session new" >&2
  exit 1
fi

if ! command -v wsh >/dev/null 2>&1; then
  echo "wsh not found. Install Wave Terminal or add wsh to PATH." >&2
  echo "Fallback — run in separate terminals:" >&2
  for id in ${IDS_RAW//,/ }; do
    [[ -z "${id// /}" ]] && continue
    echo "  cd '$REPO_ROOT' && pnpm run start:cli session repl '$id'" >&2
  done
  exit 1
fi

# Flatten commas to spaces, then iterate. Background each `wsh run` so all blocks open without waiting.
for id in ${IDS_RAW//,/ }; do
  [[ -z "${id// /}" ]] && continue
  wsh run -- bash -lc "cd '$REPO_ROOT' && exec pnpm run start:cli session repl '$id'" &
done
wait
