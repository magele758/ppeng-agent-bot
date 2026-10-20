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
 * Environment vars forwarded to daemon unchanged.
 * Set SUPERVISOR_POLL_MS   to control restart-request poll interval (default 3000).
 * Set SUPERVISOR_MAX_RESTARTS to cap crash-loop restarts (default 20, 0 = unlimited).
 * Set SUPERVISOR_CRASH_RESET_MS to reset crash counter after stable run (default 300000 = 5 min).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sanitizeScriptEnv } from './spawn-utils.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');
const daemonEntry = join(repoRoot, 'apps', 'daemon', 'dist', 'server.js');

const host = process.env.RAW_AGENT_DAEMON_HOST ?? '127.0.0.1';
const port = Number(process.env.RAW_AGENT_DAEMON_PORT ?? 37070);
const pollMs = Number(process.env.SUPERVISOR_POLL_MS ?? 3000);
const maxRestarts = Number(process.env.SUPERVISOR_MAX_RESTARTS ?? 20);
const crashResetMs = Number(process.env.SUPERVISOR_CRASH_RESET_MS ?? 300_000);

const baseUrl = `http://${host}:${port}`;

let crashCount = 0;
let lastCrashAt = 0;
let supervisorRunning = true;

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

function spawnDaemon() {
  console.log(`[supervisor] starting daemon: ${daemonEntry}`);
  const child = spawn(process.execPath, [daemonEntry], {
    cwd: repoRoot,
    // Strip injection vectors before forwarding env to the daemon (Tier 0
    // sandbox parity — see scripts/spawn-utils.mjs and AGENTS.md).
    env: sanitizeScriptEnv(),
    stdio: 'inherit'
  });
  child.on('error', (err) => {
    console.error('[supervisor] daemon spawn error:', err.message);
  });
  return child;
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

process.on('SIGINT', () => {
  console.log('[supervisor] SIGINT received, shutting down');
  supervisorRunning = false;
  process.exit(0);
});
process.on('SIGTERM', () => {
  supervisorRunning = false;
  process.exit(0);
});

console.log(`[supervisor] starting (poll=${pollMs}ms, maxRestarts=${maxRestarts || '∞'})`);
runLoop().catch((err) => {
  console.error('[supervisor] fatal:', err);
  process.exit(1);
});
