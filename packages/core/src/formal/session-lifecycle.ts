/**
 * Session status protocol draft. Encodes observed L5 statuses, not a TLC proof.
 */

import type { SessionStatus } from '../types.js';

export type SessionLifecycleEvent =
  | 'start'
  | 'end_chat'
  | 'end_task'
  | 'need_approval'
  | 'resume'
  | 'fail'
  | 'abort';

const TRANSITIONS: Record<SessionStatus, Partial<Record<SessionLifecycleEvent, SessionStatus>>> = {
  idle: { start: 'running' },
  running: {
    end_chat: 'idle',
    end_task: 'completed',
    need_approval: 'waiting_approval',
    fail: 'failed',
    abort: 'idle'
  },
  waiting_approval: {
    resume: 'running',
    abort: 'idle',
    fail: 'failed'
  },
  completed: {},
  failed: {},
  /** Written on process restart for a child that was still running. Terminal. */
  unknown: {}
};

export const SESSION_STATUSES: readonly SessionStatus[] = [
  'idle',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'unknown'
];

export const SESSION_EVENTS: readonly SessionLifecycleEvent[] = [
  'start',
  'end_chat',
  'end_task',
  'need_approval',
  'resume',
  'fail',
  'abort'
];

export function transitionSession(
  from: SessionStatus,
  event: SessionLifecycleEvent
): SessionStatus {
  const to = TRANSITIONS[from]?.[event];
  if (!to) {
    throw new Error(`[SessionLifecycle] illegal: ${from} --${event}-->`);
  }
  return to;
}

export function isLegalSessionTransition(from: SessionStatus, event: SessionLifecycleEvent): boolean {
  return Boolean(TRANSITIONS[from]?.[event]);
}

export function listSessionTransitions(): Array<{
  from: SessionStatus;
  event: SessionLifecycleEvent;
  to: SessionStatus;
}> {
  const out: Array<{ from: SessionStatus; event: SessionLifecycleEvent; to: SessionStatus }> = [];
  for (const from of SESSION_STATUSES) {
    const row = TRANSITIONS[from];
    for (const event of SESSION_EVENTS) {
      const to = row?.[event];
      if (to) out.push({ from, event, to });
    }
  }
  return out;
}
