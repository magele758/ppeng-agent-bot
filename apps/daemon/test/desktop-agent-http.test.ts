import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCompositeRegisteredMachineBackend,
  createRegisteredMachinePort,
  getSharedDesktopAgentHub,
  httpStatusFromError,
  RawAgentRuntime,
  ResourceOwnerStore,
  setSharedDesktopAgentHubForTests,
  type RequestAuth
} from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { desktopAgentRoutes, resetDesktopAgentSessionsForTests } from '../dist/routes/desktop-agent.js';

async function boot() {
  resetDesktopAgentSessionsForTests();
  setSharedDesktopAgentHubForTests(undefined);
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agent-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'desktop-agent-http',
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
  }).addAll(desktopAgentRoutes());
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
      resetDesktopAgentSessionsForTests();
      setSharedDesktopAgentHubForTests(undefined);
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

test('SSE attach delivers shell and POST reply completes it [AC:registered-machine-desktop-agent#AC-4]', async () => {
  const env = await boot();
  try {
    const principal = { userId: 'owner' };
    const port = createRegisteredMachinePort(
      env.runtime.store,
      createCompositeRegisteredMachineBackend({ agentHub: getSharedDesktopAgentHub() })
    );
    port.register(principal, { machineId: 'desk', label: 'Desk', kind: 'desktop' });

    const ac = new AbortController();
    const res = await fetch(`${env.root}/api/desktop-agent/desk/events`, { signal: ac.signal });
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
    assert.equal(getSharedDesktopAgentHub().isAttached('desk'), true);

    const shellP = port.shell(principal, 'desk', { command: 'uname' });
    while (!text.includes('event: op')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    const op = parseSse(text).find((row) => row.event === 'op') as {
      data: { requestId: string; kind: string; input: { command: string } };
    };
    assert.equal(op.data.kind, 'shell');
    assert.equal(op.data.input.command, 'uname');

    const unknown = await fetch(`${env.root}/api/desktop-agent/desk/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'missing', result: { ok: true, content: 'no' } })
    });
    assert.equal(unknown.status, 404);

    const reply = await fetch(`${env.root}/api/desktop-agent/desk/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: op.data.requestId, result: { ok: true, content: 'linux', exitCode: 0 } })
    });
    assert.equal(reply.status, 200);
    const shell = await shellP;
    assert.equal(shell.ok, true);
    assert.equal(shell.content, 'linux');

    const detach = await fetch(`${env.root}/api/desktop-agent/desk/detach`, { method: 'POST' });
    assert.equal(detach.status, 200);
    assert.equal(getSharedDesktopAgentHub().isAttached('desk'), false);
    const after = await port.shell(principal, 'desk', { command: 'later' });
    assert.equal(after.ok, false);
    assert.match(after.content, /machine_disconnected/);

    ac.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    await env.close();
  }
});
