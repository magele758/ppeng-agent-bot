/**
 * A Room member turn that needs a person (approval, login, verification) does not
 * wait in the Room. The pending approval moves to that bot's private chat; the Room
 * only keeps a short notice. Completing it in private never resumes the Room.
 */

export const ROOM_HUMAN_STEP_REASON = 'handed_to_private_chat';

/** What the Room shows. No tool name, arguments, credentials, or approval card. */
export const ROOM_HUMAN_STEP_NOTICE = '这一步需要你本人处理，已转到和我的私聊，群里不再等待。';

/** What the private chat shows. The approval card itself carries the step; this line only says where it came from. */
export function privateHandbackText(roomTitle: string): string {
  const title = roomTitle.trim() || '群';
  return `群「${title}」里有一步需要你本人批准或完成。请在这里处理；处理结果留在这段私聊，不会写回群。`;
}

export interface HumanStepApproval {
  status: string;
}

/** True when this member session is parked on a person who still has to approve, log in, or verify. */
export function memberNeedsHuman(
  session: { status?: string },
  approvals: readonly HumanStepApproval[]
): boolean {
  return session.status === 'waiting_approval' && approvals.some((approval) => approval.status === 'pending');
}

/**
 * Drop the waiting latch so a later private decision cannot resume this Room session.
 * Keep roomDelivery: executeMember already advanced the read position, and a hand-off
 * must not make the member answer those Room messages again. A rolled-back hand-off
 * never reaches this write, so it cannot undo that position either.
 */
export function roomMetadataAfterHandOff(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next.interrupt;
  delete next.outcome;
  return next;
}
