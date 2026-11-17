import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { miscRoutes } from '../dist/routes/misc.js';
import { sessionsRoutes } from '../dist/routes/sessions.js';

function listen(runtime: RawAgentRuntime): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      return raw ? JSON.parse(raw) : {};
    }
  }).addAll([
    ...miscRoutes(runtime, { pkgName: 'test', pkgVersion: '0' }),
    ...sessionsRoutes(runtime)
  ]);
  const server = createServer((request, response) => {
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost')).then((found) => {
      if (!found) {
        response.statusCode = 404;
        response.end();
      }
    }).catch((error: unknown) => {
      if (!response.headersSent) response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  const { promise, resolve } = Promise.withResolvers<{ port: number; close: () => Promise<void> }>();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    resolve({
      port: address.port,
      close: () => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      })
    });
  });
  return promise;
}

test('本会话始终允许记在会话上，只覆盖同类，撤销后清空 [AC:console-sections-redesign#AC-1] [AC:console-sections-redesign#AC-2] [AC:console-sections-redesign#AC-3]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-grant-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: dir,
    modelAdapter: {
      name: 'grant',
      async summarizeMessages() { return ''; },
      async runTurn() { return { stopReason: 'end' as const, assistantParts: [] }; },
      async completeText() { return ''; }
    }
  });
  const server = await listen(runtime);
  try {
    const session = runtime.store.createSession({ title: 'grant', mode: 'chat', agentId: 'general', background: false, metadata: {} });
    const other = runtime.store.createSession({ title: 'other', mode: 'chat', agentId: 'general', background: false, metadata: {} });
    const os = runtime.store.createApproval({ sessionId: session.id, toolName: 'bash', reason: 'need', args: { command: 'ls', isolation: 'os' } });
    const same = runtime.store.createApproval({ sessionId: session.id, toolName: 'bash', reason: 'need', args: { command: 'pwd', isolation: 'os' } });
    const direct = runtime.store.createApproval({ sessionId: session.id, toolName: 'bash', reason: 'need', args: { command: 'ls', isolation: 'direct' } });
    const post = await fetch(`http://127.0.0.1:${server.port}/api/approvals/${os.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionGrant: true })
    });
    assert.equal(post.status, 200, await post.text());
    assert.equal(runtime.store.getApproval(os.id)?.status, 'approved');
    assert.equal(runtime.store.getApproval(same.id)?.status, 'approved');
    assert.equal(runtime.store.getApproval(direct.id)?.status, 'pending');
    assert.deepEqual(runtime.getSession(session.id)?.metadata.sessionToolGrants, [{ toolName: 'bash', isolation: 'os' }]);
    assert.equal(runtime.getSession(other.id)?.metadata.sessionToolGrants, undefined);
    const revoke = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToolGrants: [{ toolName: 'write_file', isolation: 'unspecified' }] })
    });
    assert.equal(revoke.status, 200, await revoke.text());
    assert.deepEqual(runtime.getSession(session.id)?.metadata.sessionToolGrants, [{ toolName: 'write_file', isolation: 'unspecified' }]);
    const clear = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToolGrants: [{ toolName: '*', isolation: 'os' }] })
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(runtime.getSession(session.id)?.metadata.sessionToolGrants, []);
  } finally {
    await server.close();
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
