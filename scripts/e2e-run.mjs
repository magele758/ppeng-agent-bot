#!/usr/bin/env node
import {createRequire} from 'node:module';
/**
 * 启动临时 daemon + Next 控制台（生产构建），再跑 Playwright。
 * CI：PLAYWRIGHT_BASE_URL 不设，由本脚本写入。
 * 本地对已运行中的环境：export PLAYWRIGHT_BASE_URL=http://127.0.0.1:33815 并确保 Next 的 DAEMON_PROXY_TARGET 指向 daemon。
 *
 * 脚本自管启动时：会为 daemon 与 Next 注入同一随机 RAW_AGENT_AUTH_TOKEN，Next middleware 代为附加 Bearer。
 * 草稿批准/拒绝只认 Lab 登录会话，不注入 release secret（Sec-Fetch-Site 可伪造）。
 * Playwright 可通过 PLAYWRIGHT_AUTH_PROBE_DAEMON_ORIGIN 断言「直连 daemon 401 / 经 Lab 200」。
 *
 * 子进程生命周期（进程组、失败/信号时清理、日志排空）见 ./e2e-lifecycle.mjs；
 * 每次运行用系统分配的空闲端口与独立 mkdtemp 状态目录，可重复执行。
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, runWithCleanup } from './e2e-lifecycle.mjs';
import { envForEphemeralDaemon, sanitizeScriptEnv } from './spawn-utils.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/package.json').replace(/package\.json$/, 'cli.js');
const nextBin = createRequire(join(repoRoot,'apps/web-console/package.json')).resolve('next/dist/bin/next');
const webConsoleDir = join(repoRoot, 'apps', 'web-console');
const webNextDir = join(webConsoleDir, '.next');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(probe, { timeoutMs, intervalMs, label, registry }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    registry.assertAlive();
    try {
      if (await probe()) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} not ready within ${timeoutMs}ms: ${lastErr?.message ?? 'unknown'}`);
}

async function daemonHealthy(baseUrl) {
  const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) return false;
  const body = await res.json();
  return body?.ok === true;
}

async function httpOk(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return res.ok;
}

/**
 * A `.next` written by `next dev` (or a half-finished build) makes `next start`
 * die with "routesManifest.dataRoutes is not iterable"; only reuse a complete
 * production build.
 */
function nextBuildUsable() {
  if (!existsSync(join(webNextDir, 'BUILD_ID'))) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(webNextDir, 'routes-manifest.json'), 'utf8'));
    return Array.isArray(manifest.dataRoutes);
  } catch {
    return false;
  }
}

function ensureNextBuild() {
  if (nextBuildUsable()) return 0;
  if (existsSync(webNextDir)) {
    console.error('[e2e] apps/web-console/.next is not a complete production build (next dev output?); rebuilding');
    rmSync(webNextDir, { recursive: true, force: true });
  }
  const b = spawnSync('pnpm', ['--filter', '@ppeng/agent-lab-web', 'run', 'build'], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
    shell: true
  });
  return b.status ?? 1;
}

/** Extra CLI args (`pnpm run test:e2e --reporter=list,junit`) are forwarded to `playwright test`. */
function runPlaywright(registry, env) {
  return registry.spawnTask(process.execPath, [playwrightCli, 'test', ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: sanitizeScriptEnv(env)
  });
}

async function main(registry) {
  const existing = process.env.PLAYWRIGHT_BASE_URL?.trim();
  if (existing) {
    return runPlaywright(registry, { ...process.env });
  }

  const buildStatus = ensureNextBuild();
  if (buildStatus !== 0) return buildStatus;

  const daemonPort = await freePort();
  let webPort = await freePort();
  while (webPort === daemonPort) webPort = await freePort();
  const stateDir = registry.trackDir(mkdtempSync(join(tmpdir(), 'ppeng-e2e-')));
  const daemonBase = `http://127.0.0.1:${daemonPort}`;
  const webBase = `http://127.0.0.1:${webPort}`;
  const e2eBearer = randomBytes(24).toString('hex');

  registry.spawnService('daemon', process.execPath, ['apps/daemon/dist/server.js'], {
    cwd: repoRoot,
    env: {
      ...envForEphemeralDaemon(),
      RAW_AGENT_DAEMON_HOST: '127.0.0.1',
      RAW_AGENT_DAEMON_PORT: String(daemonPort),
      RAW_AGENT_STATE_DIR: stateDir,
      RAW_AGENT_E2E_ISOLATE: '1',
      RAW_AGENT_SELF_HEAL_AUTO_START: '0',
      RAW_AGENT_AUTH_TOKEN: e2eBearer
    }
  });
  registry.spawnService('next', process.execPath, [nextBin, 'start', '-p', String(webPort), '-H', '127.0.0.1'], {
    cwd: webConsoleDir,
    env: {
      ...envForEphemeralDaemon(),
      DAEMON_PROXY_TARGET: daemonBase,
      RAW_AGENT_AUTH_TOKEN: e2eBearer
    }
  });

  await waitFor(() => daemonHealthy(daemonBase), { timeoutMs: 25_000, intervalMs: 150, label: 'daemon', registry });
  await waitFor(() => httpOk(webBase), { timeoutMs: 45_000, intervalMs: 200, label: 'next', registry });
  return runPlaywright(registry, {
    ...process.env,
    PLAYWRIGHT_BASE_URL: webBase,
    PLAYWRIGHT_AUTH_PROBE_DAEMON_ORIGIN: daemonBase,
    PLAYWRIGHT_E2E_STATE_DIR: stateDir
  });
}

process.exitCode = await runWithCleanup(main);
