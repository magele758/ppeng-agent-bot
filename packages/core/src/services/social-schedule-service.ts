/**
 * Social-post schedule service — extracted from RawAgentRuntime.
 *
 * Owns the read/write surface around the SQLite-backed social post tasks
 * (list summaries, approve / reject / cancel, run_now). Keeps the original
 * behaviour while pulling ~80 lines of logic out of `runtime.ts`.
 *
 * Layering: depends on SqliteStateStore but NOT on RawAgentRuntime, so the
 * facade in `runtime.ts` constructs and delegates to this service.
 */
import { NotFoundError, ValidationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import type { TaskRecord } from '../types.js';
import type { ApiSocialPostScheduleItem } from '../api-types.js';
import {
  SOCIAL_POST_SCHEDULE_METADATA_KEY,
  SOCIAL_POST_TASK_KIND,
  readSocialPostSchedule,
  runSocialPostScheduleDelivery,
  type SocialPostDeliverFn,
  type SocialPostScheduleV1
} from '../social-schedule.js';

export type SocialScheduleAction = 'approve' | 'reject' | 'cancel';

export class SocialScheduleService {
  constructor(private readonly store: SqliteStateStore) {}

  /** Surface every task whose metadata.kind is `social_post_schedule` for the Ops panel. */
  list(): ApiSocialPostScheduleItem[] {
    const out: ApiSocialPostScheduleItem[] = [];
    for (const task of this.store.listTasks()) {
      const meta = task.metadata as Record<string, unknown> | undefined;
      if (!meta || meta.kind !== SOCIAL_POST_TASK_KIND) continue;
      const schedule = readSocialPostSchedule(meta);
      if (!schedule) continue;
      out.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        sessionId: task.sessionId,
        publishAt: schedule.publishAt,
        channels: schedule.channels,
        approval: schedule.approval,
        dispatchState: schedule.dispatch.state,
        idempotencyKey: schedule.idempotencyKey
      });
    }
    return out;
  }

  /**
   * Approve / reject changes only the approval flag. Cancel additionally marks
   * not-yet-succeeded per-channel entries as `skipped` (preserving any channels
   * that already published) and flips the task to `cancelled`.
   */
  applyAction(taskId: string, action: SocialScheduleAction): TaskRecord {
    const task = this.store.getTask(taskId);
    if (!task) throw new NotFoundError('Task', taskId);
    const schedule = readSocialPostSchedule(task.metadata as Record<string, unknown> | undefined);
    if (!schedule) throw new ValidationError('Task is not a social post schedule');

    if (action === 'cancel') {
      const nextSchedule: SocialPostScheduleV1 = (() => {
        if (schedule.dispatch.state === 'succeeded') return schedule;
        const channels = { ...(schedule.dispatch.channels ?? {}) };
        for (const ch of schedule.channels) {
          const cur = channels[ch];
          if (cur?.state !== 'succeeded') {
            channels[ch] = { state: 'skipped', lastAttemptAt: cur?.lastAttemptAt };
          }
        }
        return {
          ...schedule,
          dispatch: { ...schedule.dispatch, state: 'skipped', channels }
        };
      })();
      return this.store.updateTask(taskId, {
        status: 'cancelled',
        metadata: {
          ...(task.metadata as Record<string, unknown>),
          kind: SOCIAL_POST_TASK_KIND,
          [SOCIAL_POST_SCHEDULE_METADATA_KEY]: nextSchedule
        }
      });
    }

    const approval = action === 'approve' ? 'approved' : 'rejected';
    const nextSchedule: SocialPostScheduleV1 = { ...schedule, approval, approvalProvenance: 'human' };
    return this.store.updateTask(taskId, {
      metadata: {
        ...(task.metadata as Record<string, unknown>),
        kind: SOCIAL_POST_TASK_KIND,
        [SOCIAL_POST_SCHEDULE_METADATA_KEY]: nextSchedule
      }
    });
  }

  /**
   * Dispatch now (operator-driven retry). Already-succeeded channels are skipped
   * inside {@link runSocialPostScheduleDelivery}; aggregate state determines the
   * resulting task status:
   *   succeeded → `completed`
   *   partial   → `in_progress` (operator may retry to flush remaining failures)
   *   failed    → `failed`
   */
  async dispatchNow(taskId: string, deliver: SocialPostDeliverFn): Promise<TaskRecord> {
    const task = this.store.getTask(taskId);
    if (!task) throw new NotFoundError('Task', taskId);
    if (task.status === 'cancelled') throw new ValidationError('Task is cancelled');
    const schedule = readSocialPostSchedule(task.metadata as Record<string, unknown> | undefined);
    if (!schedule) throw new ValidationError('Task is not a social post schedule');
    if (schedule.approval !== 'approved' || schedule.approvalProvenance !== 'human') {
      throw new ValidationError('Schedule must be approved by a human before run_now');
    }
    if (schedule.dispatch.state === 'succeeded') return task;

    const { schedule: nextSchedule, ok } = await runSocialPostScheduleDelivery(schedule, deliver);
    const nextStatus =
      nextSchedule.dispatch.state === 'succeeded'
        ? 'completed'
        : nextSchedule.dispatch.state === 'partial'
          ? 'in_progress'
          : ok ? 'completed' : 'failed';
    return this.store.updateTask(taskId, {
      status: nextStatus,
      metadata: {
        ...(task.metadata as Record<string, unknown>),
        kind: SOCIAL_POST_TASK_KIND,
        [SOCIAL_POST_SCHEDULE_METADATA_KEY]: nextSchedule
      }
    });
  }
}
