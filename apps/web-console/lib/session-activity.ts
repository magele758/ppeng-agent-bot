/**
 * Last known run status per session, shared by the timers that watch one
 * session (status line, skill cards, activity list). They read slowly while the
 * session is idle and are told the moment it starts or stops running.
 */

const statuses = new Map<string, string>();
const stamps = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

/** A session that is producing output or waiting on the user for an approval. */
export function statusIsBusy(status: string | undefined): boolean {
  return status === 'running' || status === 'waiting_approval';
}

export function sessionBusy(sessionId: string): boolean {
  return statusIsBusy(statuses.get(sessionId));
}

export function noteSessionStatus(sessionId: string, status: string | undefined): void {
  if (!status) return;
  const was = sessionBusy(sessionId);
  statuses.set(sessionId, status);
  if (was === statusIsBusy(status)) return;
  for (const changed of [...(listeners.get(sessionId) ?? [])]) changed();
}

/** A send from this page makes the session busy before any status read says so. */
export function noteLocalSending(sessionId: string | null, sending: boolean): void {
  if (sessionId && sending) noteSessionStatus(sessionId, 'running');
}

export function noteSessionStatuses(sessions: readonly { id: string; status?: string; updatedAt?: string }[]): void {
  for (const session of sessions) {
    stamps.set(session.id, `${session.status ?? ''}@${session.updatedAt ?? ''}`);
    noteSessionStatus(session.id, session.status);
  }
}

/** Changes whenever the session list reports new activity for this session. */
export function sessionStamp(sessionId: string | null): string {
  return sessionId ? `${sessionId}:${stamps.get(sessionId) ?? ''}` : '';
}

/**
 * Timers stop while the tab is hidden, so a turn can start and finish unseen.
 * On return the open conversation is re-read only if its session moved meanwhile.
 */
export function createTabReturnWatch(stamp: () => string) {
  let before: string | undefined;
  return {
    hidden() {
      before = stamp();
    },
    changedSince(): boolean {
      const was = before;
      before = undefined;
      return was !== undefined && was !== stamp();
    }
  };
}

export async function onTabVisibility(
  hidden: boolean,
  watch: ReturnType<typeof createTabReturnWatch>,
  refreshOverview: () => Promise<void>,
  refreshOpenSession: () => unknown
): Promise<void> {
  if (hidden) {
    watch.hidden();
    return;
  }
  await refreshOverview();
  if (watch.changedSince()) await refreshOpenSession();
}

/** Called when the session switches between busy and idle. */
export function onSessionActivityChange(sessionId: string, changed: () => void): () => void {
  const set = listeners.get(sessionId) ?? new Set<() => void>();
  listeners.set(sessionId, set);
  set.add(changed);
  return () => {
    set.delete(changed);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

export function sessionPollMs(sessionId: string, busyMs: number, idleMs: number): number {
  return sessionBusy(sessionId) ? busyMs : idleMs;
}

/** Poll settings for a timer that watches one session. Spread into `startPollTimer`. */
export function sessionPollPace(sessionId: string, busyMs: number, idleMs: number) {
  return {
    delayMs: () => sessionPollMs(sessionId, busyMs, idleMs),
    wake: (readNow: () => void) => onSessionActivityChange(sessionId, readNow)
  };
}

export function forgetSessionActivity(): void {
  statuses.clear();
  stamps.clear();
  listeners.clear();
}
