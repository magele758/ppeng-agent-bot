#!/usr/bin/env node
/**
 * 一键本地调试：先编译 core + daemon，再并行启动 daemon 与 Next（带 DAEMON_PROXY_TARGET）。
 * 端口冲突时在首选端口起向后退避（daemon / web 各 span 个候选）。
 * 用法：pnpm run dev
 */
import dotenv from 'dotenv';
import { devWebHost, syncDevHttps } from './dev-tailnet-https.mjs';
import { runDevProcesses } from './dev-lab-processes.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveBin, sanitizeScriptEnv } from './spawn-utils.mjs';
import { pickPort, writeDevLabPortsFile } from './port-utils.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Repo-root `.env`：与 daemon(dotenv/config)同源，便于 RAW_AGENT_AUTH_TOKEN 同时注入 Next middleware
dotenv.config({ path: join(root, '.env') });

const DAEMON_PORT_PREFERRED = Number(process.env.RAW_AGENT_DAEMON_PORT ?? 27070);
const WEB_PORT_PREFERRED = Number(process.env.RAW_AGENT_WEB_PORT ?? process.env.PORT ?? 23000);
const PORT_SPAN = Math.max(1, Number(process.env.RAW_AGENT_PORT_SPAN ?? 20));

const daemonPort = await pickPort(DAEMON_PORT_PREFERRED, PORT_SPAN);
let webPort = await pickPort(WEB_PORT_PREFERRED, PORT_SPAN);
if (webPort === daemonPort) {
  webPort = await pickPort(daemonPort + 1, PORT_SPAN);
}

const proxyTarget = `http://127.0.0.1:${daemonPort}`;

if (daemonPort !== DAEMON_PORT_PREFERRED) {
  console.warn(`[dev-lab] daemon port ${DAEMON_PORT_PREFERRED} busy → backoff to ${daemonPort}`);
}
if (webPort !== WEB_PORT_PREFERRED) {
  console.warn(`[dev-lab] web port ${WEB_PORT_PREFERRED} busy → backoff to ${webPort}`);
}

const portsInfo = {
  daemonPort,
  webPort,
  proxyTarget,
  labUrl: `http://127.0.0.1:${webPort}`,
  daemonUrl: proxyTarget,
  preferred: { daemon: DAEMON_PORT_PREFERRED, web: WEB_PORT_PREFERRED },
  at: new Date().toISOString()
};
writeDevLabPortsFile(join(root, '.agent-state', 'dev-lab.ports.json'), portsInfo);

console.log('');
console.log('[dev-lab] ────────────────────────────────────────');
console.log(`[dev-lab] Agent Lab  → ${portsInfo.labUrl}`);
console.log(`[dev-lab] Daemon API → ${portsInfo.daemonUrl}`);
console.log(`[dev-lab] ports file → .agent-state/dev-lab.ports.json`);
console.log('[dev-lab] ────────────────────────────────────────');
console.log('');

const childEnv = sanitizeScriptEnv({
  ...process.env,
  RAW_AGENT_DAEMON_PORT: String(daemonPort),
  DAEMON_PROXY_TARGET: proxyTarget,
  PORT: String(webPort)
});

const httpsAbort = new AbortController();
process.exitCode = await runDevProcesses({
  cwd: root,
  build: { name: 'compile', command: resolveBin('pnpm'), args: ['exec', 'tsc', '-b', 'packages/core', 'apps/daemon'] },
  services: [
    { name: 'daemon', command: process.execPath, args: ['apps/daemon/dist/server.js'], env: childEnv },
    {
      name: 'web', command: resolveBin('pnpm'),
      args: ['--filter', '@ppeng/agent-lab-web', 'run', 'dev', '-p', String(webPort), '-H', devWebHost(root)],
      env: childEnv
    }
  ],
  onReady: () => { void syncDevHttps({ root, webPort, signal: httpsAbort.signal }); },
  onStop: () => httpsAbort.abort()
});
