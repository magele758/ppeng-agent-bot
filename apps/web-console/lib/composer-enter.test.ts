import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideComposerEnter,
  shouldSendOnComposerEnter,
  type ComposerEnterState,
} from './composer-enter.ts';

const enter: ComposerEnterState = {
  key: 'Enter',
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  compositionActive: false,
  compositionJustEnded: false,
};

test('输入法确认候选时 Enter 不发送，草稿保留 [AC:composer-ime-enter#AC-1]', () => {
  const confirming: ComposerEnterState[] = [
    { ...enter, isComposing: true },
    { ...enter, keyCode: 229 },
    { ...enter, isComposing: true, keyCode: 229 },
    { ...enter, compositionActive: true },
    { ...enter, compositionJustEnded: true },
    { ...enter, isComposing: false, keyCode: 229, compositionJustEnded: true },
  ];
  for (const state of confirming) {
    assert.equal(shouldSendOnComposerEnter(state), false);
    const decision = decideComposerEnter(state);
    assert.equal(decision.send, false);
    assert.equal(decision.clearDraft, false);
  }
  assert.equal(decideComposerEnter({ ...enter, isComposing: true }).preventDefault, false);
  assert.equal(decideComposerEnter({ ...enter, keyCode: 229 }).preventDefault, false);
  assert.equal(decideComposerEnter({ ...enter, compositionActive: true }).preventDefault, false);
  assert.equal(decideComposerEnter({ ...enter, compositionJustEnded: true }).preventDefault, true);
});

test('组词结束后 Enter 照常发送 [AC:composer-ime-enter#AC-2]', () => {
  assert.equal(shouldSendOnComposerEnter(enter), true);
  const decision = decideComposerEnter(enter);
  assert.equal(decision.send, true);
  assert.equal(decision.preventDefault, true);
  assert.equal(decision.clearDraft, true);
  assert.equal(shouldSendOnComposerEnter({ ...enter, key: 'a' }), false);
});

test('Shift+Enter 换行且不发送 [AC:composer-ime-enter#AC-3]', () => {
  const shifted: ComposerEnterState = { ...enter, shiftKey: true };
  assert.equal(shouldSendOnComposerEnter(shifted), false);
  const decision = decideComposerEnter(shifted);
  assert.equal(decision.send, false);
  assert.equal(decision.clearDraft, false);
  assert.equal(decision.preventDefault, false);
  assert.equal(
    shouldSendOnComposerEnter({ ...shifted, isComposing: true, keyCode: 229, compositionActive: true }),
    false,
  );
});
