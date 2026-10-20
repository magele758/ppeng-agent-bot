import {createRequire} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const electronBin = createRequire(join(repoRoot,'apps/desktop/package.json'))('electron');
const packedDaemon = join(
  repoRoot,
  'apps/desktop/release/linux-unpacked/resources/server-bundle/apps/daemon/dist/server.js'
);
const packedCwd = join(repoRoot, 'apps/desktop/release/linux-unpacked/resources/server-bundle');
const skip = !existsSync(electronBin) || !existsSync(packedDaemon);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

test('packed daemon becomes healthy via ELECTRON_RUN_AS_NODE', { skip }, async () => {
  const port = await freePort();
  const stateDir = mkdtempSync(join(tmpdir(), 'desktop-packed-health-'));
  const child = spawn(electronBin, [packedDaemon], {
    cwd: packedCwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      ELECTRON_RUN_AS_NODE: '1',
      RAW_AGENT_STATE_DIR: stateDir,
      RAW_AGENT_DAEMON_HOST: '127.0.0.1',
      RAW_AGENT_DAEMON_PORT: String(port),
      RAW_AGENT_AUTH_TOKEN: 'packed-health-test',
      NODE_ENV: 'production'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (buf) => {
    logs += buf.toString();
  });
  child.stderr.on('data', (buf) => {
    logs += buf.toString();
  });
  try {
    let lastErr = '';
    for (let i = 0; i < 30; i += 1) {
      if (child.exitCode !== null) {
        throw new Error(`daemon exited ${child.exitCode}: ${logs}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1000)
        });
        if (res.ok) {
          const body = await res.json();
          assert.equal(body.ok, true);
          return;
        }
        lastErr = `status ${res.status}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`health timeout: ${lastErr}\n${logs}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});
