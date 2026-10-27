#!/usr/bin/env node
/**
 * 一键本地调试：先编译 core + daemon，再并行启动 daemon 与 Next（带 DAEMON_PROXY_TARGET）。
 * 端口冲突时在首选端口起向后退避（daemon / web 各 span 个候选）。
 * 用法：pnpm run dev
 */
import dotenv from 'dotenv';
import { devWebHost, syncDevHttps } from './dev-tailnet-https.mjs';
import { runDevProcesses } from './dev-lab-processes.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveBin, sanitizeScriptEnv } from './spawn-utils.mjs';
import { pickPort, writeDevLabPortsFile } from './port-utils.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Repo-root `.env`：与 daemon(dotenv/config)同源，便于 RAW_AGENT_AUTH_TOKEN 同时注入 Next middleware
dotenv.config({ path: join(root, '.env') });

const SIGNAL_EXITS = new Set([129, 130, 143]);

export function stolenPortFailure(output, code) {
  return code !== 0 && !SIGNAL_EXITS.has(code) && String(output ?? '').includes('EADDRINUSE');
}

async function pickAvoiding(pick, preferred, span, banned) {
  let start = Number(preferred);
  for (let i = 0; i < span; i += 1) {
    const port = await pick(start, span);
    if (!banned.has(port)) return port;
    start = port + 1;
  }
  throw new Error(`No free port outside occupied set near ${preferred}`);
}

export async function launchDevLab({
  env = process.env,
  run = runDevProcesses,
  pick = pickPort,
  log = console,
  writePorts = writeDevLabPortsFile,
  labRoot = root
} = {}) {
  const preferredDaemon = Number(env.RAW_AGENT_DAEMON_PORT ?? 27070);
  const preferredWeb = Number(env.RAW_AGENT_WEB_PORT ?? env.PORT ?? 23000);
  const span = Math.max(1, Number(env.RAW_AGENT_PORT_SPAN ?? 20));
  const banned = new Set();
  let compiled = false;
  for (let attempt = 0; attempt < span; attempt += 1) {
    const daemonPort = await pickAvoiding(pick, preferredDaemon, span, banned);
    let webPort = await pickAvoiding(pick, preferredWeb, span, banned);
    if (webPort === daemonPort) webPort = await pickAvoiding(pick, daemonPort + 1, span, banned);
    const proxyTarget = `http://127.0.0.1:${daemonPort}`;
    if (daemonPort !== preferredDaemon) log.warn(`[dev-lab] daemon port ${preferredDaemon} busy → backoff to ${daemonPort}`);
    if (webPort !== preferredWeb) log.warn(`[dev-lab] web port ${preferredWeb} busy → backoff to ${webPort}`);
    const portsInfo = {
      daemonPort, webPort, proxyTarget,
      labUrl: `http://127.0.0.1:${webPort}`,
      daemonUrl: proxyTarget,
      preferred: { daemon: preferredDaemon, web: preferredWeb },
      at: new Date().toISOString()
    };
    writePorts(join(labRoot, '.agent-state', 'dev-lab.ports.json'), portsInfo);
    log.log('');
    log.log('[dev-lab] ────────────────────────────────────────');
    log.log(`[dev-lab] Agent Lab  → ${portsInfo.labUrl}`);
    log.log(`[dev-lab] Daemon API → ${portsInfo.daemonUrl}`);
    log.log('[dev-lab] ports file → .agent-state/dev-lab.ports.json');
    log.log('[dev-lab] ────────────────────────────────────────');
    log.log('');
    const childEnv = sanitizeScriptEnv({
      ...env,
      RAW_AGENT_DAEMON_PORT: String(daemonPort),
      DAEMON_PROXY_TARGET: proxyTarget,
      PORT: String(webPort)
    });
    const httpsAbort = new AbortController();
    let output = '';
    const code = await run({
      cwd: labRoot,
      build: compiled ? undefined : { name: 'compile', command: resolveBin('pnpm'), args: ['exec', 'tsc', '-b', 'packages/core', 'apps/daemon'] },
      services: [
        { name: 'daemon', command: process.execPath, args: ['apps/daemon/dist/server.js'], env: childEnv },
        { name: 'web', command: resolveBin('pnpm'), args: ['--filter', '@ppeng/agent-lab-web', 'run', 'dev', '-p', String(webPort), '-H', devWebHost(labRoot)], env: childEnv }
      ],
      onReady: () => { void syncDevHttps({ root: labRoot, webPort, signal: httpsAbort.signal }); },
      onStop: () => httpsAbort.abort(),
      onOutput: (_name, chunk) => { output += chunk; }
    });
    compiled = true;
    if (!stolenPortFailure(output, code)) return code ?? 0;
    log.warn(`[dev-lab] port ${webPort} stolen after selection → retry`);
    banned.add(daemonPort);
    banned.add(webPort);
  }
  throw new Error(`No free port after ${span} stolen-port retries`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await launchDevLab();
}
