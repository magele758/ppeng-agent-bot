/**
 * Upstream record/replay through core's production adapter path: the fixtures in
 * packages/agent-loop/src/testing/upstream-fixtures replayed against the adapters
 * core exports (and provider-catalog builds), plus the runtime fallback chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadReplayFixtures,
  replayApiKey,
  replayFixture,
  replayMismatches,
  startReplayServer
} from '../../agent-loop/dist/testing/upstream-replay.js';
import { AnthropicCompatibleAdapter, OpenAICompatibleAdapter } from '../dist/model/model-adapters.js';
import { classifyModelError, isUpstreamRetryableCategory } from '../dist/model/error-class.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { writeModelFallbackSettings } from '../dist/model/fallback-chain.js';
import { setCatalogDefaultRef, upsertProvider } from '../dist/model/provider-catalog.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../agent-loop/src/testing/upstream-fixtures');
const fixtures = loadReplayFixtures(FIXTURE_DIR);

const adapterOptions = (baseUrl) => ({ apiKey: replayApiKey(), baseUrl, model: 'replay-model', useJsonMode: false });
const makers = {
  'openai-chat': (baseUrl) => new OpenAICompatibleAdapter({ ...adapterOptions(baseUrl), httpKind: 'chat_completions' }),
  'openai-responses': (baseUrl) => new OpenAICompatibleAdapter({ ...adapterOptions(baseUrl), httpKind: 'responses' }),
  anthropic: (baseUrl) => new AnthropicCompatibleAdapter(adapterOptions(baseUrl))
};

/** How fallback must treat each failing scenario. Every error fixture has to be listed. */
const errorCategories = {
  'anthropic-error-429-retry-after': 'rate_limited',
  'anthropic-error-529': 'overloaded',
  'anthropic-stream-overloaded-error': 'overloaded',
  'anthropic-stream-premature-eof': 'connection',
  'chat-error-401': 'auth',
  'chat-error-429-retry-after': 'rate_limited',
  'chat-error-500-html': 'server_error',
  'chat-stream-connection-reset': 'connection',
  'chat-stream-midstream-error': 'server_error',
  'chat-stream-premature-eof': 'connection',
  'chat-stream-stall-timeout': 'timeout',
  'responses-error-503': 'overloaded',
  'responses-stream-error-event': 'rate_limited',
  'responses-stream-failed': 'server_error',
  'responses-stream-no-terminal-event': 'connection',
  'responses-stream-stall-timeout': 'timeout'
};

test('replay fixtures cover every provider and every error fixture has a classification', () => {
  assert.ok(fixtures.length >= 35);
  assert.deepEqual(new Set(fixtures.map((f) => f.provider)), new Set(Object.keys(makers)));
  assert.deepEqual(
    fixtures.filter((f) => f.expect.error).map((f) => f.name).sort(),
    Object.keys(errorCategories).sort()
  );
});

for (const fx of fixtures) {
  test(`core adapters replay: ${fx.name}`, async () => {
    const outcome = await replayFixture(fx, makers[fx.provider]);
    const mismatches = replayMismatches(outcome, fx.expect);
    assert.deepEqual(mismatches, [], mismatches.join('\n'));
    if (!fx.expect.error) return;
    const { category } = classifyModelError(outcome.error);
    assert.equal(category, errorCategories[fx.name]);
    assert.equal(isUpstreamRetryableCategory(category), category !== 'auth');
  });
}

const chatChunk = (content, finish = null) => ({
  data: { id: 'chatcmpl-Fallback', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: finish }] }
});

function visibleText(chunks) {
  let text = '';
  for (const c of chunks) {
    if (c.type === 'stream_reset') text = '';
    else if (c.type === 'text_delta') text += c.text;
  }
  return text;
}

test('runtime fallback after a mid-stream drop resets the client stream; transcript keeps only the backup answer', async () => {
  const primary = await startReplayServer([{ status: 200, end: 'destroy', events: [chatChunk('PARTIAL-FROM-PRIMARY ')] }]);
  const backup = await startReplayServer([
    { status: 200, events: [chatChunk('hello '), chatChunk('from backup', 'stop'), { data: '[DONE]' }] }
  ]);
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'replay-fb-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'replay-fb-state-'))
  });
  try {
    for (const [id, server] of [['prov-a', primary], ['prov-b', backup]]) {
      upsertProvider(runtime.store, {
        id,
        name: id,
        kind: 'openai-compatible',
        baseUrl: server.baseUrl,
        apiKey: replayApiKey(),
        useJsonMode: false,
        models: [{ id: `${id}-model`, enabled: true }]
      });
    }
    setCatalogDefaultRef(runtime.store, { providerId: 'prov-a', modelId: 'prov-a-model' });
    writeModelFallbackSettings(runtime.store, { chain: [{ providerId: 'prov-b', modelId: 'prov-b-model' }] }, {});

    const session = runtime.createChatSession({ title: 'fallback replay', message: 'hi' });
    const chunks = [];
    await runtime.runSession(session.id, { onModelStreamChunk: (c) => chunks.push(c) });

    assert.equal(primary.requests.length, 6, 'primary keeps the full default retry budget');
    assert.equal(backup.requests.length, 1);
    const resets = chunks.filter((c) => c.type === 'stream_reset').map((c) => c.reason);
    assert.deepEqual(resets, ['retry', 'retry', 'retry', 'retry', 'retry', 'fallback']);
    const fallbackAt = chunks.findIndex((c) => c.type === 'stream_reset' && c.reason === 'fallback');
    assert.ok(
      chunks.slice(fallbackAt + 1).every((c) => c.type !== 'text_delta' || !c.text.includes('PARTIAL')),
      'nothing from the primary after the fallback reset'
    );
    assert.equal(visibleText(chunks), 'hello from backup');

    const persisted = runtime
      .getSessionMessages(session.id)
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text));
    assert.deepEqual(persisted, ['hello from backup']);
    // Trace events are appended fire-and-forget, so give the write a moment under load.
    let kinds = [];
    for (let i = 0; i < 40 && !kinds.includes('model_fallback'); i += 1) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 50));
      kinds = (await runtime.listTraceEvents(session.id)).map((e) => e.kind);
    }
    assert.ok(kinds.includes('model_fallback'), kinds.join(','));
  } finally {
    await runtime.destroy();
    await primary.close();
    await backup.close();
  }
});
