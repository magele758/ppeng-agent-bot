/**
 * Daemon boot durations. Logs `bot_startup` only — phase, scope, duration.
 * Does not import the core helper (not a public export). Must not fail boot.
 */
import { createLogger } from '@ppeng/agent-core';

const log = createLogger('bot-startup');

export async function timeBootPhase<T>(phase: string, run: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    logBootPhase(phase, Date.now() - started);
  }
}

/** Duration from the start of boot until `server.listen` accepts. */
export function markListenReady(bootStartedAt: number): void {
  logBootPhase('listen_ready', Date.now() - bootStartedAt);
}

function logBootPhase(phase: string, durationMs: number): void {
  try {
    log.info('bot_startup', {
      phase,
      scope: 'boot',
      durationMs: Math.max(0, Math.round(durationMs))
    });
  } catch {
    /* tracing must not fail startup */
  }
}
