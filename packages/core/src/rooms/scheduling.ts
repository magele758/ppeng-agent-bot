/** Who was named, and the full speaking order that follows. */
export interface RoomSchedule {
  botIds: string[];
  /** Set only when the message named someone (or passed an explicit mentions list). */
  mentionedBotIds?: string[];
}

/** One sentence for a member who was scheduled but not named. Empty means speak normally. */
export const RESTRAINT_HINT = ' You were not @-mentioned in this message; only reply if you have something necessary that the mentioned members did not cover, otherwise reply exactly [SILENT].';

/**
 * Mentioned members speak first, in the order they were named.
 * Every other current member still gets a turn afterwards, in room order.
 * An empty mention list (an @ that matched nobody, or mentions: []) schedules everyone with restraint.
 * No mention list at all schedules everyone normally.
 */
export function scheduleRoomTurn(roomBotIds: readonly string[], mentioned: readonly string[] | undefined): RoomSchedule {
  if (mentioned === undefined) return { botIds: roomBotIds.slice() };
  const named: string[] = [];
  for (const id of mentioned) if (roomBotIds.includes(id) && !named.includes(id)) named.push(id);
  const rest = roomBotIds.filter(id => !named.includes(id));
  return { botIds: [...named, ...rest], mentionedBotIds: named };
}

/** True when this turn named members and the current speaker was not among them. */
export function isRestrainedMember(turn: { mentionedBotIds?: readonly string[] }, botId: string): boolean {
  return turn.mentionedBotIds !== undefined && !turn.mentionedBotIds.includes(botId);
}

/** Restraint sentence for an unnamed member; empty for named members and turns with no mentions. */
export function restraintHint(turn: { mentionedBotIds?: readonly string[] }, botId: string): string {
  return isRestrainedMember(turn, botId) ? RESTRAINT_HINT : '';
}

/**
 * Members that will actually run this round, in speaking order, capped by the round budget.
 * Mentioned members come first, so an unmentioned member only appears while budget remains.
 */
export function budgetedSpeakers(botIds: readonly string[], maxBotTurns: number): string[] {
  const limit = Number.isInteger(maxBotTurns) && maxBotTurns > 0 ? maxBotTurns : 0;
  return botIds.slice(0, limit);
}
