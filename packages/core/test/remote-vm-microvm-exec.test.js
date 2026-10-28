import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RemoteVmAgentSandbox } from '../dist/sandbox/remote-vm-agent-sandbox.js';
import {
  resolveMicrovmRemoteUrl,
  resolveRemoteVmExecBaseUrl,
  postMicrovmExec
} from '../dist/sandbox/microvm-remote-url.js';

test('resolveMicrovmRemoteUrl prefers MICROVM_URL', () => {
  assert.equal(
    resolveMicrovmRemoteUrl({ RAW_AGENT_SANDBOX_MICROVM_URL: 'http://127.0.0.1:9999/' }),
    'http://127.0.0.1:9999'
  );
  assert.equal(
    resolveRemoteVmExecBaseUrl({
      RAW_AGENT_SANDBOX_REMOTE_URL: 'http://adapter',
      RAW_AGENT_SANDBOX_REMOTE_BACKEND: 'microvm'
    }),
    'http://adapter'
  );
});

test('e2e mock agent-sandbox-microvm /exec returns exit code + controlled output', async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/exec') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.equal(typeof parsed.command, 'string');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            stdout: `ran:${parsed.command}`,
            stderr: '',
            code: 0
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const direct = await postMicrovmExec(base, {
      command: 'echo hi',
      cwd: '/workspace',
      workspace: '/workspace'
    });
    assert.equal(direct.ok, true);
    assert.equal(direct.parsed.code, 0);
    assert.equal(direct.parsed.stdout, 'ran:echo hi');

    const sandbox = new RemoteVmAgentSandbox({
      RAW_AGENT_SANDBOX_MICROVM_URL: base,
      RAW_AGENT_SANDBOX_REMOTE_BACKEND: 'microvm'
    });
    const result = await sandbox.execute({
      command: 'uname -a',
      cwd: '/workspace',
      workspace: '/workspace',
      timeoutMs: 5_000
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'ran:uname -a');
    assert.equal(result.kind, 'remote_vm');
    assert.equal(result.backend, 'remote_vm-microvm');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('unconfigured remote_vm fails closed with code 127', async () => {
  const sandbox = new RemoteVmAgentSandbox({});
  const result = await sandbox.execute({
    command: 'echo x',
    cwd: '/tmp',
    workspace: '/tmp'
  });
  assert.equal(result.code, 127);
  assert.match(result.stderr, /not configured|MICROVM|REMOTE_URL/);
});
