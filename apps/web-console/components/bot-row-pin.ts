import type { BotPinState } from '../lib/bot-pin.ts';
import {
  nextStateAfterPinDrop,
  nextStateAfterRoomPinDrop,
  nextStateAfterRoomUnpin,
  nextStateAfterUnpin,
  type PinRoom,
  type PinRosterBot
} from '../lib/bot-pin-area.ts';

export function nextBotPin(
  state: BotPinState,
  bots: readonly PinRosterBot[],
  botId: string,
  pinned: boolean
): BotPinState | null {
  if (pinned) return nextStateAfterUnpin(state, bots, botId);
  return nextStateAfterPinDrop(state, bots, botId);
}

export function nextRoomPin(
  state: BotPinState,
  bots: readonly PinRosterBot[],
  rooms: readonly PinRoom[],
  roomId: string,
  pinned: boolean
): BotPinState | null {
  if (pinned) return nextStateAfterRoomUnpin(state, bots, rooms, roomId);
  return nextStateAfterRoomPinDrop(state, bots, rooms, roomId);
}
