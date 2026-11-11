import test from 'node:test';
import assert from 'node:assert/strict';

const {
  defaultPromptVariantSettings,
  normalizePromptVariantSettings,
  readPromptVariantSettings,
  writePromptVariantSettings,
  resolvePromptVariant,
  hasPersistedPromptVariantSettings,
  resetPromptVariantLogGuardForTests
} = await import('../dist/model/prompt-variant-settings.js');

const { PromptBuilder } = await import('../dist/model/prompt-builder.js');

function kvStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getDaemonControl(key) {
      return map.get(key);
    },
    setDaemonControl(key, value) {
      map.set(key, value);
    }
  };
}

function makeCtx() {
  return {
    agent: {
      id: 'test-agent',
      name: 'TestBot',
      role: 'assistant',
      instructions: 'Be helpful.',
      capabilities: []
    },
    session: {
      id: 'sess-1',
      mode: 'chat',
      todo: [],
      summary: ''
    },
    repoRoot: '/repo'
  };
}

test('default variant is anthropic5', () => {
  assert.equal(defaultPromptVariantSettings().variant, 'anthropic5');
  assert.equal(readPromptVariantSettings(undefined).variant, 'anthropic5');
  assert.equal(resolvePromptVariant(undefined), 'anthropic5');
  assert.equal(hasPersistedPromptVariantSettings(undefined), false);
});

test('write legacy then resolve returns legacy', () => {
  resetPromptVariantLogGuardForTests();
  const store = kvStore();
  const next = writePromptVariantSettings(store, { variant: 'legacy' });
  assert.equal(next.variant, 'legacy');
  assert.equal(readPromptVariantSettings(store).variant, 'legacy');
  assert.equal(resolvePromptVariant(store), 'legacy');
  assert.equal(hasPersistedPromptVariantSettings(store), true);
});

test('normalize ignores junk variant → default anthropic5', () => {
  const n = normalizePromptVariantSettings({ variant: 'nope', updatedAt: 'x' });
  assert.equal(n.variant, 'anthropic5');
  assert.equal(normalizePromptVariantSettings(null).variant, 'anthropic5');
  assert.equal(normalizePromptVariantSettings({}).variant, 'anthropic5');
});

test('both variants produce non-empty stable prefix', () => {
  resetPromptVariantLogGuardForTests();
  const store = kvStore();
  const builder = new PromptBuilder({ store, repoRoot: '/repo' });

  // default anthropic5
  const a5 = builder.buildStablePrefix(makeCtx());
  assert.ok(a5.length > 50, 'anthropic5 prefix too short');
  assert.ok(a5.includes('TestBot'));
  assert.ok(a5.includes('<role>'), 'anthropic5 should use XML role section');

  writePromptVariantSettings(store, { variant: 'legacy' });
  // clear cache by using new builder (stablePrefixCache is per instance)
  const builder2 = new PromptBuilder({ store, repoRoot: '/repo' });
  const legacy = builder2.buildStablePrefix(makeCtx());
  assert.ok(legacy.length > 50, 'legacy prefix too short');
  assert.ok(legacy.includes('TestBot'));
  assert.ok(legacy.includes('You are TestBot (assistant).'));
  assert.ok(!legacy.includes('<role>'), 'legacy should not use XML role section');
});


test('literal identifiers in both variants [AC:literal-tool-identifiers#AC-1]', () => {
  for (const variant of ['legacy', 'anthropic5']) {
    const store = kvStore();
    writePromptVariantSettings(store, { variant });
    const prefix = new PromptBuilder({ store, repoRoot: '/repo' }).buildStablePrefix(makeCtx());
    assert.ok(prefix.includes('The colon belongs to the key.'));
    assert.ok(prefix.includes('{"key":"inventory:blue"}'));
    assert.ok(prefix.includes('Preserve the complete identifier verbatim'));
    for (const examKey of ['document:policy', 'gauge:idle', 'token:west', 'route:start']) {
      assert.ok(!prefix.includes(examKey), 'exam answers must not enter the stable prompt');
    }
  }
});
test('read evidence in both variants [AC:literal-tool-identifiers#AC-2]', () => {
  for (const variant of ['legacy', 'anthropic5']) {
    const store = kvStore();
    writePromptVariantSettings(store, { variant });
    const prefix = new PromptBuilder({ store, repoRoot: '/repo' }).buildStablePrefix(makeCtx());
    assert.ok(prefix.includes('A failed lookup is not evidence'));
    assert.ok(prefix.includes('0, false, and an empty string'));
    assert.ok(prefix.includes('do not guess a value and save it'));
  }
});
