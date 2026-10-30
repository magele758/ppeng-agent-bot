import { expect, it, vi, afterEach } from 'vitest';
import { createAssembledLoop } from './create-assembled-loop.js';
import { createDefaultMemoryStore, DEFAULT_EMBED_AGENT } from './store-adapter.js';
import { OpenAICompatibleAdapter } from '../model/model-adapters.js';
import type { ModelTurnInput, MediaPart, ToolContract } from '../types.js';

afterEach(() => { vi.unstubAllGlobals(); });
it('forwards native files and asset resolvers in every preset [AC:loop-native-media#AC-4]', async () => {
  for (const preset of ['mini', 'normal', 'full', 'max'] as const) {
    const { store, surface } = createDefaultMemoryStore({ agent: DEFAULT_EMBED_AGENT });
    const session = surface.createSession({ title: 'media', mode: 'chat', agentId: DEFAULT_EMBED_AGENT.id });
    const parts: MediaPart[] = [
      { type: 'image', assetId: 'inline', mimeType: 'image/png', source: { type: 'base64', data: 'AQID' } },
      { type: 'audio', assetId: 'audio', mimeType: 'audio/wav' },
      { type: 'video', assetId: 'video', mimeType: 'video/mp4' },
    ];
    surface.appendMessage(session.id, 'user', parts);
    const seen: ModelTurnInput[] = [];
    const loop = await createAssembledLoop({ preset, io: { store,
      resolveMediaDataUrl: async (part, sid) => { expect(sid).toBe(session.id); return `data:${part.mimeType};base64,AQID`; },
      model: { name: 'test', summarizeMessages: async () => '', runTurn: async turn => {
        seen.push(turn);
        expect(await turn.resolveMediaDataUrl?.(parts[1]!)).toBe('data:audio/wav;base64,AQID');
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      } },
    } });
    await loop.run(session.id);
    expect(seen[0]?.messages.flatMap(m => m.parts)).toEqual(expect.arrayContaining(parts));
  }
});

it('delivers tool media after paired tool results to the real adapter [AC:loop-native-media#AC-4]', async () => {
  for (const preset of ['mini', 'normal', 'full', 'max'] as const) {
  const { store, surface } = createDefaultMemoryStore({ agent: DEFAULT_EMBED_AGENT });
  const session = surface.createSession({ title: 'media', mode: 'chat', agentId: DEFAULT_EMBED_AGENT.id });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'read clip' }]);
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: bodies.length === 1
      ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'clip', arguments: '{}' } }] }
      : { content: 'clip understood' }, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }] });
  }));
  const tool: ToolContract = { name: 'clip', description: 'clip', inputSchema: { type: 'object', properties: {} }, approvalMode: 'never', sideEffectLevel: 'none', execute: async () => ({ ok: true, content: 'loaded', media: [{ type: 'video', assetId: 'clip', mimeType: 'video/mp4', source: { type: 'base64', data: 'AQID' } }] }) };
  const loop = await createAssembledLoop({ preset, io: { store, tools: [tool], model: new OpenAICompatibleAdapter({ baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'omni', useJsonMode: false, mediaProfile: 'qwen-omni' }) } });
  await loop.run(session.id);
  expect(bodies).toHaveLength(2);
  const messages = bodies[1].messages;
  expect(messages.slice(-2).map((m: any) => m.role)).toEqual(['tool', 'user']);
  expect(messages.at(-2).tool_call_id).toBe('call-1');
  expect(messages.at(-1).content).toContainEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AQID' } });
  }
});
