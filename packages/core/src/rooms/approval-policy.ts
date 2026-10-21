/**
 * Room approval policy. Pure: no store and no environment switch.
 * Default is private hand-off. Lab passes the saved value later; only the
 * exact string `in_room` selects in-room approval.
 *
 * The room scheduler calls these later (not wired in this change):
 * - resolveRoomApprovalMode(savedLabValue) before a member hits a human step
 * - viewRoomHumanStep(...) for the room notice or card; the room does not wait
 * - memberMayPostWhileWaiting(waitingBotId, speakerBotId) before another member posts
 * - resolveInlineApproval(...) when the user approves or rejects an in-room card
 * - roomPostsAfterInlineDecision(...) to keep other posts and append one line
 *
 * Private hand-off still moves the step with handRoomHumanStepToPrivateChat.
 * This module does not write the room transcript, resume a session, or start a turn.
 */

/** Same sentence the room already shows. The scheduler keeps that hand-off path. */
export const ROOM_PRIVATE_HANDOFF_NOTICE = '这一步需要你本人处理，已转到和我的私聊，群里不再等待。';

export const ROOM_INLINE_REJECTION = '已拒绝';

export type RoomApprovalMode = 'private_handoff' | 'in_room';

export interface RoomApprovalCard {
  botId: string;
  requesterName: string;
  actionSummary: string;
}

interface HumanStepBase {
  resultReturnsToRoom: false;
  replayStepInRoom: false;
  memberFailed: false;
  /** A single member's wait must not park the room turn. */
  roomWaits: false;
  otherMembersContinue: true;
  toolTextEntersRoomHistory: false;
}

export type RoomHumanStepView = HumanStepBase & (
  | {
    mode: 'private_handoff';
    showApprovalCard: false;
    roomNotice: string;
    card?: undefined;
    memberOutcome: 'handed_to_private_chat';
  }
  | {
    mode: 'in_room';
    showApprovalCard: true;
    roomNotice: string;
    card: RoomApprovalCard;
    memberOutcome: 'waiting_on_member';
  }
);

export interface InlineApprovalResult {
  executed: boolean;
  roomText: string;
  roomFailed: false;
  otherRepliesRemain: true;
  toolTextEntersRoomHistory: false;
  privateTranscriptEntersRoomHistory: false;
}

export interface RoomPost {
  botId: string;
  text: string;
}

/** Missing, unknown, or closed values stay on the private path. */
export function resolveRoomApprovalMode(value: unknown): RoomApprovalMode {
  return value === 'in_room' ? 'in_room' : 'private_handoff';
}

function scrub(text: string, hidden: readonly (string | undefined)[]): string {
  let next = text;
  for (const secret of hidden) {
    if (secret) next = next.split(secret).join('');
  }
  return next.trim();
}

export function viewRoomHumanStep(input: {
  mode: unknown;
  botId: string;
  requesterName: string;
  actionSummary: string;
  toolText?: string;
}): RoomHumanStepView {
  const requesterName = input.requesterName.trim() || input.botId;
  const actionSummary = scrub(input.actionSummary, [input.toolText]);
  const shared = {
    resultReturnsToRoom: false,
    replayStepInRoom: false,
    memberFailed: false,
    roomWaits: false,
    otherMembersContinue: true,
    toolTextEntersRoomHistory: false,
  } as const;
  if (resolveRoomApprovalMode(input.mode) === 'in_room') {
    return {
      ...shared,
      mode: 'in_room',
      showApprovalCard: true,
      roomNotice: scrub(`${requesterName}：${actionSummary}`, [input.toolText]),
      card: { botId: input.botId, requesterName, actionSummary },
      memberOutcome: 'waiting_on_member',
    };
  }
  return {
    ...shared,
    mode: 'private_handoff',
    showApprovalCard: false,
    roomNotice: ROOM_PRIVATE_HANDOFF_NOTICE,
    memberOutcome: 'handed_to_private_chat',
  };
}

/** Other speakers in the wave may post. The member who is waiting does not post the step. */
export function memberMayPostWhileWaiting(waitingBotId: string, speakerBotId: string): boolean {
  return speakerBotId !== waitingBotId;
}

export function resolveInlineApproval(input: {
  mode: unknown;
  decision: 'approve' | 'reject';
  finalText?: string;
  toolText?: string;
  privateTranscript?: string;
}): InlineApprovalResult {
  const hidden = [input.toolText, input.privateTranscript];
  const kept = {
    roomFailed: false,
    otherRepliesRemain: true,
    toolTextEntersRoomHistory: false,
    privateTranscriptEntersRoomHistory: false,
  } as const;
  if (resolveRoomApprovalMode(input.mode) !== 'in_room') {
    return { ...kept, executed: false, roomText: ROOM_PRIVATE_HANDOFF_NOTICE };
  }
  if (input.decision === 'reject') {
    return { ...kept, executed: false, roomText: ROOM_INLINE_REJECTION };
  }
  return { ...kept, executed: true, roomText: scrub(input.finalText ?? '', hidden) };
}

/** Keep posts that already landed, then append the one decision line. */
export function roomPostsAfterInlineDecision(
  posted: readonly RoomPost[],
  decision: InlineApprovalResult,
  actorBotId: string
): RoomPost[] {
  return [...posted.map(post => ({ ...post })), { botId: actorBotId, text: decision.roomText }];
}
