/**
 * PM2：常驻受监督的 daemon（scripts/supervisor.mjs）。
 *
 * 依赖：npm i -g pm2，且已 pnpm run build（或至少编译出 apps/daemon/dist）。
 * 启动：pnpm run pm2:start
 * 停止 / 重启 / 日志 / 移除：pm2:stop、pm2:restart、pm2:logs、pm2:delete
 *
 * 只管理 ppeng-daemon，不会碰 ecosystem.evolution.config.cjs 里的 evolution-nightly。
 * 单实例 fork。kill_timeout 必须大于监督进程转发给 daemon 的收尾时间（8 秒）。
 * 解释器用启动 PM2 时的 node，避免落到没有 FTS5 的 Node。
 * 改 .env 后需 pnpm run pm2:restart。
 */
const path = require('path');

const root = __dirname;

const app = {
  name: 'ppeng-daemon',
  cwd: root,
  script: 'scripts/supervisor.mjs',
  interpreter: process.execPath,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  kill_timeout: 10000,
  time: true,
};

module.exports = { apps: [app] };
