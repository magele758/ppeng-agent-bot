import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryIndexWatcher, RawAgentRuntime, ResourceOwnerStore, writeIngestionSettings } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { attachmentRoutes } from '../dist/routes/attachments.js';
import { miscRoutes } from '../dist/routes/misc.js';

function folder(root: string): string {
  return realpathSync(mkdtempSync(join(root, 'notes-')));
}

function holdIndex(): { entered: Promise<void>; release: () => void; restore: () => void } {
  const original = LibraryIndexWatcher.prototype.start;
  const entered = Promise.withResolvers<void>();
  let release = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  LibraryIndexWatcher.prototype.start = function (this: LibraryIndexWatcher) {
    entered.resolve();
    return gate.then(() => original.call(this));
  };
  return {
    entered: entered.promise,
    release,
    restore() {
      LibraryIndexWatcher.prototype.start = original;
    }
  };
}

async function boot(dir: string) {
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'library-index-yield',
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
  })
    .addAll(miscRoutes(runtime, { pkgName: 'test', pkgVersion: '0' }))
    .addAll(attachmentRoutes(runtime));
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
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.destroy();
    }
  };
}

function dispatch(router: Router, request: IncomingMessage, response: ServerResponse): Promise<void> {
  return router
    .dispatch(request, response, new URL(request.url ?? '/', 'http://localhost'))
    .then((found) => {
      if (!found && !response.writableEnded) {
        response.statusCode = 404;
        response.end();
      }
    })
    .catch((error: unknown) => {
      if (response.writableEnded) return;
      response.statusCode = 500;
      response.end(String(error));
    });
}

async function saveDirs(root: string, dirs: string[]): Promise<number> {
  const response = await fetch(`${root}/api/ingestion/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ libraryDirs: dirs })
  });
  return response.status;
}

function libraryHits(runtime: RawAgentRuntime, query: string): number {
  return runtime.store.agentMemory().search({ scope: 'library', query, limit: 10 }).length;
}

async function waitHits(runtime: RawAgentRuntime, query: string, count: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    if (libraryHits(runtime, query) === count) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(libraryHits(runtime, query), count, query);
}

test('保存很多文件的资料目录后健康检查仍然返回 [AC:library-index-yield#AC-1]', async () => {
  const held = holdIndex();
  const dir = mkdtempSync(join(tmpdir(), 'library-yield-save-'));
  const notes = folder(dir);
  for (let i = 0; i < 30; i += 1) writeFileSync(join(notes, `n${i}.md`), `filler ${i}`);
  writeFileSync(join(notes, 'keep.md'), 'savequartzbeacon stays searchable');
  let env: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    env = await boot(dir);
    await held.entered;
    const pending = saveDirs(env.root, [notes]);
    const status = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500))
    ]);
    assert.equal(status, 200);
    const health = await fetch(`${env.root}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.equal(libraryHits(env.runtime, 'savequartzbeacon'), 0);
    held.release();
    await pending;
    await waitHits(env.runtime, 'savequartzbeacon', 1);
  } finally {
    held.release();
    held.restore();
    await env?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端口刚开始接受访问时健康检查不必等资料库扫完 [AC:library-index-yield#AC-2]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'library-yield-boot-'));
  const notes = folder(dir);
  for (let i = 0; i < 30; i += 1) writeFileSync(join(notes, `n${i}.md`), `boot filler ${i}`);
  writeFileSync(join(notes, 'keep.md'), 'bootquartzbeacon stays searchable');
  const seed = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'library-index-seed',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  writeIngestionSettings(seed.store, { libraryDirs: [notes] });
  await seed.destroy();
  const held = holdIndex();
  let env: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    env = await boot(dir);
    await held.entered;
    const health = await fetch(`${env.root}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.equal(libraryHits(env.runtime, 'bootquartzbeacon'), 0);
    held.release();
    await waitHits(env.runtime, 'bootquartzbeacon', 1);
  } finally {
    held.release();
    held.restore();
    await env?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
