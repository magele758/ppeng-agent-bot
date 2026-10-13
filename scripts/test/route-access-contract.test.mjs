/**
 * Route authorization contract, driven over HTTP against the real daemon route
 * registry (apps/daemon/dist/app.js) in-process, with Lab login enabled:
 *
 *   - every registered route has an access class (and the policy has no stale keys)
 *   - every non-public route answers 401 without a Lab session
 *   - every admin route answers 403 to a plain signed-in user
 *   - every owner route answers 403/404 when user B names user A's resource,
 *     and B's update/delete attempts leave A's resources intact
 *   - every self-filtered list hides user A's rows from user B
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuthStore, hashToken, RawAgentRuntime } from '@ppeng/agent-core';
import { createDaemonApp } from '../../apps/daemon/dist/app.js';
import { buildRoutePolicy } from '../../apps/daemon/dist/access/policy.js';
import { Router } from '../../apps/daemon/dist/routing.js';

const idleAdapter = {
  name: 'idle',
  async runTurn() {
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
  },
  async summarizeMessages() {
    return '';
  }
};

const DAEMON_TOKEN = ['contract', randomBytes(8).toString('hex')].join('-');

function labEnv(extra = {}) {
  return {
    RAW_AGENT_OAUTH_GITHUB_CLIENT_ID: 'contract-client',
    RAW_AGENT_OAUTH_GITHUB_CLIENT_SECRET: ['contract', 'secret'].join('-'),
    ...extra
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const c of request) chunks.push(Buffer.from(c));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Boots the real daemon app on an ephemeral port with users A, B (member) and admin C.
 * `gatewayPrefix` mounts the capability gateway (no `RAW_AGENT_GATEWAY_TOKEN`) at that prefix.
 */
export async function bootDaemon(env, { gatewayPrefix } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'authz-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'authz-state-'));
  const runtime = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: idleAdapter });
  const gatewayCtx = gatewayPrefix && {
    runtime,
    repoRoot,
    stateDir,
    env: { enabled: true, pathPrefix: gatewayPrefix, learnEnabled: false, learnDailyHourUtc: 6 },
    fileConfigRef: { current: {} }
  };
  const authStore = new AuthStore(runtime.store.db);
  const app = createDaemonApp({
    runtime,
    authStore,
    env,
    repoRoot,
    config: { storageCtx: {}, domainsMounted: [] },
    pkgName: 'contract',
    pkgVersion: '0.0.0',
    readBody: readJsonBody,
    readBodyLimit: 2_000_000,
    gateway: () => gatewayCtx || undefined
  });
  const server = createServer(async (request, response) => {
    try {
      if (!(await app.handle(request, response))) {
        response.statusCode = 404;
        response.end('static');
      }
    } catch (error) {
      response.statusCode = error.statusCode ?? 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const memory = runtime.store.agentMemory();
  const tokens = {};
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  memory.upsertTenant({ id: 'default', name: 'Default', createdAt: new Date().toISOString() });
  for (const [who, id, role] of [['A', 'user_a', 'member'], ['B', 'user_b', 'member'], ['C', 'user_c', 'admin']]) {
    memory.upsertUser({ id, email: `${id}@example.test`, status: 'active', createdAt: new Date().toISOString() });
    memory.addMembership({ userId: id, tenantId: 'default', role });
    tokens[who] = randomBytes(16).toString('hex');
    authStore.createAuthSession({ tokenHash: hashToken(tokens[who]), userId: id, expiresAt, createdAt: new Date().toISOString() });
  }

  /**
   * `as`: 'A' | 'B' | 'C' (Lab user), 'anon' (Lab proxy, no cookie), 'operator' (bearer, no Lab header), 'raw'.
   * `lab: false` drops the `x-ppeng-lab` header while keeping the user's cookie.
   */
  async function call(as, method, path, body, { lab = as !== 'raw' && as !== 'operator' } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (lab) headers['x-ppeng-lab'] = '1';
    if (env.RAW_AGENT_AUTH_TOKEN && as !== 'raw') headers.authorization = `Bearer ${env.RAW_AGENT_AUTH_TOKEN}`;
    if (tokens[as]) headers.cookie = `ppeng_lab_session=${tokens[as]}`;
    const res = await fetch(base + path, {
      method,
      headers,
      redirect: 'manual',
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }
    return { status: res.status, data, text };
  }

  return { runtime, app, call, tokens, close: () => new Promise((r) => server.close(r)) };
}

const DUMMY_PARAMS = { decision: 'approve', gate: 'review', name: 'nope', itemId: 'nope', messageId: 'nope', rootId: 'nope', runId: 'nope', userId: 'user_a' };

function fillPath(pattern, fixtureId) {
  return pattern.replace(/:(\w+)/g, (_m, name) =>
    name === 'id' || name === 'taskId' ? encodeURIComponent(fixtureId) : DUMMY_PARAMS[name] ?? 'nope'
  );
}

/** Creates one resource of every owner kind as user A. */
async function seedFixtures(d) {
  const { call, runtime } = d;
  const ok = (r, what) => {
    assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text.slice(0, 200)}`);
    return r.data;
  };
  const session = ok(await call('A', 'POST', '/api/sessions', { title: 'A-secret', autoRun: false }), 'session').session;
  const f = { session: session.id, user: 'user_a' };
  f.task = ok(await call('A', 'POST', '/api/tasks', { title: 'A-task', autoRun: false }), 'task').task.id;
  f.goal = ok(await call('A', 'POST', '/api/goals', { sessionId: f.session, condition: 'A-goal' }), 'goal').goal.goalId;
  f.bot = ok(await call('A', 'POST', '/api/bots', { name: 'A Bot' }), 'bot').bot.id;
  f['cron-job'] = ok(
    await call('A', 'POST', '/api/cron/jobs', { name: 'a-cron', prompt: 'A-CRON', cron: '0 9 * * *', sessionId: f.session, enabled: false }),
    'cron'
  ).job.id;
  f['memory-entry'] = ok(await call('A', 'POST', '/api/memory', { scope: 'user.memory', key: 'a-key', value: 'A-MEM-SECRET' }), 'memory').entry.id;
  f['team-plan'] = ok(await call('A', 'POST', '/api/teams/plans', { objective: 'A-PLAN' }), 'plan').plan.id;
  f['swarm-run'] = ok(await call('A', 'POST', '/api/swarm/runs', { goal: 'A-SWARM' }), 'swarm').run.id;
  f['swarm-task'] = ok(
    await call('A', 'POST', `/api/swarm/runs/${f['swarm-run']}/tasks`, { title: 'A-swarm-task' }),
    'swarm task'
  ).task.id;
  f['research-task'] = ok(await call('A', 'POST', '/api/research/tasks', { query: 'A-RESEARCH' }), 'research').task.id;
  f['orchestration-run'] = ok(await call('A', 'POST', '/api/orchestration/runs', { title: 'A-ORCH' }), 'orch').run.id;
  f['cloud-folder'] = ok(await call('A', 'POST', '/api/cloud-folders', { name: 'A-folder' }), 'folder').folder.id;

  mkdirSync(join(runtime.stateDir, 'contract-artifacts'), { recursive: true });
  writeFileSync(join(runtime.stateDir, 'contract-artifacts', 'a.txt'), 'A-ARTIFACT-SECRET');
  f.artifact = runtime.store.createArtifactIndex({
    id: 'art_contract_a',
    sessionId: f.session,
    sourceTool: 'contract',
    fileName: 'a.txt',
    mimeType: 'text/plain',
    localRelPath: 'contract-artifacts/a.txt',
    totalBytes: 17,
    totalChars: 17,
    pageSizeChars: 1000,
    totalPages: 1,
    createdAt: new Date().toISOString()
  }).id;
  f.approval = runtime.store.createApproval({ sessionId: f.session, toolName: 'bash', reason: 'contract', args: {} }).id;
  return f;
}

/** Owner routes whose resource is named in the body / query instead of the path. */
function bodyRefCases(f) {
  return {
    'POST /api/sessions': { workspaceBinding: { kind: 'cloud_folder', cloudFolderId: f['cloud-folder'] }, autoRun: false },
    'POST /api/chat': { sessionId: f.session, message: 'B-INJECT' },
    'POST /api/chat/stream': { sessionId: f.session, message: 'B-INJECT' },
    'GET /api/traces': `?sessionId=${f.session}`,
    'POST /api/goals': { sessionId: f.session, condition: 'B-goal' },
    'POST /api/teams': { name: 'x', role: 'r', prompt: 'p', parentSessionId: f.session, autoRun: false },
    'POST /api/teams/plans': { objective: 'B into A', sessionId: f.session },
    'POST /api/cron/jobs': { name: 'b', prompt: 'B-INJECTED', cron: '* * * * *', sessionId: f.session, enabled: true },
    'POST /api/memory': { scope: 'user.memory', key: 'b-poison', value: 'B-POISON', userId: 'user_a' },
    'POST /api/swarm/runs': { goal: 'B', orchestrationRunId: f['orchestration-run'] }
  };
}

/** Self-filtered writes that need a request shaped around A's data. */
function selfFilteredWriteCases(f) {
  return {
    'POST /api/sessions/cancel-all': {},
    'POST /api/sessions/bulk-delete': { ids: [f.session] },
    'POST /api/memory/preview': { query: 'secret memory', userId: 'user_a' },
    'POST /api/memory/dream-now': { userId: 'user_a', messagesText: 'B wants A memory' },
    'POST /api/tasks': { title: 'B-task', autoRun: false },
    'POST /api/bots': { name: 'B Bot' },
    'POST /api/research/tasks': { query: 'B' },
    'POST /api/orchestration/runs': { title: 'B' },
    'POST /api/cloud-folders': { name: 'B-folder' }
  };
}

const ownerReadRoute = {
  session: '/api/sessions/:id',
  artifact: '/api/artifact/:id/download',
  task: '/api/tasks/:id',
  goal: '/api/goals/:id',
  bot: '/api/bots/:id',
  'cron-job': '/api/cron/jobs/:id',
  user: '/api/users/:id',
  'team-plan': '/api/teams/plans/:id',
  'swarm-run': '/api/swarm/runs/:id',
  'research-task': '/api/research/tasks/:id',
  'orchestration-run': '/api/orchestration/runs/:id',
  'cloud-folder': '/api/cloud-folders/:id'
};

test('route access contract: every route is classified, isolated, and A-owned data stays private [AC:lab-auth-and-route-access#AC-1] [AC:lab-auth-and-route-access#AC-3] [AC:lab-auth-and-route-access#AC-4]', async (t) => {
  const d = await bootDaemon(labEnv({ RAW_AGENT_AUTH_TOKEN: DAEMON_TOKEN }));
  t.after(() => d.close());
  const routes = d.app.router.list();
  const key = (r) => `${r.method} ${r.pattern}`;

  await t.test('registry and policy table match exactly', () => {
    const kinds = new Set(['public', 'authenticated', 'self-filtered', 'owner', 'admin']);
    for (const r of routes) assert.ok(kinds.has(r.access.kind), `${key(r)} has class ${r.access.kind}`);
    const policy = buildRoutePolicy({ runtime: d.runtime, owners: { ownerOf: () => undefined } });
    const registered = new Set(routes.map(key));
    const stale = [...policy.keys()].filter((k) => !registered.has(k));
    assert.deepEqual(stale, [], 'policy entries without a route');
    assert.ok(routes.length >= 200, `expected the full registry, got ${routes.length}`);
  });

  const f = await seedFixtures(d);
  const bodyCases = bodyRefCases(f);
  const writeCases = selfFilteredWriteCases(f);

  await t.test('non-public routes require a Lab session (401); public ones do not [AC:lab-auth-and-route-access#AC-1]', async () => {
    for (const r of routes) {
      const path = fillPath(r.pattern, 'nope');
      const anon = await d.call('anon', r.method, path, {});
      const raw = await d.call('raw', r.method, path, {});
      if (r.access.kind === 'public') {
        assert.notEqual(anon.status, 401, `${key(r)} should be public`);
      } else {
        assert.equal(anon.status, 401, `${key(r)} without cookie`);
        assert.equal(raw.status, 401, `${key(r)} without bearer`);
      }
    }
  });

  await t.test('admin routes reject plain users with 403 [AC:lab-auth-and-route-access#AC-3]', async () => {
    for (const r of routes.filter((x) => x.access.kind === 'admin')) {
      const res = await d.call('B', r.method, fillPath(r.pattern, 'nope'), {});
      assert.equal(res.status, 403, `${key(r)} as member`);
      assert.equal(res.data.error, 'admin_required');
    }
    assert.equal((await d.call('C', 'GET', '/api/secrets')).status, 200, 'tenant admin');
    assert.equal((await d.call('operator', 'GET', '/api/secrets')).status, 200, 'operator bearer');
  });

  await t.test('authenticated GET routes stay reachable for plain users', async () => {
    for (const r of routes.filter((x) => x.access.kind === 'authenticated' && x.method === 'GET')) {
      const res = await d.call('B', 'GET', fillPath(r.pattern, 'nope'));
      assert.ok(![401, 403].includes(res.status), `${key(r)} -> ${res.status}`);
    }
  });

  await t.test("owner routes hide A's resources from B [AC:lab-auth-and-route-access#AC-4]", async () => {
    for (const r of routes.filter((x) => x.access.kind === 'owner')) {
      const k = key(r);
      const pathOwner = r.pattern.includes('/:');
      assert.ok(pathOwner || k in bodyCases, `${k}: add a body/query case for its owner reference`);
      const fixtureId = f[r.access.resource];
      if (pathOwner) assert.ok(fixtureId, `${k}: no fixture for resource ${r.access.resource}`);
      const bodyCase = bodyCases[k];
      const path = fillPath(r.pattern, fixtureId) + (typeof bodyCase === 'string' ? bodyCase : '');
      const res = await d.call('B', r.method, path, typeof bodyCase === 'object' ? bodyCase : {});
      assert.ok([403, 404].includes(res.status), `${k} as B -> ${res.status} ${res.text.slice(0, 160)}`);
    }
  });

  await t.test("A still owns every resource after B's attempts [AC:lab-auth-and-route-access#AC-4]", async () => {
    for (const [resource, pattern] of Object.entries(ownerReadRoute)) {
      const res = await d.call('A', 'GET', fillPath(pattern, f[resource]));
      assert.equal(res.status, 200, `${resource} readable by A: ${res.text.slice(0, 160)}`);
    }
    const cron = await d.call('A', 'GET', `/api/cron/jobs/${f['cron-job']}`);
    assert.equal(cron.data.job.prompt, 'A-CRON');
    const memory = await d.call('A', 'GET', '/api/memory?scope=user.memory');
    assert.ok(memory.text.includes('A-MEM-SECRET'));
    assert.ok(!memory.text.includes('B-POISON'));
  });

  await t.test("self-filtered routes never return A's rows to B [AC:lab-auth-and-route-access#AC-4]", async () => {
    const secrets = Object.entries(f)
      .filter(([k]) => k !== 'user')
      .map(([, v]) => v)
      .concat(['A-MEM-SECRET', 'A-CRON', 'A-PLAN', 'A-SWARM', 'A-RESEARCH', 'A-ORCH']);
    for (const r of routes.filter((x) => x.access.kind === 'self-filtered')) {
      const k = key(r);
      let res;
      if (r.method === 'GET') {
        res = await d.call('B', 'GET', r.pattern);
      } else {
        assert.ok(k in writeCases, `${k}: add a self-filtered write case`);
        res = await d.call('B', r.method, r.pattern, writeCases[k]);
      }
      assert.ok(![401, 403].includes(res.status), `${k} -> ${res.status}`);
      for (const s of secrets) assert.ok(!res.text.includes(s), `${k} leaked ${s}`);
    }
    assert.equal((await d.call('A', 'GET', `/api/sessions/${f.session}`)).status, 200, 'bulk-delete spared A');
  });
});

test('a route missing from the access policy cannot be registered', () => {
  const router = new Router({ readBody: readJsonBody, policy: new Map() });
  assert.throws(
    () => router.add({ method: 'GET', pattern: '/api/brand-new', handler() {} }),
    /Unclassified route GET \/api\/brand-new/
  );
});

test('without a daemon token, omitting the Lab header never bypasses login [AC:lab-auth-and-route-access#AC-6]', async (t) => {
  const d = await bootDaemon(labEnv());
  t.after(() => d.close());
  const session = (await d.call('A', 'POST', '/api/sessions', { title: 'A-only', autoRun: false })).data.session;
  const noLab = { lab: false };

  assert.equal((await d.call('raw', 'GET', '/api/sessions')).status, 401, 'no cookie, no header');
  assert.equal((await d.call('raw', 'POST', '/api/users', { id: 'user_x', email: 'x@example.test' })).status, 401);
  assert.equal((await d.call('B', 'GET', `/api/sessions/${session.id}`, undefined, noLab)).status, 404);
  assert.equal((await d.call('B', 'GET', '/api/secrets', undefined, noLab)).status, 403);
  assert.equal((await d.call('A', 'GET', `/api/sessions/${session.id}`, undefined, noLab)).status, 200);
  const list = await d.call('B', 'GET', '/api/sessions', undefined, noLab);
  assert.ok(!list.text.includes(session.id), 'B list without Lab header');
});

test('gateway prefix is reachable and never bypasses the daemon token [AC:lab-auth-and-route-access#AC-1]', async (t) => {
  const outside = await bootDaemon(labEnv({ RAW_AGENT_AUTH_TOKEN: DAEMON_TOKEN }), { gatewayPrefix: '/gateway/v1' });
  t.after(() => outside.close());
  assert.equal((await outside.call('operator', 'GET', '/gateway/v1/health')).status, 200, 'default prefix reachable');
  assert.equal((await outside.call('raw', 'GET', '/gateway/v1/health')).status, 401);

  const inside = await bootDaemon(labEnv({ RAW_AGENT_AUTH_TOKEN: DAEMON_TOKEN }), { gatewayPrefix: '/api/gateway/v1' });
  t.after(() => inside.close());
  assert.equal((await inside.call('raw', 'GET', '/api/gateway/v1/health')).status, 401);
  assert.equal((await inside.call('raw', 'POST', '/api/gateway/v1/chat', { message: 'anon' })).status, 401);
  assert.equal((await inside.call('operator', 'GET', '/api/gateway/v1/health')).status, 200);

  const loginOnly = await bootDaemon(labEnv(), { gatewayPrefix: '/gateway/v1' });
  t.after(() => loginOnly.close());
  assert.equal((await loginOnly.call('raw', 'GET', '/gateway/v1/health')).status, 401, 'Lab login without any token');

  const singleUser = await bootDaemon({}, { gatewayPrefix: '/gateway/v1' });
  t.after(() => singleUser.close());
  assert.equal((await singleUser.call('raw', 'GET', '/gateway/v1/health')).status, 200, 'single-user mode stays open');
});

test('tenant admins manage roles only inside their own tenant [AC:lab-auth-and-route-access#AC-5]', async (t) => {
  const d = await bootDaemon(labEnv());
  t.after(() => d.close());
  assert.equal((await d.call('B', 'GET', '/api/secrets')).status, 403);
  assert.equal((await d.call('B', 'PUT', '/api/tenants/default/members/user_b', { role: 'owner' })).status, 403);
  assert.equal((await d.call('C', 'PUT', '/api/tenants/other/members/user_b', { role: 'owner' })).status, 403);
  assert.equal((await d.call('C', 'PUT', '/api/tenants/default/members/user_b', { role: 'admin' })).status, 200);
  assert.equal((await d.call('B', 'GET', '/api/secrets')).status, 200, 'promoted member');
});
