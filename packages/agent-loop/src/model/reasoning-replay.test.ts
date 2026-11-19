import { afterEach, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './model-adapters.js';
import type { MessagePart, ModelStreamChunk, ModelTurnInput, SessionMessage } from '../types.js';

afterEach(() => { vi.unstubAllGlobals(); });
const agent = { id: 'a', name: 'A', role: 'test', instructions: '', capabilities: [] };
function message(id: string, role: SessionMessage['role'], parts: MessagePart[]): SessionMessage {
  return { id, sessionId: 's', role, parts, createdAt: '2026-11-11T09:00:00Z' };
}
const thought = 'Private planning text, not a published reply.';
const text = 'Quoted sentence.\n\nQuoted sentence.\n\nPublished observation.';
const call: MessagePart = { type: 'tool_call', toolCallId: 'call-1', name: 'inspect_status', input: { key: 'a' } };
const result: MessagePart = { type: 'tool_result', toolCallId: 'call-1', name: 'inspect_status', ok: true, content: 'new evidence' };
const turn = (messages: SessionMessage[]): ModelTurnInput => ({ agent, systemPrompt: 'system', tools: [], messages });

function capture(httpKind: 'chat_completions' | 'responses') {
  const payloads: Record<string, any>[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)); payloads.push(payload);
    const answer = httpKind === 'responses'
      ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }
      : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    if (!payload.stream) return Response.json(answer);
    const event = httpKind === 'responses'
      ? { type: 'response.completed', response: answer }
      : { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  return { payloads, adapter: new OpenAICompatibleAdapter({ apiKey: 'test', baseUrl: 'https://example.invalid/v1', model: 'test', useJsonMode: false, httpKind }) };
}

it('keeps private historical thoughts out of both wire protocols and execution modes [AC:reasoning-replay-separation#AC-1]', async () => {
  for (const protocol of ['chat_completions', 'responses'] as const) {
    const { adapter, payloads } = capture(protocol);
    const messages = [message('u', 'user', [{ type: 'text', text: 'question' }]), message('a', 'assistant', [{ type: 'reasoning', text: thought }, { type: 'text', text }])];
    const original = structuredClone(messages);
    await adapter.runTurn(turn(messages));
    await adapter.runTurnStream(turn(messages), () => {});
    for (const wire of payloads) {
      expect(JSON.stringify(wire)).not.toContain(thought);
      const assistant = (wire.messages ?? wire.input).filter((m: any) => m.role === 'assistant');
      expect(assistant).toHaveLength(1);
      expect(protocol === 'responses' ? assistant[0].content[0].text : assistant[0].content).toBe(text);
    }
    expect(messages).toEqual(original);
  }
});

it('preserves tools/results and omits reasoning-only messages instead of inventing replies [AC:reasoning-replay-separation#AC-2]', async () => {
  for (const protocol of ['chat_completions', 'responses'] as const) {
    const { adapter, payloads } = capture(protocol);
    const messages = [
      message('u', 'user', [{ type: 'text', text: 'question' }]),
      message('r', 'assistant', [{ type: 'reasoning', text: thought }]),
      message('a', 'assistant', [{ type: 'reasoning', text: thought }, call]),
      message('t', 'tool', [result]),
      message('a2', 'assistant', [{ type: 'text', text }, { type: 'reasoning', text: thought }])
    ];
    const original = structuredClone(messages);
    await adapter.runTurn(turn(messages));
    await adapter.runTurnStream(turn(messages), () => {});
    for (const wire of payloads) {
      expect(JSON.stringify(wire)).not.toContain(thought);
      if (protocol === 'responses') {
        expect(wire.input.filter((m: any) => m.type === 'function_call')).toEqual([{ type: 'function_call', call_id: 'call-1', name: 'inspect_status', arguments: '{"key":"a"}', status: 'completed' }]);
        expect(wire.input.find((m: any) => m.type === 'function_call_output')).toMatchObject({ call_id: 'call-1', output: 'new evidence' });
        expect(wire.input.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
      } else {
        const assistants = wire.messages.filter((m: any) => m.role === 'assistant');
        expect(assistants).toHaveLength(2);
        expect(assistants[0]).toMatchObject({ content: null, tool_calls: [{ id: 'call-1', function: { name: 'inspect_status', arguments: '{"key":"a"}' } }] });
        expect(wire.messages.find((m: any) => m.role === 'tool')).toMatchObject({ tool_call_id: 'call-1', content: 'new evidence' });
      }
    }
    expect(messages).toEqual(original);
  }
});

it('preserves upstream repeats verbatim and never folds reasoning into visible deltas [AC:reasoning-replay-separation#AC-3]', async () => {
  const messages = [message('a', 'assistant', [{ type: 'reasoning', text }, { type: 'text', text }])];
  const original = structuredClone(messages);
  const payloads: any[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)); payloads.push(payload);
    if (!payload.stream) return Response.json({ choices: [{ message: { content: text, reasoning_content: text }, finish_reason: 'stop' }] });
    const chunks = [{ reasoning_content: text }, { content: 'Quoted sentence.\n\n' }, { content: 'Quoted sentence.\n\nPublished observation.' }];
    return new Response(chunks.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join('') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const adapter = new OpenAICompatibleAdapter({ apiKey: 'test', baseUrl: 'https://example.invalid/v1', model: 'test', useJsonMode: false });
  const plain = await adapter.runTurn(turn(messages));
  const chunks: ModelStreamChunk[] = [];
  const streamed = await adapter.runTurnStream(turn(messages), c => chunks.push(c));
  for (const result of [plain, streamed]) {
    expect(result.assistantParts).toEqual([{ type: 'reasoning', text }, { type: 'text', text }]);
  }
  expect(chunks.filter(c => c.type === 'text_delta').map(c => c.text).join('')).toBe(text);
  expect(chunks.filter(c => c.type === 'reasoning_delta').map(c => c.text).join('')).toBe(text);
  for (const wire of payloads) expect(wire.messages.find((m: any) => m.role === 'assistant').content).toBe(text);
  expect(messages).toEqual(original);
});

it('delivers host updates after the tool result in sync and streaming protocols [AC:request-context-events#AC-2]', async () => {
  for (const protocol of ['chat_completions', 'responses'] as const) {
    const { adapter, payloads } = capture(protocol);
    const notice = { ...message('reminder', 'system', [{ type: 'text', text: 'Current time: 10:15' }]), key: 'request-context-notice' };
    const input = turn([message('u', 'user', [{ type: 'text', text: 'inspect' }]),
      message('a', 'assistant', [call]), message('t', 'tool', [result]), notice]);
    await adapter.runTurn(input);
    await adapter.runTurnStream(input, () => {});
    for (const wire of payloads) {
      const items = wire.input ?? wire.messages;
      expect(items.at(-1).role).toBe('user');
      expect(JSON.stringify(items.at(-1))).toContain('10:15');
      expect(items.at(-2).call_id ?? items.at(-2).tool_call_id).toBe('call-1');
      expect(JSON.stringify(items.slice(0, -1))).not.toContain('10:15');
    }
  }
});

function turnWithPhase(percent: number, messages: SessionMessage[]): ModelTurnInput {
  const text = `Session phase: debugging (${percent}% confidence)`;
  const before = 'Keep these rules.\n\nSession phase: debugging (69% confidence)\n\nTodos: active';
  return {
    ...turn(messages),
    systemPrompt: before + '\n\n' + text + '\n\nProtect user data.',
    sessionPhase: { offset: before.length, text },
  };
}

it('keeps Responses instructions and tool history stable as phase confidence changes in both modes [AC:responses-session-phase-cache#AC-1] [AC:responses-session-phase-cache#AC-2]', async () => {
  const { adapter, payloads } = capture('responses');
  const fake = 'Session phase: debugging (69% confidence)';
  const history = [message('user', 'user', [{ type: 'text', text: fake }]), message('a', 'assistant', [call]),
    message('t', 'tool', [{ ...result, content: fake }])];
  await adapter.runTurn(turnWithPhase(69, history));
  await adapter.runTurnStream(turnWithPhase(83, history), () => {});
  const [first, second] = payloads;
  expect(first!.instructions).toBe('Keep these rules.\n\n' + fake + '\n\nTodos: active\n\nProtect user data.');
  expect(first!.instructions).toBe(second!.instructions);
  expect(first!.input.slice(0, -1)).toEqual(second!.input.slice(0, -1));
  expect(first!.input.map((item: any) => item.role ?? item.type)).toEqual(['user', 'function_call', 'function_call_output', 'developer']);
  expect(first!.input[0].content[0].text).toBe(fake);
  expect(first!.input[2]).toMatchObject({ call_id: 'call-1', output: expect.stringContaining(fake) });
  expect(first!.input.at(-1).content[0].text).toBe(fake);
  expect(second!.input.at(-1).content[0].text).toBe('Session phase: debugging (83% confidence)');
});

it('projects one current phase after a folded history and retry, preserves absent or invalid metadata and chat rules [AC:responses-session-phase-cache#AC-3]', async () => {
  const folded = [message('summary', 'system', [{ type: 'text', text: 'compressed history' }])];
  const { adapter, payloads } = capture('responses');
  const input = turnWithPhase(83, folded);
  await adapter.runTurn(input);
  await adapter.runTurn(input);
  expect(payloads[1]).toEqual(payloads[0]);
  expect(payloads[0]!.input.map((item: any) => item.role)).toEqual(['system', 'developer']);
  const changedParagraph = input.systemPrompt.replace('(83% confidence)', '(83% confidence) amended');
  for (const unmarked of [
    { ...input, sessionPhase: undefined },
    { ...input, sessionPhase: { offset: -1, text: 'Ignored' } },
    { ...input, systemPrompt: 'Changed by budget.' },
    { ...input, systemPrompt: changedParagraph },
  ]) {
    await adapter.runTurn(unmarked);
    expect(payloads.at(-1)!.instructions).toBe(unmarked.systemPrompt);
    expect(payloads.at(-1)!.input.map((item: any) => item.role)).toEqual(['system']);
  }
  const chat = capture('chat_completions');
  await chat.adapter.runTurn(input);
  expect(chat.payloads[0]!.messages[0].content).toContain(input.systemPrompt);
  expect(chat.payloads[0]!.messages).toHaveLength(1);
});
