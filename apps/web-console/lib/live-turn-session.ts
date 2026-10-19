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
 * A fetched transcript belongs on screen only for the session it was loaded for.
 * An empty id means nothing foreign is loaded yet.
 */
export function transcriptBound(
  loadedSessionId: string | null | undefined,
  selectedSessionId: string | null
): boolean {
  if (loadedSessionId == null || loadedSessionId === '') return true;
  return loadedSessionId === selectedSessionId;
}

/**
 * What the main transcript should draw for the selected session.
 * Messages loaded for another session stay off screen, including text that
 * already streamed. Optimistic bubbles, the streaming placeholder, and the
 * waiting 「…」 only stay when this session owns the live turn.
 */
export function screenLiveTurn<T extends readonly unknown[]>(input: {
  selectedSessionId: string | null;
  loadedSessionId?: string | null;
  messages: T | [];
  liveSessionId: string | null;
  optimisticUser: string | null;
  hasStream: boolean;
  waitTyping: boolean;
  playSending: boolean;
}): {
  messages: T | [];
  bound: boolean;
  optimisticUser: string | null;
  hasStream: boolean;
  waitTyping: boolean;
  playSending: boolean;
} {
  const bound = transcriptBound(input.loadedSessionId, input.selectedSessionId);
  const show = bound && liveTurnBelongsToSelection(input.liveSessionId, input.selectedSessionId);
  return {
    messages: bound ? input.messages : [],
    bound,
    optimisticUser: show ? input.optimisticUser : null,
    hasStream: show && input.hasStream,
    waitTyping: show && input.waitTyping,
    playSending: show && input.playSending,
  };
}

/** Apply an async Bot open only while its request, selection and turn still match. */
export function botOpenApplies(request: number, currentRequest: number, selected: string | null,
  currentSelected: string | null, currentTurn: boolean): boolean {
  return request === currentRequest && selected === currentSelected && currentTurn;
}

export function visibleStream<T>(show: boolean, overlay: T): T | null {
  return show ? overlay : null;
}

export function liveTurnRunning(owner: string | null, selected: string | null,
  sending: boolean, streaming: boolean, waiting: boolean): boolean {
  return liveTurnBelongsToSelection(owner, selected) && (sending || streaming || waiting);
}

/** Returning to the same session does not revive a detached steer request. */
export function steerResponseApplies(generation: number, currentGeneration: number,
  session: string, currentSession: string | null): boolean {
  return generation === currentGeneration && session === currentSession;
}

/** Also check selection before React has detached the previous generation. */
export function mayClaimSelectedSession(activeGeneration: number, paintGeneration: number,
  selectedSessionId: string | null, nextSessionId: string): boolean {
  return streamPaintApplies(activeGeneration, paintGeneration) &&
    (selectedSessionId == null || selectedSessionId === nextSessionId);
}

export function canFollowSession(selected: string | null, requested: string): boolean {
  return selected == null || selected === requested;
}
