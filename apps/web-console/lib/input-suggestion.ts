/**
 * Composer ghost-text state. The suggestion is never part of the textarea value
 * until Tab commits it. Typing, Escape, send, blur, or a non-empty draft drops it.
 */

export interface InputSuggestion {
  primary: string;
  alternatives: string[];
}

export interface GhostState {
  items: string[];
  index: number;
}

export function emptyGhost(): GhostState {
  return { items: [], index: 0 };
}

export function ghostFromSuggestion(suggestion: InputSuggestion | null | undefined): GhostState {
  if (!suggestion) return emptyGhost();
  const items = [suggestion.primary, ...suggestion.alternatives]
    .map((item) => item.trim())
    .filter(Boolean);
  const unique: string[] = [];
  for (const item of items) {
    if (!unique.includes(item)) unique.push(item);
  }
  return unique.length ? { items: unique.slice(0, 3), index: 0 } : emptyGhost();
}

export function ghostText(state: GhostState): string {
  return state.items[state.index] ?? '';
}

export type GhostKey = 'Tab' | 'Escape' | 'type' | 'send' | 'blur';

export interface GhostKeyResult {
  state: GhostState;
  /** Text to write into the real input. Absent means the draft is unchanged. */
  commit?: string;
  preventDefault: boolean;
}

/**
 * Tab commits the visible guess (or cycles when more than one is showing and
 * the caller asks to cycle before commit). One Tab writes the current item
 * into the real input so the user can edit it. A later Tab, while the draft
 * still equals that item and more guesses remain, replaces it with the next.
 */
export function applyGhostKey(state: GhostState, key: GhostKey, draft: string): GhostKeyResult {
  const current = ghostText(state);
  if (key === 'Tab') {
    if (!current) return { state, preventDefault: false };
    if (draft.trim().length === 0) {
      return {
        state: { items: state.items, index: state.index },
        commit: current,
        preventDefault: true
      };
    }
    if (draft === current && state.items.length > 1) {
      const index = (state.index + 1) % state.items.length;
      const next = state.items[index] ?? '';
      return { state: { items: state.items, index }, commit: next, preventDefault: true };
    }
    return { state, preventDefault: false };
  }
  if (key === 'Escape' || key === 'send' || key === 'blur' || key === 'type') {
    return { state: emptyGhost(), preventDefault: key === 'Escape' && Boolean(current) };
  }
  return { state, preventDefault: false };
}

/** While a guess is showing, the next Tab should fill the box instead of moving focus. */
export function tabAcceptsGhost(state: GhostState, draft: string): boolean {
  if (!ghostText(state)) return false;
  if (draft.trim().length === 0) return true;
  return draft === ghostText(state) && state.items.length > 1;
}

export interface SuggestionRace {
  requestId: number;
  sessionId: string;
  /** Live turn generation when the request was issued. A newer turn drops the response. */
  turnGeneration: number;
}

/** Newer request, a session switch, or a newer turn invalidates an in-flight response. */
export function suggestionStillCurrent(issued: SuggestionRace, current: SuggestionRace): boolean {
  return (
    issued.requestId === current.requestId &&
    issued.sessionId === current.sessionId &&
    issued.turnGeneration === current.turnGeneration
  );
}

/**
 * Ask again when the empty composer can show a guess and nothing is already on screen.
 * Blur hides the ghost without forgetting it; focus, or the reply ending, brings it back.
 * A draft, a busy turn, or a non-bot surface does not ask.
 */
export function shouldRefreshSuggestion(input: {
  botChat: boolean;
  enabled: boolean;
  draft: string;
  busy: boolean;
  hasSuggestion: boolean;
}): boolean {
  return input.botChat && input.enabled && !input.busy && input.draft.trim().length === 0 && !input.hasSuggestion;
}
