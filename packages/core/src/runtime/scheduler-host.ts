/**
 * Scheduler / cron / mailbox-wake host extracted from RawAgentRuntime.
 */

import { stampSessionWake, wakeFromSchedulerReason, expireDueUnattendedApprovals } from '../approval/unattended-approval.js';
import { CronJobStore, markCronJobRan } from '../cron/cron-store.js';
import { evaluateRoutinePrecheck, readStoredPrecheck } from '../cron/routine-precheck.js';
import { considerEvolutionSchedule, type EvolutionScheduleReason } from '../evolution/surface.js';
import type { Logger } from '../logger.js';
import type { AutonomousScheduler } from '../services/autonomous-scheduler.js';
import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';
import { textPart } from './session-facade.js';

export interface SchedulerTickHost {
  store: SqliteStateStore;
  stateDir: string;
  log: Logger;
  cronStore: CronJobStore | undefined;
  setCronStore(store: CronJobStore): void;
  selfHeal: { processRuns(): Promise<void> };
  swarmExecutor: { tick(): Promise<unknown> };
  teamDagExecutor?: { tick(): Promise<unknown> };
  orchestrationEngine: { tick(): Promise<unknown> };
  autonomousScheduler: AutonomousScheduler;
  runSession(sessionId: string): Promise<SessionRecord>;
  /**
   * Optional injector. The product tick does not set this, so a timer never
   * spawns Evolution. While the surface switch is off, even an injector is ignored.
   */
  launchEvolution?(reason: EvolutionScheduleReason): void;
}

/**
 * After a user prompt is already on an idle session, wake it the same way cron does:
 * background sessions join the scheduler queue; foreground sessions start `runSession`.
 * A non-idle session is left alone (no parallel run).
 */
export function startIdleSessionRun(
  host: {
    store: Pick<SqliteStateStore, 'enqueueSchedulerWake'> & {
      getSession?: SqliteStateStore['getSession'];
      updateSession?: SqliteStateStore['updateSession'];
    };
    log: Logger;
    runSession(sessionId: string): Promise<unknown>;
  },
  session: SessionRecord,
  reason: string
): boolean {
  if (session.status !== 'idle') return false;
  stampSessionWake(host.store, session.id, wakeFromSchedulerReason(reason));
  if (session.background) {
    host.store.enqueueSchedulerWake(session.id, reason);
    return true;
  }
  const fail = (err: unknown) => {
    const label =
      reason.startsWith('cron:') || reason.startsWith('routine:')
        ? 'cron session run failed'
        : 'idle session run failed';
    host.log.warn(label, {
      sessionId: session.id,
      reason,
      error: err instanceof Error ? err.message : String(err)
    });
  };
  try {
    void Promise.resolve(host.runSession(session.id)).catch(fail);
  } catch (err) {
    fail(err);
  }
  return true;
}

/** Tick due cron jobs: append prompt to owning session and enqueue a run. */
export async function tickCronJobs(host: SchedulerTickHost): Promise<number> {
  let cronStore = host.cronStore;
  if (!cronStore) {
    cronStore = new CronJobStore(host.stateDir);
    host.setCronStore(cronStore);
  }
  const due = cronStore.dueJobs();
  let n = 0;
  for (const job of due) {
    const session = host.store.getSession(job.sessionId);
    if (!session) {
      cronStore.update(job.id, { enabled: false });
      continue;
    }
    const precheck = readStoredPrecheck(job.metadata);
    if (precheck) {
      let wakeAgent = true;
      try {
        const gate = await evaluateRoutinePrecheck(precheck, { cwd: host.stateDir });
        wakeAgent = gate.wakeAgent;
      } catch (err) {
        host.log.warn('cron precheck failed open', {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      if (!wakeAgent) {
        markCronJobRan(cronStore, job);
        host.log.info('cron precheck skipped model turn', { jobId: job.id, name: job.name });
        n += 1;
        continue;
      }
    }
    host.store.appendMessage(job.sessionId, 'user', [
      textPart(`[cron:${job.name}] ${job.prompt}`)
    ]);
    markCronJobRan(cronStore, job);
    const boundToBot = typeof job.metadata?.botId === 'string' && job.metadata.botId.trim().length > 0;
    startIdleSessionRun(host, session, `${boundToBot ? 'routine' : 'cron'}:${job.id}`);
    n += 1;
  }
  return n;
}

export async function runScheduler(host: SchedulerTickHost): Promise<void> {
  expireDueUnattendedApprovals(host.store);
  considerEvolutionSchedule({
    reason: 'timer',
    launch: host.launchEvolution
  });
  await host.selfHeal.processRuns();
  await host.swarmExecutor.tick();
  if (host.teamDagExecutor) {
    await host.teamDagExecutor.tick();
  }
  await host.orchestrationEngine.tick();
  await tickCronJobs(host);
  await host.autonomousScheduler.tick();
}

export async function ingestMailbox(store: SqliteStateStore, session: SessionRecord): Promise<void> {
  const pending = store.listMailbox(session.agentId, true);
  if (pending.length === 0) {
    return;
  }

  const delivered = pending.map((mail) => store.markMailRead(mail.id));
  const text = delivered
    .map((mail) => `[${mail.type}] from ${mail.fromAgentId}${mail.correlationId ? ` (${mail.correlationId})` : ''}: ${mail.content}`)
    .join('\n');

  store.appendMessage(session.id, 'user', [textPart(`Inbox:\n${text}`)]);
}

export async function autoClaimTask(store: SqliteStateStore, session: SessionRecord): Promise<void> {
  if (session.mode !== 'teammate') {
    return;
  }

  const available = store
    .listTasks({ status: 'pending' })
    .find((task) => !task.ownerAgentId && task.blockedBy.length === 0);

  if (!available) {
    return;
  }

  store.updateTask(available.id, {
    ownerAgentId: session.agentId,
    status: 'in_progress',
    sessionId: session.id
  });
  store.appendMessage(
    session.id,
    'user',
    [textPart(`You auto-claimed task ${available.id}: ${available.title}\n${available.description}`)]
  );
}

export async function unblockDependentTasks(
  store: SqliteStateStore,
  completedTaskId: string
): Promise<void> {
  const tasks = store.listTasks();
  for (const task of tasks) {
    if (!task.blockedBy.includes(completedTaskId)) {
      continue;
    }

    const nextBlockedBy = task.blockedBy.filter((candidate) => candidate !== completedTaskId);
    const nextStatus = task.status === 'pending' ? 'pending' : nextBlockedBy.length === 0 ? 'pending' : task.status;
    store.updateTask(task.id, {
      blockedBy: nextBlockedBy,
      status: nextStatus
    });
  }
}

/** Swarm teammate is done when completed, or idle after at least one assistant/tool WAL turn. */
export function sessionTeammateFinished(store: SqliteStateStore, sessionId: string): boolean {
  const session = store.getSession(sessionId);
  if (!session) return false;
  if (session.status === 'completed') return true;
  if (session.status !== 'idle') return false;
  return store.listMessages(sessionId).some((m) => m.role === 'assistant' || m.role === 'tool');
}
