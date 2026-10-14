import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { MicroserviceAgentSandbox } from '../dist/sandbox/microservice-agent-sandbox.js';
import { RemoteVmAgentSandbox } from '../dist/sandbox/remote-vm-agent-sandbox.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

test('bash and work_evidence request network; omitted runner calls stay closed', async () => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    bodies.push(JSON.parse(await readBody(req)));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stdout: 'ok\n', stderr: '', code: 0 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const previous = {
    kind: process.env.RAW_AGENT_AGENT_SANDBOX_KIND,
    runner: process.env.RAW_AGENT_SANDBOX_RUNNER_URL
  };
  process.env.RAW_AGENT_AGENT_SANDBOX_KIND = 'microservice';
  process.env.RAW_AGENT_SANDBOX_RUNNER_URL = base;
  const dir = mkdtempSync(join(tmpdir(), 'bash-net-flag-'));
  const ctx = { repoRoot: dir, stateDir: dir, workspaceRoot: dir, agent: { id: 'test' }, session: { id: 'test' } };
  try {
    const tools = createBuiltinTools({});
    const bash = tools.find((tool) => tool.name === 'bash');
    const evidence = tools.find((tool) => tool.name === 'work_evidence');
    const bashResult = await bash.execute(ctx, { command: 'printf ok' });
    assert.equal(bashResult.ok, true, bashResult.content);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].allowNetwork, true);

    const beforeEvidence = bodies.length;
    const evidenceResult = await evidence.execute(ctx, { include_diff_stat: false });
    assert.equal(evidenceResult.ok, true, evidenceResult.content);
    const evidenceBodies = bodies.slice(beforeEvidence);
    assert.ok(evidenceBodies.length > 0);
    assert.ok(evidenceBodies.every((body) => body.allowNetwork === true));

    const micro = new MicroserviceAgentSandbox({ RAW_AGENT_SANDBOX_RUNNER_URL: base });
    const remote = new RemoteVmAgentSandbox({ RAW_AGENT_SANDBOX_REMOTE_URL: base });
    const mark = bodies.length;
    await micro.execute({ command: 'echo hi', cwd: dir, workspace: dir });
    await micro.execute({ command: 'echo hi', cwd: dir, workspace: dir, allowNetwork: true });
    await remote.execute({ command: 'echo hi', cwd: dir, workspace: dir });
    await remote.execute({ command: 'echo hi', cwd: dir, workspace: dir, allowNetwork: false });
    assert.equal(bodies[mark].allowNetwork, false);
    assert.equal(bodies[mark + 1].allowNetwork, true);
    assert.equal(bodies[mark + 2].allowNetwork, false);
    assert.equal(bodies[mark + 3].allowNetwork, false);
  } finally {
    if (previous.kind === undefined) delete process.env.RAW_AGENT_AGENT_SANDBOX_KIND;
    else process.env.RAW_AGENT_AGENT_SANDBOX_KIND = previous.kind;
    if (previous.runner === undefined) delete process.env.RAW_AGENT_SANDBOX_RUNNER_URL;
    else process.env.RAW_AGENT_SANDBOX_RUNNER_URL = previous.runner;
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
});
