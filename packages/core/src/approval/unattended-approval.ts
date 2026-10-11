/**
 * Fail-safe for approvals raised while nobody is sitting in Lab chat.
 *
 * Cron, a bot routine, and other unattended wakes expire as deny after
 * {@link UNATTENDED_APPROVAL_TTL_MS}. A human-present chat approval has no
 * deadline and keeps waiting. The timeout is a named constant — not an env var.
 */
import { unmatchedToolCallsFromFold, mergeInterruptMetadata } from '@ppeng/agent-loop/session';
import type { ApprovalRecord, MessagePart, SessionMessage, SessionRecord } from '../types.js';

/** 10 minutes. Not configurable via the environment. */
export const UNATTENDED_APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Stored on the approval when an unattended wake expires without an answer. */
export const UNATTENDED_APPROVAL_EXPIRE_REASON =
  'Denied: nobody answered within 10 minutes of an unattended wake, so the tool was not run.';

/** Session metadata key. Human chat overwrites it; the next unattended wake overwrites it back. */
export const APPROVAL_WAKE_KEY = 'approvalWake';

export interface ApprovalWake {
  kind: 'human' | 'unattended';
  source: string;
}

export interface UnattendedApprovalExpiryStore {
  listApprovals(filter?: { status?: ApprovalRecord['status'] }): ApprovalRecord[];
  getApproval(id: string): ApprovalRecord | undefined;
  markApprovalExpired(id: string, expireReason: string): ApprovalRecord | undefined;
  getSession(id: string): SessionRecord | undefined;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, 'status' | 'metadata'>>
  ): SessionRecord;
  foldMessages(id: string): SessionMessage[];
  appendMessage(id: string, role: 'tool', parts: MessagePart[]): unknown;
}

const armed = new Map<string, ReturnType<typeof setTimeout>>();

export function wakeFromSchedulerReason(reason: string): ApprovalWake {
  const raw = reason.trim();
  if (raw.startsWith('routine:')) return { kind: 'unattended', source: 'routine' };
  if (raw.startsWith('cron:')) return { kind: 'unattended', source: 'cron' };
  if (raw.startsWith('message_agent:')) return { kind: 'unattended', source: 'message-agent' };
  const source = raw.split(':')[0]?.trim() || 'scheduler';
  return { kind: 'unattended', source };
}

export function readApprovalWake(metadata: Record<string, unknown> | undefined): ApprovalWake | undefined {
  const raw = metadata?.[APPROVAL_WAKE_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const kind = (raw as { kind?: unknown }).kind;
  const source = (raw as { source?: unknown }).source;
  if ((kind !== 'human' && kind !== 'unattended') || typeof source !== 'string' || !source.trim()) {
    return undefined;
  }
  return { kind, source: source.trim() };
}

export function withApprovalWake(
  metadata: Record<string, unknown> | undefined,
  wake: ApprovalWake
): Record<string, unknown> {
  return { ...(metadata ?? {}), [APPROVAL_WAKE_KEY]: wake };
}

export function unattendedApprovalDeadline(
  wake: ApprovalWake | undefined,
  now = Date.now()
): { expiresAt?: string; wakeSource?: string } {
  if (wake?.kind !== 'unattended') return {};
  return {
    expiresAt: new Date(now + UNATTENDED_APPROVAL_TTL_MS).toISOString(),
    wakeSource: wake.source
  };
}

export function stampSessionWake(
  store: {
    getSession?(id: string): SessionRecord | undefined;
    updateSession?(id: string, patch: { metadata: Record<string, unknown> }): SessionRecord;
  },
  sessionId: string,
  wake: ApprovalWake
): void {
  if (typeof store.getSession !== 'function' || typeof store.updateSession !== 'function') return;
  const session = store.getSession(sessionId);
  if (!session) return;
  store.updateSession(sessionId, { metadata: withApprovalWake(session.metadata, wake) });
}

function denialParts(store: UnattendedApprovalExpiryStore, sessionId: string): MessagePart[] {
  const open = unmatchedToolCallsFromFold(store.foldMessages(sessionId));
  return open.map((call) => ({
    type: 'tool_result',
    toolCallId: call.toolCallId,
    name: call.name,
    ok: false,
    content: UNATTENDED_APPROVAL_EXPIRE_REASON
  }));
}

function closeDeniedSession(store: UnattendedApprovalExpiryStore, sessionId: string): void {
  const pending = store
    .listApprovals({ status: 'pending' })
    .filter((item) => item.sessionId === sessionId);
  if (pending.length > 0) return;
  const session = store.getSession(sessionId);
  if (!session) return;
  const parts = denialParts(store, sessionId);
  if (parts.length > 0) {
    store.appendMessage(sessionId, 'tool', parts);
  }
  const fresh = store.getSession(sessionId) ?? session;
  store.updateSession(sessionId, {
    status: fresh.status === 'waiting_approval' ? 'idle' : fresh.status,
    metadata: mergeInterruptMetadata(fresh.metadata ?? {}, null)
  });
}

/**
 * Deny every pending unattended approval whose deadline has passed.
 * Writes a failed tool result and clears the waiting-approval interrupt so a
 * later run cannot execute the tool. Human-present approvals (no `expiresAt`)
 * are left pending.
 */
export function expireDueUnattendedApprovals(
  store: UnattendedApprovalExpiryStore,
  now = Date.now()
): ApprovalRecord[] {
  const due = store.listApprovals({ status: 'pending' }).filter((approval) => {
    if (!approval.expiresAt) return false;
    const deadline = Date.parse(approval.expiresAt);
    return Number.isFinite(deadline) && deadline <= now;
  });
  const expired: ApprovalRecord[] = [];
  for (const approval of due) {
    disarmUnattendedApprovalExpiry(approval.id);
    const next = store.markApprovalExpired(approval.id, UNATTENDED_APPROVAL_EXPIRE_REASON);
    if (next?.status === 'rejected' && next.expireReason === UNATTENDED_APPROVAL_EXPIRE_REASON) {
      expired.push(next);
    }
  }
  const sessions = new Set(expired.map((approval) => approval.sessionId));
  for (const sessionId of sessions) {
    closeDeniedSession(store, sessionId);
  }
  return expired;
}

/** Arm the in-process timer. A scheduler sweep covers process restarts. */
export function armUnattendedApprovalExpiry(
  approval: Pick<ApprovalRecord, 'id' | 'status' | 'expiresAt'>,
  onFire: (id: string) => void,
  now = Date.now()
): void {
  disarmUnattendedApprovalExpiry(approval.id);
  if (approval.status !== 'pending' || !approval.expiresAt) return;
  const deadline = Date.parse(approval.expiresAt);
  if (!Number.isFinite(deadline)) return;
  const delay = Math.max(0, deadline - now);
  const handle = setTimeout(() => {
    armed.delete(approval.id);
    onFire(approval.id);
  }, delay);
  if (typeof handle.unref === 'function') handle.unref();
  armed.set(approval.id, handle);
}

export function disarmUnattendedApprovalExpiry(id: string): void {
  const existing = armed.get(id);
  if (existing) clearTimeout(existing);
  armed.delete(id);
}

export function disarmAllUnattendedApprovalExpiries(): void {
  for (const id of [...armed.keys()]) disarmUnattendedApprovalExpiry(id);
}
