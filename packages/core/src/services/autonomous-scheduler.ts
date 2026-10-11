/**
 * Autonomous session scheduler — extracted from RawAgentRuntime.
 *
 * Responsibilities:
 *   - Fan-out wake events when tasks are created or mailbox messages arrive.
 *   - Walk the wake queue + idle background sessions and run those that have
 *     pending work (mailbox / task mode / unowned-pending tasks).
 *
 * The actual session execution stays on the runtime (`runSession`) — this
 * service only decides *which* sessions to wake.
 */
import { stampSessionWake } from '../approval/unattended-approval.js';
import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';

interface AutonomousSchedulerCtx {
  store: SqliteStateStore;
  /** Run a session by id; injected to break the cyclic dep with RawAgentRuntime. */
  runSession: (sessionId: string) => Promise<unknown>;
  /** Sessions controlled by self-heal must NOT be auto-run by this scheduler. */
  isSelfHealControlled?: (session: SessionRecord) => boolean;
}

const AUTONOMOUS_MODES: Set<SessionRecord['mode']> = new Set(['task', 'teammate']);

export class AutonomousScheduler {
  constructor(private readonly ctx: AutonomousSchedulerCtx) {}

  /** Push wake intents for every idle background session owned by `agentId`. */
  wakeAgent(agentId: string, reason: string): void {
    for (const session of this.ctx.store.listSessions()) {
      if (session.agentId === agentId && session.background && session.status === 'idle') {
        this.ctx.store.enqueueSchedulerWake(session.id, reason);
      }
    }
  }

  /** Push wake intents for all autonomous sessions (e.g. on task creation). */
  wakeAll(reason: string): void {
    for (const session of this.ctx.store.listSessions()) {
      if (session.background && session.status === 'idle' && AUTONOMOUS_MODES.has(session.mode)) {
        this.ctx.store.enqueueSchedulerWake(session.id, reason);
      }
    }
  }

  /**
   * Drain the wake queue + sweep idle sessions that have pending work.
   * Two phases:
   *   1. Explicit wakes (someone enqueued a reason).
   *   2. Belt-and-braces sweep: any background task/teammate session with mail
   *      or unowned-pending tasks gets a chance to run.
   */
  async tick(): Promise<void> {
    const { store, runSession, isSelfHealControlled } = this.ctx;

    const woken = store.dequeueSchedulerWakes(64);
    for (const sessionId of woken) {
      const s = store.getSession(sessionId);
      if (!s || !s.background || s.status !== 'idle' || !AUTONOMOUS_MODES.has(s.mode)) continue;
      if (isSelfHealControlled?.(s)) continue;
      await runSession(sessionId);
    }

    const sessions = store.listSessions().filter((session) => {
      if (!session.background || session.status !== 'idle') return false;
      if (!AUTONOMOUS_MODES.has(session.mode)) return false;
      if (isSelfHealControlled?.(session)) return false;
      return true;
    });

    for (const session of sessions) {
      const inbox = store.listMailbox(session.agentId, true);
      const shouldRun =
        inbox.length > 0 ||
        session.mode === 'task' ||
        store
          .listTasks({ status: 'pending' })
          .some((task) => !task.ownerAgentId && task.blockedBy.length === 0);
      if (shouldRun) {
        stampSessionWake(store, session.id, { kind: 'unattended', source: 'scheduler' });
        await runSession(session.id);
      }
    }
  }
}
