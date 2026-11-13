import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_MODEL_FOLLOW_DEFAULT,
  botModelPickable,
  botModelPinIsStale,
  botModelSelectValue,
  composerModelLocked,
  parseBotModelOverride,
  resolveLoadedComposerModelRef
} from './bot-model.ts';
import type { ModelPickerOption } from './model-providers.ts';

const opt = (providerId: string, modelId: string, source: ModelPickerOption['source'] = 'ui'): ModelPickerOption => ({
  providerId,
  providerName: providerId,
  modelId,
  kind: 'openai-compatible',
  source
});

test('parseBotModelOverride reads a well-formed pin and ignores everything else', () => {
  assert.deepEqual(parseBotModelOverride({ modelOverride: { providerId: 'a', modelId: 'm' } }), {
    providerId: 'a',
    modelId: 'm'
  });
  assert.equal(parseBotModelOverride(undefined), null);
  assert.equal(parseBotModelOverride({}), null);
  assert.equal(parseBotModelOverride({ modelRef: { providerId: 'a', modelId: 'm' } }), null);
  assert.equal(parseBotModelOverride({ modelOverride: 'gpt-x' }), null);
  assert.equal(parseBotModelOverride({ modelOverride: { providerId: 'a' } }), null);
});

test('botModelSelectValue maps no pin to follow-default', () => {
  assert.equal(botModelSelectValue(null), BOT_MODEL_FOLLOW_DEFAULT);
  assert.equal(botModelSelectValue({ providerId: 'a', modelId: 'm' }), 'a::m');
});

test('picker never offers the env fallback; a pin outside the list is stale', () => {
  const options = [opt('a', 'm1'), opt('__env__', 'env-model', 'env')];
  assert.deepEqual(
    botModelPickable(options).map((o) => o.modelId),
    ['m1']
  );
  assert.equal(botModelPinIsStale(null, options), false);
  assert.equal(botModelPinIsStale({ providerId: 'a', modelId: 'm1' }, options), false);
  assert.equal(botModelPinIsStale({ providerId: 'a', modelId: 'gone' }, options), true);
  assert.equal(botModelPinIsStale({ providerId: '__env__', modelId: 'env-model' }, options), true);
});

const A = { providerId: 'a', modelId: 'm1' };
const B = { providerId: 'b', modelId: 'm2' };
const options = [opt('a', 'm1'), opt('b', 'm2')];
const base = { options, catalogDefault: B, current: A, sameSession: false, pinLifted: false };

test('resolveLoadedComposerModelRef adopts the session pin or saved modelRef', () => {
  assert.deepEqual(
    resolveLoadedComposerModelRef({ ...base, current: null, metadata: { modelOverride: A } }),
    A
  );
  assert.deepEqual(
    resolveLoadedComposerModelRef({ ...base, current: null, metadata: { modelRef: B } }),
    B
  );
});

test('resolveLoadedComposerModelRef resets when switching from a pinned Bot to an unpinned one', () => {
  assert.equal(resolveLoadedComposerModelRef({ ...base, metadata: {} }), null);
  assert.equal(resolveLoadedComposerModelRef({ ...base, metadata: undefined }), null);
});

test('resolveLoadedComposerModelRef keeps the current pick on a plain refresh of the same session', () => {
  assert.deepEqual(resolveLoadedComposerModelRef({ ...base, sameSession: true, metadata: {} }), A);
});

test('resolveLoadedComposerModelRef drops the stale modelRef right after the pin is lifted', () => {
  assert.equal(
    resolveLoadedComposerModelRef({
      ...base,
      sameSession: true,
      pinLifted: true,
      metadata: { modelRef: A }
    }),
    null
  );
  assert.equal(
    resolveLoadedComposerModelRef({ ...base, sameSession: true, pinLifted: true, metadata: {} }),
    null
  );
});

test('composerModelLocked follows the session pin, forks included', () => {
  assert.equal(composerModelLocked(A), true);
  assert.equal(composerModelLocked(null), false);
});

test('Bot follow default drops legacy composer selection on reload [AC:bot-follow-default#AC-1]', () => {
  assert.equal(resolveLoadedComposerModelRef({
    ...base, sameSession: true, metadata: { canonicalBotChat: true, modelRef: A }
  }), null);
  assert.deepEqual(resolveLoadedComposerModelRef({
    ...base, metadata: { canonicalBotChat: true, modelOverride: B, modelRef: A }
  }), B);
});
