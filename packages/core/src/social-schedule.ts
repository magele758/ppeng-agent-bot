/**
 * Agent-first social post scheduling: structured payload stored on {@link TaskRecord.metadata}
 * (no extra DB tables). Used by `schedule_social_post` and daemon / gateway dispatch.
 */
import { createId, nowIso } from './id.js';

/** Key on task.metadata holding {@link SocialPostScheduleV1}. */
export const SOCIAL_POST_SCHEDULE_METADATA_KEY = 'socialPostSchedule' as const;

/** Discriminator for filtering task lists / Ops UI. */
export const SOCIAL_POST_TASK_KIND = 'social_post_schedule' as const;

export type SocialPostApprovalState = 'draft' | 'pending_approval' | 'approved' | 'rejected';

/**
 * Aggregate dispatch state across all channels:
 * - `pending`     : never attempted
 * - `in_flight`   : reserved for a future async dispatcher (currently unused)
 * - `succeeded`   : every channel succeeded
 * - `partial`     : at least one succeeded and at least one failed
 * - `failed`      : every attempted channel failed
 * - `skipped`     : operator cancelled before all channels finished
 */
export type SocialPostDispatchState =
  | 'pending'
  | 'in_flight'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'skipped';

/** Per-channel dispatch outcome (since each channel can succeed/fail independently). */
export interface SocialPostChannelDispatch {
  state: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'skipped';
  lastAttemptAt?: string;
  externalRef?: string;
  lastError?: string;
}

/** Built-in logical providers (validated at schedule time). */
export const BUILTIN_SOCIAL_CHANNELS = new Set([
  'x',
  'linkedin',
  'bluesky',
  'threads',
  'mastodon',
  'facebook',
  'instagram'
]);

export interface SocialPostScheduleV1 {
  version: 1;
  body: string;
  /** Logical targets, e.g. `x`, `linkedin`, or `webhook:<gateway channel id>`. */
  channels: string[];
  /** ISO 8601 instant when the post should go out (UTC). */
  publishAt: string;
  approval: SocialPostApprovalState;
  /**
   * Who set `approval`. Only the operator action writes `human`.
   * Model metadata writes are forced to `model` and cannot dispatch.
   */
  approvalProvenance?: 'human' | 'model';
  /**
   * Aggregate + per-channel dispatch outcome.
   *
   * `state` summarises the channels map. The map is keyed by the same labels
   * used in `channels` and is populated lazily — older records (without a
   * `channels` map) are upgraded by {@link readSocialPostSchedule}.
   *
   * Idempotency: when `run_now` retries a partial/failed schedule, only channels
   * NOT in the `succeeded` state are re-attempted, so the post is never sent
   * twice to a channel that already accepted it.
   */
  dispatch: {
    state: SocialPostDispatchState;
    lastAttemptAt?: string;
    /** Concise summary of last per-channel results (truncated). */
    externalRef?: string;
    lastError?: string;
    /** Per-channel state. Missing entry == treat as `pending`. */
    channels?: Record<string, SocialPostChannelDispatch>;
  };
  firstComment?: string;
  /** Free-text hint for auto-reply / follow-up automation (future). */
  followUpHint?: string;
  /** Stable key so retries do not duplicate outbound posts once dispatch is wired. */
  idempotencyKey: string;
  createdAt: string;
}

/**
 * ISO-8601 calendar instant with explicit UTC (`Z`) or numeric offset (`±HH:MM`).
 * Rejects date-only strings, locale-shaped dates, and naive local datetimes (no zone).
 */
const ISO_INSTANT_WITH_EXPLICIT_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i;

/** Parse and normalize to UTC `...Z` with millisecond precision, or `undefined` if invalid. */
export function normalizePublishAtToUtc(iso: string): string | undefined {
  const s = iso.trim();
  if (!ISO_INSTANT_WITH_EXPLICIT_OFFSET.test(s)) return undefined;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toISOString();
}

export function isValidIsoInstant(iso: string): boolean {
  return normalizePublishAtToUtc(iso) !== undefined;
}

/** Normalize channel labels (trim, alias, dedupe). */
export function normalizeSocialChannels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return undefined;
    const t = item.trim().toLowerCase();
    if (!t) return undefined;
    const mapped = t === 'twitter' ? 'x' : t;
    if (!seen.has(mapped)) {
      seen.add(mapped);
      out.push(mapped);
    }
  }
  return out.length ? out : undefined;
}

export function validateNormalizedSocialChannels(
  channels: string[],
  gatewayChannelIds: ReadonlySet<string>
): { ok: true } | { ok: false; error: string } {
  for (const ch of channels) {
    if (ch.startsWith('webhook:')) {
      const id = ch.slice('webhook:'.length).trim();
      if (!id) {
        return { ok: false, error: 'invalid webhook channel (empty id after webhook:)' };
      }
      if (!gatewayChannelIds.has(id)) {
        return {
          ok: false,
          error: `webhook channel id is not configured in gateway.config.json channels: ${id}`
        };
      }
      continue;
    }
    if (!BUILTIN_SOCIAL_CHANNELS.has(ch)) {
      return {
        ok: false,
        error: `unsupported social channel: ${ch}. Use a built-in label (${[...BUILTIN_SOCIAL_CHANNELS].sort().join(', ')}) or webhook:<gateway_channel_id>.`
      };
    }
  }
  return { ok: true };
}

const MAX_BODY = 32_000;
const MAX_FIRST_COMMENT = 8_000;
const MAX_FOLLOW_HINT = 4_000;

export interface BuildSocialScheduleInput {
  body: string;
  channels: unknown;
  publishAt: string;
  approval?: SocialPostApprovalState;
  firstComment?: string;
  followUpHint?: string;
  idempotencyKey?: string;
  gatewayChannelIds?: ReadonlySet<string>;
}

export type SocialScheduleBuildResult =
  | { ok: true; schedule: SocialPostScheduleV1 }
  | { ok: false; error: string };

export function buildSocialPostSchedule(input: BuildSocialScheduleInput): SocialScheduleBuildResult {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) {
    return { ok: false, error: 'body is required' };
  }
  if (body.length > MAX_BODY) {
    return { ok: false, error: `body exceeds ${MAX_BODY} characters` };
  }

  const channels = normalizeSocialChannels(input.channels);
  if (!channels) {
    return { ok: false, error: 'channels must be a non-empty array of non-empty strings' };
  }

  const gatewayIds = input.gatewayChannelIds ?? new Set<string>();
  const chk = validateNormalizedSocialChannels(channels, gatewayIds);
  if (!chk.ok) {
    return { ok: false, error: chk.error };
  }

  const publishAtRaw = typeof input.publishAt === 'string' ? input.publishAt.trim() : '';
  const publishAt = publishAtRaw ? normalizePublishAtToUtc(publishAtRaw) : undefined;
  if (!publishAt) {
    return {
      ok: false,
      error:
        'publishAt must be an ISO 8601 instant with explicit UTC (Z) or offset (±HH:MM), e.g. 2026-04-18T12:00:00Z'
    };
  }

  let firstComment: string | undefined;
  if (input.firstComment !== undefined) {
    if (typeof input.firstComment !== 'string') {
      return { ok: false, error: 'firstComment must be a string when provided' };
    }
    const fc = input.firstComment.trim();
    if (fc.length > MAX_FIRST_COMMENT) {
      return { ok: false, error: `firstComment exceeds ${MAX_FIRST_COMMENT} characters` };
    }
    firstComment = fc || undefined;
  }

  let followUpHint: string | undefined;
  if (input.followUpHint !== undefined) {
    if (typeof input.followUpHint !== 'string') {
      return { ok: false, error: 'followUpHint must be a string when provided' };
    }
    const fh = input.followUpHint.trim();
    if (fh.length > MAX_FOLLOW_HINT) {
      return { ok: false, error: `followUpHint exceeds ${MAX_FOLLOW_HINT} characters` };
    }
    followUpHint = fh || undefined;
  }

  const allowedApproval: SocialPostApprovalState[] = ['draft', 'pending_approval', 'approved', 'rejected'];
  const approval =
    input.approval && allowedApproval.includes(input.approval) ? input.approval : 'pending_approval';

  let idempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim()
      : '';
  if (!idempotencyKey) {
    idempotencyKey = createId('soc');
  }

  const schedule: SocialPostScheduleV1 = {
    version: 1,
    body,
    channels,
    publishAt,
    approval,
    dispatch: { state: 'pending' },
    firstComment,
    followUpHint,
    idempotencyKey,
    createdAt: nowIso()
  };

  return { ok: true, schedule };
}

/**
 * Lazy upgrade hook for legacy schedule shapes:
 * before per-channel `dispatch.channels` was introduced the dispatch only
 * carried an aggregate state. Records still on disk are normalised here so
 * downstream code can rely on `dispatch.channels`.
 *
 * CRITICAL: for non-`succeeded` / non-`pending` legacy aggregates we **cannot**
 * determine which channels already published vs which failed. Marking them all
 * `pending` would cause `runSocialPostScheduleDelivery` to re-deliver to
 * channels that previously succeeded → duplicate public posts.
 *
 * Strategy:
 *   - `succeeded` → all channels marked `succeeded` (safe — already delivered).
 *   - `pending` / `in_flight` → all channels `pending` (safe — nothing delivered yet).
 *   - `failed` / `partial` / `skipped` → all channels marked `failed` with a
 *     sentinel `lastError` explaining they need manual review. `run_now` will
 *     still attempt delivery (failed channels are eligible for retry), but the
 *     operator sees the sentinel in the Ops UI and can cancel + recreate if
 *     they prefer a clean slate. This is conservative — we might re-deliver to
 *     a channel that previously succeeded AND failed on a later retry, but
 *     that's the best we can do without per-channel history.
 */
function ensureDispatchChannels(schedule: SocialPostScheduleV1): SocialPostScheduleV1 {
  if (schedule.dispatch.channels) return schedule;
  const map: Record<string, SocialPostChannelDispatch> = {};
  const aggregate = schedule.dispatch.state;
  for (const ch of schedule.channels) {
    if (aggregate === 'succeeded') {
      map[ch] = {
        state: 'succeeded',
        lastAttemptAt: schedule.dispatch.lastAttemptAt,
        externalRef: schedule.dispatch.externalRef
      };
    } else if (aggregate === 'pending' || aggregate === 'in_flight') {
      map[ch] = { state: 'pending' };
    } else {
      // failed / partial / skipped — we don't know per-channel outcome.
      // Mark as failed so run_now will attempt them, but the operator sees the
      // sentinel and can cancel + recreate if they want a clean slate.
      map[ch] = {
        state: 'failed',
        lastAttemptAt: schedule.dispatch.lastAttemptAt,
        lastError: schedule.dispatch.lastError ?? `legacy upgrade from aggregate state '${aggregate}' — per-channel history unavailable; cancel and recreate for a clean retry`
      };
    }
  }
  return {
    ...schedule,
    dispatch: { ...schedule.dispatch, channels: map }
  };
}

/**
 * Model `task_update` metadata must not install or keep `approval: "approved"`.
 * Operator `applyAction` writes the task store directly and does not pass through here.
 */
export function protectModelSocialScheduleMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(metadata, SOCIAL_POST_SCHEDULE_METADATA_KEY)) return metadata;
  const raw = metadata[SOCIAL_POST_SCHEDULE_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return metadata;
  return {
    ...metadata,
    [SOCIAL_POST_SCHEDULE_METADATA_KEY]: {
      ...(raw as Record<string, unknown>),
      approval: 'pending_approval',
      approvalProvenance: 'model'
    }
  };
}

export function readSocialPostSchedule(metadata: Record<string, unknown> | undefined): SocialPostScheduleV1 | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = metadata[SOCIAL_POST_SCHEDULE_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || typeof o.body !== 'string' || !Array.isArray(o.channels)) return undefined;
  return ensureDispatchChannels(raw as SocialPostScheduleV1);
}

export function taskTitleForSocialSchedule(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim()) ?? body;
  const snippet = line.trim().slice(0, 72);
  return `[Social] ${snippet}${line.trim().length > 72 ? '…' : ''}`;
}

export type SocialPostDeliverFn = (
  channel: string,
  body: string,
  firstComment?: string
) => Promise<{ ok: boolean; detail: string }>;

export async function runSocialPostScheduleDelivery(
  schedule: SocialPostScheduleV1,
  deliver: SocialPostDeliverFn
): Promise<{ schedule: SocialPostScheduleV1; ok: boolean; error?: string }> {
  const normalised = ensureDispatchChannels(schedule);
  const channelMap: Record<string, SocialPostChannelDispatch> = { ...(normalised.dispatch.channels ?? {}) };
  const attemptAt = nowIso();

  if (normalised.channels.length === 0) {
    return {
      ok: false,
      error: 'no channels',
      schedule: {
        ...normalised,
        dispatch: {
          state: 'failed',
          lastAttemptAt: attemptAt,
          lastError: 'no channels',
          channels: channelMap
        }
      }
    };
  }

  // Idempotent retry: skip channels already in `succeeded` state. This guards
  // against duplicate publishes when an operator clicks `run_now` again on a
  // partially-succeeded schedule.
  let lastFail = '';
  const lines: string[] = [];
  for (const ch of normalised.channels) {
    const prior = channelMap[ch];
    if (prior?.state === 'succeeded') {
      lines.push(`${ch}:skipped(already-succeeded)`);
      continue;
    }
    const r = await deliver(ch, normalised.body, normalised.firstComment);
    if (r.ok) {
      channelMap[ch] = {
        state: 'succeeded',
        lastAttemptAt: attemptAt,
        externalRef: r.detail
      };
      lines.push(`${ch}:ok`);
    } else {
      channelMap[ch] = {
        state: 'failed',
        lastAttemptAt: attemptAt,
        lastError: r.detail
      };
      lastFail = r.detail;
      lines.push(`${ch}:${r.detail}`);
    }
  }

  // Aggregate state from per-channel outcomes.
  const states = normalised.channels.map((c) => channelMap[c]?.state ?? 'pending');
  const allSucceeded = states.every((s) => s === 'succeeded');
  const anySucceeded = states.some((s) => s === 'succeeded');
  const anyFailed = states.some((s) => s === 'failed');
  const aggregate: SocialPostDispatchState = allSucceeded
    ? 'succeeded'
    : anySucceeded && anyFailed
      ? 'partial'
      : anyFailed
        ? 'failed'
        : 'pending';

  const updated: SocialPostScheduleV1 = {
    ...normalised,
    dispatch: {
      state: aggregate,
      lastAttemptAt: attemptAt,
      externalRef: lines.join(';').slice(0, 500),
      ...(aggregate === 'succeeded' || aggregate === 'partial' ? {} : { lastError: lastFail || 'dispatch failed' }),
      channels: channelMap
    }
  };

  if (aggregate === 'succeeded') {
    return { schedule: updated, ok: true };
  }
  return {
    schedule: updated,
    ok: false,
    error: aggregate === 'partial'
      ? `partial dispatch — failed: ${normalised.channels.filter((c) => channelMap[c]?.state === 'failed').join(',')}`
      : lastFail || 'dispatch failed'
  };
}
