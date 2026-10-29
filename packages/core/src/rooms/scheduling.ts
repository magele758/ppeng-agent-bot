import { selectUnnamedSpeakers, type RoomSpeakerCard, type RoomSpeakerScore } from './speaker-score.js';

/** Who speaks this round. Unnamed turns list members whose cards clear the score line. Named turns list only the named members. */
export interface RoomSchedule {
  botIds: string[];
  /** Set only when the message named someone. Empty means an @ matched nobody. */
  mentionedBotIds?: string[];
  /** Scores for an unnamed turn, including members below the line. */
  speakerScores?: RoomSpeakerScore[];
}

export interface RoomScheduleOptions {
  hostBotId?: string;
  /** Maximum speakers this round. Named and unnamed turns are both cut to this. */
  maxSpeakers?: number;
  /** User text scored against member cards when nobody was named. */
  message?: string;
  cards?: readonly RoomSpeakerCard[];
}

/** Kept for older callers. Unnamed members are no longer scheduled, so this hint is unused on the sparse path. */
export const RESTRAINT_HINT = ' You were not @-mentioned in this message; only reply if you have something necessary that the mentioned members did not cover, otherwise reply exactly [SILENT].';

/**
 * No mention list: members whose name, title, description, or group clears the score line, best first, within the cap.
 * The host is not added just to open or close the turn.
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
    const plan = selectUnnamedSpeakers(options.message ?? '', options.cards ?? [], cap);
    return { botIds: plan.botIds, speakerScores: plan.scores };
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
  if (!Number.isInteger(maxBotTurns) || maxBotTurns <= 0) return [...botIds];
  return botIds.slice(0, maxBotTurns);
}
