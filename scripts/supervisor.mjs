#!/usr/bin/env node
/**
 * Supervisor for raw-agent daemon.
 *
 * Starts the daemon as a child process, polls its /api/daemon/restart-request
 * endpoint, and restarts the child when:
 *   1. The daemon writes a restart_request (e.g. after a self-heal merge)
 *   2. The daemon crashes unexpectedly (non-zero exit / signal)
 *
 * Usage:
 *   node scripts/supervisor.mjs
 *   # or: pnpm run start:supervised
 *
 * Environment vars forwarded to daemon unchanged. Loads `<repo>/.env` first
 * (does not override variables already set) so the health probe uses the same
 * port the daemon will bind. PM2 only signals this process; on SIGINT/SIGTERM
 * the child is signaled and this process waits for it to exit.
 *
 * Set SUPERVISOR_POLL_MS   to control restart-request poll interval (default 3000).
 * Set SUPERVISOR_MAX_RESTARTS to cap crash-loop restarts (default 20, 0 = unlimited).
 * Set SUPERVISOR_CRASH_RESET_MS to reset crash counter after stable run (default 300000 = 5 min).
 * Set SUPERVISOR_SHUTDOWN_GRACE_MS to how long to wait before SIGKILL (default 8000).
 * Set SUPERVISOR_ENV_FILE / SUPERVISOR_DAEMON_ENTRY to override the env file and
 * the child entry (tests only; not a product switch).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { sanitizeScriptEnv } from './spawn-utils.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');
const envFile = process.env.SUPERVISOR_ENV_FILE
  ? resolve(process.env.SUPERVISOR_ENV_FILE)
  : join(repoRoot, '.env');
dotenv.config({ path: envFile, quiet: true });

const daemonEntry = process.env.SUPERVISOR_DAEMON_ENTRY
  ? resolve(process.env.SUPERVISOR_DAEMON_ENTRY)
  : join(repoRoot, 'apps', 'daemon', 'dist', 'server.js');

const host = process.env.RAW_AGENT_DAEMON_HOST ?? '127.0.0.1';
const port = Number(process.env.RAW_AGENT_DAEMON_PORT ?? 37070);
const pollMs = Number(process.env.SUPERVISOR_POLL_MS ?? 3000);
const maxRestarts = Number(process.env.SUPERVISOR_MAX_RESTARTS ?? 20);
const crashResetMs = Number(process.env.SUPERVISOR_CRASH_RESET_MS ?? 300_000);
const shutdownGraceMs = Number(process.env.SUPERVISOR_SHUTDOWN_GRACE_MS ?? 8_000);

const baseUrl = `http://${host}:${port}`;

let crashCount = 0;
let lastCrashAt = 0;
let supervisorRunning = true;
let activeChild = null;
let shutdownRequested = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkRestartRequest() {
  try {
    const res = await fetch(`${baseUrl}/api/daemon/restart-request`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.restartRequest != null;
  } catch {
    return false;
  }
}

async function ackRestartRequest() {
  try {
    await fetch(`${baseUrl}/api/daemon/restart-request/ack`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000)
    });
  } catch {
    /* best-effort */
  }
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const d = await res.json();
        if (d?.ok) return true;
      }
    } catch {
      /* not ready yet */
    }
    await sleep(300);
  }
  return false;
}

function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch (err) {
    console.error('[supervisor] failed to signal daemon:', err.message);
  }
}

function spawnDaemon() {
  console.log(`[supervisor] starting daemon: ${daemonEntry}`);
  const child = spawn(process.execPath, [daemonEntry], {
    cwd: repoRoot,
    // Strip injection vectors before forwarding env to the daemon (Tier 0
    // sandbox parity — see scripts/spawn-utils.mjs and AGENTS.md).
    env: sanitizeScriptEnv(),
    stdio: 'inherit'
  });
  activeChild = child;
  child.on('error', (err) => {
    console.error('[supervisor] daemon spawn error:', err.message);
  });
  child.on('exit', () => {
    if (activeChild === child) activeChild = null;
  });
  return child;
}

function shutdownSupervisor(signal) {
  if (shutdownRequested) {
    console.warn(`[supervisor] ${signal} during shutdown — forcing daemon exit`);
    signalChild(activeChild, 'SIGKILL');
    process.exit(1);
    return;
  }
  shutdownRequested = true;
  supervisorRunning = false;
  console.log(`[supervisor] ${signal} received, shutting down`);
  const child = activeChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    process.exit(0);
    return;
  }
  const forwarded = signal === 'SIGINT' || signal === 'SIGTERM' ? signal : 'SIGTERM';
  signalChild(child, forwarded);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    process.exit(0);
  };
  const timer = setTimeout(() => {
    console.warn('[supervisor] daemon still running after grace period, sending SIGKILL');
    signalChild(child, 'SIGKILL');
  }, shutdownGraceMs);
  child.once('exit', finish);
  if (child.exitCode !== null || child.signalCode !== null) finish();
}

async function runLoop() {
  while (supervisorRunning) {
    const now = Date.now();
    if (maxRestarts > 0 && now - lastCrashAt > crashResetMs) {
      crashCount = 0;
    }
    if (maxRestarts > 0 && crashCount >= maxRestarts) {
      console.error(
        `[supervisor] crash-loop protection: reached ${crashCount} restarts within ${crashResetMs}ms. Giving up.`
      );
      process.exitCode = 1;
      return;
    }

    const child = spawnDaemon();

    let exitedByRequest = false;

    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    // Poll for restart_request while daemon is alive
    const pollLoop = (async () => {
      // Wait for daemon to be healthy before polling
      const healthy = await waitForHealth();
      if (!healthy) {
        console.warn('[supervisor] daemon did not become healthy within timeout');
        return;
      }
      console.log('[supervisor] daemon healthy, polling for restart-requests');

      while (supervisorRunning) {
        await sleep(pollMs);
        // Check if daemon is still running
        if (child.exitCode !== null) break;

        const shouldRestart = await checkRestartRequest();
        if (shouldRestart) {
          console.log('[supervisor] restart-request detected — ACK and restarting daemon');
          await ackRestartRequest();
          exitedByRequest = true;
          child.kill('SIGTERM');
          // Give it a moment to shut down gracefully
          await sleep(2000);
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
          break;
        }
      }
    })();

    const { code, signal } = await exitPromise;
    // Cancel poll loop if still running
    exitedByRequest = exitedByRequest || child.exitCode !== null;

    await pollLoop.catch(() => {});

    if (!supervisorRunning) break;

    if (exitedByRequest) {
      console.log(`[supervisor] daemon exited cleanly (code=${code ?? signal}), restarting for new cycle`);
    } else {
      lastCrashAt = Date.now();
      crashCount += 1;
      console.warn(
        `[supervisor] daemon crashed (code=${code ?? signal}), restart #${crashCount}/${maxRestarts || '∞'}`
      );
      await sleep(Math.min(1000 * crashCount, 10_000));
    }
  }
}

process.on('SIGINT', () => { shutdownSupervisor('SIGINT'); });
process.on('SIGTERM', () => { shutdownSupervisor('SIGTERM'); });

console.log(`[supervisor] starting (poll=${pollMs}ms, maxRestarts=${maxRestarts || '∞'}, daemon=${baseUrl})`);
runLoop().catch((err) => {
  console.error('[supervisor] fatal:', err);
  process.exit(1);
});
