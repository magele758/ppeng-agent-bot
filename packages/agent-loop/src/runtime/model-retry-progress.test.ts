import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTurnWithRetries, retryDelayMs, type ToolLoopHost } from './tool-loop.js';
import { UpstreamHttpError, UpstreamStreamError } from '../model/upstream-error.js';
import { replayTurnInput } from '../testing/upstream-replay.js';
import type { ModelAdapter, ModelStreamChunk } from '../types.js';

const host = { env: {} } as ToolLoopHost;
const fail = () => new UpstreamHttpError('Service unavailable', { status: 503 });
const result = { stopReason: 'end' as const, assistantParts: [{ type: 'text' as const, text: 'Recovered' }] };
const adapter = (runTurn: ModelAdapter['runTurn']): ModelAdapter => ({ name: 'test-model', runTurn, summarizeMessages: async () => '' });
afterEach(() => { vi.useRealTimers(); });

describe('model retry progress', () => {
  it('honors an explicit zero retry budget', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValue(fail());
    const pending = runTurnWithRetries({ ...host, env: { RAW_AGENT_MODEL_MAX_RETRIES: '0' } }, adapter(run), replayTurnInput()).catch(e => e);
    await vi.runAllTimersAsync();
    await pending;
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('waits through five escalating delays before exhausting six requests [AC:model-retry-progress#AC-1] [AC:model-retry-progress#AC-9]', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValue(fail());
    const chunks: ModelStreamChunk[] = [];
    const pending = runTurnWithRetries(host, adapter(run), replayTurnInput(), c => chunks.push(c)).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    for (const [i, delay] of [2000, 4000, 8000, 16000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(run).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(i + 2);
    }
    expect(await pending).toBeInstanceOf(Error);
    expect(chunks.at(-1)).toMatchObject({ type: 'model_retry', phase: 'failed', requests: 6, reason: 'exhausted' });
  });

  it('honors long Retry-After and reports waits exceeding the limit [AC:model-retry-progress#AC-3]', async () => {
    vi.useFakeTimers();
    const limited = new UpstreamHttpError('limited', { status: 429, retryAfterMs: 120000 });
    expect(retryDelayMs(limited, 0)).toBe(120000);
    const eventually = vi.fn().mockRejectedValueOnce(limited).mockResolvedValue(result);
    const resumed = runTurnWithRetries(host, adapter(eventually), replayTurnInput());
    await vi.advanceTimersByTimeAsync(119999);
    expect(eventually).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await resumed).toEqual(result);
    expect(eventually).toHaveBeenCalledTimes(2);
    const chunks: ModelStreamChunk[] = [];
    const run = vi.fn().mockRejectedValue(new UpstreamHttpError('limited', { status: 429, retryAfterMs: 120001 }));
    await expect(runTurnWithRetries(host, adapter(run), replayTurnInput(), c => chunks.push(c))).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(chunks.at(-1)).toMatchObject({ phase: 'failed', reason: 'wait_limit', requests: 1 });
  });

  it.each([408, 429, 500, 502, 503, 504])('recovers from HTTP %i after the backoff [AC:model-retry-progress#AC-1]', async status => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new UpstreamHttpError('temporary', { status })).mockResolvedValue(result);
    const pending = runTurnWithRetries(host, adapter(run), replayTurnInput());
    await vi.advanceTimersByTimeAsync(1999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(result);
  });

  it.each([400, 401, 403, 404, 422])('does not retry permanent HTTP %i errors [AC:model-retry-progress#AC-4]', async status => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValue(new UpstreamHttpError('invalid request', { status }));
    const pending = runTurnWithRetries(host, adapter(run), replayTurnInput()).catch(e => e);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(Error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['authentication_error', 'permission_denied', 'model_not_found', 'invalid_api_key'])('does not retry explicit stream error %s [AC:model-retry-progress#AC-4]', async code => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValue(new UpstreamStreamError('request rejected', code));
    const pending = runTurnWithRetries(host, adapter(run), replayTurnInput()).catch(e => e);
    await vi.runAllTimersAsync();
    await pending;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('emits waiting, requesting and recovered progress [AC:model-retry-progress#AC-6]', async () => {
    vi.useFakeTimers();
    const chunks: ModelStreamChunk[] = [];
    const run = vi.fn().mockRejectedValueOnce(fail()).mockResolvedValue(result);
    const pending = runTurnWithRetries(host, adapter(run), replayTurnInput(), c => chunks.push(c));
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(result);
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model_retry', phase: 'waiting', model: 'test-model', retry: 1, maxRetries: 5, delayMs: 2000 }),
      expect.objectContaining({ type: 'model_retry', phase: 'requesting', retry: 1 }),
      expect.objectContaining({ type: 'model_retry', phase: 'recovered' }),
    ]));
  });

  it('cancels the backoff without another model call [AC:model-retry-progress#AC-7]', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const chunks: ModelStreamChunk[] = [];
    const run = vi.fn().mockRejectedValue(fail());
    const pending = runTurnWithRetries(host, adapter(run), replayTurnInput(controller.signal), c => chunks.push(c)).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(Error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(chunks.at(-1)).toMatchObject({ phase: 'cancelled' });
  });
});
