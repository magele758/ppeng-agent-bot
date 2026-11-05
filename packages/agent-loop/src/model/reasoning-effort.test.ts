import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicMessagesAdapter, OpenAICompatibleAdapter } from './model-adapters.js';
import type { ModelTurnInput } from '../types.js';

afterEach(() => { vi.unstubAllGlobals(); });

function turn(effort?: ModelTurnInput['reasoningEffort']): ModelTurnInput {
  return {
    agent: { id: 'a', name: 'A', role: 'test', instructions: '', capabilities: [] },
    systemPrompt: 'policy',
    tools: [],
    messages: [{
      id: '1',
      sessionId: 's',
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
      createdAt: '2026-01-01T00:00:00Z'
    }],
    ...(effort ? { reasoningEffort: effort } : {})
  };
}

function streamBody(payload: Record<string, unknown>): string {
  if (Array.isArray(payload.system)) {
    return `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
  }
  if ('instructions' in payload) {
    return `data: ${JSON.stringify({
      type: 'response.completed',
      response: { status: 'completed', output_text: 'ok' }
    })}\n\n`;
  }
  return 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
}

function captureFetch(reply: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bodies.push(payload);
    if (payload.stream === true) return new Response(streamBody(payload));
    return Response.json(reply);
  }));
  return bodies;
}

it('leaves chat, responses, and anthropic requests unchanged when effort is absent [AC:thinking-effort#AC-1]', async () => {
  const chat = captureFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  const chatAdapter = new OpenAICompatibleAdapter({
    model: 'text', baseUrl: 'https://example.test/v1', apiKey: 'test', useJsonMode: false
  });
  await chatAdapter.runTurn(turn());
  await chatAdapter.runTurnStream(turn(), () => {});
  for (const body of chat) {
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
  }

  const responses = captureFetch({ output_text: 'ok' });
  const responsesAdapter = new OpenAICompatibleAdapter({
    model: 'text', baseUrl: 'https://example.test/v1', apiKey: 'test', useJsonMode: false, httpKind: 'responses'
  });
  await responsesAdapter.runTurn(turn());
  expect(responses[0]).not.toHaveProperty('reasoning');
  expect(responses[0]).not.toHaveProperty('reasoning_effort');

  const anthropic = captureFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  const anthropicAdapter = new AnthropicMessagesAdapter({
    apiKey: 'test', baseUrl: 'https://example.test', model: 'claude'
  });
  await anthropicAdapter.runTurn(turn());
  expect(anthropic[0]).not.toHaveProperty('output_config');
});

it('asks the provider to think at the saved level on the next chat turn [AC:thinking-effort#AC-2]', async () => {
  const chat = captureFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  const chatAdapter = new OpenAICompatibleAdapter({
    model: 'text', baseUrl: 'https://example.test/v1', apiKey: 'test', useJsonMode: false
  });
  await chatAdapter.runTurn(turn('low'));
  await chatAdapter.runTurnStream(turn('high'), () => {});
  expect(chat[0]?.reasoning_effort).toBe('low');
  expect(chat[1]?.reasoning_effort).toBe('high');

  const responses = captureFetch({ output_text: 'ok' });
  const responsesAdapter = new OpenAICompatibleAdapter({
    model: 'text', baseUrl: 'https://example.test/v1', apiKey: 'test', useJsonMode: false, httpKind: 'responses'
  });
  await responsesAdapter.runTurn(turn('medium'));
  await responsesAdapter.runTurnStream(turn('low'), () => {});
  expect(responses[0]?.reasoning).toEqual({ effort: 'medium' });
  expect(responses[1]?.reasoning).toEqual({ effort: 'low' });

  const anthropic = captureFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  const anthropicAdapter = new AnthropicMessagesAdapter({
    apiKey: 'test', baseUrl: 'https://example.test', model: 'claude'
  });
  await anthropicAdapter.runTurn(turn('high'));
  await anthropicAdapter.runTurnStream(turn('medium'), () => {});
  expect(anthropic[0]?.output_config).toEqual({ effort: 'high' });
  expect(anthropic[1]?.output_config).toEqual({ effort: 'medium' });
});

it('does not put thinking effort on summaries or internal judgments [AC:thinking-effort#AC-4]', async () => {
  const bodies = captureFetch({
    choices: [{ message: { content: 'summary' }, finish_reason: 'stop' }],
    content: [{ type: 'text', text: 'summary' }],
    output_text: 'summary'
  });
  const chat = new OpenAICompatibleAdapter({
    model: 'text', baseUrl: 'https://example.test/v1', apiKey: 'test', useJsonMode: false
  });
  const summary = { agent: turn().agent, messages: turn().messages, reason: 'compact' };
  await chat.summarizeMessages(summary);
  await chat.completeText({ system: 'judge', user: 'done?' });
  const responses = new OpenAICompatibleAdapter({
    model: 'text', baseUrl: 'https://example.test/v1', apiKey: 'test', useJsonMode: false, httpKind: 'responses'
  });
  await responses.summarizeMessages(summary);
  const anthropic = new AnthropicMessagesAdapter({
    apiKey: 'test', baseUrl: 'https://example.test', model: 'claude'
  });
  await anthropic.summarizeMessages(summary);
  await anthropic.completeText({ system: 'judge', user: 'done?' });
  for (const body of bodies) {
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('output_config');
  }
});
