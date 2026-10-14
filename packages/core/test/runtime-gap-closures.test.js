import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SoftwareExecution } from '../dist/connectors/software-execution.js';
import { SqliteStateStore } from '../dist/storage.js';
import { createCronJob, updateCronJob } from '../dist/cron/cron-facade.js';
import { createCronTools } from '../dist/cron/cron-store.js';
import { acceptEventRoutine } from '../dist/cron/event-routine.js';
import { SKILL_PROPOSE_TOOL_NAME } from '../dist/skill-proposals/tool.js';
import { MESSAGE_AGENT_TOOL_NAME } from '../dist/tools/message-agent.js';

const ROOT = resolve(import.meta.dirname, '../../..');

function memory() {
  const map = new Map();
  return {
    getDaemonControl: (key) => structuredClone(map.get(key)),
    setDaemonControl: (key, value) => map.set(key, structuredClone(value))
  };
}

function ctx(bot = 'a', user = 'u') {
  return { session: { id: 's', metadata: { botId: bot, userId: user } }, agent: { id: 'general' } };
}

function httpTool(name, method = 'GET') {
  return {
    name,
    description: 'software',
    inputSchema: { type: 'object' },
    executor: { kind: 'http', url: 'https://example.com', method }
  };
}

async function server(fn) {
  const s = createServer(fn);
  await new Promise((resolveListen) => s.listen(0, '127.0.0.1', resolveListen));
  return {
    url: `http://127.0.0.1:${s.address().port}`,
    close: () => new Promise((resolveClose) => {
      s.closeAllConnections();
      s.close(resolveClose);
    })
  };
}

function catalogNames() {
  const files = [];
  const toolsDir = join(ROOT, 'packages/core/src/tools');
  for (const name of readdirSync(toolsDir)) {
    if (name.endsWith('.ts')) files.push(join(toolsDir, name));
  }
  files.push(
    join(ROOT, 'packages/core/src/cron/cron-store.ts'),
    join(ROOT, 'packages/core/src/bots/bot-work.ts')
  );
  const names = new Set([SKILL_PROPOSE_TOOL_NAME, MESSAGE_AGENT_TOOL_NAME]);
  const pattern = /name:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return [...names].sort();
}

function eventHost() {
  const dir = mkdtempSync(join(tmpdir(), 'gap-event-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const runs = [];
  const host = {
    store,
    stateDir: dir,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    cronStore: undefined,
    setCronStore(next) { this.cronStore = next; },
    runSession: async (sessionId) => {
      runs.push(sessionId);
      return store.getSession(sessionId);
    }
  };
  const session = store.createSession({
    title: 'event',
    mode: 'chat',
    agentId: 'general',
    background: false
  });
  return { dir, store, host, runs, session };
}

function githubHeaders(raw, deliveryId, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${raw}`, 'utf8').digest('hex');
  return {
    'x-github-event': 'push',
    'x-github-delivery': deliveryId,
    'x-github-timestamp': timestamp,
    'x-hub-signature-256': `sha256=${signature}`
  };
}

test('event routines reject operator tokens the same way software connections do [AC:runtime-gap-closures#AC-1]', async () => {
  const { dir, store, host, runs, session } = eventHost();
  const previousToken = process.env.RAW_AGENT_AUTH_TOKEN;
  const previousRelease = process.env.RAW_AGENT_HUMAN_RELEASE_SECRET;
  process.env.RAW_AGENT_AUTH_TOKEN = 'operator-auth-token';
  process.env.RAW_AGENT_HUMAN_RELEASE_SECRET = 'operator-release-token';
  process.env.GAP_EVENT_SECRET = 'ordinary-event-secret';
  try {
    for (const secretEnv of ['RAW_AGENT_AUTH_TOKEN', 'RAW_AGENT_HUMAN_RELEASE_SECRET']) {
      assert.throws(
        () => createCronJob(host, {
          sessionId: session.id,
          name: 'push',
          prompt: '总结',
          event: 'github/push',
          secretEnv
        }),
        /Operator credential/
      );
    }
    for (const secretEnv of ['NODE_OPTIONS', 'PATH']) {
      assert.throws(
        () => createCronJob(host, {
          sessionId: session.id,
          name: 'push',
          prompt: '总结',
          event: 'github/push',
          secretEnv
        }),
        /保留名/
      );
    }
    const job = createCronJob(host, {
      sessionId: session.id,
      name: 'push',
      prompt: '总结',
      event: 'github/push',
      secretEnv: 'GAP_EVENT_SECRET'
    });
    assert.equal(job.metadata.secretEnv, 'GAP_EVENT_SECRET');
    assert.throws(() => updateCronJob(host, job.id, { secretEnv: 'RAW_AGENT_AUTH_TOKEN' }), /Operator credential/);
    assert.throws(() => updateCronJob(host, job.id, { secretEnv: 'RAW_AGENT_HUMAN_RELEASE_SECRET' }), /Operator credential/);
    const tools = createCronTools(() => host.cronStore, { store });
    await assert.rejects(
      () => tools[0].execute(
        { session, agent: { id: 'general' } },
        { name: 'tool', prompt: '总结', event: 'github/push', secretEnv: 'RAW_AGENT_AUTH_TOKEN' }
      ),
      /Operator credential/
    );
    host.cronStore.update(job.id, { metadata: { ...job.metadata, secretEnv: 'RAW_AGENT_AUTH_TOKEN' } });
    const raw = JSON.stringify({ ref: 'refs/heads/main' });
    const result = await acceptEventRoutine(host, {
      provider: 'github',
      rawBody: raw,
      headers: githubHeaders(raw, 'delivery-operator', process.env.RAW_AGENT_AUTH_TOKEN),
      claimDelivery: () => true
    });
    assert.equal(result.outcomes[0]?.status, 'rejected');
    assert.equal(result.outcomes[0]?.reason, 'bad_signature');
    assert.deepEqual(runs, []);
  } finally {
    if (previousToken === undefined) delete process.env.RAW_AGENT_AUTH_TOKEN;
    else process.env.RAW_AGENT_AUTH_TOKEN = previousToken;
    if (previousRelease === undefined) delete process.env.RAW_AGENT_HUMAN_RELEASE_SECRET;
    else process.env.RAW_AGENT_HUMAN_RELEASE_SECRET = previousRelease;
    delete process.env.GAP_EVENT_SECRET;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('builtin names that a connection could hide stay reserved and visible [AC:runtime-gap-closures#AC-2]', () => {
  const names = catalogNames();
  assert.ok(names.includes('vision_analyze'));
  const store = memory();
  const execution = new SoftwareExecution(store);
  const principal = execution.principal({ userId: 'owner' });
  for (const name of names) {
    assert.throws(
      () => execution.bind(principal, 'bot-a', `bind_${name}`, { tools: [httpTool(name)] }),
      /Invalid or duplicate tool name/,
      name
    );
  }
  execution.bind(principal, 'bot-a', 'custom', { tools: [httpTool('warehouse_lookup')] });
  const key = JSON.stringify([principal, 'bot-a', 'legacy']);
  const rows = store.getDaemonControl('software_connections_v1');
  rows[key] = {
    principal,
    botId: 'bot-a',
    connectorId: 'legacy',
    health: 'configured',
    tools: names.map((name) => httpTool(name))
  };
  store.setDaemonControl('software_connections_v1', rows);
  const catalog = [
    ...names.map((name) => ({ name, description: 'builtin' })),
    ...execution.tools()
  ];
  const other = execution.filterForSession(catalog, { metadata: { userId: 'other', botId: 'bot-b' } });
  for (const name of names) {
    assert.ok(other.some((tool) => tool.name === name && tool.description === 'builtin'), `${name} removed from another session`);
    assert.equal(other.some((tool) => tool.name === name && tool.description === 'software'), false, name);
  }
  assert.equal(other.some((tool) => tool.name === 'warehouse_lookup'), false);
  const owner = execution.filterForSession(catalog, { metadata: { userId: 'owner', botId: 'bot-a' } });
  assert.ok(owner.some((tool) => tool.name === 'warehouse_lookup' && tool.description === 'software'));
  for (const name of names) {
    assert.ok(owner.some((tool) => tool.name === name && tool.description === 'builtin'), `${name} missing for owner`);
  }
});

test('read-only MCP calls are not stuck in the write retry ban [AC:runtime-gap-closures#AC-4]', async () => {
  const execution = new SoftwareExecution(memory());
  let calls = 0;
  execution.setMcpInvoker(async (_name, args) => {
    calls += 1;
    if (args.mode === 'fail') return { ok: false, content: 'temporary' };
    return { ok: true, content: 'ok' };
  });
  const principal = execution.principal({ userId: 'u' });
  execution.bind(principal, 'a', 'mcp', {
    tools: [
      {
        name: 'read_tool',
        description: 'read',
        inputSchema: { type: 'object' },
        executor: { kind: 'mcp', toolName: 'mcp_h0_echo', readOnly: true }
      },
      {
        name: 'write_tool',
        description: 'write',
        inputSchema: { type: 'object' },
        executor: { kind: 'mcp', toolName: 'mcp_h0_write' }
      }
    ]
  });
  const read = execution.tools().find((tool) => tool.name === 'read_tool');
  const write = execution.tools().find((tool) => tool.name === 'write_tool');
  assert.equal(read.sideEffectLevel, 'none');
  assert.equal(read.needsApproval(), false);
  assert.equal(write.sideEffectLevel, 'system');
  assert.equal(write.needsApproval(), true);
  const failed = await execution.execute(ctx(), 'read_tool', { mode: 'fail', idempotency_key: 'r1' });
  assert.equal(failed.ok, false);
  assert.equal(execution.invocations().find((row) => row.toolName === 'read_tool').state, 'failed');
  assert.equal(execution.invocations().find((row) => row.toolName === 'read_tool').write, false);
  await execution.execute(ctx(), 'read_tool', { mode: 'fail', idempotency_key: 'r2' });
  assert.equal(calls, 2);
  calls = 0;
  await execution.execute(ctx(), 'write_tool', { mode: 'fail', idempotency_key: 'w1' });
  assert.equal(execution.invocations().find((row) => row.toolName === 'write_tool').state, 'unknown');
  const banned = await execution.execute(ctx(), 'write_tool', { mode: 'fail', idempotency_key: 'w2' });
  assert.match(banned.content, /verify before retrying/);
  assert.equal(calls, 1);
});

test('HTTP software results are not fenced as MCP [AC:runtime-gap-closures#AC-5]', async () => {
  const endpoint = await server((_request, response) => response.end('hello-from-http'));
  try {
    const execution = new SoftwareExecution(memory(), { RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE: '1' });
    const tool = httpTool('software_test');
    tool.executor.url = endpoint.url;
    execution.bind(execution.principal({ userId: 'u' }), 'a', 'local', { tools: [tool] });
    const result = await execution.execute(ctx(), 'software_test', {});
    assert.equal(result.ok, true);
    assert.match(result.content, /hello-from-http/);
    assert.match(result.content, /source=http/);
    assert.equal(result.content.includes('source=mcp'), false);
  } finally {
    await endpoint.close();
  }
});

test('concurrent duplicate idempotency keys return the existing invocation [AC:runtime-gap-closures#AC-6]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gap-idem-'));
  const store = new SqliteStateStore(join(dir, 'state.sqlite'));
  let hits = 0;
  const endpoint = await server((_request, response) => {
    hits += 1;
    response.end('idempotent-body');
  });
  const execution = new SoftwareExecution(store, { RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE: '1' });
  const tool = httpTool('software_test');
  tool.executor.url = endpoint.url;
  execution.bind(execution.principal({ userId: 'u' }), 'a', 'local', { tools: [tool] });
  try {
    const first = await execution.execute(ctx(), 'software_test', { idempotency_key: 'same' });
    assert.equal(first.ok, true);
    assert.equal(hits, 1);
    const original = store.db.prepare.bind(store.db);
    let hidden = false;
    store.db.prepare = (sql, ...args) => {
      const statement = original(sql, ...args);
      if (!hidden && typeof sql === 'string' && sql.includes('WHERE fingerprint=?')) {
        hidden = true;
        return { get: () => undefined, all: (...values) => statement.all(...values), run: (...values) => statement.run(...values) };
      }
      return statement;
    };
    let thrown;
    let second;
    try {
      second = await execution.execute(ctx(), 'software_test', { idempotency_key: 'same' });
    } catch (error) {
      thrown = error;
    } finally {
      store.db.prepare = original;
    }
    assert.equal(thrown, undefined);
    assert.equal(second.content, first.content);
    assert.equal(hits, 1);
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM software_invocations').get();
    assert.equal(Number(count.n), 1);
  } finally {
    await endpoint.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
