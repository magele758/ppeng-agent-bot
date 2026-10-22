/** Who speaks this round. Unnamed turns list only the host. Named turns list only the named members. */
export interface RoomSchedule {
  botIds: string[];
  /** Set only when the message named someone. Empty means an @ matched nobody. */
  mentionedBotIds?: string[];
}

export interface RoomScheduleOptions {
  hostBotId?: string;
  /** Maximum speakers this round. Named turns are cut to this. Unnamed turns are host-only. */
  maxSpeakers?: number;
}

/** Kept for older callers. Unnamed members are no longer scheduled, so this hint is unused on the sparse path. */
export const RESTRAINT_HINT = ' You were not @-mentioned in this message; only reply if you have something necessary that the mentioned members did not cover, otherwise reply exactly [SILENT].';

/**
 * No mention list: only the host (or the first member) speaks. The host may add others later.
 * An explicit mention list, including an empty one, schedules only named members, in mention order, within the cap.
 * People who were not named are not added.
 */
export function scheduleRoomTurn(
  roomBotIds: readonly string[],
  mentioned: readonly string[] | undefined,
  options: RoomScheduleOptions = {}
): RoomSchedule {
  const cap = Number.isInteger(options.maxSpeakers) && (options.maxSpeakers as number) > 0
    ? (options.maxSpeakers as number)
    : roomBotIds.length;
  if (mentioned === undefined) {
    const host = options.hostBotId && roomBotIds.includes(options.hostBotId) ? options.hostBotId : roomBotIds[0];
    return { botIds: host ? [host] : [] };
  }
  const named: string[] = [];
  for (const id of mentioned) if (roomBotIds.includes(id) && !named.includes(id)) named.push(id);
  return { botIds: named.slice(0, cap), mentionedBotIds: named };
}

/** True when this turn named members and the current speaker was not among them. */
export function isRestrainedMember(turn: { mentionedBotIds?: readonly string[] }, botId: string): boolean {
  return turn.mentionedBotIds !== undefined && !turn.mentionedBotIds.includes(botId);
}

/** Restraint sentence for an unnamed member; empty for named members and turns with no mentions. */
export function restraintHint(turn: { mentionedBotIds?: readonly string[] }, botId: string): string {
  return isRestrainedMember(turn, botId) ? RESTRAINT_HINT : '';
}

/** Members that will actually run this round, in speaking order, capped by the visible-reply budget. */
export function budgetedSpeakers(botIds: readonly string[], maxBotTurns: number): string[] {
  const limit = Number.isInteger(maxBotTurns) && maxBotTurns > 0 ? maxBotTurns : 0;
  return botIds.slice(0, limit);
}
