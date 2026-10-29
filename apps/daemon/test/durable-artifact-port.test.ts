import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, writeIngestionSettings } from '@ppeng/agent-core';
import { attachmentRoutes } from '../dist/routes/attachments.js';
import { createDaemonArtifactPort } from '../dist/artifact-port.js';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'dur-art-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'artifact-port',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  return { dir, runtime, routes: attachmentRoutes(runtime) };
}

function invoke(
  routes: ReturnType<typeof attachmentRoutes>,
  pattern: string,
  params: Record<string, string>
): { status: number; body: string | Buffer | undefined; headers: Record<string, string> } {
  const spec = routes.find((route) => route.method === 'GET' && route.pattern === pattern);
  if (!spec) throw new Error(`missing route ${pattern}`);
  const headers: Record<string, string> = {};
  let body: string | Buffer | undefined;
  let status = 0;
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(raw?: string | Buffer) {
      status = this.statusCode;
      body = raw;
    }
  };
  spec.handler({
    requireParam: (name: string) => {
      const value = params[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
    auth: { isolate: false, labProxy: false, user: null },
    response
  } as never);
  return { status, body, headers };
}

test('会话产物列表和下载能拿到模型没看到的尾部 [AC:durable-artifact-port#AC-6]', () => {
  const { dir, runtime, routes } = boot();
  try {
    writeIngestionSettings(runtime.store, {
      toolResultArchiveChars: 2000,
      archivePreviewChars: 100,
      pageSizeChars: 1000
    });
    const session = runtime.store.createSession({ title: 'artifacts', mode: 'chat', agentId: 'general' });
    const sentinel = 'TAIL-SENTINEL-9f3c';
    const content = `HEAD-${'x'.repeat(3000)}${sentinel}`;
    const retained = createDaemonArtifactPort(runtime).retain({
      sessionId: session.id,
      source: 'bash',
      content
    });
    assert.equal(retained.mode, 'ref');
    if (retained.mode !== 'ref') return;
    assert.equal(retained.text.includes(sentinel), false);

    const listed = invoke(routes, '/api/sessions/:id/artifacts', { id: session.id });
    assert.equal(listed.status, 200);
    const payload = JSON.parse(String(listed.body)) as { artifacts: Array<{ id: string }> };
    assert.ok(payload.artifacts.some((row) => row.id === retained.ref.handle));

    const downloaded = invoke(routes, '/api/artifact/:id/download', { id: retained.ref.handle });
    assert.equal(downloaded.status, 200);
    assert.match(String(downloaded.body), /TAIL-SENTINEL-9f3c/);
    assert.match(downloaded.headers['content-disposition'] ?? '', /bash\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
