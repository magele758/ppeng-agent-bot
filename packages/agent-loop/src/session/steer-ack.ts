/**
 * Steer admission receipt (Codex Started | Steered | NotSubmitted).
 *
 * Hosts enqueue into the next-shot inbox; this module only decides whether
 * the item is admitted and which status to report. Default: steer never
 * mutates an in-flight model HTTP body.
 */

import type { SessionRecord, SessionStatus } from '../types.js';
import type { InboxItem } from './step-inbox.js';
import {
  DEFAULT_STEER_INTERRUPT_POLICY,
  parseSteerInterruptPolicy,
  type SteerInterruptPolicy
} from './steer-interrupt.js';

export type SteerAckStatus = 'started' | 'steered' | 'not_submitted';

export type NotSubmittedReason =
  | 'no_session'
  | 'session_ended'
  | 'empty'
  | 'compact_in_flight'
  | 'non_steerable_turn'
  | 'steer_disabled';

export type SteerAck =
  | { status: 'started'; item: InboxItem }
  | { status: 'steered'; item: InboxItem }
  | { status: 'not_submitted'; reason: NotSubmittedReason };

/** HTTP projection for daemon/Lab (queued | steered | rejected). */
export type HttpSteerAckStatus = 'queued' | 'steered' | 'rejected';

export interface HttpSteerAck {
  status: HttpSteerAckStatus;
  reason?: NotSubmittedReason;
  item?: InboxItem;
}

const ENDED: ReadonlySet<SessionStatus> = new Set(['completed', 'failed', 'unknown']);

export function isSessionEndedStatus(status: SessionStatus | undefined): boolean {
  return status !== undefined && ENDED.has(status);
}

export function isCompactInFlight(session: SessionRecord | undefined | null): boolean {
  if (!session) return false;
  return session.metadata?.compactInFlight === true;
}

export function decideSteerAdmission(input: {
  session?: SessionRecord | null;
  text: string;
  compactInFlight?: boolean;
  /** Running-turn policy. Default queue (follow-ups wait until this turn ends). */
  interruptPolicy?: SteerInterruptPolicy;
}): { admit: true; status: 'started' | 'steered' } | { admit: false; reason: NotSubmittedReason } {
  if (!input.text.trim()) {
    return { admit: false, reason: 'empty' };
  }
  if (!input.session) {
    return { admit: false, reason: 'no_session' };
  }
  if (input.compactInFlight === true || isCompactInFlight(input.session)) {
    return { admit: false, reason: 'compact_in_flight' };
  }
  if (isSessionEndedStatus(input.session.status)) {
    return { admit: false, reason: 'session_ended' };
  }
  if (input.session.status === 'running') {
    const policy = parseSteerInterruptPolicy(input.interruptPolicy) ?? DEFAULT_STEER_INTERRUPT_POLICY;
    if (policy === 'disabled') {
      return { admit: false, reason: 'steer_disabled' };
    }
    if (policy === 'queue') {
      return { admit: true, status: 'started' };
    }
    return { admit: true, status: 'steered' };
  }
  return { admit: true, status: 'started' };
}

export function steerAckToHttp(ack: SteerAck): HttpSteerAck {
  switch (ack.status) {
    case 'started':
      return { status: 'queued', item: ack.item };
    case 'steered':
      return { status: 'steered', item: ack.item };
    case 'not_submitted':
      return { status: 'rejected', reason: ack.reason };
    default: {
      const _never: never = ack;
      return _never;
    }
  }
}
