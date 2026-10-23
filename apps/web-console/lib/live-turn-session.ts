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
 * already streamed. The streaming placeholder and the waiting 「…」 stay only
 * while this session owns the live turn. A steer bubble stays on this session
 * until its official message lands, even after the local stream follow ends.
 */
export function screenLiveTurn<T extends readonly unknown[]>(input: {
  selectedSessionId: string | null;
  loadedSessionId?: string | null;
  messages: T | [];
  liveSessionId: string | null;
  optimisticUser: string | null;
  pendingSteerSessionId?: string | null;
  steerLanded?: boolean;
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
  const holdSteer = bound
    && input.steerLanded !== true
    && input.pendingSteerSessionId != null
    && input.pendingSteerSessionId === input.selectedSessionId
    && Boolean(input.optimisticUser);
  return {
    messages: bound ? input.messages : [],
    bound,
    optimisticUser: input.steerLanded ? null : (show || holdSteer ? input.optimisticUser : null),
    hasStream: show && input.hasStream,
    waitTyping: show && input.waitTyping,
    playSending: show && input.playSending,
  };
}

/** A rejected immediate steer leaves the transcript and returns to the composer. */
export function steerUiAfterSend(input: {
  rejected: boolean;
  text: string;
  optimistic: string | null;
}): { bubble: string | null; composer: string | null } {
  if (input.rejected) return { bubble: null, composer: input.text };
  return { bubble: input.optimistic, composer: null };
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

/** Thrown when a newer selection owns the screen and this turn must stop quietly. */
export class LiveTurnSuperseded extends Error {
  constructor() {
    super('live turn superseded');
    this.name = 'LiveTurnSuperseded';
  }
}

export function liveTurnOwnerId(sessionId: string | null): string {
  return sessionId ?? UNBOUND_LIVE_TURN;
}

export function visibleLiveOverlay<T>(show: boolean, overlay: T): T | null {
  return show ? overlay : null;
}

export function assertLiveTurn(ok: boolean): void {
  if (!ok) throw new LiveTurnSuperseded();
}

export function assertSameSession(current: string | null, expected: string): void {
  if (current !== expected) throw new LiveTurnSuperseded();
}

export function releaseIfCurrent(current: boolean, release: () => void): void {
  if (current) release();
}

export function liveTurnIsRunning(
  belongs: boolean,
  sending: boolean,
  streaming: boolean,
  waiting: boolean
): boolean {
  return belongs && (sending || streaming || waiting);
}

export function ownsLiveTurn(err: unknown, onScreen: boolean): boolean {
  return !(err instanceof LiveTurnSuperseded) && onScreen;
}

export function reportOwnedError(owned: boolean, report: () => void): void {
  if (owned) report();
}

export async function runIf(ok: boolean, action: () => Promise<void> | void): Promise<void> {
  if (ok) await action();
}

export function restoreComposerUnlessPersisted(persisted: boolean, restore: () => void): void {
  if (!persisted) restore();
}

export async function tickIfPersisted(persisted: boolean, tick: () => Promise<unknown>): Promise<void> {
  if (persisted) await tick();
}

export function handleSteerFailure(input: {
  superseded: boolean;
  sameSession: boolean;
  immediate: boolean;
  restore: () => void;
  report: () => void;
}): void {
  if (input.superseded || !input.sameSession) return;
  if (input.immediate) input.restore();
  input.report();
}

export function resultSessionId(event: string, sessionId: string | undefined): string | null {
  if (event !== 'result' || !sessionId) return null;
  return sessionId;
}

export function streamSessionAllowed(input: {
  liveGen: number | undefined;
  activeGeneration: number;
  selectedSessionId: string | null;
  sessionId: string;
}): boolean {
  if (
    input.liveGen != null &&
    !mayClaimSelectedSession(input.activeGeneration, input.liveGen, input.selectedSessionId, input.sessionId)
  ) {
    return false;
  }
  if (input.selectedSessionId != null && input.selectedSessionId !== input.sessionId) return false;
  return true;
}

export function streamOverlayVisible(input: {
  liveGen: number | undefined;
  activeGeneration: number;
  liveSessionId: string | null;
  selectedSessionId: string | null;
}): boolean {
  if (input.liveGen != null && !streamPaintApplies(input.activeGeneration, input.liveGen)) return false;
  return liveTurnBelongsToSelection(input.liveSessionId, input.selectedSessionId);
}

export function shouldSkipForeignLiveArm(selected: string | null, sessionId: string): boolean {
  return Boolean(selected) && selected !== sessionId;
}

export function generationForArm(alreadyOwner: boolean, current: number, claim: () => number): number {
  return alreadyOwner ? current : claim();
}

export function shouldSurfaceLiveArmError(aborted: boolean, onScreen: boolean): boolean {
  return !aborted && onScreen;
}

export function releaseArmOwner(current: boolean, claimedHere: boolean, ownerIsSession: boolean): boolean {
  return current && claimedHere && ownerIsSession;
}

/** A dropped follow socket is not a user stop. Still load the saved transcript. */
export function shouldTickLiveArm(current: boolean, aborted: boolean): boolean {
  void aborted;
  return current;
}

export function applyWhen(cond: boolean, effect: () => void): void {
  if (cond) effect();
}
