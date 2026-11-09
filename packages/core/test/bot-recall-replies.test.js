import test from 'node:test';
import assert from 'node:assert/strict';
import { botConversationRequest, deliverConversationTurn } from '../dist/bots/conversation-reply.js';

test('a conversational receipt is identical in the stream and transcript [AC:bot-recall-replies#AC-1]', async () => {
  const text = '切换到任务 Orion；目标：整理文档；仅回复“收到”。';
  assert.equal(botConversationRequest(text), 'receipt');
  assert.equal(botConversationRequest('只回“收到”'), 'receipt');
  assert.equal(botConversationRequest('请保存文档，然后仅回复收到。'), 'format-receipt');
  assert.equal(botConversationRequest('把“旧文件名”改为“新文件名”。只回收到。'), 'format-receipt');
  const chunks = [];
  const result = await deliverConversationTurn('receipt', { tools: [], systemPrompt: '' }, c => chunks.push(c), async (_input, stream) => {
    stream?.({ type: 'text_delta', text: '仅回复收到。' }); return { stopReason: 'end', assistantParts: [{ type: 'text', text: '仅回复收到。' }] };
  });
  assert.deepEqual(chunks, [{ type: 'text_delta', text: '收到' }]);
  assert.deepEqual(result.assistantParts, [{ type: 'text', text: '收到' }]);
});

test('historical identifier questions use only available original-source readers [AC:bot-recall-replies#AC-2]', async () => {
  const question = 'What exact release identifier did the inspection find? Return only the identifier.';
  assert.equal(botConversationRequest(question), 'history');
  assert.equal(botConversationRequest('Inspection of the release log found identifier RX-946. Keep the source available.'), 'observation');
  assert.equal(botConversationRequest('Inspect the release log and publish the result.'), undefined);
  assert.equal(botConversationRequest('What code did the bank send to my phone?'), undefined);
  const tools = [{ name: 'history_search' }, { name: 'bash' }];
  await deliverConversationTurn('history', { tools, systemPrompt: '' }, undefined, async input => {
    assert.deepEqual(input.tools, [tools[0]]);
    assert.match(input.systemPrompt, /history_read/);
    return { stopReason: 'end', assistantParts: [] };
  });
});

test('unique earlier source uses the stable read reference before asking the model for its answer [AC:bot-recall-replies#AC-2]', async () => {
  const sessionId = 'one';
  const messages = [{ role: 'user', seq: 42, parts: [{ type: 'text', text: 'Which exact release code did the previous review report?' }] }];
  const tools = [{ name: 'history_search' }, { name: 'history_read' }];
  const run = () => deliverConversationTurn('history', { messages, sessionId, tools, systemPrompt: '' }, undefined, async () => assert.fail('original not yet read'));
  const search = (await run()).assistantParts[0];
  assert.deepEqual(search.input, { query: 'release code', session_id: sessionId });
  const matched = { ref: 'history:one:original:0', sessionId, seq: 3, role: 'user' };
  messages.push({ role: 'tool', parts: [{ type: 'tool_result', ok: true, name: 'history_search', content: JSON.stringify({ matches: [matched, { ...matched, seq: 42 }] }) }] });
  assert.deepEqual((await run()).assistantParts[0].input, { ref: matched.ref });
});

test('reply format alone preserves operational tools and reports a blocked action [AC:bot-recall-replies#AC-1]', async () => {
  const tools = [{ name: 'write_file', approvalMode: 'always' }];
  const blocked = { stopReason: 'end', assistantParts: [{ type: 'text', text: '需要批准写入。' }] };
  const result = await deliverConversationTurn('format-receipt', { tools, systemPrompt: '' }, undefined, async input => {
    assert.equal(input.tools, tools);
    return blocked;
  });
  assert.deepEqual(result, blocked);
});

test('Bot human-turn entry echoes only the requested receipt despite model punctuation [AC:bot-recall-replies#AC-1]', async t => {
  const { RawAgentRuntime } = await import('../dist/runtime.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'bot-receipt-'));
  const answer = { stopReason: 'end', assistantParts: [{ type: 'text', text: '按要求，我只回复“收到”。' }] };
  const adapter = {
    name: 'receipt-test', runTurn: async () => answer, async runTurnStream(input, send) {
      send({ type: 'text_delta', text: answer.assistantParts[0].text });
      send({ type: 'done', stopReason: 'end' });
      return answer;
    }, async summarizeMessages() { return 'summary'; }
  };
  const runtime = new RawAgentRuntime({ repoRoot: directory, stateDir: directory, modelAdapter: adapter });
  t.after(async () => { await runtime.destroy(); rmSync(directory, { recursive: true, force: true }); });
  const bot = runtime.createBot({ name: 'receipt-test' });
  const { sessionId } = runtime.openBot(bot.id);
  runtime.sendUserMessage(sessionId, '切回任务 Orion。只回“收到”。');
  const chunks = [];
  const session = await runtime.runHumanSession(sessionId, { onModelStreamChunk: chunk => chunks.push(chunk) });
  assert.equal(session.status, 'idle');
  const last = runtime.store.foldMessages(sessionId).findLast(message => message.role === 'assistant');
  assert.deepEqual(last.parts.filter(part => part.type === 'text').map(part => part.text), ['收到']);
  assert.equal(chunks.filter(chunk => chunk.type === 'text_delta').map(chunk => chunk.text).join(''), '收到');
});
