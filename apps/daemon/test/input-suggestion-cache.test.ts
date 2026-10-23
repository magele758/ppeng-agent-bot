import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '@ppeng/agent-core';
import { inputSuggestionRoutes } from '../dist/routes/input-suggestion.js';

const answer = JSON.stringify({ suggestions: ['下一步怎么验证？', '给我一个例子'] });
function fixture(t: any, complete: () => Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), 'suggestion-cache-'));
  const options = { repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: {
    name: 'cache-test', async runTurn() { return { stopReason: 'end' as const, assistantParts: [] }; },
    async summarizeMessages() { return ''; }, completeText: complete
  } };
  let runtime = new RawAgentRuntime(options);
  t.after(async () => { await runtime.destroy(); rmSync(dir, { recursive: true, force: true }); });
  const bot = runtime.createBot({ name: 'Cache test' });
  const id = runtime.openBot(bot.id).sessionId;
  function reply(text = '已经完成') {
    runtime.store.appendMessage(id, 'user', [{ type: 'text', text: '请继续' }]);
    runtime.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
  }
  async function request(requestId = 1, sessionId = id) {
    let body: any;
    const route = inputSuggestionRoutes(runtime).find(r => r.method === 'POST')!;
    await route.handler({ requireParam: () => sessionId, readBody: async () => ({ requestId }),
      response: { setHeader() {}, end(text: string) { body = JSON.parse(text); } } } as any);
    return body;
  }
  return { id, reply, request, get runtime() { return runtime; }, async restart() {
    await runtime.destroy(); runtime = new RawAgentRuntime(options);
  } };
}

test('same reply coalesces concurrent and repeated requests [AC:bot-input-suggestion-cache#AC-1]', async t => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const f = fixture(t, async () => { calls++; await gate; return answer; });
  f.reply();
  const a = f.request(1), b = f.request(2);
  await new Promise(r => setImmediate(r)); release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual(first.suggestion, second.suggestion);
  assert.equal(first.suggestion.primary, '下一步怎么验证？');
  assert.deepEqual((await f.request(0)).suggestion, first.suggestion);
  assert.equal(calls, 1);
});

test('saved suggestions survive route recreation and runtime restart [AC:bot-input-suggestion-cache#AC-2]', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return answer; });
  f.reply(); const first = await f.request();
  const other = f.runtime.openBot(f.runtime.createBot({ name: 'Other' }).id).sessionId;
  assert.equal((await f.request(2, other)).suggestion, null);
  await f.restart();
  assert.deepEqual((await f.request(1)).suggestion, first.suggestion);
  assert.equal(calls, 1);
});

test('a later reply wins while unfinished and stale replies cannot be reused [AC:bot-input-suggestion-cache#AC-3] [AC:bot-input-suggestion#AC-4]', async t => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const f = fixture(t, async () => { const n = ++calls; if (n === 1) await gate; return JSON.stringify({ suggestions: [`reply-${n}`] }); });
  f.reply(); const old = f.request(1); await new Promise(r => setImmediate(r));
  f.reply('new reply'); f.runtime.store.updateSession(f.id, { status: 'running' });
  assert.equal((await f.request(2)).suggestion, null);
  f.runtime.store.updateSession(f.id, { status: 'idle' });
  const fresh = await f.request(3); release();
  assert.equal((await old).suggestion, null);
  assert.equal(fresh.suggestion.primary, 'reply-2');
  assert.deepEqual((await f.request(4)).suggestion, fresh.suggestion);
  assert.equal(calls, 2);
});

for (const kind of ['empty', 'failure']) test(`${kind} result is retained without same-round retries [AC:bot-input-suggestion-cache#AC-4]`, async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; if (kind === 'failure') throw new Error('private upstream detail'); return '{}'; });
  f.reply(); assert.equal((await f.request()).suggestion, null);
  await f.restart(); assert.equal((await f.request(2)).suggestion, null);
  assert.equal(calls, 1);
});
