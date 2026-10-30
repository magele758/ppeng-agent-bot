import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ANONYMOUS_AUTH, RawAgentRuntime, ResourceOwnerStore, createDurablePagePort, httpStatusFromError, type RequestAuth } from '@ppeng/agent-core';
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

async function bootHttp() {
  const { dir, runtime } = boot();
  const user = { id: 'page-admin', tenantId: 'page-tests' };
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async () => ({})
  }).addAll(libraryPageRoutes(runtime));
  const server = createServer((request, response) => {
    const role = request.headers['x-test-role'];
    const auth: RequestAuth = {
      ...ANONYMOUS_AUTH, isolate: true,
      user: role === 'admin' || role === 'member' ? user : null,
      admin: role === 'admin'
    };
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost'), auth)
      .then((found) => {
        if (!found) { response.statusCode = 404; response.end(); }
      })
      .catch((error: unknown) => {
        response.statusCode = httpStatusFromError(error);
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    port: createDurablePagePort(runtime.store),
    send(method: string, path: string, role = 'admin') {
      return fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { 'x-test-role': role } });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('admin DELETE revokes page and share reads and removes its list entry [AC:delete-page#AC-2]', async () => {
  const h = await bootHttp();
  try {
    const page = h.port.create({ title: 'Delete', markdown: 'Body' });
    const keep = h.port.create({ title: 'Keep', markdown: 'Untouched' });
    const path = `/api/library/pages/${page.id}`;
    assert.equal((await h.send('GET', `/api/pages/share/${page.shareId}`, 'anonymous')).status, 200);
    assert.equal((await h.send('DELETE', path, 'anonymous')).status, 401);
    assert.equal((await h.send('DELETE', path, 'member')).status, 403);
    assert.deepEqual(h.port.get(page.id), page);
    const removed = await h.send('DELETE', path);
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { deleted: true, id: page.id });
    assert.equal((await h.send('GET', path)).status, 404);
    assert.equal((await h.send('GET', `/api/pages/share/${page.shareId}`, 'anonymous')).status, 404);
    const listed = await (await h.send('GET', '/api/library/pages')).json() as { pages: { id: string }[] };
    assert.deepEqual(listed.pages.map((row) => row.id), [keep.id]);
    assert.deepEqual(h.port.get(keep.id), keep);
  } finally {
    await h.close();
  }
});

test('public share does not accept DELETE even for an admin [AC:delete-page#AC-3]', async () => {
  const h = await bootHttp();
  try {
    const page = h.port.create({ title: 'Keep', markdown: 'Shared' });
    const path = `/api/pages/share/${page.shareId}`;
    for (const role of ['anonymous', 'admin']) {
      assert.equal((await h.send('DELETE', path, role)).status, 404);
      assert.equal((await h.send('GET', path, 'anonymous')).status, 200);
      assert.deepEqual(h.port.get(page.id), page);
    }
  } finally {
    await h.close();
  }
});

test('admin deletion rejects unknown, share, and blank ids without mis-deletion [AC:delete-page#AC-5]', async () => {
  const h = await bootHttp();
  try {
    const page = h.port.create({ title: 'Keep', markdown: 'Shared' });
    for (const id of ['page_missing', page.shareId, "' OR 1=1 --"]) {
      assert.equal((await h.send('DELETE', `/api/library/pages/${encodeURIComponent(id)}`)).status, 404);
    }
    assert.equal((await h.send('DELETE', '/api/library/pages/%20')).status, 400);
    assert.equal((await h.send('DELETE', '/api/library/pages')).status, 404);
    assert.deepEqual(h.port.getByShareId(page.shareId), page);
    assert.deepEqual(h.port.list().map((row) => row.id), [page.id]);
    assert.equal((await h.send('DELETE', `/api/library/pages/${page.id}`)).status, 200);
    assert.equal((await h.send('DELETE', `/api/library/pages/${page.id}`)).status, 404);
  } finally {
    await h.close();
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
