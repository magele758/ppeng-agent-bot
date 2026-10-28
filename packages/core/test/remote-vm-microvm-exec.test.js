import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteVmAgentSandbox } from '../dist/sandbox/remote-vm-agent-sandbox.js';
import { createAgentSandboxFromEnv } from '../dist/sandbox/create-agent-sandbox.js';
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

test('e2e mock agent-sandbox-microvm /exec returns exit code + controlled output [AC:remotevm-no-host-downgrade#AC-3]', async () => {
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

test('microvm kind does not run on the host when /exec is missing or down [AC:remotevm-no-host-downgrade#AC-1] [AC:remotevm-no-host-downgrade#AC-2]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'microvm-host-'));
  const marker = join(dir, 'host-ran');
  try {
    const unconfigured = createAgentSandboxFromEnv({ RAW_AGENT_AGENT_SANDBOX_KIND: 'microvm' });
    assert.equal(unconfigured.kind, 'remote_vm');
    const missing = await unconfigured.execute({
      command: `touch ${JSON.stringify(marker)}`,
      cwd: dir,
      workspace: dir
    });
    assert.equal(missing.code, 127);
    assert.equal(missing.kind, 'remote_vm');
    assert.equal(existsSync(marker), false);

    const down = new RemoteVmAgentSandbox({
      RAW_AGENT_SANDBOX_MICROVM_URL: 'http://127.0.0.1:1',
      RAW_AGENT_AGENT_SANDBOX_KIND: 'agent-sandbox-microvm'
    });
    const failed = await down.execute({
      command: `touch ${JSON.stringify(marker)}`,
      cwd: dir,
      workspace: dir,
      timeoutMs: 2_000
    });
    assert.notEqual(failed.code, 0);
    assert.equal(failed.kind, 'remote_vm');
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('microvm kind does not fall back to a generic remote URL or the host [AC:remotevm-no-host-downgrade#AC-4]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'microvm-generic-'));
  const marker = join(dir, 'host-ran');
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/exec') {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stdout: 'generic', stderr: '', code: 0 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const sandbox = createAgentSandboxFromEnv({
      RAW_AGENT_AGENT_SANDBOX_KIND: 'microvm',
      RAW_AGENT_SANDBOX_REMOTE_URL: `http://127.0.0.1:${port}`
    });
    const result = await sandbox.execute({
      command: `touch ${JSON.stringify(marker)}`,
      cwd: dir,
      workspace: dir
    });
    assert.equal(result.code, 127);
    assert.equal(result.kind, 'remote_vm');
    assert.equal(hits, 0);
    assert.equal(existsSync(marker), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('microvm /exec without a numeric code is not a success [AC:remotevm-no-host-downgrade#AC-2]', async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/exec') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stdout: 'should-not-count' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const sandbox = new RemoteVmAgentSandbox({ RAW_AGENT_SANDBOX_MICROVM_URL: `http://127.0.0.1:${port}` });
    const result = await sandbox.execute({ command: 'true', cwd: '/workspace', workspace: '/workspace' });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /numeric code/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
