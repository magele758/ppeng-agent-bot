import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { handleGatewayHttp } from '../dist/http.js';
import { call, cleanupGatewayTemps, fakeRuntime, makeCtx } from './gateway-harness.mjs';

after(() => cleanupGatewayTemps());

function runtime() {
  const base = fakeRuntime();
  const tasks = new Map();
  const sessions = new Map();
  const mails = [];
  const rt = {
    ...base,
    createTaskSession(input) {
      base.calls.created.push({ kind: 'task', ...input });
      const task = { id: `task_${tasks.size + 1}`, title: input.title };
      const session = { id: `sess_${sessions.size + 1}`, title: input.title };
      tasks.set(task.id, task);
      sessions.set(session.id, session);
      return { task, session };
    },
    getTask: (id) => tasks.get(id),
    getSession: (id) => sessions.get(id) ?? base.getSession(id),
    sendMailboxMessage(input) {
      const mail = { id: `mail_${mails.length + 1}`, ...input };
      mails.push(mail);
      base.calls.sent.push(mail);
      return mail;
    }
  };
  return rt;
}

function ctxFor(rt) {
  return makeCtx({ runtime: rt });
}

test('POST /task 缺少标题时返回 400 且不建会话', async () => {
  const rt = runtime();
  const missing = await call(handleGatewayHttp, ctxFor(rt), { path: '/task', body: { title: '   ' } });
  const blank = await call(handleGatewayHttp, ctxFor(rt), { path: '/task', body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'Missing title');
  assert.equal(blank.status, 400);
  assert.equal(rt.calls.created.length, 0);
  assert.equal(rt.calls.ran.length, 0);
});

test('POST /task 建会话、默认自动运行，并只把字符串字段传给运行时', async () => {
  const rt = runtime();
  const r = await call(handleGatewayHttp, ctxFor(rt), {
    path: '/task',
    body: {
      title: '  ship it  ',
      description: 'details',
      message: 'go',
      agentId: 'general',
      blockedBy: ['a', 2],
      background: false,
      autoRun: true,
      extra: 1
    }
  });
  assert.equal(r.status, 201);
  assert.equal(rt.calls.created.length, 1);
  const created = rt.calls.created[0];
  assert.equal(created.title, 'ship it');
  assert.equal(created.description, 'details');
  assert.equal(created.message, 'go');
  assert.equal(created.agentId, 'general');
  assert.deepEqual(created.blockedBy, ['a', '2']);
  assert.equal(created.background, false);
  assert.equal(rt.calls.ran.length, 1);
  assert.equal(rt.calls.ran[0], r.json.session.id);
  assert.equal(r.json.task.id, created && rt.getTask(r.json.task.id).id);
  assert.equal(r.json.latestAssistant, `echo:`);
});

test('POST /task 省略可选字段且 autoRun 为 false 时不跑会话', async () => {
  const rt = runtime();
  const r = await call(handleGatewayHttp, ctxFor(rt), {
    path: '/task',
    body: {
      title: 'quiet',
      description: 1,
      message: { text: 'no' },
      agentId: 9,
      blockedBy: 'not-a-list',
      background: 'yes',
      autoRun: false
    }
  });
  assert.equal(r.status, 201);
  const created = rt.calls.created[0];
  assert.equal(created.description, undefined);
  assert.equal(created.message, undefined);
  assert.equal(created.agentId, undefined);
  assert.equal(created.blockedBy, undefined);
  assert.equal(created.background, true);
  assert.equal(rt.calls.ran.length, 0);
  assert.equal(r.json.latestAssistant, 'echo:');
});

test('POST /mailbox 缺任一必填字段时返回 400', async () => {
  const rt = runtime();
  const cases = [
    {},
    { fromAgentId: 'main', toAgentId: 'general' },
    { fromAgentId: '  ', toAgentId: 'general', content: 'hi' },
    { fromAgentId: 'main', toAgentId: '', content: 'hi' },
    { fromAgentId: 'main', toAgentId: 'general', content: '   ' }
  ];
  for (const body of cases) {
    const r = await call(handleGatewayHttp, ctxFor(rt), { path: '/mailbox', body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'Missing fromAgentId, toAgentId, or content');
  }
  assert.equal(rt.calls.sent.length, 0);
});

test('POST /mailbox 投递邮件并保留可选类型与关联 id', async () => {
  const rt = runtime();
  const full = await call(handleGatewayHttp, ctxFor(rt), {
    path: '/mailbox',
    body: {
      fromAgentId: ' main ',
      toAgentId: ' general ',
      content: ' hello ',
      type: 'handoff',
      correlationId: 'corr-1',
      ignored: true
    }
  });
  assert.equal(full.status, 201);
  assert.equal(full.json.mail.fromAgentId, 'main');
  assert.equal(full.json.mail.toAgentId, 'general');
  assert.equal(full.json.mail.content, 'hello');
  assert.equal(full.json.mail.type, 'handoff');
  assert.equal(full.json.mail.correlationId, 'corr-1');

  const bare = await call(handleGatewayHttp, ctxFor(rt), {
    path: '/mailbox',
    body: { fromAgentId: 'main', toAgentId: 'general', content: 'ping', type: 1, correlationId: 2 }
  });
  assert.equal(bare.status, 201);
  assert.equal(bare.json.mail.type, undefined);
  assert.equal(bare.json.mail.correlationId, undefined);
  assert.equal(rt.calls.sent.length, 2);
});
