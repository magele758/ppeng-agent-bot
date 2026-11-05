#!/usr/bin/env node
/**
 * PM2 entry for the Lab web console. Loads the repo .env, then runs
 * `next start` against the already built apps/web-console/.next.
 * The page is that build, not the working tree.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { sanitizeSpawnEnv } from '../packages/core/dist/sandbox/env-sanitizer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(root, '.env'), quiet: true });

const port = String(process.env.RAW_AGENT_WEB_PORT || '23000');
const daemonPort = String(process.env.RAW_AGENT_DAEMON_PORT || '37070');
const proxy = process.env.DAEMON_PROXY_TARGET || `http://127.0.0.1:${daemonPort}`;
const nextBin = join(root, 'apps/web-console/node_modules/next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, 'start', '-p', port, '-H', '127.0.0.1'], {
  cwd: join(root, 'apps/web-console'),
  env: sanitizeSpawnEnv({ base: { ...process.env, NODE_ENV: 'production', PORT: port, DAEMON_PROXY_TARGET: proxy } }),
  stdio: 'inherit'
});

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode !== null || child.signalCode !== null) {
    process.exit(0);
    return;
  }
  child.kill(signal);
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    process.exit(0);
  }, 8_000);
  child.once('exit', () => {
    clearTimeout(timer);
    process.exit(0);
  });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code) => {
  if (!stopping) process.exit(code ?? 0);
});
