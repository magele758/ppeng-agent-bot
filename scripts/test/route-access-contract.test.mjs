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
import { AuthStore, BotGoalService, hashToken, RawAgentRuntime } from '@ppeng/agent-core';
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
    'POST /api/lab/composer-hint': { sessionId: f.session },
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
    'POST /api/memory/suppressions/:id/restore': {},
    'POST /api/memory/preview': { query: 'secret memory', userId: 'user_a' },
    'POST /api/memory/dream-now': { userId: 'user_a', messagesText: 'B wants A memory' },
    'POST /api/tasks': { title: 'B-task', autoRun: false },
    'POST /api/bots': { name: 'B Bot' },
    'POST /api/research/tasks': { query: 'B' },
    'POST /api/orchestration/runs': { title: 'B' },
    'POST /api/cloud-folders': { name: 'B-folder' },
    'POST /api/factory/development/:machine/:repository/preflight': {baseline:'a'.repeat(40)},
    'POST /api/factory/development/tasks': {machineId:'missing-private-machine',repositoryId:'core',requestKey:'foreign-development',requirement:'x',baseline:'a'.repeat(40)},
    'POST /api/factory/development/tasks/:id/control': {action:'cancel'},
    'POST /api/factory/development/tasks/:id/decision': {action:'resume'},
    'POST /api/factory/delivery/tasks/:id/verify': {},
    'POST /api/factory/delivery/tasks/:id/grant': {scope:'MERGED'},
    'POST /api/factory/delivery/tasks/:id/control': {action:'cancel'},
    'POST /api/factory/delivery/tasks/:id/decision': {action:'resume'},
    'POST /api/factory/delivery/:machine/:repository/preflight': {},
    'POST /api/factory/machines/:id/probe': {},
    'POST /api/factory/tasks': {machineId:'missing-private-machine',repositoryId:'core',operation:'snapshot',requestKey:'foreign'},
    'POST /api/factory/tasks/:id/cancel': {},
    'POST /api/factory/patrol/run': {},
    'POST /api/bot-work/tasks': { targetBotId: 'missing-private-target', input: 'B-request' },
    'POST /api/bot-work/tasks/:id/cancel': {},
    'POST /api/bot-work/bots/:id/control': {paused: true},
    'POST /api/bot-work/tasks/:id/retry': {},
    'POST /api/bot-work/tasks/:id/review': { attempt: 1, accepted: true },
    'POST /api/cron/runs/:id/retry': {},
    'POST /api/cron/runs/:id/cancel': {},
    'POST /api/cron/runs/:id/publication': {approved:true},
    'POST /api/bot-functional-groups': { name: 'B group' },
    'PATCH /api/bot-functional-groups/:id': { name: 'B replacement' },
    'DELETE /api/bot-functional-groups/:id': {},
    'PUT /api/bots/:id/functional-group': { groupId: null },
    'PUT /api/bot-rooms/:id/functional-group': { groupId: null },
    'PUT /api/bot-shared-context': { entries: { note: 'B own scope' } },
    'DELETE /api/bot-rooms/:id': {},
    'PATCH /api/bot-rooms/settings': { maxWaveSpeakers: 4 },
    'POST /api/bot-rooms': { title: 'B-room', botIds: ['missing-private-target'] },
    'PATCH /api/bot-rooms/:id': { title: 'B-change' },
    'POST /api/bot-rooms/:id/members': { botId: 'missing-private-target' },
    'DELETE /api/bot-rooms/:id/members/:botId': {},
    'POST /api/bot-rooms/:id/messages': { text: 'B-request' },
    'POST /api/bot-rooms/:id/stop': {},
    'POST /api/bot-rooms/:id/resume': {}
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
    const kinds = new Set(['public', 'authenticated', 'self-filtered', 'owner', 'admin', 'external-agent']);
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
    const ownBot = (await d.call('B', 'POST', '/api/bots', { name: 'B goal fixture' })).data.bot;
    const ownSession = (await d.call('B', 'POST', `/api/bots/${ownBot.id}/open`, {})).data.session;
    const ownGoals = new BotGoalService(d.runtime.store, Date.now, ownSession.id);
    const ownGoal = ownGoals.create({ botId: ownBot.id, sessionId: ownSession.id, title: 'B goal', objective: 'B work' });
    const scopedCases = {
      'GET /api/bots/:id/goals': { path: `/api/bots/${ownBot.id}/goals?sessionId=${ownSession.id}` },
      'PATCH /api/bots/:id/goals/settings': { path: `/api/bots/${ownBot.id}/goals/settings`, body: { sessionId: ownSession.id, maxConcurrent: 2 } },
      'POST /api/bots/:id/goals/:goalId/actions': { path: `/api/bots/${ownBot.id}/goals/${ownGoal.id}/actions`, body: { sessionId: ownSession.id, action: 'pause' } }
    };
    for (const r of routes.filter((x) => x.access.kind === 'self-filtered')) {
      const k = key(r);
      let res;
      const scoped = scopedCases[k];
      if (r.access.resource === 'bot-goals') assert.ok(scoped, `${k}: add a concrete scoped fixture`);
      if (r.method === 'GET') {
        res = await d.call('B', 'GET', scoped?.path ?? r.pattern);
      } else {
        assert.ok(k in writeCases || scoped?.body, `${k}: add a self-filtered write case`);
        res = await d.call('B', r.method, scoped?.path ?? r.pattern, scoped?.body ?? writeCases[k]);
      }
      if (scoped) {
        assert.equal(res.status, 200, `${k}: B can use their own goal scope`);
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


test('Bot work and Room writes reject another principal over real HTTP', async t => {
  const d = await bootDaemon(labEnv({ RAW_AGENT_AUTH_TOKEN: DAEMON_TOKEN }));
  t.after(() => d.close());
  const bot = await d.call('A', 'POST', '/api/bots', {name:'Owner-only Bot'});
  assert.equal(bot.status,201);
  const peer = await d.call('A', 'POST', '/api/bots', {name:'Owner-only Peer'});
  assert.equal(peer.status,201);
  const room = await d.call('A','POST','/api/bot-rooms',{title:'A private room',botIds:[bot.data.bot.id, peer.data.bot.id]});
  assert.equal(room.status,201);
  const rid=room.data.room.id;
  for (const [method,path,body] of [
    ['POST','/api/bot-work/tasks',{targetBotId:bot.data.bot.id,input:'forbidden'}],
    ['GET',`/api/bot-rooms/${rid}`],
    ['PATCH',`/api/bot-rooms/${rid}`,{title:'B replacement'}],
    ['POST',`/api/bot-rooms/${rid}/members`,{botId:bot.data.bot.id}],
    ['POST',`/api/bot-rooms/${rid}/messages`,{text:'B injection'}],
    ['POST',`/api/bot-rooms/${rid}/stop`,{}]
  ]) {
    const response=await d.call('B',method,path,body);
    assert.ok([403,404].includes(response.status),`${method} ${path}: ${response.status}`);
  }
  const preserved=await d.call('A','GET',`/api/bot-rooms/${rid}`);
  assert.equal(preserved.data.room.title,'A private room');
  assert.equal(preserved.data.room.status,'active');
  assert.equal((await d.call('A','GET',`/api/bot-rooms/${rid}/messages`)).data.messages.length,0);
});


test('functional groups and explicit global/group/room facts stay isolated across real HTTP principals [AC:bot-functional-groups#AC-9] [AC:bot-functional-groups#AC-10]', async t => {
  const d = await bootDaemon(labEnv({ RAW_AGENT_AUTH_TOKEN: DAEMON_TOKEN }));
  t.after(() => d.close());
  const bot = await d.call('A','POST','/api/bots',{name:'A scoped Bot'});
  assert.equal(bot.status,201);
  const peer = await d.call('A','POST','/api/bots',{name:'A scoped Peer'});
  assert.equal(peer.status,201);
  const botId=bot.data.bot.id;
  const group = await d.call('A','POST','/api/bot-functional-groups',{name:'A private function'});
  assert.equal(group.status,201);
  const groupId=group.data.group.id;
  const room=await d.call('A','POST','/api/bot-rooms',{title:'A shared facts room',botIds:[botId, peer.data.bot.id]});
  assert.equal(room.status,201);
  const roomId=room.data.room.id;
  assert.equal((await d.call('A','PUT',`/api/bots/${botId}/functional-group`,{groupId})).status,200);
  assert.equal((await d.call('A','PUT',`/api/bot-rooms/${roomId}/functional-group`,{groupId})).status,200);
  const scopes=[
    ['global','A_GLOBAL_SECRET'],
    [`group&id=${encodeURIComponent(groupId)}`,'A_GROUP_SECRET'],
    [`room&id=${encodeURIComponent(roomId)}`,'A_ROOM_SECRET']
  ];
  for(const [query,secret] of scopes) {
    const path=`/api/bot-shared-context?scope=${query}`;
    const written=await d.call('A','PUT',path,{entries:{fact:secret}});
    assert.equal(written.status,200,written.text);
    const otherRead=await d.call('B','GET',path);
    assert.ok(!otherRead.text.includes(secret),'shared facts never appear for another principal');
    if(query==='global') {
      assert.equal(otherRead.status,200);
      assert.deepEqual(otherRead.data.entries,{});
      assert.equal((await d.call('B','PUT',path,{entries:{fact:'B_OWN_GLOBAL'}})).status,200);
    } else {
      assert.ok([403,404].includes(otherRead.status),otherRead.text);
      const forbiddenWrite=await d.call('B','PUT',path,{entries:{fact:'B_POISON'}});
      assert.ok([403,404].includes(forbiddenWrite.status),forbiddenWrite.text);
    }
    const preserved=await d.call('A','GET',path);
    assert.equal(preserved.status,200);
    assert.deepEqual(preserved.data.entries,{fact:secret});
  }
  const ownGroup=await d.call('B','POST','/api/bot-functional-groups',{name:'B function'});
  assert.equal(ownGroup.status,201);
  for(const [method,path,body] of [
    ['PATCH',`/api/bot-functional-groups/${groupId}`,{name:'B takeover'}],
    ['DELETE',`/api/bot-functional-groups/${groupId}`],
    ['PUT',`/api/bots/${botId}/functional-group`,{groupId:null}],
    ['PUT',`/api/bots/${botId}/functional-group`,{groupId:ownGroup.data.group.id}],
    ['PUT',`/api/bot-rooms/${roomId}/functional-group`,{groupId:null}],
    ['PUT',`/api/bot-rooms/${roomId}/functional-group`,{groupId:ownGroup.data.group.id}]
  ]) {
    const response=await d.call('B',method,path,body);
    assert.ok([403,404].includes(response.status),`${method} ${path}: ${response.status} ${response.text}`);
  }
  const bList=await d.call('B','GET','/api/bot-functional-groups');
  assert.equal(bList.status,200);
  assert.ok(!bList.text.includes(groupId));
  assert.ok(!bList.text.includes('A private function'));
  const preservedGroups=await d.call('A','GET','/api/bot-functional-groups');
  assert.equal(preservedGroups.status,200);
  assert.deepEqual(preservedGroups.data.groups,[{id:groupId,name:'A private function',botIds:[botId],roomIds:[roomId]}]);
  const preservedBot=await d.call('A','GET',`/api/bots/${botId}`);
  assert.equal(preservedBot.status,200);
  assert.equal(preservedBot.data.bot.id,botId);
  assert.equal(preservedBot.data.bot.name,'A scoped Bot');
});


test('Bot goal reads and writes reject another owner and preserve session-scoped preferences', async t => {
  const d = await bootDaemon(labEnv({ RAW_AGENT_AUTH_TOKEN: DAEMON_TOKEN }));
  t.after(() => d.close());
  const fixtures = {};
  const sharedBot = d.runtime.createBot({ name: 'Shared goal Bot' });
  for (const who of ['A', 'B']) {
    const bot = sharedBot;
    const opened = await d.call(who, 'POST', `/api/bots/${bot.id}/open`, {});
    assert.equal(opened.status, 200);
    const sessionId = opened.data.session.id;
    const service = new BotGoalService(d.runtime.store, Date.now, sessionId);
    const goal = service.create({ botId: bot.id, sessionId, title: `${who}-PRIVATE-GOAL`, objective: `${who}-PRIVATE-WORK` });
    fixtures[who] = { bot, sessionId, service, goal };
  }
  const a = fixtures.A;
  const b = fixtures.B;
  assert.notEqual(a.sessionId, b.sessionId, 'shared Bot retains separate principal sessions');
  const aBase = `/api/bots/${a.bot.id}/goals`;
  for (const [method, path, body] of [
    ['GET', `${aBase}?sessionId=${a.sessionId}`],
    ['PATCH', `${aBase}/settings`, { sessionId: a.sessionId, maxConcurrent: 19 }],
    ['POST', `${aBase}/${a.goal.id}/actions`, { sessionId: a.sessionId, action: 'cancel' }]
  ]) {
    const rejected = await d.call('B', method, path, body);
    assert.ok([403, 404].includes(rejected.status), `${method} ${path}: ${rejected.status}`);
    assert.ok(!rejected.text.includes('A-PRIVATE'));
  }
  const mixed = await d.call('B', 'POST', `/api/bots/${b.bot.id}/goals/${a.goal.id}/actions`, { sessionId: b.sessionId, action: 'cancel' });
  assert.equal(mixed.status, 400, 'goal ID cannot escape the permitted session');
  assert.equal(a.service.get(a.bot.id, a.goal.id).status, 'queued');
  assert.notEqual(a.service.readSettings().maxConcurrent, 19);
  const aRead = await d.call('A', 'GET', `${aBase}?sessionId=${a.sessionId}`);
  assert.equal(aRead.status, 200);
  assert.ok(aRead.text.includes('A-PRIVATE-GOAL'));
  const bRead = await d.call('B', 'GET', `/api/bots/${b.bot.id}/goals?sessionId=${b.sessionId}`);
  assert.equal(bRead.status, 200);
  assert.ok(!bRead.text.includes(a.goal.id));
  assert.ok(!bRead.text.includes('A-PRIVATE'));
});
