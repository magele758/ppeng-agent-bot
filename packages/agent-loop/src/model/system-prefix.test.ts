import { afterEach, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './model-adapters.js';
import type { ModelTurnInput } from '../types.js';

afterEach(() => { vi.unstubAllGlobals(); });

it('keeps historical runtime system notices in a single leading system message without changing history', async () => {
  const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const payload = JSON.parse(init.body); payloads.push(payload);
    if (payload.stream) return new Response('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] });
  }));
  const adapter = new OpenAICompatibleAdapter({ model: 'text', baseUrl: 'https://example.test/v1', apiKey: 'test', useJsonMode: false });
  const messages = ['user', 'assistant', 'system', 'user', 'system'].map((role, i) => ({ id: String(i), sessionId: 's', role, parts: [{ type: 'text', text: `message-${i}` }], createdAt: '2026-01-01T00:00:00Z' })) as ModelTurnInput['messages'];
  const original = structuredClone(messages);
  const input: ModelTurnInput = { agent: { id: 'a', name: 'A', role: 'test', instructions: '', capabilities: [] }, systemPrompt: 'Root policy', tools: [], messages };
  await adapter.runTurn(input);
  await adapter.runTurnStream(input, () => {});
  for (const payload of payloads) {
    expect(payload.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(payload.messages[0]!.content).toBe('Root policy\n\nmessage-2\n\nmessage-4');
  }
  expect(messages).toEqual(original);
});
