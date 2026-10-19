/** Live composer turn that has not been bound to a saved session yet. */
export const UNBOUND_LIVE_TURN = '*unbound-live-turn*';

/** True when this in-progress turn should be drawn on the selected session. */
export function liveTurnBelongsToSelection(
  liveSessionId: string | null,
  selectedSessionId: string | null
): boolean {
  if (liveSessionId == null) return false;
  if (liveSessionId === UNBOUND_LIVE_TURN) return selectedSessionId == null;
  return liveSessionId === selectedSessionId;
}

export function shouldDetachLiveTurn(
  liveSessionId: string | null,
  selectedSessionId: string | null
): boolean {
  return liveSessionId != null && !liveTurnBelongsToSelection(liveSessionId, selectedSessionId);
}

/** Drop a live turn that belongs to some other session. History messages are not part of this value. */
export function detachLiveTurn<T extends { generation: number; liveSessionId: string | null }>(
  live: T,
  selectedSessionId: string | null
): T & { detached: boolean } {
  if (!shouldDetachLiveTurn(live.liveSessionId, selectedSessionId)) {
    return { ...live, detached: false };
  }
  return {
    ...live,
    generation: live.generation + 1,
    liveSessionId: null,
    detached: true,
  };
}

/** Stream tokens from an older turn must not paint after that turn was detached. */
export function streamPaintApplies(activeGeneration: number, paintGeneration: number): boolean {
  return activeGeneration === paintGeneration;
}

/**
 * A live turn may bind `nextSessionId` only while it still owns the screen.
 * A session the user already selected is left alone, even before the generation bumps.
 */
export function mayClaimSelectedSession(
  activeGeneration: number,
  paintGeneration: number,
  selectedSessionId: string | null,
  nextSessionId: string
): boolean {
  if (!streamPaintApplies(activeGeneration, paintGeneration)) return false;
  return selectedSessionId == null || selectedSessionId === nextSessionId;
}

/**
 * What the main transcript should draw for the selected session.
 * Saved messages stay as given. Optimistic bubbles, the streaming placeholder,
 * and the waiting 「…」 only stay when they belong to that session.
 */
export function screenLiveTurn<T>(input: {
  selectedSessionId: string | null;
  messages: readonly T[];
  liveSessionId: string | null;
  optimisticUser: string | null;
  hasStream: boolean;
  waitTyping: boolean;
  playSending: boolean;
}): {
  messages: readonly T[];
  optimisticUser: string | null;
  hasStream: boolean;
  waitTyping: boolean;
  playSending: boolean;
} {
  const show = liveTurnBelongsToSelection(input.liveSessionId, input.selectedSessionId);
  return {
    messages: input.messages,
    optimisticUser: show ? input.optimisticUser : null,
    hasStream: show && input.hasStream,
    waitTyping: show && input.waitTyping,
    playSending: show && input.playSending,
  };
}
