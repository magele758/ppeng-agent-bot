/** DOM keyCode while an IME is handling the key (not a committed Enter). */
export const IME_COMPOSITION_KEY_CODE = 229;

/**
 * After compositionend, swallow the Enter that confirmed the candidate.
 * Browsers may fire that keydown with isComposing already false.
 * The timer is one turn, so the next Enter still sends.
 */
export const COMPOSITION_ENTER_GUARD_MS = 0;

export type ComposerEnterState = {
  key: string;
  shiftKey: boolean;
  /** KeyboardEvent.isComposing */
  isComposing: boolean;
  /** KeyboardEvent.keyCode */
  keyCode: number;
  /** True from compositionstart until compositionend. */
  compositionActive: boolean;
  /** True for COMPOSITION_ENTER_GUARD_MS after compositionend. */
  compositionJustEnded: boolean;
};

export type ComposerEnterDecision = {
  send: boolean;
  /** Stop the key from inserting a newline. Never set while the IME still owns the key. */
  preventDefault: boolean;
  /** Only a real send clears the draft. A swallowed Enter must leave it. */
  clearDraft: boolean;
};

const keepDraft = (preventDefault: boolean): ComposerEnterDecision => ({
  send: false,
  preventDefault,
  clearDraft: false,
});

/** Whether this keydown should send, insert a newline, or be ignored for IME. */
export function decideComposerEnter(state: ComposerEnterState): ComposerEnterDecision {
  if (state.key !== 'Enter') return keepDraft(false);
  if (state.shiftKey) return keepDraft(false);
  const imeOwnsKey =
    state.isComposing ||
    state.keyCode === IME_COMPOSITION_KEY_CODE ||
    state.compositionActive;
  if (imeOwnsKey) return keepDraft(false);
  if (state.compositionJustEnded) return keepDraft(true);
  return { send: true, preventDefault: true, clearDraft: true };
}

export function shouldSendOnComposerEnter(state: ComposerEnterState): boolean {
  return decideComposerEnter(state).send;
}
