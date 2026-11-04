import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function startDaemon() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const bodyText = await readBody(request);
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (request.method !== 'POST' || url.pathname !== '/api/sessions/sess-1/permission') {
      sendJson(response, 404, { error: 'no route' });
      return;
    }
    const entersBypass = body.shift === 'elevate' || body.mode === 'bypass';
    if (entersBypass && body.confirmBypass !== true) {
      sendJson(response, 400, { error: 'Setting permissionMode to bypass requires confirmBypass: true' });
      return;
    }
    sendJson(response, 200, { permission: { mode: body.mode === 'ask' ? 'ask' : 'bypass' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock daemon failed to bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

function runCli(baseUrl, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'apps/cli/src/index.ts', ...args], {
      cwd: root,
      env: { ...process.env, RAW_AGENT_DAEMON_BASE_URL: baseUrl, RAW_AGENT_AUTH_TOKEN: '' }
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cli timed out\n${stderr}\n${stdout}`));
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('提升到免审批或直接设为免审批时命令成功 [AC:cli-session-permission#AC-1]', async () => {
  const daemon = await startDaemon();
  try {
    const elevated = await runCli(daemon.baseUrl, ['session', 'permission', 'sess-1', 'elevate']);
    assert.equal(elevated.status, 0, elevated.stderr);
    assert.match(elevated.stdout, /bypass/);
    const direct = await runCli(daemon.baseUrl, ['session', 'permission', 'sess-1', 'bypass']);
    assert.equal(direct.status, 0, direct.stderr);
    assert.match(direct.stdout, /bypass/);
    const ask = await runCli(daemon.baseUrl, ['session', 'permission', 'sess-1', 'ask']);
    assert.equal(ask.status, 0, ask.stderr);
    assert.match(ask.stdout, /ask/);
  } finally {
    await daemon.close();
  }
});
