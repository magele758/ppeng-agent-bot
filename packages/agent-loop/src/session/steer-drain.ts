/**
 * Tool-launch steer drain (A3 / OpenClaw). Lab default is off (`next_shot_only`):
 * steer only lands on the next model shot via prepareTurnInput claim.
 *
 * When `tool_launch` is set (options / session.metadata / daemon_control KV
 * `loop_settings`): after approvals, before executeToolCalls, claim next-step.
 * Materialize waiting inputs without skipping any tools. Cancellation is a
 * separate per-tool host decision. Does not mutate in-flight model HTTP.
 *
 * No RAW_AGENT_* env vars.
 */

import type { MessageReplyTo } from '../types.js';
import type { InboxItem, InboxTarget } from './step-inbox.js';
import type { SteerInterruptPolicy } from './steer-interrupt.js';
import { applyClaimedInbox } from './apply-claimed-inbox.js';
import type { SessionMessage } from '../types.js';

export type SteerDrainPolicy = 'next_shot_only' | 'tool_launch';

/** Same KV key as daemon Lab loop settings (Phase 4 sibling). */
export const AGENT_LOOP_SETTINGS_KEY = 'loop_settings';
export const DEFAULT_STEER_DRAIN_POLICY: SteerDrainPolicy = 'next_shot_only';

export interface AgentLoopSettings {
  steerDrainPolicy: SteerDrainPolicy;
  /** null/omit = unlimited (default, never drop). Positive = max unclaimed. */
  inboxOverflowCap?: number | null;
  /** Running-turn interrupt: queue | steer | disabled. */
  steerInterruptPolicy?: SteerInterruptPolicy;
}

export interface SteerDrainSettingsStore {
  getDaemonControl?(key: string): unknown;
}

export interface SteerDrainClaimStore {
  foldMessages(sessionId: string): SessionMessage[];
  appendMessage(
    sessionId: string,
    role: SessionMessage['role'],
    parts: SessionMessage['parts'],
    opts?: { key?: string; expectedWriterRunId?: string; replyTo?: MessageReplyTo }
  ): SessionMessage;
  hideByKey(sessionId: string, key: string): number;
  claimInbox(sessionId: string, target: InboxTarget): InboxItem[];
}

export interface DrainSteerAtToolLaunchResult {
  drained: boolean;
  items: InboxItem[];
  skippedIds: string[];
}

export function parseSteerDrainPolicy(raw: unknown): SteerDrainPolicy | undefined {
  if (raw === 'next_shot_only' || raw === 'tool_launch') return raw;
  return undefined;
}

export function resolveSteerDrainPolicy(input: {
  option?: SteerDrainPolicy;
  sessionMetadata?: Record<string, unknown>;
  store?: SteerDrainSettingsStore;
}): SteerDrainPolicy {
  const fromOption = parseSteerDrainPolicy(input.option);
  if (fromOption) return fromOption;
  const fromSession = parseSteerDrainPolicy(input.sessionMetadata?.steerDrainPolicy);
  if (fromSession) return fromSession;
  const saved = input.store?.getDaemonControl?.(AGENT_LOOP_SETTINGS_KEY);
  if (saved && typeof saved === 'object') {
    const rec = saved as Record<string, unknown>;
    // Lab 实验特性 master switch. Missing means on so existing KV keeps its tier.
    if (rec.engineEnabled !== false) {
      const fromKv = parseSteerDrainPolicy(rec.steerDrainPolicy);
      if (fromKv) return fromKv;
    }
  }
  return DEFAULT_STEER_DRAIN_POLICY;
}

/**
 * Where a steer lands. `tool_launch` must use next-step so the tool-launch
 * gate can claim it; queue+running otherwise waits for the next runSession.
 */
export function resolveSteerInboxTarget(input: {
  explicitTarget?: InboxTarget;
  interruptPolicy: SteerInterruptPolicy;
  drainPolicy?: SteerDrainPolicy;
  sessionStatus?: string;
  /** Canonical bot chat: land on the next shot, even if the caller asked for next-run. */
  immediate?: boolean;
}): InboxTarget {
  if (input.immediate) return 'next-step';
  if (input.explicitTarget) return input.explicitTarget;
  if (input.drainPolicy === 'tool_launch') return 'next-step';
  if (input.interruptPolicy === 'queue' && input.sessionStatus === 'running') return 'next-run';
  return 'next-step';
}

/**
 * Tool-launch checkpoint: claim next-step after approvals / before execute.
 * Parallel batch = one gate. Returns drained=false when policy is default
 * or the inbox is empty (tools proceed as usual).
 */
export function drainSteerAtToolLaunch(input: {
  store: SteerDrainClaimStore;
  sessionId: string;
  toolCallIds: string[];
  policy: SteerDrainPolicy;
  expectedWriterRunId?: string;
}): DrainSteerAtToolLaunchResult {
  if (input.policy !== 'tool_launch') {
    return { drained: false, items: [], skippedIds: [] };
  }
  const items = input.store.claimInbox(input.sessionId, 'next-step');
  if (items.length === 0) {
    return { drained: false, items: [], skippedIds: [] };
  }
  applyClaimedInbox(input.store, input.sessionId, items, { expectedWriterRunId: input.expectedWriterRunId });
  return { drained: true, items, skippedIds: [] };
}

export {
  parseInboxOverflowCap,
  resolveInboxOverflowCap,
  SUGGESTED_INBOX_OVERFLOW_CAP,
  DEFAULT_INBOX_OVERFLOW_CAP,
  INBOX_OVERFLOW_KEY
} from './inbox-overflow.js';
