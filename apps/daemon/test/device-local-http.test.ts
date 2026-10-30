import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCompositeRegisteredMachineBackend,
  createDesktopAgentHub,
  createRegisteredMachinePort,
  getSharedDeviceLocalHub,
  httpStatusFromError,
  RawAgentRuntime,
  ResourceOwnerStore,
  setSharedDeviceLocalHubForTests,
  type RequestAuth
} from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { deviceLocalRoutes, resetDeviceLocalSessionsForTests } from '../dist/routes/device-local.js';

async function boot() {
  resetDeviceLocalSessionsForTests();
  setSharedDeviceLocalHubForTests(undefined);
  const dir = mkdtempSync(join(tmpdir(), 'device-local-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'device-local-http',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      return raw ? JSON.parse(raw) : {};
    }
  }).addAll(deviceLocalRoutes());
  const server = createServer((request, response) => {
    void dispatch(router, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    runtime,
    root: `http://127.0.0.1:${address.port}`,
    async close() {
      resetDeviceLocalSessionsForTests();
      setSharedDeviceLocalHubForTests(undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function dispatch(router: Router, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const auth: RequestAuth = { isolate: false, labProxy: false, user: null, admin: true };
  return router
    .dispatch(request, response, new URL(request.url ?? '/', 'http://localhost'), auth)
    .then((found) => {
      if (!found && !response.writableEnded) {
        response.statusCode = 404;
        response.end();
      }
    })
    .catch((error: unknown) => {
      if (response.writableEnded) return;
      response.statusCode = httpStatusFromError(error);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
}

function parseSse(chunk: string): Array<{ event: string; data: unknown }> {
  return chunk
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? '';
      const dataLine = block.match(/^data: (.+)$/m)?.[1] ?? '{}';
      return { event, data: JSON.parse(dataLine) as unknown };
    });
}

test('device-local SSE delivers read, keeps shell readonly, and detach fails closed [AC:registered-machine-phone-local#AC-5]', async () => {
  const env = await boot();
  try {
    const principal = { userId: 'owner' };
    const port = createRegisteredMachinePort(
      env.runtime.store,
      createCompositeRegisteredMachineBackend({
        agentHub: createDesktopAgentHub(),
        deviceLocalHub: getSharedDeviceLocalHub()
      })
    );
    port.register(principal, {
      machineId: 'pixel',
      label: 'Pixel',
      kind: 'phone',
      deviceLocalTools: [{ toolId: 'device_shell', state: 'available' }]
    });

    const ac = new AbortController();
    const res = await fetch(`${env.root}/api/device-local/pixel/events`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: ready')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const ready = parseSse(text).find((row) => row.event === 'ready') as {
      data: { attached: boolean; shell: boolean; copy: boolean };
    };
    assert.equal(ready.data.attached, true);
    assert.equal(ready.data.shell, false);
    assert.equal(ready.data.copy, false);
    assert.equal(getSharedDeviceLocalHub().isAttached('pixel'), true);
    assert.equal((await port.listLive(principal))[0]?.connected, true);

    const readP = port.read(principal, 'pixel', { path: 'note.txt' });
    while (!text.includes('event: op')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    const op = parseSse(text).find((row) => row.event === 'op') as {
      data: { requestId: string; kind: string; input: { path: string } };
    };
    assert.equal(op.data.kind, 'read');
    assert.equal(op.data.input.path, 'note.txt');

    const shell = await port.shell(principal, 'pixel', { command: 'id' });
    assert.equal(shell.ok, false);
    assert.match(shell.content, /device_local_readonly/);
    assert.equal(parseSse(text).filter((row) => row.event === 'op').length, 1);

    const reply = await fetch(`${env.root}/api/device-local/pixel/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: op.data.requestId, result: { ok: true, content: 'line1' } })
    });
    assert.equal(reply.status, 200);
    assert.equal((await readP).content, 'line1');

    const detach = await fetch(`${env.root}/api/device-local/pixel/detach`, { method: 'POST' });
    assert.equal(detach.status, 200);
    assert.equal(getSharedDeviceLocalHub().isAttached('pixel'), false);
    const after = await port.read(principal, 'pixel', { path: 'note.txt' });
    assert.equal(after.ok, false);
    assert.match(after.content, /machine_disconnected/);

    ac.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    await env.close();
  }
});

test('device-local SSE shell opt-in stays unavailable until device_shell is available [AC:registered-machine-phone-local#AC-6]', async () => {
  const env = await boot();
  try {
    const principal = { userId: 'owner' };
    const port = createRegisteredMachinePort(
      env.runtime.store,
      createCompositeRegisteredMachineBackend({
        agentHub: createDesktopAgentHub(),
        deviceLocalHub: getSharedDeviceLocalHub()
      })
    );
    port.register(principal, {
      machineId: 'pixel',
      label: 'Pixel',
      kind: 'phone',
      deviceLocalTools: [{ toolId: 'device_shell', state: 'needs_permission' }]
    });

    const ac = new AbortController();
    const res = await fetch(`${env.root}/api/device-local/pixel/events?shell=1`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: ready')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const ready = parseSse(text).find((row) => row.event === 'ready') as { data: { shell: boolean } };
    assert.equal(ready.data.shell, true);
    assert.equal(getSharedDeviceLocalHub().get('pixel')?.shell, true);

    const blocked = await port.shell(principal, 'pixel', { command: 'pwd' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.content, /device_local_tool_unavailable/);
    assert.equal(text.includes('event: op'), false);

    port.register(principal, {
      machineId: 'pixel',
      label: 'Pixel',
      kind: 'phone',
      deviceLocalTools: [{ toolId: 'device_shell', state: 'available' }]
    });
    const shellP = port.shell(principal, 'pixel', { command: 'pwd' });
    while (!text.includes('event: op')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    const op = parseSse(text).find((row) => row.event === 'op') as {
      data: { requestId: string; kind: string };
    };
    assert.equal(op.data.kind, 'shell');
    const reply = await fetch(`${env.root}/api/device-local/pixel/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: op.data.requestId, result: { ok: true, content: 'echo:pwd', exitCode: 0 } })
    });
    assert.equal(reply.status, 200);
    assert.match((await shellP).content, /echo:pwd/);

    ac.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    await env.close();
  }
});
