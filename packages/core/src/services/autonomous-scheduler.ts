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
  log?: { warn(message: string, fields?: Record<string, unknown>): void };
}

function sessionRunError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A run that dies before the kernel settles must not stay idle or running forever. */
function markOpenSessionFailed(store: SqliteStateStore, sessionId: string): void {
  const session = store.getSession(sessionId);
  if (!session) return;
  if (session.status !== 'idle' && session.status !== 'running') return;
  store.updateSession(sessionId, { status: 'failed' });
}

function warnAutonomousRunFailed(ctx: AutonomousSchedulerCtx, sessionId: string, error: unknown): void {
  const log = ctx.log;
  if (!log) return;
  log.warn('autonomous session run failed', { sessionId, error: sessionRunError(error) });
}

function noteAutonomousRunFailed(ctx: AutonomousSchedulerCtx, sessionId: string, error: unknown): void {
  markOpenSessionFailed(ctx.store, sessionId);
  warnAutonomousRunFailed(ctx, sessionId, error);
}

const AUTONOMOUS_MODES: Set<SessionRecord['mode']> = new Set(['task', 'teammate']);

function isIdleBackground(session: SessionRecord | undefined): session is SessionRecord {
  if (!session) return false;
  if (!session.background) return false;
  return session.status === 'idle';
}

function canAutonomousRun(session: SessionRecord, blocked?: (session: SessionRecord) => boolean): boolean {
  if (!AUTONOMOUS_MODES.has(session.mode)) return false;
  if (blocked && blocked(session)) return false;
  return true;
}

function hasUnownedPendingTask(store: SqliteStateStore): boolean {
  return store.listTasks({ status: 'pending' }).some((task) => !task.ownerAgentId && task.blockedBy.length === 0);
}

function sessionHasWork(store: SqliteStateStore, session: SessionRecord, pending: boolean): boolean {
  if (store.listMailbox(session.agentId, true).length > 0) return true;
  if (session.mode === 'task') return true;
  return pending;
}

export class AutonomousScheduler {
  private readonly running = new Set<string>();
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly ctx: AutonomousSchedulerCtx) {}

  /** Resolves when sessions started by recent ticks have settled. */
  whenIdle(): Promise<void> {
    return Promise.all([...this.inflight]).then(() => undefined);
  }

  private startSession(sessionId: string): void {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);
    const job = Promise.resolve()
      .then(() => this.ctx.runSession(sessionId))
      .catch((error: unknown) => {
        noteAutonomousRunFailed(this.ctx, sessionId, error);
      })
      .finally(() => {
        this.running.delete(sessionId);
        this.inflight.delete(job);
      });
    this.inflight.add(job);
  }

  private drainWakes(): void {
    const { store, isSelfHealControlled } = this.ctx;
    for (const sessionId of store.dequeueSchedulerWakes(64)) {
      const session = store.getSession(sessionId);
      if (!isIdleBackground(session) || !canAutonomousRun(session, isSelfHealControlled)) continue;
      this.startSession(sessionId);
    }
  }

  private sweepIdle(): void {
    const { store, isSelfHealControlled } = this.ctx;
    const pending = hasUnownedPendingTask(store);
    for (const session of store.listIdleBackgroundSessions([...AUTONOMOUS_MODES])) {
      if (!canAutonomousRun(session, isSelfHealControlled)) continue;
      if (!sessionHasWork(store, session, pending)) continue;
      stampSessionWake(store, session.id, { kind: 'unattended', source: 'scheduler' });
      this.startSession(session.id);
    }
  }

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
    this.drainWakes();
    this.sweepIdle();
  }
}
