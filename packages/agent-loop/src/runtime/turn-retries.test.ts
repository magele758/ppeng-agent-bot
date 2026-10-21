import { describe, expect, it } from 'vitest';
import type { ModelStreamChunk } from '../types.js';
import { OpenAiChatAdapter } from '../model/model-adapters.js';
import { UpstreamHttpError } from '../model/upstream-error.js';
import { createStreamResetTracker } from '../streaming/stream-reset.js';
import { replayApiKey, replayTurnInput, startReplayServer, type ReplayResponse } from '../testing/upstream-replay.js';
import { MAX_RETRY_AFTER_MS, retryDelayMs, runTurnWithRetries, type ToolLoopHost } from './tool-loop.js';

const host = { env: {} } as unknown as ToolLoopHost;

function chatDelta(content: string, finish: string | null = null): { data: unknown } {
  return { data: { id: 'chatcmpl-Retry', choices: [{ index: 0, delta: { content }, finish_reason: finish }] } };
}

const partialThenError: ReplayResponse = {
  status: 200,
  events: [chatDelta('PARTIAL-FROM-FIRST-ATTEMPT '), { data: { error: { message: 'The server had an error', type: 'server_error' } } }]
};
const fullAnswer: ReplayResponse = {
  status: 200,
  events: [chatDelta('hello '), chatDelta('again', 'stop'), { data: '[DONE]' }]
};

/** What a client shows after applying `stream_reset`: text streamed since the last reset. */
function visibleText(chunks: ModelStreamChunk[]): string {
  let text = '';
  for (const c of chunks) {
    if (c.type === 'stream_reset') text = '';
    else if (c.type === 'text_delta') text += c.text;
  }
  return text;
}

function adapterFor(baseUrl: string): OpenAiChatAdapter {
  return new OpenAiChatAdapter({ apiKey: replayApiKey(), baseUrl, model: 'replay-model', useJsonMode: false });
}

describe('runTurnWithRetries', () => {
  it('emits stream_reset before re-streaming a failed attempt [AC:upstream-resilience#AC-3] [AC:model-retry-progress#AC-8]', async () => {
    const server = await startReplayServer([partialThenError, fullAnswer]);
    try {
      const chunks: ModelStreamChunk[] = [];
      const result = await runTurnWithRetries(host, adapterFor(server.baseUrl), replayTurnInput(), (c) => chunks.push(c));
      expect(server.requests).toHaveLength(2);
      expect(chunks.filter((c) => c.type === 'stream_reset')).toEqual([{ type: 'stream_reset', reason: 'retry' }]);
      expect(visibleText(chunks)).toBe('hello again');
      expect(chunks.at(-1)).toMatchObject({ type: 'model_retry', phase: 'recovered' });
      expect(result.assistantParts).toEqual([{ type: 'text', text: 'hello again' }]);
    } finally {
      await server.close();
    }
  });

  it('does not emit stream_reset when the failed attempt streamed nothing [AC:upstream-resilience#AC-3]', async () => {
    const server = await startReplayServer([{ status: 500, json: { error: { message: 'boom' } } }, fullAnswer]);
    try {
      const chunks: ModelStreamChunk[] = [];
      await runTurnWithRetries(host, adapterFor(server.baseUrl), replayTurnInput(), (c) => chunks.push(c));
      expect(chunks.some((c) => c.type === 'stream_reset')).toBe(false);
      expect(visibleText(chunks)).toBe('hello again');
    } finally {
      await server.close();
    }
  });

  it('waits at least the Retry-After the server asked for [AC:upstream-resilience#AC-4]', async () => {
    const server = await startReplayServer([
      { status: 429, headers: { 'retry-after-ms': '700' }, json: { error: { message: 'Rate limit reached' } } },
      fullAnswer
    ]);
    try {
      const started = Date.now();
      await runTurnWithRetries(host, adapterFor(server.baseUrl), replayTurnInput(), () => undefined);
      expect(Date.now() - started).toBeGreaterThanOrEqual(650);
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('fails fast when Retry-After exceeds the in-process cap [AC:upstream-resilience#AC-4]', async () => {
    const server = await startReplayServer([
      { status: 429, headers: { 'retry-after': '121' }, json: { error: { message: 'Rate limit reached' } } },
      fullAnswer
    ]);
    try {
      const err = await runTurnWithRetries(host, adapterFor(server.baseUrl), replayTurnInput(), () => undefined).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(UpstreamHttpError);
      expect((err as UpstreamHttpError).retryAfterMs).toBe(121_000);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('abort during the backoff wait ends the turn immediately', async () => {
    const server = await startReplayServer([
      { status: 503, headers: { 'retry-after': '15' }, json: { error: { message: 'overloaded' } } }
    ]);
    try {
      const ac = new AbortController();
      const started = Date.now();
      const pending = runTurnWithRetries(host, adapterFor(server.baseUrl), replayTurnInput(ac.signal), () => undefined);
      setTimeout(() => ac.abort(), 100);
      await expect(pending).rejects.toThrow('Session aborted');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('retryDelayMs', () => {
  it('uses capped exponential backoff without Retry-After', () => {
    expect(retryDelayMs(new Error('x'), 0)).toBe(2000);
    expect(retryDelayMs(new Error('x'), 2)).toBe(8000);
  });

  it('never waits less than the backoff, and gives up past the cap', () => {
    const ask = (ms: number) => new UpstreamHttpError('429', { status: 429, retryAfterMs: ms });
    expect(retryDelayMs(ask(100), 1)).toBe(4000);
    expect(retryDelayMs(ask(5_000), 0)).toBe(5_000);
    expect(retryDelayMs(ask(MAX_RETRY_AFTER_MS + 1), 0)).toBeUndefined();
  });
});

describe('createStreamResetTracker', () => {
  it('resets only after content was forwarded', () => {
    const out: ModelStreamChunk[] = [];
    const tracker = createStreamResetTracker((c) => out.push(c));
    tracker.resetIfDirty('fallback');
    expect(out).toEqual([]);
    tracker.onChunk({ type: 'text_delta', text: 'a' });
    tracker.resetIfDirty('fallback');
    tracker.resetIfDirty('fallback');
    expect(out).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'stream_reset', reason: 'fallback' }
    ]);
  });

  it('a nested reset passing through clears the outer dirty flag', () => {
    const out: ModelStreamChunk[] = [];
    const tracker = createStreamResetTracker((c) => out.push(c));
    tracker.onChunk({ type: 'text_delta', text: 'a' });
    tracker.onChunk({ type: 'stream_reset', reason: 'retry' });
    tracker.resetIfDirty('fallback');
    expect(out.filter((c) => c.type === 'stream_reset')).toHaveLength(1);
  });
});
