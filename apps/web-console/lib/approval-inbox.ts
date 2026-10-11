/** View-model for the existing approvals inbox. No new screen. */

export type ApprovalInboxNote = 'expired' | 'unattended-pending';

export function approvalInboxNote(approval: {
  status?: string;
  expireReason?: string;
  expiresAt?: string;
}): ApprovalInboxNote | null {
  if (typeof approval.expireReason === 'string' && approval.expireReason.trim()) return 'expired';
  const pending = approval.status === undefined || approval.status === 'pending';
  if (pending && typeof approval.expiresAt === 'string' && approval.expiresAt.trim()) {
    return 'unattended-pending';
  }
  return null;
}

export function approvalInboxNoteKey(
  note: ApprovalInboxNote
): 'tasks.inbox.expiredDeny' | 'tasks.inbox.unattendedPending' {
  switch (note) {
    case 'expired':
      return 'tasks.inbox.expiredDeny';
    case 'unattended-pending':
      return 'tasks.inbox.unattendedPending';
    default: {
      const _never: never = note;
      return _never;
    }
  }
}

export function approvalInboxStatusText(
  approval: {
    status?: string;
    expireReason?: string;
    expiresAt?: string;
  },
  t: (key: 'tasks.inbox.expiredDeny' | 'tasks.inbox.unattendedPending') => string
): string | null {
  const note = approvalInboxNote(approval);
  if (!note) return null;
  return t(approvalInboxNoteKey(note));
}
