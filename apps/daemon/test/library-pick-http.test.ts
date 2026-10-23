import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  httpStatusFromError,
  LAB_BROWSER_HOST_HEADER as coreBrowserHost,
  RawAgentRuntime,
  ResourceOwnerStore,
  type FolderPickResult,
  type RequestAuth
} from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { attachmentRoutes } from '../dist/routes/attachments.js';
import { libraryPickRoutes } from '../dist/routes/library-pick.js';
import { applyLibraryPick, withoutLibraryDir } from '../../web-console/components/sections/knowledge/library-dirs-model.ts';
import { LAB_BROWSER_HOST_HEADER as webBrowserHost } from '../../web-console/lib/daemon-proxy.ts';

const SECRET = 'librarypicksecretsentinel';
const OUTSIDE = 'librarypickoutsidesentinel';

function folder(root: string): string {
  return realpathSync(mkdtempSync(join(root, 'notes-')));
}

async function boot(pick: (deps?: { signal?: AbortSignal }) => Promise<FolderPickResult>) {
  const dir = mkdtempSync(join(tmpdir(), 'library-pick-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'library-pick-http',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  let auth: RequestAuth | undefined;
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      return raw ? JSON.parse(raw) : {};
    }
  })
    .addAll(attachmentRoutes(runtime))
    .addAll(libraryPickRoutes(runtime, { pick }));
  const server = createServer((request, response) => {
    void dispatch(router, request, response, auth);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    runtime,
    root: `http://127.0.0.1:${address.port}`,
    setAuth(next: RequestAuth | undefined) {
      auth = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function dispatch(
  router: Router,
  request: IncomingMessage,
  response: ServerResponse,
  auth: RequestAuth | undefined
): Promise<void> {
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

async function readSettings(root: string): Promise<string[]> {
  const res = await fetch(`${root}/api/ingestion/settings`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { settings: { libraryDirs: string[] } };
  return body.settings.libraryDirs;
}

test('选择的文件夹会追加保存并索引，重复路径不加两次 [AC:knowledge-library-dirs#AC-6] [AC:knowledge-library-dirs#AC-7] [AC:knowledge-library-dirs#AC-4]', async () => {
  const work = mkdtempSync(join(tmpdir(), 'library-pick-dirs-'));
  const first = folder(work);
  const second = folder(work);
  const outside = folder(work);
  writeFileSync(join(first, 'keep.md'), 'pickbeaconone lives here');
  writeFileSync(join(first, '.env'), SECRET);
  writeFileSync(join(first, 'id_rsa'), SECRET);
  writeFileSync(join(first, 'credentials'), SECRET);
  writeFileSync(join(second, 'more.md'), 'pickbeacontwo lives here');
  writeFileSync(join(outside, 'other.md'), OUTSIDE);
  const queue = [first, second, first];
  let cursor = 0;
  let picks = 0;
  const env = await boot(async () => {
    picks += 1;
    const path = queue[cursor] ?? first;
    cursor += 1;
    return { status: 'selected', path };
  });
  try {
    const choose = async () => {
      const res = await fetch(`${env.root}/api/library/pick-folder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(res.status, 200);
      return res.json() as Promise<FolderPickResult>;
    };
    const save = async (dirs: string[]) => {
      const res = await fetch(`${env.root}/api/ingestion/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ libraryDirs: dirs })
      });
      assert.equal(res.status, 200);
      return ((await res.json()) as { settings: { libraryDirs: string[] } }).settings.libraryDirs;
    };
    const search = (query: string) =>
      env.runtime.store.agentMemory().search({ scope: 'library', query, limit: 10 });

    let dirs = await readSettings(env.root);
    assert.deepEqual(dirs, []);
    const one = applyLibraryPick(dirs, await choose());
    assert.equal(one.action, 'save');
    if (one.action === 'save') dirs = await save(one.dirs);
    assert.deepEqual(dirs, [first]);
    assert.equal(search('pickbeaconone').length, 1);
    assert.equal(search(SECRET).length, 0);
    assert.equal(search(OUTSIDE).length, 0);

    const two = applyLibraryPick(dirs, await choose());
    assert.equal(two.action, 'save');
    if (two.action === 'save') dirs = await save(two.dirs);
    assert.deepEqual(dirs, [first, second]);
    assert.equal(search('pickbeacontwo').length, 1);
    assert.equal(search('pickbeaconone').length, 1);

    const again = applyLibraryPick(dirs, await choose());
    assert.equal(again.action, 'duplicate');
    assert.deepEqual(await readSettings(env.root), [first, second]);
    assert.deepEqual(await save([first, first, second]), [first, second]);

    dirs = await save(withoutLibraryDir([first, second], second));
    assert.deepEqual(dirs, [first]);
    assert.equal(search('pickbeacontwo').length, 0);
    assert.equal(search('pickbeaconone').length, 1);

    assert.deepEqual(await save([]), []);
    assert.equal(search('pickbeaconone').length, 0);
    assert.equal(picks, 3);
  } finally {
    await env.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test('取消、远程和指定路径不会写入列表，也不会读出文件 [AC:knowledge-library-dirs#AC-8] [AC:knowledge-library-dirs#AC-9]', async () => {
  const work = mkdtempSync(join(tmpdir(), 'library-pick-guard-'));
  const notes = folder(work);
  const secretFile = join(notes, 'secret.txt');
  writeFileSync(secretFile, SECRET);
  let mode: 'cancelled' | 'unavailable' = 'cancelled';
  let picks = 0;
  const env = await boot(async (deps) => {
    picks += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(deps?.signal?.aborted, false);
    return { status: mode };
  });
  try {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${env.root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
      });

    const cancelled = await post('/api/library/pick-folder', {}, {
      'x-forwarded-host': '0.0.0.0:23000',
      [coreBrowserHost]: '127.0.0.1:23000'
    });
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as FolderPickResult).status, 'cancelled');
    assert.deepEqual(await readSettings(env.root), []);
    assert.equal(picks, 1);

    mode = 'unavailable';
    const headless = await post('/api/library/pick-folder', {});
    assert.equal(((await headless.json()) as FolderPickResult).status, 'unavailable');
    assert.deepEqual(await readSettings(env.root), []);

    const beforeGuard = picks;
    const supplied = await post('/api/library/pick-folder', { path: secretFile, marker: SECRET });
    const suppliedText = await supplied.text();
    assert.equal(supplied.status, 400);
    assert.equal(suppliedText.includes(SECRET), false);
    assert.equal(suppliedText.includes('path_not_accepted'), true);
    const queried = await post(`/api/library/pick-folder?path=${encodeURIComponent(secretFile)}`, {});
    const queriedText = await queried.text();
    assert.equal(queried.status, 400);
    assert.equal(queriedText.includes(SECRET), false);
    const remote = await post('/api/library/pick-folder', {}, { 'x-forwarded-host': 'evil.example' });
    assert.equal(remote.status, 403);
    assert.equal(((await remote.json()) as { error: string }).error, 'local_only');
    const otherMachine = await post('/api/library/pick-folder', {}, {
      'x-forwarded-host': '0.0.0.0:23000',
      [webBrowserHost]: '192.168.1.40:23000'
    });
    assert.equal(otherMachine.status, 403);
    assert.equal(((await otherMachine.json()) as { error: string }).error, 'local_only');
    assert.equal(coreBrowserHost, webBrowserHost);
    assert.equal(picks, beforeGuard);

    env.setAuth({ isolate: true, labProxy: true, admin: false, user: { id: 'bob', tenantId: 't', email: 'bob@example.test' } });
    const member = await post('/api/library/pick-folder', {});
    assert.equal(member.status, 403);
    assert.equal(((await member.json()) as { error: string }).error, 'admin_required');

    env.setAuth({ isolate: true, labProxy: true, admin: false, user: null });
    const anon = await post('/api/library/pick-folder', {});
    assert.equal(anon.status, 401);
    assert.equal(picks, beforeGuard);
    env.setAuth(undefined);
    assert.deepEqual(await readSettings(env.root), []);
  } finally {
    await env.close();
    rmSync(work, { recursive: true, force: true });
  }
});
