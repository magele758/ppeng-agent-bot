import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  httpStatusFromError,
  RawAgentRuntime,
  ResourceOwnerStore,
  setCatalogDefaultRef,
  upsertProvider,
  type RequestAuth
} from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { botsRoutes } from '../dist/routes/bots.js';
import { sessionsRoutes } from '../dist/routes/sessions.js';
import { tasksRoutes } from '../dist/routes/tasks.js';

const MODEL_A = { providerId: 'prov-a', modelId: 'alpha-1' };
const MODEL_B = { providerId: 'prov-b', modelId: 'beta-1' };
type Pins = { modelOverride: unknown; thinkingEffort: unknown };

/** `x-test-user` signs in a Lab user; `x-test-admin: 1` makes them a tenant admin. No header is the operator. */
function authFor(request: IncomingMessage): RequestAuth | undefined {
  const user = request.headers['x-test-user'];
  if (!user) return undefined;
  return {
    isolate: true,
    labProxy: true,
    admin: request.headers['x-test-admin'] === '1',
    user: { id: String(user), tenantId: 't', email: `${user}@example.test` }
  };
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-pin-permission-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'bot-pin-permission',
      async runTurn() {
        return { stopReason: 'end' as const, assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  for (const [id, model] of [['prov-a', 'alpha-1'], ['prov-b', 'beta-1']] as const) {
    upsertProvider(runtime.store, {
      id,
      name: id,
      kind: 'openai-compatible',
      baseUrl: `https://${id}.invalid/v1`,
      apiKey: `key-${id}`,
      models: [{ id: model, enabled: true }]
    });
  }
  setCatalogDefaultRef(runtime.store, MODEL_A);
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      return text ? JSON.parse(text) : {};
    }
  })
    .addAll(botsRoutes(runtime))
    .addAll(sessionsRoutes(runtime))
    .addAll(tasksRoutes(runtime));
  const server = createServer((request, response) => {
    void router
      .dispatch(request, response, new URL(request.url ?? '/', 'http://localhost'), authFor(request))
      .then((found) => {
        if (!found) {
          response.statusCode = 404;
          response.end();
        }
      })
      .catch((error: unknown) => {
        response.statusCode = httpStatusFromError(error);
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const root = `http://127.0.0.1:${address.port}`;

  async function call(who: string | null, method: string, path: string, body?: unknown, admin = false) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who) headers['x-test-user'] = who;
    if (admin) headers['x-test-admin'] = '1';
    const res = await fetch(root + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : {}) as Record<string, any> };
  }

  /** A Bot installed by the operator: it has no owner, so only an admin may change it. */
  function sharedBot(name: string, pins: Partial<Pins>) {
    const bot = runtime.createBot({ name });
    runtime.updateBot(bot.id, pins);
    return runtime.getBot(bot.id);
  }

  function botChats(botId: string) {
    return runtime.store.listSessions().filter((session) => session.metadata?.botId === botId);
  }

  return {
    runtime,
    call,
    sharedBot,
    botChats,
    sessionCount: () => runtime.store.listSessions().length,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

type App = Awaited<ReturnType<typeof boot>>;

function assertEveryChat(app: App, botId: string, field: keyof Pins, expected: unknown) {
  const chats = app.botChats(botId);
  assert.ok(chats.length > 0);
  for (const chat of chats) assert.deepEqual(chat.metadata?.[field], expected, `${chat.id}.${field}`);
}

/** Every way a signed-in non-admin can ask to change one pin of a Bot without an owner. */
async function assertMemberCannotChange(app: App, botId: string, field: keyof Pins, saved: unknown, attempts: unknown[]) {
  const opened = await app.call('mallory', 'POST', `/api/bots/${botId}/open`, {});
  assert.equal(opened.status, 200);
  for (const value of attempts) {
    const before = app.sessionCount();
    const requests: Array<[string, string, unknown]> = [
      ['POST', '/api/sessions', { botId, autoRun: false, metadata: { [field]: value } }],
      ['POST', '/api/chat', { botId, message: 'hi', metadata: { [field]: value } }],
      ['PATCH', `/api/bots/${botId}`, { [field]: value }],
      ['POST', '/api/sessions', { title: 'forged', autoRun: false, metadata: { botId, canonicalBotChat: true, [field]: value } }],
      ['POST', '/api/tasks', { title: 'forged task', autoRun: false, metadata: { botId, [field]: value } }]
    ];
    for (const [method, path, body] of requests) {
      const res = await app.call('mallory', method, path, body);
      assert.equal(res.status, 403, `${method} ${path} ${JSON.stringify(value)}: ${JSON.stringify(res.data)}`);
    }
    assert.equal(app.sessionCount(), before, `no chat is created for ${JSON.stringify(value)}`);
    assertEveryChat(app, botId, field, saved);
  }
}

test('a signed-in non-admin cannot change the model pin of a Bot without an owner [AC:bot-pin-permission#AC-1]', async () => {
  const app = await boot();
  try {
    const bot = app.sharedBot('Shared model Bot', { modelOverride: MODEL_A });
    await assertMemberCannotChange(app, bot.id, 'modelOverride', MODEL_A, [MODEL_B, null, { providerId: 'nope' }]);
    assert.equal(app.botChats(bot.id).length, 2, 'canonical chat plus the member own chat');
  } finally {
    await app.close();
  }
});

test('a signed-in non-admin cannot change the thinking effort pin of a Bot without an owner [AC:bot-pin-permission#AC-2]', async () => {
  const app = await boot();
  try {
    const bot = app.sharedBot('Shared effort Bot', { thinkingEffort: 'low' });
    await assertMemberCannotChange(app, bot.id, 'thinkingEffort', 'low', ['high', 'off', null, 'turbo']);
  } finally {
    await app.close();
  }
});

test('a non-admin still opens a Bot without an owner and inherits both pins [AC:bot-pin-permission#AC-3]', async () => {
  const app = await boot();
  try {
    const bot = app.sharedBot('Open shared Bot', { modelOverride: MODEL_A, thinkingEffort: 'low' });
    const plain = await app.call('mallory', 'POST', '/api/sessions', { botId: bot.id, autoRun: false });
    assert.equal(plain.status, 201);
    assert.deepEqual(plain.data.session.metadata.modelOverride, MODEL_A);
    assert.equal(plain.data.session.metadata.thinkingEffort, 'low');
    assert.equal(plain.data.session.metadata.userId, 'mallory');

    const same = await app.call('trent', 'POST', '/api/sessions', {
      botId: bot.id,
      autoRun: false,
      metadata: { modelOverride: MODEL_A, thinkingEffort: 'low' }
    });
    assert.equal(same.status, 201);
    assert.deepEqual(same.data.session.metadata.modelOverride, MODEL_A);
    assert.equal(same.data.session.metadata.thinkingEffort, 'low');

    const echoed = await app.call('mallory', 'PATCH', `/api/bots/${bot.id}`, { modelOverride: MODEL_A, thinkingEffort: 'low' });
    assert.equal(echoed.status, 200);
    assert.deepEqual(echoed.data.modelOverride, MODEL_A);
    assert.equal(echoed.data.thinkingEffort, 'low');

    const viaOpen = await app.call('victor', 'POST', `/api/bots/${bot.id}/open`, {});
    assert.equal(viaOpen.status, 200);
    assert.deepEqual(viaOpen.data.session.metadata.modelOverride, MODEL_A);
    assert.equal(viaOpen.data.session.metadata.thinkingEffort, 'low');
    assertEveryChat(app, bot.id, 'modelOverride', MODEL_A);
    assertEveryChat(app, bot.id, 'thinkingEffort', 'low');
  } finally {
    await app.close();
  }
});

test('the owner changes their own Bot and an admin changes a Bot without an owner [AC:bot-pin-permission#AC-4]', async () => {
  const app = await boot();
  try {
    const created = await app.call('alice', 'POST', '/api/bots', { name: 'Alice Bot' });
    assert.equal(created.status, 201);
    const own = created.data.bot.id as string;
    assert.equal((await app.call('alice', 'PATCH', `/api/bots/${own}`, { modelOverride: MODEL_B, thinkingEffort: 'high' })).status, 200);
    assertEveryChat(app, own, 'modelOverride', MODEL_B);
    assertEveryChat(app, own, 'thinkingEffort', 'high');
    const reopened = await app.call('alice', 'POST', '/api/sessions', { botId: own, autoRun: false, metadata: { thinkingEffort: 'medium' } });
    assert.equal(reopened.status, 201);
    assertEveryChat(app, own, 'thinkingEffort', 'medium');

    const shared = app.sharedBot('Admin shared Bot', { modelOverride: MODEL_A, thinkingEffort: 'low' });
    assert.equal((await app.call('mallory', 'POST', `/api/bots/${shared.id}/open`, {})).status, 200);
    const patched = await app.call('carol', 'PATCH', `/api/bots/${shared.id}`, { modelOverride: MODEL_B }, true);
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.data.modelOverride, MODEL_B);
    const viaSession = await app.call('carol', 'POST', '/api/sessions', { botId: shared.id, autoRun: false, metadata: { thinkingEffort: null } }, true);
    assert.equal(viaSession.status, 201);
    assertEveryChat(app, shared.id, 'modelOverride', MODEL_B);
    assertEveryChat(app, shared.id, 'thinkingEffort', undefined);

    const later = await app.call('trent', 'POST', `/api/bots/${shared.id}/open`, {});
    assert.equal(later.status, 200);
    assert.deepEqual(later.data.session.metadata.modelOverride, MODEL_B);
    assert.equal('thinkingEffort' in later.data.session.metadata, false);
  } finally {
    await app.close();
  }
});

test('/model in a Bot chat without an owner is refused to a non-admin and still works for an admin [AC:bot-pin-permission#AC-6]', async () => {
  const app = await boot();
  try {
    const bot = app.sharedBot('Command shared Bot', { modelOverride: MODEL_A });
    const mine = await app.call('mallory', 'POST', `/api/bots/${bot.id}/open`, {});
    assert.equal(mine.status, 200);
    const sid = mine.data.session.id as string;
    for (const text of ['/model prov-b/beta-1', '/model default']) {
      for (const [path, body] of [
        [`/api/sessions/${sid}/messages`, { message: text, autoRun: false }],
        ['/api/chat', { sessionId: sid, message: text }],
        ['/api/sessions', { botId: bot.id, message: text, autoRun: false }]
      ] as const) {
        const res = await app.call('mallory', 'POST', path, body);
        assert.equal(res.status, 403, `${path} ${text}: ${JSON.stringify(res.data)}`);
      }
      assertEveryChat(app, bot.id, 'modelOverride', MODEL_A);
    }
    const repeat = await app.call('mallory', 'POST', `/api/sessions/${sid}/messages`, { message: '/model prov-a/alpha-1', autoRun: false });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.data.command.code, 'model_set');
    const unknown = await app.call('mallory', 'POST', `/api/sessions/${sid}/messages`, { message: '/model nope', autoRun: false });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.data.command.code, 'model_unknown');
    assertEveryChat(app, bot.id, 'modelOverride', MODEL_A);

    const adminChat = await app.call('carol', 'POST', `/api/bots/${bot.id}/open`, {}, true);
    const switched = await app.call('carol', 'POST', `/api/sessions/${adminChat.data.session.id}/messages`, { message: '/model prov-b/beta-1', autoRun: false }, true);
    assert.equal(switched.status, 200);
    assert.equal(switched.data.command.code, 'model_set');
    assertEveryChat(app, bot.id, 'modelOverride', MODEL_B);
  } finally {
    await app.close();
  }
});

test('ordinary chats and tasks keep their own model and thinking effort [AC:bot-pin-permission#AC-7]', async () => {
  const app = await boot();
  try {
    const chat = await app.call('mallory', 'POST', '/api/sessions', {
      title: 'mine',
      autoRun: false,
      metadata: { modelOverride: MODEL_B, thinkingEffort: 'high' }
    });
    assert.equal(chat.status, 201);
    assert.deepEqual(chat.data.session.metadata.modelOverride, MODEL_B);
    assert.equal(chat.data.session.metadata.thinkingEffort, 'high');
    const task = await app.call('mallory', 'POST', '/api/tasks', {
      title: 'mine',
      autoRun: false,
      metadata: { modelOverride: MODEL_B, thinkingEffort: 'low' }
    });
    assert.equal(task.status, 201);
    assert.deepEqual(task.data.session.metadata.modelOverride, MODEL_B);
    assert.equal(task.data.session.metadata.thinkingEffort, 'low');
    const operator = await app.call(null, 'POST', '/api/sessions', { title: 'ops', autoRun: false, metadata: { thinkingEffort: 'medium' } });
    assert.equal(operator.status, 201);
    assert.equal(operator.data.session.metadata.thinkingEffort, 'medium');
  } finally {
    await app.close();
  }
});
