export type PageLeave = 'refresh' | 'unmount' | 'navigate' | 'stop';

/** Refresh, hot reload, and leaving the view are not a user stop. */
export function leaveCancelsRun(reason: PageLeave): boolean {
  return reason === 'stop';
}

/**
 * After a reload, attach to a turn the server is still running.
 * A send started on this page already has its own stream.
 * Another open page can still be idle locally while the shared session is running.
 */
export function shouldResumeRunningTurn(input: {
  status: string | undefined;
  locallySending: boolean;
  sharedStatus?: string | undefined;
}): boolean {
  if (leaveCancelsRun('refresh') || input.locallySending) return false;
  return input.status === 'running' || input.sharedStatus === 'running';
}

/**
 * While any open page is showing a live turn, every other open page of that
 * session keeps its transcript and chrome in step. A quiet page does not wait
 * for the turn to finish.
 */
export function shouldRefreshOpenSession(input: {
  openSessionId: string | null;
  selectedSessionId: string | null;
  selectedStatus: string | undefined;
}): boolean {
  if (!input.openSessionId || input.openSessionId !== input.selectedSessionId) return false;
  return input.selectedStatus === 'running';
}
