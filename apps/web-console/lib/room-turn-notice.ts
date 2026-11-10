import type { MessageKey } from './i18n/messages/types';

type NoticeTurn = { status: string; terminationReason?: string; botIds?: readonly string[]; postedBotIds?: readonly string[] };

/**
 * Which notice the group chat shows for its latest turn. A turn that the room's
 * own budget stopped is stored as failed too, so the reason decides the wording.
 */
export function roomTurnNoticeKey(turn: NoticeTurn | undefined): MessageKey | null {
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

const NAMED: Partial<Record<MessageKey, MessageKey>> = {
  'play.group.stoppedByCostBudget': 'play.group.stoppedByCostBudgetNamed',
  'play.group.stoppedByToolBudget': 'play.group.stoppedByToolBudgetNamed'
};

/** Members scheduled for this turn that have no reply in the room, by display name. An unknown id shows as the id. */
export function roomTurnUnreplied(turn: NoticeTurn, names: ReadonlyMap<string, string>): string[] {
  const posted = new Set(turn.postedBotIds ?? []);
  return [...new Set(turn.botIds ?? [])].filter((id) => !posted.has(id)).map((id) => names.get(id) ?? id);
}

/** The notice and its text parameters. A budget stop names who did not reply when anyone is missing. */
export function roomTurnNotice(turn: NoticeTurn | undefined, names: ReadonlyMap<string, string>, separator: string): { key: MessageKey; params?: { names: string } } | null {
  const key = roomTurnNoticeKey(turn);
  if (!key || !turn) return null;
  const named = NAMED[key];
  const missing = named ? roomTurnUnreplied(turn, names) : [];
  if (!named || missing.length === 0) return { key };
  return { key: named, params: { names: missing.join(separator) } };
}
