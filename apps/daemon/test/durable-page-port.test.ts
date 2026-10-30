import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANONYMOUS_AUTH, RawAgentRuntime, ResourceOwnerStore, createDurablePagePort } from '@ppeng/agent-core';
import { UnauthenticatedError } from '../dist/access/enforce.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { Router } from '../dist/routing.js';
import { libraryPageRoutes } from '../dist/routes/library-pages.js';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'dur-page-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'page-port',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  return { dir, runtime, routes: libraryPageRoutes(runtime) };
}

function invoke(
  routes: ReturnType<typeof libraryPageRoutes>,
  method: string,
  pattern: string,
  params: Record<string, string>,
  body?: unknown
): { status: number; json: Record<string, unknown> } {
  const spec = routes.find((route) => route.method === method && route.pattern === pattern);
  if (!spec) throw new Error(`missing route ${method} ${pattern}`);
  let status = 0;
  let raw = '';
  const response = {
    statusCode: 0,
    setHeader() {},
    end(chunk?: string) {
      status = this.statusCode;
      raw = chunk ?? '';
    }
  };
  const result = spec.handler({
    requireParam: (name: string) => {
      const value = params[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
    readBody: async () => body,
    auth: { isolate: false, labProxy: false, user: null },
    response
  } as never);
  return Promise.resolve(result).then(() => ({ status, json: raw ? JSON.parse(raw) : {} }));
}

test('daemon 列出、按 id 读取，并用分享链接读到同一页 [AC:durable-page-port#AC-6]', async () => {
  const { dir, routes } = boot();
  try {
    const created = await invoke(routes, 'POST', '/api/library/pages', {}, {
      title: '库页面',
      markdown: '# 分享正文'
    });
    assert.equal(created.status, 201);
    const page = created.json.page as { id: string; shareId: string; sharePath: string; revision: number };
    assert.equal(page.revision, 1);
    assert.equal(page.sharePath, `/pages/${page.shareId}`);

    const listed = await invoke(routes, 'GET', '/api/library/pages', {});
    assert.equal(listed.status, 200);
    const pages = listed.json.pages as Array<{ id: string; sharePath: string; markdown?: string }>;
    assert.equal(pages.some((row) => row.id === page.id && row.sharePath === page.sharePath), true);
    assert.equal(pages.some((row) => 'markdown' in row), false);

    const fetched = await invoke(routes, 'GET', '/api/library/pages/:id', { id: page.id });
    assert.equal(fetched.status, 200);
    assert.equal((fetched.json.page as { markdown: string }).markdown, '# 分享正文');

    const shared = await invoke(routes, 'GET', '/api/pages/share/:shareId', { shareId: page.shareId });
    assert.equal(shared.status, 200);
    const sharedPage = shared.json.page as { id: string; markdown: string; surface: unknown[] };
    assert.equal(sharedPage.id, page.id);
    assert.equal(sharedPage.markdown, '# 分享正文');
    assert.equal(Array.isArray(sharedPage.surface), true);

    const patched = await invoke(routes, 'PATCH', '/api/library/pages/:id', { id: page.id }, { markdown: '改过' });
    assert.equal(patched.status, 200);
    assert.equal((patched.json.page as { revision: number; shareId: string }).revision, 2);
    assert.equal((patched.json.page as { shareId: string }).shareId, page.shareId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('分享链接在登录隔离下仍可读，库列表不行 [AC:durable-page-port#AC-6]', async () => {
  const { dir, runtime } = boot();
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async () => ({})
  }).addAll(libraryPageRoutes(runtime));
  const created = createDurablePagePort(runtime.store).create({ title: '公开页', markdown: '分享正文' });
  const anonymous = { ...ANONYMOUS_AUTH, isolate: true };
  try {
    const shared = await dispatch(router, 'GET', `/api/pages/share/${created.shareId}`, anonymous);
    assert.equal(shared.status, 200);
    assert.equal((shared.json.page as { id: string; markdown: string }).id, created.id);
    assert.equal((shared.json.page as { markdown: string }).markdown, '分享正文');

    await assert.rejects(
      () => dispatch(router, 'GET', '/api/library/pages', anonymous),
      (error: unknown) => error instanceof UnauthenticatedError
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dispatch(
  router: Router,
  method: string,
  pathname: string,
  auth: { isolate: boolean; labProxy: boolean; user: null }
): Promise<{ status: number; json: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const response = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string) {
      status = this.statusCode;
      raw = chunk ?? '';
    }
  };
  return router
    .dispatch(
      { method, headers: {} } as never,
      response as never,
      new URL(pathname, 'http://127.0.0.1'),
      auth as never
    )
    .then(() => ({ status, json: raw ? JSON.parse(raw) : {} }));
}
