import type { MessageKey } from './i18n/messages/types';

/**
 * Which notice the group chat shows for its latest turn. A turn that the room's
 * own budget stopped is stored as failed too, so the reason decides the wording.
 */
export function roomTurnNoticeKey(turn: { status: string; terminationReason?: string } | undefined): MessageKey | null {
  if (turn?.status !== 'failed') return null;
  switch (turn.terminationReason) {
    case 'cost_budget':
      return 'play.group.stoppedByCostBudget';
    case 'tool_budget':
      return 'play.group.stoppedByToolBudget';
    default:
      return 'play.group.replyFailed';
  }
}
