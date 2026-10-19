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

export function shouldTickLiveArm(current: boolean, aborted: boolean): boolean {
  return current && !aborted;
}

export function applyWhen(cond: boolean, effect: () => void): void {
  if (cond) effect();
}
