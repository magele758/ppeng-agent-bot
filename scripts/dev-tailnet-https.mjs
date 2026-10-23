import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sanitizeScriptEnv } from './spawn-utils.mjs';

function privateJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function devWebHost(root) {
  const path = join(root, '.agent-state', 'dev-https.json');
  if (!existsSync(path)) return '0.0.0.0';
  try { return JSON.parse(readFileSync(path, 'utf8')).enabled === false ? '0.0.0.0' : '127.0.0.1'; }
  catch { return '127.0.0.1'; }
}

export function tailscaleCommand() {
  // Resolve the app binary: executing its symlink can break macOS bundle discovery.
  const candidates = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'));
  }
  if (process.platform === 'darwin') candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  const found = candidates.find(existsSync);
  if (!found) throw new Error('cli-unavailable');
  return realpathSync(found);
}

export function runTailscale(args) {
  // The CLI needs its OS login/socket context, never the app's model or auth secrets.
  const env = sanitizeScriptEnv(Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR',
      'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])
  ));
  // macOS's app executable chooses CLI mode only with a terminal context.
  env.TERM = process.env.TERM || 'dumb';
  const result = spawnSync(tailscaleCommand(), args, {
    env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    timeout: 15_000, maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error('cli-failed');
  return args.includes('--json') ? JSON.parse(result.stdout) : {};
}

export async function waitForLab(target, signal) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(target, {
        signal: AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]),
        redirect: 'manual'
      });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch { /* Retry until the local web process is ready or shutdown begins. */ }
    await delay(500, undefined, { signal });
  }
  throw new Error('lab-not-ready');
}

function validateReservation(state, hostPort, port, target, previous) {
  if (state.AllowFunnel?.[hostPort]) throw new Error('public-listener');
  const listener = state.TCP?.[port];
  const endpoints = Object.entries(state.Web ?? {}).filter(([key]) => key.endsWith(`:${port}`));
  if (!listener && !endpoints.length) return;
  const handlers = state.Web?.[hostPort]?.Handlers;
  if (!listener?.HTTPS || listener.TCPForward || endpoints.length !== 1 || !handlers ||
      Object.keys(handlers).length !== 1 || !handlers['/']?.Proxy ||
      ![target, previous].includes(handlers['/'].Proxy)) {
    throw new Error('listener-conflict');
  }
}

/** Optional per-checkout HTTPS; no device identity or CLI output reaches shared logs. */
export async function syncDevHttps({ root, webPort, signal, run = runTailscale, waitReady = waitForLab, log = console.log }) {
  const dir = join(root, '.agent-state');
  const configPath = join(dir, 'dev-https.json');
  const statusPath = join(dir, 'dev-https.status.json');
  try {
    rmSync(statusPath, { force: true });
    if (!existsSync(configPath)) return { status: 'disabled' };
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config.enabled === false) return { status: 'disabled' };
    if (config.enabled !== true || !Number.isInteger(config.httpsPort) || config.httpsPort < 1 || config.httpsPort > 65535 ||
        !Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw new Error('invalid-config');
    signal?.throwIfAborted();
    const target = `http://127.0.0.1:${webPort}`;
    await waitReady(target, signal);
    signal?.throwIfAborted();
    const status = run(['status', '--json']);
    if (status.BackendState !== 'Running') throw new Error('not-connected');
    const host = status.Self?.DNSName?.replace(/\.$/, '');
    if (typeof host !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.ts\.net$/i.test(host)) throw new Error('invalid-host');
    const hostPort = `${host}:${config.httpsPort}`;
    const state = run(['serve', 'status', '--json']);
    validateReservation(state, hostPort, config.httpsPort, target, config.lastTarget);
    signal?.throwIfAborted();
    run(['serve', '--bg', `--https=${config.httpsPort}`, target]);
    const applied = run(['serve', 'status', '--json']);
    validateReservation(applied, hostPort, config.httpsPort, target, target);
    if (applied.Web?.[hostPort]?.Handlers?.['/']?.Proxy !== target) throw new Error('not-applied');
    mkdirSync(dir, { recursive: true });
    privateJson(configPath, { enabled: true, httpsPort: config.httpsPort, lastTarget: target });
    privateJson(statusPath, { httpsUrl: `https://${host}${config.httpsPort === 443 ? '' : `:${config.httpsPort}`}`, target, updatedAt: new Date().toISOString() });
    log('[dev-lab] HTTPS ready (Tailnet only). Private URL: .agent-state/dev-https.status.json');
    return { status: 'ready' };
  } catch {
    log('[dev-lab] HTTPS unavailable or cancelled; local HTTP remains available. Check local Tailscale login, HTTPS port ownership and .agent-state/dev-https.json.');
    return { status: 'unavailable' };
  }
}
