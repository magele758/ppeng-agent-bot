import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { SandboxManager } from '../dist/sandbox/os-sandbox.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

test('bash tool can use the network in auto mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-net-auto-'));
  const previous = process.env.RAW_AGENT_SANDBOX_MODE;
  process.env.RAW_AGENT_SANDBOX_MODE = 'auto';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pong-net');
  });
  const address = await listen(server);
  assert.ok(address && typeof address === 'object');
  const command = `node -e "fetch('http://127.0.0.1:${address.port}/').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exit(1)})"`;
  try {
    const bash = createBuiltinTools({}).find((tool) => tool.name === 'bash');
    const result = await bash.execute(
      { repoRoot: dir, stateDir: dir, workspaceRoot: dir, agent: { id: 'test' }, session: { id: 'test' } },
      { command, timeout_ms: 8000 }
    );
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /pong-net/);

    const mgr = new SandboxManager('auto');
    if (mgr.activeTier > 0) {
      const denied = await mgr.execute(command, dir, { workspace: dir, timeoutMs: 8000 });
      assert.notEqual(denied.code, 0, `${denied.stdout}\n${denied.stderr}`);
    }
  } finally {
    if (previous === undefined) delete process.env.RAW_AGENT_SANDBOX_MODE;
    else process.env.RAW_AGENT_SANDBOX_MODE = previous;
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bash tool keeps model settings and drops RAW_AGENT API keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-net-env-'));
  const previousKey = process.env.RAW_AGENT_API_KEY;
  const previousName = process.env.RAW_AGENT_MODEL_NAME;
  process.env.RAW_AGENT_API_KEY = 'sk-should-not-leak';
  process.env.RAW_AGENT_MODEL_NAME = 'kept-model';
  try {
    const bash = createBuiltinTools({}).find((tool) => tool.name === 'bash');
    const result = await bash.execute(
      { repoRoot: dir, stateDir: dir, workspaceRoot: dir, agent: { id: 'test' }, session: { id: 'test' } },
      { command: 'printf %s "$RAW_AGENT_API_KEY|$RAW_AGENT_MODEL_NAME"' }
    );
    assert.equal(result.ok, true, result.content);
    assert.equal(result.content, '|kept-model');
  } finally {
    if (previousKey === undefined) delete process.env.RAW_AGENT_API_KEY;
    else process.env.RAW_AGENT_API_KEY = previousKey;
    if (previousName === undefined) delete process.env.RAW_AGENT_MODEL_NAME;
    else process.env.RAW_AGENT_MODEL_NAME = previousName;
    rmSync(dir, { recursive: true, force: true });
  }
});
