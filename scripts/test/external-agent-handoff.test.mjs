import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const SETTINGS = '/api/external-agents/settings';
const TASKS = '/api/external-agent/v1/tasks';

import {boot} from './helpers/external-agent-fixture.mjs';

test('authorized external agent hands off context and receives result [AC:external-agent-task-handoff#AC-1] [AC:external-agent-task-handoff#AC-2]', async t => {
  let prompt;
  const d = await boot(t, input => {
    prompt = input.messages;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Report is ready' }] };
  });
  const accepted = await d.submit();
  assert.equal(accepted.status, 202);
  assert.ok(accepted.data.task.id);
  assert.equal(accepted.data.statusUrl, `${TASKS}/${accepted.data.task.id}`);
  assert.equal(accepted.data.task.agentId, 'general');
  const done = await d.wait(accepted.data.task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result, 'Report is ready');
  assert.ok(JSON.stringify(prompt).includes('Keep the result concise'));
  assert.ok(JSON.stringify(prompt).includes('Complete the report'));
  assert.equal(d.runtime.listTasks().length, 1);
  assert.equal(d.runs(), 1);
});

test('query reports failed and waiting approval with reasons [AC:external-agent-task-handoff#AC-2]', async t => {
  const d = await boot(t);
  const accepted = await d.submit();
  await d.wait(accepted.data.task.id);
  const task = d.runtime.getTask(accepted.data.task.id);
  d.runtime.store.updateSession(task.sessionId, { status: 'failed', metadata: { ...d.runtime.getSession(task.sessionId).metadata,
    outcome: { kind: 'failed', reason: 'upstream_error', message: 'Model unavailable' } } });
  let queried = await d.call(d.tokenA, 'GET', `${TASKS}/${task.id}`);
  assert.equal(queried.data.task.status, 'failed');
  assert.match(queried.data.task.reason, /upstream_error|Model unavailable/);
  d.runtime.store.updateSession(task.sessionId, { status: 'waiting_approval' });
  queried = await d.call(d.tokenA, 'GET', `${TASKS}/${task.id}`);
  assert.equal(queried.data.task.status, 'waiting_approval');
  assert.ok(queried.data.task.reason);
  assert.ok(!('session' in queried.data));
  assert.ok(!('metadata' in queried.data.task));
});

test('parallel retries and application restart retain a single task [AC:external-agent-task-handoff#AC-3]', async t => {
  const d = await boot(t);
  const replies = await Promise.all(Array.from({ length: 6 }, () => d.submit()));
  assert.equal(replies.filter(r => r.status === 202).length, 1);
  assert.equal(replies.filter(r => r.status === 200 && r.data.duplicate).length, 5);
  const ids = new Set(replies.map(r => r.data.task.id));
  assert.equal(ids.size, 1);
  await d.wait([...ids][0]);
  await d.recreate();
  const retry = await d.submit();
  assert.equal(retry.status, 200);
  assert.equal(retry.data.task.id, [...ids][0]);
  assert.equal(d.runs(), 1);
  assert.equal(d.runtime.listTasks().length, 1);
});

test('cancelling a task waiting for input is observable as cancelled [AC:external-agent-task-handoff#AC-2]', async t => {
  const d = await boot(t);
  const accepted = await d.submit();
  await d.wait(accepted.data.task.id);
  const task = d.runtime.getTask(accepted.data.task.id);
  const session = d.runtime.getSession(task.sessionId);
  d.runtime.store.updateTask(task.id, { status: 'in_progress' });
  d.runtime.store.updateSession(session.id, { status: 'waiting_approval', metadata: { ...session.metadata,
    askUserPending: true, outcome: { kind: 'waiting_approval', reason: 'waiting_approval' } } });
  assert.equal((await d.call(d.tokenA, 'GET', `${TASKS}/${task.id}`)).data.task.status, 'waiting_input');
  d.runtime.cancelSession(session.id);
  const queried = await d.call(d.tokenA, 'GET', `${TASKS}/${task.id}`);
  assert.equal(queried.data.task.status, 'cancelled');
  assert.equal(queried.data.task.reason, 'abort');
});

test('interrupted execution exposes uncertainty rather than claiming it is still running [AC:external-agent-task-handoff#AC-2]', async t => {
  const d = await boot(t);
  const accepted = await d.submit();
  await d.wait(accepted.data.task.id);
  const task = d.runtime.getTask(accepted.data.task.id);
  d.runtime.store.updateTask(task.id, { status: 'in_progress' });
  d.runtime.store.updateSession(task.sessionId, { status: 'unknown', metadata: {} });
  const queried = await d.call(d.tokenA, 'GET', `${TASKS}/${task.id}`);
  assert.equal(queried.data.task.status, 'unknown');
  assert.equal(queried.data.task.reason, 'execution_state_unknown');
});

test('terminal task states are not masked by stale pending questions [AC:external-agent-task-handoff#AC-2]', async t => {
  const d = await boot(t);
  const accepted = await d.submit();
  await d.wait(accepted.data.task.id);
  const task = d.runtime.getTask(accepted.data.task.id);
  const cases = [
    { taskStatus: 'failed', sessionStatus: 'failed', outcome: { kind: 'failed', reason: 'model_error' }, status: 'failed', reason: 'model_error' },
    { taskStatus: 'completed', sessionStatus: 'completed', outcome: { kind: 'completed', reason: 'end' }, status: 'completed', reason: undefined },
    { taskStatus: 'cancelled', sessionStatus: 'waiting_approval', outcome: { kind: 'waiting_approval', reason: 'waiting_approval' }, status: 'cancelled', reason: 'cancelled' }
  ];
  for (const item of cases) {
    d.runtime.store.updateTask(task.id, { status: item.taskStatus });
    d.runtime.store.updateSession(task.sessionId, { status: item.sessionStatus, metadata: { askUserPending: true, outcome: item.outcome } });
    const queried = await d.call(d.tokenA, 'GET', `${TASKS}/${task.id}`);
    assert.equal(queried.data.task.status, item.status);
    assert.equal(queried.data.task.reason, item.reason);
  }
});

test('host execution failure becomes queryable instead of leaving an accepted task running [AC:external-agent-task-handoff#AC-2]', async t => {
  const d = await boot(t);
  d.runtime.runSession = async () => { throw new Error('simulated host failure'); };
  const accepted = await d.submit();
  assert.equal(accepted.status, 202);
  const failed = await d.wait(accepted.data.task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'execution_failed');
});

test('unauthorized callers, other clients, and disallowed executors are isolated [AC:external-agent-task-handoff#AC-4]', async t => {
  const d = await boot(t);
  assert.equal((await d.submit({}, '')).status, 401);
  assert.equal((await d.submit({}, 'invalid')).status, 401);
  assert.equal((await d.submit({}, d.operator)).status, 401);
  assert.equal((await d.submit({ agentId: 'main' })).status, 403);
  assert.equal(d.runtime.listTasks().length, 0);
  const accepted = await d.submit();
  await d.wait(accepted.data.task.id);
  const foreign = await d.call(d.tokenB, 'GET', `${TASKS}/${accepted.data.task.id}`);
  assert.equal(foreign.status, 404);
  assert.ok(!JSON.stringify(foreign.data).includes('Complete the report'));
  assert.equal((await d.call(d.tokenA, 'GET', '/api/tasks')).status, 401);
  assert.equal((await d.call(d.tokenA, 'PATCH', SETTINGS, { enabled: false })).status, 401);
  const own = await d.submit({}, d.tokenB);
  assert.equal(own.status, 202);
  assert.notEqual(own.data.task.id, accepted.data.task.id);
  await d.call(d.tokenB, 'GET', `${TASKS}/${own.data.task.id}`);
  // Wait for both runs before tearing down the runtime.
  for (let i = 0; i < 150 && d.runtime.getTask(own.data.task.id).status !== 'completed'; i++) await new Promise(r => setTimeout(r, 20));
});

test('settings redact credentials and revoke or rotate access immediately [AC:external-agent-task-handoff#AC-5]', async t => {
  const d = await boot(t);
  const read = await d.call(d.operator, 'GET', SETTINGS);
  assert.equal(read.data.settings.clients[0].tokenSet, true);
  assert.ok(!JSON.stringify(read.data).includes(d.tokenA));
  const persisted = d.runtime.store.getDaemonControl('external_agent_settings');
  assert.ok(!JSON.stringify(persisted).includes(d.tokenA));
  const rotation = randomBytes(32).toString('hex');
  const clients = read.data.settings.clients.map(c => c.id === 'agent-a' ? { ...c, token: rotation } : c);
  assert.equal((await d.configure({ clients })).status, 200);
  assert.equal((await d.submit()).status, 401);
  const accepted = await d.submit({}, rotation);
  assert.equal(accepted.status, 202);
  for (let i = 0; i < 150 && d.runtime.getTask(accepted.data.task.id).status !== 'completed'; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal((await d.configure({ enabled: false })).status, 200);
  assert.equal((await d.call(rotation, 'GET', `${TASKS}/${accepted.data.task.id}`)).status, 401);
  await d.recreate();
  assert.equal((await d.call(d.operator, 'GET', SETTINGS)).data.settings.enabled, false);
});

test('external credentials remain mandatory without daemon auth or Lab login [AC:external-agent-task-handoff#AC-4]', async t => {
  const d = await boot(t, undefined, { RAW_AGENT_AUTH_TOKEN: '', RAW_AGENT_OAUTH_GITHUB_CLIENT_ID: '', RAW_AGENT_OAUTH_GITHUB_CLIENT_SECRET: '' });
  assert.equal((await d.submit({}, '')).status, 401);
  assert.equal((await d.call('', 'GET', `${TASKS}/missing`)).status, 401);
  assert.equal((await d.configure({ clients: d.clients.map(c => ({ ...c, enabled: false })) })).status, 200);
  assert.equal((await d.submit()).status, 401);
  assert.equal(d.runtime.listTasks().length, 0);
});

test('invalid input never creates a task and invalid settings never replace saved grants', async t => {
  const d = await boot(t);
  for (const bad of [{ goal: '' }, { context: {} }, { sourceTaskId: '' }, { agentId: 123 }]) {
    assert.equal((await d.submit(bad)).status, 400);
  }
  assert.equal((await d.configure({ clients: [{ ...d.clients[0], allowedAgentIds: ['missing'] }] })).status, 400);
  assert.equal((await d.configure({ clients: [d.clients[0], { ...d.clients[1], token: d.tokenA }] })).status, 400);
  assert.equal(d.runtime.listTasks().length, 0);
  assert.equal((await d.call(d.operator, 'GET', SETTINGS)).data.settings.clients.length, 2);
});
