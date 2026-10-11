#!/usr/bin/env bash
# 每日自我进化管线示例（cron / launchd 调用）
# 委托 scripts/evolution-pipeline.sh：learn → run-day →（可选）合并后 build + 重启监听端口上的 daemon
#
# crontab 示例（每天 06:30，仓库路径请改成你的）：
# 30 6 * * * cd /path/to/ppeng-agent-core && /usr/bin/env bash scripts/cron-evolution.example.sh >> /tmp/evolution-cron.log 2>&1
#
# 环境：在 .env 中配置 EVOLUTION_*；合并后自动 build + 重载 daemon 示例：
#   EVOLUTION_POST_MERGE_RELOAD=1
#   EVOLUTION_RELOAD_DAEMON=1
# 并确保 daemon 由 `npm run start:supervised` 拉起。

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The running app does not install this crontab. If a host still calls it,
# the product switch no-ops before learn / run-day / daemon reload.
# shellcheck disable=SC1091
source "$ROOT/scripts/evolution/refuse-if-hidden.sh"
evolution_refuse_if_hidden "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"
[[ -f .env ]] && set -a && source .env && set +a

exec bash "$ROOT/scripts/evolution-pipeline.sh"
