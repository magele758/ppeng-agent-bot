import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RawAgentRuntime, runAutoCompact } from '@ppeng/agent-core';
import { freePort, createProcessRegistry } from '../e2e-lifecycle.mjs';
import { envForEphemeralDaemon } from '../spawn-utils.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const ask = 'Compare the earlier config versions and reopen the screenshot.';
const tool = 'read_chat_attachment';
const call = (name, args, id) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
});

// Speak the real provider protocol. Generate a receipt only from the tool replies and model-visible image.
function modelReply(body) {
  const messages = body.messages ?? [];
  const toolNames = (body.tools ?? []).map((t) => t.function?.name);
  if (!toolNames.length) return { content: 'OK' };
  if (messages.some((m) => JSON.stringify(m.content).includes('VERIFY_FIRST_DELIVERY'))) {
    const latest = messages.findLast((m) => m.role === 'user');
    const hasText = JSON.stringify(latest.content).includes('code=q3d7');
    const pictures = latest.content.filter((p) => p.image_url?.url === 'data:image/png;base64,' + png);
    return { content: 'mixed delivery ' + hasText + ' / ' + pictures.length };
  }
  const results = messages.filter((m) => m.role === 'tool');
  const listed = results.find((m) => m.tool_call_id === 'list');
  if (!listed && !toolNames.includes(tool)) {
    if (results.some((m) => m.tool_call_id === 'discover')) return { content: 'Attachment tool unavailable' };
    return { tool_calls: [call('tool_search', { query: tool }, 'discover')] };
  }
  if (!listed) return { tool_calls: [call(tool, {}, 'list')] };
  const calls = messages
    .flatMap((m) => m.tool_calls ?? [])
    .filter((c) => c.function.name === tool && c.id !== 'list');
  // Compaction may already have replaced the listing with a tool-result stub.
  // The tool call ids and the newly returned pages are visible in the current request.
  if (!calls.length) {
    const versions = JSON.parse(listed.content).versions;
    if (versions.length !== 3) return { content: 'Unexpected sent version count ' + versions.length };
    return { tool_calls: versions.map((v) => call(tool, { id: v.id }, v.id)) };
  }
  const text = calls.flatMap((c) => {
    const result = results.find((m) => m.tool_call_id === c.id);
    const payload = JSON.parse(result.content);
    return payload.file === 'config.ts' ? [payload.content.match(/code=([a-z0-9]+)/)?.[1]] : [];
  });
  const pixels = messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .some((part) => part.image_url?.url === 'data:image/png;base64,' + png);
  return { content: text.join(' / ') + ' / original pixels ' + pixels };
}

async function modelServer() {
  const server = createServer(async (req, res) => {
    try {
      let data = '';
      for await (const piece of req) data += piece;
      const body = JSON.parse(data);
      const reply = modelReply(body);
      const finish = reply.tool_calls ? 'tool_calls' : 'stop';
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', ...reply }, finish_reason: finish }] })
        );
        return;
      }
      const delta = { ...reply };
      if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((c, index) => ({ ...c, index }));
      res.setHeader('Content-Type', 'text/event-stream');
      for (const [d, f] of [
        [delta, null],
        [{}, finish]
      ])
        res.write(
          'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: f }] }) + '\n\n'
        );
      res.end('data: [DONE]\n\n');
    } catch (e) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: String(e) }, finish_reason: 'stop' }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function startDaemon(stateDir, upstream) {
  const registry = createProcessRegistry({ graceMs: 1000 });
  const port = await freePort();
  const url = 'http://127.0.0.1:' + port;
  registry.spawnService('daemon', process.execPath, ['apps/daemon/dist/server.js'], {
    env: {
      ...envForEphemeralDaemon({ PATH: process.env.PATH }),
      RAW_AGENT_STATE_DIR: stateDir,
      RAW_AGENT_DAEMON_PORT: String(port),
      RAW_AGENT_MODEL_PROVIDER: 'openai-compatible',
      RAW_AGENT_BASE_URL: upstream,
      RAW_AGENT_API_KEY: 'local-fixture',
      RAW_AGENT_MODEL_NAME: 'gpt-4o',
      RAW_AGENT_USE_JSON_MODE: '0',
      RAW_AGENT_SELF_HEAL_AUTO_START: '0'
    }
  });
  try {
    for (let i = 0; i < 160; i++) {
      registry.assertAlive();
      if (
        await fetch(url + '/api/health')
          .then((r) => r.ok)
          .catch(() => false)
      )
        return { url, stop: () => registry.cleanup() };
      await delay(100);
    }
    throw new Error('Test daemon did not start');
  } catch (e) {
    await registry.cleanup();
    throw e;
  }
}

async function post(url, path, body) {
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000)
  });
  const text = await response.text();
  assert.ok(response.ok, text.slice(0, 500));
  return JSON.parse(text);
}

async function seed(url, sid) {
  const base = '/api/sessions/' + sid;
  const upload = async (fileName, dataBase64) =>
    (await post(url, base + '/attachments/ingest-base64', { fileName, dataBase64 })).attachment.id;
  const first = await upload('config.ts', Buffer.from('code=q3d7').toString('base64'));
  const img = await upload('screen.png', png);
  const initial = await post(url, base + '/messages', {
    message: 'VERIFY_FIRST_DELIVERY',
    attachmentIds: [first, img]
  });
  assert.equal(initial.latestAssistant, 'mixed delivery true / 1');
  const second = await upload('config.ts', Buffer.from('code=p9b2').toString('base64'));
  await post(url, base + '/messages', {
    message: 'save second config',
    attachmentIds: [second],
    autoRun: false
  });
  await upload('unsent.txt', Buffer.from('draft').toString('base64'));
}

async function compact(stateDir, sessions) {
  const runtime = new RawAgentRuntime({ repoRoot: stateDir, stateDir });
  try {
    for (const id of sessions) {
      for (let i = 0; i < 8; i++)
        runtime.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'padding '.repeat(100) }]);
      runtime.sendUserMessage(id, 'switch topics for a while');
      const compacted = await runAutoCompact({
        store: runtime.store,
        session: runtime.getSession(id),
        agent: runtime.store.getAgent('general'),
        force: true,
        tokenThreshold: 1,
        keepRecent: 2,
        summarize: async () => 'Only the task remains.'
      });
      assert.equal(compacted.didCompact, true);
      assert.ok(!JSON.stringify(runtime.store.foldMessages(id)).includes('screen.png'));
    }
  } finally {
    await runtime.destroy();
  }
}

test(
  '普通和单 Bot 真实服务重启、压缩后，追问读回同名两版与原图 [AC:chat-file-originals#AC-3]',
  { timeout: 110_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'chat-restart-'));
    const upstream = await modelServer();
    const model = 'http://127.0.0.1:' + upstream.address().port + '/v1';
    let daemon;
    try {
      daemon = await startDaemon(root, model);
      const chat = (await post(daemon.url, '/api/sessions', { title: 'versions', autoRun: false })).session
        .id;
      const bot = (await post(daemon.url, '/api/bots', { name: 'versions bot' })).bot.canonicalSessionId;
      for (const sid of [chat, bot]) await seed(daemon.url, sid);
      await daemon.stop();
      await compact(root, [chat, bot]);
      daemon = await startDaemon(root, model);
      for (const sid of [chat, bot]) {
        const reply = await post(daemon.url, '/api/sessions/' + sid + '/messages', { message: ask });
        assert.equal(reply.latestAssistant, 'q3d7 / p9b2 / original pixels true');
      }
    } finally {
      await daemon?.stop();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  }
);
