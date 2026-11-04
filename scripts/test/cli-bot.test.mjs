import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function startDaemon(seed) {
  const state = {
    bots: seed.bots.map((bot) => ({ ...bot })),
    goals: { ...seed.goals },
    calls: []
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const bodyText = await readBody(request);
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    state.calls.push({ method: request.method, pathname, body, sessionId: url.searchParams.get('sessionId') });
    if (request.method === 'GET' && pathname === '/api/bots') {
      sendJson(response, 200, { bots: state.bots });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/bots') {
      const bot = {
        id: `bot-${state.bots.length + 1}`,
        name: body.name,
        canonicalSessionId: `canon-${state.bots.length + 1}`,
        title: '',
        description: ''
      };
      state.bots.push(bot);
      sendJson(response, 201, { bot });
      return;
    }
    const open = pathname.match(/^\/api\/bots\/([^/]+)\/open$/);
    const goals = pathname.match(/^\/api\/bots\/([^/]+)\/goals$/);
    const one = pathname.match(/^\/api\/bots\/([^/]+)$/);
    const botId = decodeURIComponent((open ?? goals ?? one)?.[1] ?? '');
    const bot = state.bots.find((item) => item.id === botId);
    if (request.method === 'POST' && open) {
      if (!bot) {
        sendJson(response, 404, { error: 'Bot not found' });
        return;
      }
      sendJson(response, 200, { bot, session: { id: `sess-${bot.id}` }, createdSession: false });
      return;
    }
    if (request.method === 'GET' && goals) {
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId !== `sess-${botId}`) {
        sendJson(response, 400, { error: 'sessionId is required' });
        return;
      }
      sendJson(response, 200, { goals: state.goals[botId] ?? [] });
      return;
    }
    if (request.method === 'GET' && one) {
      if (!bot) {
        sendJson(response, 404, { error: 'Bot not found' });
        return;
      }
      sendJson(response, 200, { bot });
      return;
    }
    const stream = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
    if (request.method === 'POST' && stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: model\ndata: ${JSON.stringify({ type: 'text_delta', text: 'noted' })}\n\n`);
      return;
    }
    sendJson(response, 404, { error: `no route ${request.method} ${pathname}` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock daemon failed to bind');
  return {
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

function runCli(baseUrl, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'apps/cli/src/index.ts', ...args], {
      cwd: root,
      env: { ...process.env, RAW_AGENT_DAEMON_BASE_URL: baseUrl, RAW_AGENT_AUTH_TOKEN: '' }
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cli timed out\n${stderr}\n${stdout}`));
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('列出机器人时能看到 id 和名字 [AC:cli-bot#AC-1]', async () => {
  const daemon = await startDaemon({
    bots: [
      { id: 'bot-ada', name: 'Ada' },
      { id: 'bot-lin', name: 'Lin' }
    ],
    goals: {}
  });
  try {
    const result = await runCli(daemon.baseUrl, ['bot', 'ls']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bot-ada\s+Ada/);
    assert.match(result.stdout, /bot-lin\s+Lin/);
  } finally {
    await daemon.close();
  }
});

test('创建机器人后列表里出现这个名字 [AC:cli-bot#AC-2]', async () => {
  const daemon = await startDaemon({ bots: [], goals: {} });
  try {
    const created = await runCli(daemon.baseUrl, ['bot', 'create', 'Nova']);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /bot-1/);
    const listed = await runCli(daemon.baseUrl, ['bot', 'ls']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /Nova/);
  } finally {
    await daemon.close();
  }
});

test('打开机器人时打印当前对话的会话 id [AC:cli-bot#AC-3]', async () => {
  const daemon = await startDaemon({ bots: [{ id: 'bot-ada', name: 'Ada' }], goals: {} });
  try {
    const result = await runCli(daemon.baseUrl, ['bot', 'open', 'bot-ada']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sess-bot-ada/);
  } finally {
    await daemon.close();
  }
});

test('向机器人发送一句话后能看到助手回复 [AC:cli-bot#AC-4]', async () => {
  const daemon = await startDaemon({ bots: [{ id: 'bot-ada', name: 'Ada' }], goals: {} });
  try {
    const result = await runCli(daemon.baseUrl, ['bot', 'send', 'bot-ada', 'hello', 'bot']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /noted/);
    const sent = daemon.state.calls.find((call) => call.pathname === '/api/sessions/sess-bot-ada/stream');
    assert.equal(sent?.body?.message, 'hello bot');
  } finally {
    await daemon.close();
  }
});

test('查看目标时能看到 id、标题和状态，没有目标时有空提示 [AC:cli-bot#AC-5]', async () => {
  const daemon = await startDaemon({
    bots: [
      { id: 'bot-ada', name: 'Ada' },
      { id: 'bot-lin', name: 'Lin' }
    ],
    goals: { 'bot-ada': [{ id: 'goal-1', title: 'Ship the note', status: 'queued' }] }
  });
  try {
    const listed = await runCli(daemon.baseUrl, ['bot', 'goals', 'bot-ada']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /goal-1/);
    assert.match(listed.stdout, /Ship the note/);
    assert.match(listed.stdout, /queued/);
    const empty = await runCli(daemon.baseUrl, ['bot', 'goals', 'bot-lin']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /\(no goals\)/);
  } finally {
    await daemon.close();
  }
});

test('缺少或无法识别机器人子命令时失败并打印用法 [AC:cli-bot#AC-6]', async () => {
  const daemon = await startDaemon({ bots: [], goals: {} });
  try {
    for (const args of [['bot'], ['bot', 'nope']]) {
      const result = await runCli(daemon.baseUrl, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Usage: bot/);
    }
  } finally {
    await daemon.close();
  }
});

test('打开不存在的机器人时失败并说明原因 [AC:cli-bot#AC-7]', async () => {
  const daemon = await startDaemon({ bots: [], goals: {} });
  try {
    const result = await runCli(daemon.baseUrl, ['bot', 'open', 'missing']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bot not found/);
    assert.doesNotMatch(result.stderr, /at openBot/);
  } finally {
    await daemon.close();
  }
});

test('创建缺名字或发送缺正文时不发出请求 [AC:cli-bot#AC-8]', async () => {
  const daemon = await startDaemon({ bots: [{ id: 'bot-ada', name: 'Ada' }], goals: {} });
  try {
    const create = await runCli(daemon.baseUrl, ['bot', 'create']);
    assert.notEqual(create.status, 0);
    assert.match(create.stderr, /Usage: bot create/);
    const send = await runCli(daemon.baseUrl, ['bot', 'send', 'bot-ada']);
    assert.notEqual(send.status, 0);
    assert.match(send.stderr, /Usage: bot send/);
    assert.equal(daemon.state.calls.length, 0);
  } finally {
    await daemon.close();
  }
});
