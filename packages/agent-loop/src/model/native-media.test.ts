import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleAdapter, AnthropicMessagesAdapter, HybridModelRouterAdapter, textSummaryFromParts } from './model-adapters.js';
import { readMediaFile } from './media-files.js';
import { classifyModelError } from './error-class.js';
import { sanitizeLlmRequestBodyForDebug } from './llm-prompt-debug.js';
import { estimateMessageTokens } from './token-estimate.js';
import type { MediaPart, MessagePart, ModelTurnInput } from '../types.js';

const data = 'AQIDBA==';
const media = (type: MediaPart['type'], mimeType: string): MediaPart => ({ type, mimeType, assetId: type, source: { type: 'base64', data } });
const parts: MessagePart[] = [media('image', 'image/png'), { type: 'text', text: 'explain' }, media('audio', 'audio/wav'), media('video', 'video/mp4')];
function input(body: MessagePart[] = parts): ModelTurnInput {
  return { agent: { id: 'a', name: 'A', role: 'test', instructions: '', capabilities: [] }, systemPrompt: '', tools: [], messages: [{ id: 'm', sessionId: 's', role: 'user', parts: body, createdAt: '' }] };
}
function adapter(mediaProfile: 'openai' | 'qwen-omni' = 'qwen-omni', httpKind: 'responses' | 'chat_completions' = 'chat_completions') {
  return new OpenAICompatibleAdapter({ baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'omni', useJsonMode: false, mediaProfile, httpKind });
}
function capture() {
  const bodies: any[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"understood"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    return Response.json({ choices: [{ message: { content: 'understood' }, finish_reason: 'stop' }] });
  });
  vi.stubGlobal('fetch', fetcher);
  return { bodies, fetcher };
}
afterEach(() => { vi.unstubAllGlobals(); });

it('loads original files and rejects invalid file inputs [AC:loop-native-media#AC-1]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-media-'));
  try {
    for (const [ext, type] of [['png', 'image'], ['wav', 'audio'], ['mp4', 'video']]) {
      const path = join(dir, `file.${ext}`); await writeFile(path, Buffer.from(data, 'base64'));
      expect(await readMediaFile(path)).toMatchObject({ type, source: { type: 'base64', data } });
      await expect(readMediaFile(path, { maxBytes: 2 })).rejects.toThrow(/limit/i);
      await expect(readMediaFile(path, { signal: AbortSignal.abort() })).rejects.toThrow();
    }
    const empty = join(dir, 'empty.wav'); await writeFile(empty, '');
    await expect(readMediaFile(empty)).rejects.toThrow(/empty/i);
    await expect(readMediaFile(join(dir, 'file.unknown'))).rejects.toThrow(/type/i);
    await expect(readMediaFile(dir, { mimeType: 'video/mp4' })).rejects.toThrow(/file/i);
    await expect(readMediaFile(empty, { maxBytes: NaN })).rejects.toThrow(/limit/i);
    await expect(readMediaFile(join(dir, 'missing.wav'))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('sends mixed native media in order in both modes [AC:loop-native-media#AC-2]', async () => {
  const { bodies } = capture();
  const model = adapter();
  expect((await model.runTurn(input())).assistantParts).toContainEqual({ type: 'text', text: 'understood' });
  const chunks: unknown[] = [];
  await model.runTurnStream(input(), chunk => chunks.push(chunk));
  expect(chunks).toContainEqual({ type: 'text_delta', text: 'understood' });
  for (const body of bodies) {
    expect(body.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
      { type: 'text', text: 'explain' },
      { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${data}`, format: 'wav' } },
      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${data}` } },
    ]);
    expect(body.modalities).toEqual(['text']);
  }
});

it('uses standard raw base64 for OpenAI audio [AC:loop-native-media#AC-2]', async () => {
  const { bodies } = capture();
  await adapter('openai').runTurn(input([media('audio', 'audio/mpeg')]));
  expect(bodies[0].messages[1].content).toEqual([{ type: 'input_audio', input_audio: { data, format: 'mp3' } }]);
});

it('rejects unsupported or missing media before HTTP without retry [AC:loop-native-media#AC-3]', async () => {
  const { fetcher } = capture();
  const anthropic = new AnthropicMessagesAdapter({ baseUrl: 'https://example.test', apiKey: 'test', model: 'test' });
  for (const model of [adapter('openai'), adapter('qwen-omni', 'responses'), anthropic]) {
    await expect(model.runTurn(input([media('video', 'video/mp4')]))).rejects.toMatchObject({ status: 400 });
    await expect(model.runTurnStream!(input([media('video', 'video/mp4')]), () => {})).rejects.toMatchObject({ status: 400 });
  }
  for (const part of [
    { type: 'audio', assetId: 'missing', mimeType: 'audio/wav' },
    { type: 'audio', assetId: 'bad', mimeType: 'video/mp4', source: { type: 'base64', data } },
    { type: 'audio', assetId: 'bad', mimeType: 'audio/wav', source: { type: 'base64', data: 'invalid!' } },
    { type: 'video', assetId: 'bad', mimeType: 'video/mp4', source: { type: 'url', url: 'file:///tmp/clip.mp4' } },
  ] as MessagePart[]) {
    await expect(adapter().runTurn(input([part]))).rejects.toMatchObject({ status: 400 });
  }
  try { await adapter('openai').runTurn(input([media('video', 'video/mp4')])); } catch (error) {
    expect(classifyModelError(error)).toMatchObject({ category: 'bad_request', upstreamRetryable: false });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not log media bodies and counts media in summaries and budgets [AC:loop-native-media#AC-5]', () => {
  const body = { messages: [{ content: [{ type: 'input_audio', input_audio: { data, format: 'wav' } }, { type: 'video_url', video_url: { url: `data:video/mp4;base64,${data}` } }, { type: 'image', source: { type: 'base64', data } }] }], input: [{ content: [{ type: 'input_image', image_url: `data:image/png;base64,${data}` }] }] };
  expect(JSON.stringify(sanitizeLlmRequestBodyForDebug(body, {}))).not.toContain(data);
  expect(body.messages[0]!.content[0]!.input_audio?.data).toBe(data);
  expect(textSummaryFromParts(parts)).toContain('[audio');
  expect(textSummaryFromParts(parts)).toContain('[video');
  expect(estimateMessageTokens(input([media('video', 'video/mp4')]).messages)).toBeGreaterThan(1000);
  expect(estimateMessageTokens(input([media('audio', 'audio/wav')]).messages)).toBeGreaterThan(1000);
});

it('resolves old image assets and new media without mutating history [AC:loop-native-media#AC-4]', async () => {
  const { bodies } = capture();
  const turn = input([{ type: 'image', assetId: 'old', mimeType: 'image/png' }, { type: 'video', assetId: 'new', mimeType: 'video/mp4' }]);
  const before = structuredClone(turn.messages);
  turn.resolveImageDataUrl = async () => `data:image/png;base64,${data}`;
  turn.resolveMediaDataUrl = async part => part.type === 'video' ? 'https://example.test/clip.mp4' : undefined;
  await adapter().runTurn(turn);
  expect(bodies[0].messages[1].content).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }, { type: 'video_url', video_url: { url: 'https://example.test/clip.mp4' } }]);
  expect(turn.messages).toEqual(before);
});

it('routes audio and video to the multimodal adapter [AC:loop-native-media#AC-4]', async () => {
  const text = { name: 'text', runTurn: vi.fn(), summarizeMessages: async () => '' };
  const omni = { name: 'omni', runTurn: vi.fn(async () => ({ stopReason: 'end' as const, assistantParts: [] })), summarizeMessages: async () => '' };
  for (const scope of ['any', 'last_user'] as const) {
    const router = new HybridModelRouterAdapter(text, omni, scope);
    await router.runTurn(input([media('audio', 'audio/wav')]));
    await router.runTurn(input([media('video', 'video/mp4')]));
  }
  expect(omni.runTurn).toHaveBeenCalledTimes(4);
  expect(text.runTurn).not.toHaveBeenCalled();
});

it('sends inline images through Responses and Anthropic [AC:loop-native-media#AC-2]', async () => {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return Response.json(body.input
      ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'image seen' }] }] }
      : { content: [{ type: 'text', text: 'image seen' }], stop_reason: 'end_turn' });
  }));
  const turn = input([media('image', 'image/png')]);
  await adapter('openai', 'responses').runTurn(turn);
  await new AnthropicMessagesAdapter({ baseUrl: 'https://example.test', apiKey: 'test', model: 'test' }).runTurn(turn);
  expect(bodies[0].input[0].content).toEqual([{ type: 'input_image', image_url: `data:image/png;base64,${data}`, detail: 'auto' }]);
  expect(bodies[1].messages[0].content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]);
});

it('preserves URL inputs for Qwen, validates OpenAI formats, and propagates cancellation [AC:loop-native-media#AC-2] [AC:loop-native-media#AC-3]', async () => {
  const { bodies, fetcher } = capture();
  const audio: MediaPart = { type: 'audio', assetId: 'url', mimeType: 'audio/mpeg', source: { type: 'url', url: 'https://example.test/audio.mp3?signature=abc' } };
  await adapter().runTurn(input([audio]));
  expect(bodies[0].messages[1].content[0].input_audio).toEqual({ data: audio.source!.type === 'url' ? audio.source!.url : '', format: 'mp3' });
  await expect(adapter('openai').runTurn(input([audio]))).rejects.toMatchObject({ status: 400 });
  await expect(adapter('openai').runTurn(input([media('audio', 'audio/aac')]))).rejects.toMatchObject({ status: 400 });
  await expect(adapter().runTurn(input([media('audio', 'audio/flac')]))).rejects.toMatchObject({ status: 400 });
  const ctrl = new AbortController();
  const turn = input([{ type: 'video', assetId: 'asset', mimeType: 'video/mp4' }]);
  turn.signal = ctrl.signal;
  turn.resolveMediaDataUrl = async (_part, signal) => { expect(signal).toBe(ctrl.signal); ctrl.abort(); return `data:video/mp4;base64,${data}`; };
  await expect(adapter().runTurnStream(turn, () => {})).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('handles large file Base64 without exposing binary in diagnostics [AC:loop-native-media#AC-1] [AC:loop-native-media#AC-3]', async () => {
  const { bodies } = capture();
  const bytes = Buffer.alloc(1024 * 1024, 42).toString('base64');
  const part: MediaPart = { type: 'audio', assetId: 'large', mimeType: 'audio/wav', source: { type: 'base64', data: bytes } };
  await adapter('openai').runTurn(input([part]));
  expect(bodies[0].messages[1].content[0].input_audio.data).toBe(bytes);
  const turn = input([{ type: 'video', assetId: 'asset', mimeType: 'video/mp4' }]);
  turn.resolveMediaDataUrl = async () => `data:audio/wav;base64,${data}`;
  await expect(adapter().runTurn(turn)).rejects.toMatchObject({ status: 400 });
});
