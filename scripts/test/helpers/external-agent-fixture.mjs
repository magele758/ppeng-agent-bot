import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuthStore, RawAgentRuntime } from '@ppeng/agent-core';
import { createDaemonApp } from '../../../apps/daemon/dist/app.js';

const SETTINGS = '/api/external-agents/settings';
const TASKS = '/api/external-agent/v1/tasks';

export async function boot(t, adapter, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'external-handoff-'));
  mkdirSync(join(dir, 'repo'));
  let runs = 0;
  const runtimeOptions = {
    repoRoot: join(dir, 'repo'), stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'scripted', summarizeMessages: async () => '',
      async runTurn(input) {
        runs++;
        return adapter ? adapter(input) : { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Delivered result' }] };
      }
    }
  };
  let runtime = new RawAgentRuntime(runtimeOptions);
  const operator = randomBytes(32).toString('hex');
  const tokenA = randomBytes(32).toString('hex');
  const tokenB = randomBytes(32).toString('hex');
  const deps = {
    runtime, repoRoot: dir, authStore: new AuthStore(runtime.store.db),
    env: { RAW_AGENT_AUTH_TOKEN: operator, RAW_AGENT_OAUTH_GITHUB_CLIENT_ID: 'test', RAW_AGENT_OAUTH_GITHUB_CLIENT_SECRET: 'test', ...env },
    config: { storageCtx: {}, domainsMounted: [] }, pkgName: 'test', pkgVersion: '0', readBodyLimit: 100000,
    readBody: async request => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString() || '{}');
    }
  };
  let app = createDaemonApp(deps);
  const server = createServer(async (request, response) => {
    try {
      if (!await app.handle(request, response)) { response.statusCode = 404; response.end(); }
    } catch (error) {
      response.statusCode = error.statusCode ?? 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const session of runtime.listSessions()) await runtime.listTraceEvents(session.id);
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, data: await res.json() };
  };
  const clients = [
    { id: 'agent-a', name: 'Agent A', enabled: true, token: tokenA, allowedAgentIds: ['general'], defaultAgentId: 'general' },
    { id: 'agent-b', name: 'Agent B', enabled: true, token: tokenB, allowedAgentIds: ['general'], defaultAgentId: 'general' }
  ];
  const configure = patch => call(operator, 'PATCH', SETTINGS, patch ?? { enabled: true, clients });
  const configured = await configure();
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  const submit = (body = {}, token = tokenA) => call(token, 'POST', TASKS, {
    source: 'upstream-bot', sourceTaskId: 'task-1', goal: 'Complete the report', context: 'Keep the result concise', agentId: 'general', ...body
  });
  const wait = async id => {
    for (let i = 0; i < 150; i++) {
      const r = await call(tokenA, 'GET', `${TASKS}/${id}`);
      if (['completed', 'failed', 'waiting_approval', 'waiting_input'].includes(r.data.task?.status)) return r.data.task;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('task never reached an observable outcome');
  };
  return { base, get runtime() { return runtime; }, call, configure, submit, wait, tokenA, tokenB, operator, clients,
    runs: () => runs, recreate: async () => {
      for (const session of runtime.listSessions()) await runtime.listTraceEvents(session.id);
      await runtime.destroy();
      runtime = new RawAgentRuntime(runtimeOptions);
      deps.runtime = runtime;
      deps.authStore = new AuthStore(runtime.store.db);
      app = createDaemonApp(deps);
    } };
}
