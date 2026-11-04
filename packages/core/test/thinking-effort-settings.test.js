import test from 'node:test';
import assert from 'node:assert/strict';

const {
  defaultThinkingEffortSettings,
  normalizeThinkingEffortSettings,
  readThinkingEffortSettings,
  writeThinkingEffortSettings,
  resolveThinkingEffort,
  hasPersistedThinkingEffortSettings,
  applyThinkingEffortToTurn,
  isThinkingEffortLevel
} = await import('../dist/model/thinking-effort-settings.js');

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

test('unsaved thinking effort stays off and omits the request field [AC:thinking-effort#AC-1]', () => {
  assert.equal(defaultThinkingEffortSettings().level, 'off');
  assert.equal(readThinkingEffortSettings(undefined).level, 'off');
  assert.equal(resolveThinkingEffort(undefined), 'off');
  assert.equal(hasPersistedThinkingEffortSettings(undefined), false);
  const turn = { reasoningEffort: 'high', text: 'keep' };
  const next = applyThinkingEffortToTurn(turn, undefined);
  assert.equal('reasoningEffort' in next, false);
  assert.equal(next.text, 'keep');
});

test('saved low, medium, and high are what the next turn asks for [AC:thinking-effort#AC-2]', () => {
  const store = kvStore();
  for (const level of ['low', 'medium', 'high']) {
    const saved = writeThinkingEffortSettings(store, { level });
    assert.equal(saved.level, level);
    assert.equal(readThinkingEffortSettings(store).level, level);
    assert.equal(resolveThinkingEffort(store), level);
    assert.equal(hasPersistedThinkingEffortSettings(store), true);
    assert.equal(applyThinkingEffortToTurn({ text: 'turn' }, store).reasoningEffort, level);
  }
});

test('saving off removes thinking effort from the next turn [AC:thinking-effort#AC-3]', () => {
  const store = kvStore();
  writeThinkingEffortSettings(store, { level: 'high' });
  writeThinkingEffortSettings(store, { level: 'off' });
  assert.equal(readThinkingEffortSettings(store).level, 'off');
  assert.equal(hasPersistedThinkingEffortSettings(store), true);
  const next = applyThinkingEffortToTurn({ reasoningEffort: 'high' }, store);
  assert.equal('reasoningEffort' in next, false);
});

test('junk levels do not become a thinking effort [AC:thinking-effort#AC-1]', () => {
  assert.equal(isThinkingEffortLevel('max'), false);
  assert.equal(normalizeThinkingEffortSettings({ level: 'max' }).level, 'off');
  const store = kvStore();
  writeThinkingEffortSettings(store, { level: 'low' });
  writeThinkingEffortSettings(store, { level: 'turbo' });
  assert.equal(readThinkingEffortSettings(store).level, 'low');
});
