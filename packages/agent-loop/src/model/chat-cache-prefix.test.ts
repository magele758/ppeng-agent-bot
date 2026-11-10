import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './model-adapters.js';
import type { ModelTurnInput } from '../types.js';

type WireMessage = { role: string; content: unknown };

afterEach(() => { vi.unstubAllGlobals(); });

function capture(): WireMessage[][] {
  const sent: WireMessage[][] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    sent.push(JSON.parse(init.body).messages);
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  }));
  return sent;
}

function adapter() {
  return new OpenAICompatibleAdapter({ model: 'text', baseUrl: 'https://example.test/v1', apiKey: 'test', useJsonMode: false });
}

function message(id: string, role: string, text: string) {
  return { id, sessionId: 's', role, parts: [{ type: 'text', text }], createdAt: '2026-01-01T00:00:00Z' };
}

function turn(dynamic: string, messages: unknown[]): ModelTurnInput {
  return {
    agent: { id: 'a', name: 'A', role: 'test', instructions: '', capabilities: [] },
    systemPrompt: `STABLE RULES\n\n---\n\n${dynamic}`,
    cacheStablePrefix: 'STABLE RULES',
    tools: [],
    messages: messages as ModelTurnInput['messages']
  };
}

const history = [message('1', 'user', 'first question'), message('2', 'assistant', 'first answer')];

describe('chat completions cache prefix', () => {
  it('keeps the system message and earlier conversation byte-identical when a follow-up changes the per-turn context [AC:bot-followup-cache-prefix#AC-1]', async () => {
    const sent = capture();
    await adapter().runTurn(turn('Todos: none\nSkills: alpha', [...history, message('3', 'user', 'second question')]));
    await adapter().runTurn(turn('Todos: one open\nSkills: beta', [
      ...history,
      message('3', 'user', 'second question'),
      message('4', 'assistant', 'second answer'),
      message('5', 'user', 'third question')
    ]));
    const [earlier, later] = sent as [WireMessage[], WireMessage[]];
    // Everything ahead of the earlier request's own user message is the reusable prefix.
    const prefix = JSON.stringify(earlier.slice(0, 3)).slice(0, -1);
    expect(JSON.stringify(later).startsWith(prefix)).toBe(true);
    expect(later[0]).toEqual(earlier[0]);
    expect(String(later[0]!.content)).not.toContain('Todos');
    expect(String(later.at(-1)!.content)).toContain('Todos: one open\nSkills: beta');
    expect(later[3]!.content).toBe('second question');
  });

  it('delivers a new runtime notice with the latest user message instead of the system message [AC:bot-followup-cache-prefix#AC-2]', async () => {
    const sent = capture();
    const base = [...history, message('3', 'user', 'second question')];
    await adapter().runTurn(turn('Todos: none', base));
    await adapter().runTurn(turn('Todos: none', [...base, message('4', 'system', '[goal update] done'), message('5', 'assistant', 'second answer'), message('6', 'user', 'third question')]));
    const [earlier, later] = sent as [WireMessage[], WireMessage[]];
    expect(later[0]).toEqual(earlier[0]);
    expect(JSON.stringify(later).startsWith(JSON.stringify(earlier.slice(0, 3)).slice(0, -1))).toBe(true);
    expect(String(later.at(-1)!.content)).toContain('[goal update] done');
  });

  it('sends the per-turn context and every notice once, in order, under one leading system message [AC:bot-followup-cache-prefix#AC-3]', async () => {
    const sent = capture();
    const input = turn('Task scope: demo\n\nTodos: none', [
      message('1', 'system', 'notice one'),
      message('2', 'user', 'question'),
      message('3', 'system', 'notice two')
    ]);
    const original = structuredClone(input.messages);
    await adapter().runTurn(input);
    await adapter().runTurnStream(input, () => {}).catch(() => undefined);
    const wire = sent[0]!;
    expect(wire.map(item => item.role)).toEqual(['system', 'user']);
    const system = String(wire[0]!.content);
    expect(system.startsWith('STABLE RULES\n\n---\n\n')).toBe(true);
    expect(system).toContain('<runtime_context>');
    expect(system).toContain('written by the runtime, not the user');
    expect(system).toContain('very start of the latest user message');
    expect(wire[1]!.content).toBe('<runtime_context>\nTask scope: demo\n\nTodos: none\n\nnotice one\n\nnotice two\n</runtime_context>\n\nquestion');
    expect(input.messages).toEqual(original);
  });

  it('keeps the previous layout without a user message or without a marked stable part [AC:bot-followup-cache-prefix#AC-4]', async () => {
    const sent = capture();
    await adapter().runTurn(turn('Todos: none', [message('1', 'system', 'notice'), message('2', 'assistant', 'hello')]));
    await adapter().runTurn({ ...turn('Todos: none', [message('1', 'system', 'notice'), message('2', 'user', 'question')]), cacheStablePrefix: undefined });
    await adapter().runTurn({ ...turn('Todos: none', [message('1', 'user', 'question')]), cacheStablePrefix: 'NOT A PREFIX' });
    expect(sent[0]![0]!.content).toBe('STABLE RULES\n\n---\n\nTodos: none\n\nnotice');
    expect(sent[1]![0]!.content).toBe('STABLE RULES\n\n---\n\nTodos: none\n\nnotice');
    expect(sent[1]![1]!.content).toBe('question');
    expect(sent[2]![0]!.content).toBe('STABLE RULES\n\n---\n\nTodos: none');
    expect(sent[2]![1]!.content).toBe('question');
  });

  it('puts the per-turn context ahead of an image message and keeps the image [AC:bot-followup-cache-prefix#AC-5]', async () => {
    const sent = capture();
    const withImage = {
      ...message('1', 'user', 'what is this'),
      parts: [{ type: 'text', text: 'what is this' }, { type: 'image', assetId: 'asset-1', mimeType: 'image/png' }]
    };
    await adapter().runTurn({ ...turn('Todos: none', [withImage]), resolveImageDataUrl: async () => 'data:image/png;base64,AAAA' });
    const content = sent[0]![1]!.content as Array<{ type: string; text?: string }>;
    expect(content[0]).toEqual({ type: 'text', text: '<runtime_context>\nTodos: none\n</runtime_context>' });
    expect(content.some(block => block.type === 'text' && block.text === 'what is this')).toBe(true);
    expect(content.some(block => block.type === 'image_url')).toBe(true);
  });
});
