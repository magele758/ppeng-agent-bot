import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAdapterFromProvider } from '../dist/model/provider-catalog.js';
import { withImageCompatibility } from '../dist/model/image-compatibility.js';

const rejection = new Error('OpenAI stream failed 400: {"error":{"message":"At most 0 image(s) may be provided in one prompt. (parameter=image)"}}');
const image = { type: 'image', assetId: 'old-screenshot', mimeType: 'image/png' };
const message = (role, parts) => ({ id: role, sessionId: 's', role, parts, createdAt: '2026-01-01T00:00:00Z' });
const history = () => ({ messages: [message('user', [{ type: 'text', text: 'old' }, image]), message('assistant', [{ type: 'text', text: 'saw image' }]), message('user', [{ type: 'text', text: 'hi' }])] });
const reply = { stopReason: 'end', assistantParts: [{ type: 'text', text: 'hello' }] };
function fixture() {
  const calls = [];
  const adapter = { name: 'test', contextWindow: 32768, summarizeMessages: async () => 'summary', runTurn: async input => {
    calls.push(input);
    if (input.messages.some(m => m.parts.some(p => p.type === 'image'))) throw rejection;
    return reply;
  } };
  adapter.runTurnStream = async (input, chunk) => { const result = await adapter.runTurn(input); chunk({ type: 'text_delta', text: 'hello' }); return result; };
  return { calls, adapter: withImageCompatibility(adapter) };
}

for (const streaming of [false, true]) {
  test(`historical images cannot poison later text turns (${streaming}) [AC:bot-chat-image-compatibility#AC-1]`, async () => {
    const { adapter, calls } = fixture();
    const input = history();
    const original = structuredClone(input);
    const chunks = [];
    const result = streaming ? await adapter.runTurnStream(input, c => chunks.push(c)) : await adapter.runTurn(input);
    assert.deepEqual(result, reply);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].messages[0].parts.some(p => p.type === 'text' && /image.*omitted/i.test(p.text)));
    assert.deepEqual(input, original, 'persisted transcript must remain intact');
    assert.equal(adapter.contextWindow, 32768);
    if (streaming) assert.deepEqual(chunks, [{ type: 'text_delta', text: 'hello' }]);
  });
}

test('current images produce an explicit incompatibility without silent retry [AC:bot-chat-image-compatibility#AC-2]', async () => {
  const { adapter, calls } = fixture();
  const input = history(); input.messages.at(-1).parts.push(image);
  await assert.rejects(adapter.runTurn(input), /MODEL_IMAGE_UNSUPPORTED/);
  assert.equal(calls.length, 1);
});

test('unrelated failures and partial streams are never replayed', async () => {
  const f = fixture();
  const authError = new Error('401 unauthorized');
  f.adapter = withImageCompatibility({ name: 'test', summarizeMessages: async () => '', runTurn: async () => { throw authError; } });
  await assert.rejects(f.adapter.runTurn(history()), error => error === authError);
  let runs = 0;
  const adapter = withImageCompatibility({ name: 'test', summarizeMessages: async () => '', runTurn: async () => reply,
    runTurnStream: async (_, emit) => { runs++; emit({ type: 'text_delta', text: 'partial' }); throw rejection; } });
  await assert.rejects(adapter.runTurnStream(history(), () => {}));
  assert.equal(runs, 1);
});

test('vision-capable models receive images unchanged and a failed text retry is not looped', async () => {
  const input = history();
  let calls = 0;
  const adapter = withImageCompatibility({ name: 'vision', summarizeMessages: async () => '', runTurn: async received => {
    calls++; assert.equal(received, input); return reply;
  } });
  assert.equal(await adapter.runTurn(input), reply);
  assert.equal(calls, 1);
  calls = 0;
  const offline = new Error('upstream offline');
  const failing = withImageCompatibility({ name: 'text', summarizeMessages: async () => '', runTurn: async () => {
    calls++; throw calls === 1 ? rejection : offline;
  } });
  await assert.rejects(failing.runTurn(input), error => error === offline);
  assert.equal(calls, 2);
});

test('current tool-generated images and cancellation cannot silently fall back [AC:bot-chat-image-compatibility#AC-2]', async () => {
  const { adapter, calls } = fixture();
  const input = history(); input.messages.push(message('tool', [image]));
  await assert.rejects(adapter.runTurnStream(input, () => {}), /MODEL_IMAGE_UNSUPPORTED/);
  assert.equal(calls.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.runTurn({ ...history(), signal: controller.signal }), error => error === rejection);
  assert.equal(calls.length, 2);
});

test('configured OpenAI provider retries rejected historical image payload over HTTP [AC:bot-chat-image-compatibility#AC-1]', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    assert.ok(!payload.messages.slice(1).some(message => message.role === 'system'), 'strict chat templates require a single leading system');
    if (body.includes('image_url')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'At most 0 image(s) may be provided in one prompt. (parameter=image)' } }));
    } else if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const adapter = createAdapterFromProvider({ id: 'test', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test', models: [{ id: 'text', enabled: true }], useJsonMode: false }, 'text');
    const input = { ...history(), agent: { id: 'test', name: 'Test', instructions: '', capabilities: [] }, tools: [], systemPrompt: 'Reply hello', resolveImageDataUrl: async () => 'data:image/png;base64,dGVzdA==' };
    input.messages.splice(1, 0, message('system', [{ type: 'text', text: 'Historical runtime notice' }]));
    for (const stream of [false, true]) {
      requests.length = 0;
      const result = stream ? await adapter.runTurnStream(input, () => {}) : await adapter.runTurn(input);
      assert.equal(result.assistantParts[0].text, 'hello');
      assert.equal(requests.length, 2);
      assert.ok(JSON.stringify(requests[0]).includes('image_url'));
      assert.ok(!JSON.stringify(requests[1]).includes('image_url'));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
