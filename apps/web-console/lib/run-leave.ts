export type PageLeave = 'refresh' | 'unmount' | 'navigate' | 'stop';

/** Refresh, hot reload, and leaving the view are not a user stop. */
export function leaveCancelsRun(reason: PageLeave): boolean {
  return reason === 'stop';
}

/**
 * After a reload, attach to a turn the server is still running.
 * A send started on this page already has its own stream.
 */
export function shouldResumeRunningTurn(input: {
  status: string | undefined;
  locallySending: boolean;
}): boolean {
  if (leaveCancelsRun('refresh') || input.locallySending) return false;
  return input.status === 'running';
}
