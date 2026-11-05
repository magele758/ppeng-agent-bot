#!/usr/bin/env node
/**
 * Idempotent PM2 start for the supervised daemon.
 * Already online: leave it. Stopped or errored: restart that app.
 * Not registered: start ecosystem.config.cjs.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const APP = 'ppeng-daemon';

export function pm2StartPlan(status) {
  if (status === 'online' || status === 'launching') return null;
  if (status === 'stopped' || status === 'errored' || status === 'stopping') {
    return ['restart', APP];
  }
  return ['start', 'ecosystem.config.cjs'];
}

function readStatus() {
  const listed = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
  if (listed.status !== 0) {
    process.stderr.write(listed.stderr || 'pm2 jlist failed\n');
    process.exit(listed.status ?? 1);
  }
  let apps = [];
  try {
    apps = JSON.parse(listed.stdout || '[]');
  } catch {
    process.stderr.write('pm2 jlist returned invalid JSON\n');
    process.exit(1);
  }
  const app = Array.isArray(apps) ? apps.find((item) => item && item.name === APP) : null;
  return app?.pm2_env?.status ?? 'missing';
}

function main() {
  const plan = pm2StartPlan(readStatus());
  if (!plan) {
    console.log(`[pm2-service] ${APP} is already online`);
    return;
  }
  const result = spawnSync('pm2', plan, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
