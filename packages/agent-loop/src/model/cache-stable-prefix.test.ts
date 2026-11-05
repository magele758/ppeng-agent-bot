import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesAdapter } from './model-adapters.js';
import type { ModelTurnInput } from '../types.js';

const input: ModelTurnInput = {
  agent: { id: 'a', name: 'a', role: 'assistant', instructions: '', capabilities: [] },
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { id: 'm1', sessionId: 's', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 't', seq: 1 }
  ],
  tools: []
};

afterEach(() => {
  vi.unstubAllGlobals();
});

async function captureSystem(turn: ModelTurnInput): Promise<Array<{ text: string; cache_control?: { type: string } }>> {
  let system: Array<{ text: string; cache_control?: { type: string } }> = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    system = (JSON.parse(String(init.body)) as { system: typeof system }).system;
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
  });
  const adapter = new AnthropicMessagesAdapter({ apiKey: 'k', baseUrl: 'https://example.test', model: 'm' });
  await adapter.runTurn(turn);
  return system;
}

describe('Anthropic cache breakpoint', () => {
  it('caches only the stable prefix and leaves the dynamic remainder uncached', async () => {
    const system = await captureSystem({
      ...input,
      systemPrompt: 'STABLE\n\n---\n\nDYNAMIC\n\nnudge',
      cacheStablePrefix: 'STABLE'
    });
    expect(system[0]).toEqual({ type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } });
    expect(system[1]?.text).toContain('DYNAMIC');
    expect(system[1]?.text).toContain('nudge');
    expect(system[1]?.cache_control).toBeUndefined();
  });

  it('keeps the last-block cache when no stable prefix is passed', async () => {
    const system = await captureSystem(input);
    expect(system).toHaveLength(1);
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]?.text).toContain('helpful assistant');
  });

  it('falls back to the last block when the prefix is not an actual prefix', async () => {
    const system = await captureSystem({ ...input, cacheStablePrefix: 'NOT-A-PREFIX' });
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]?.text).toContain('helpful assistant');
  });
});
