'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { displayPinnedIds, displayPinnedRoomIds, type BotPinState } from '@/lib/bot-pin';
import {
  commitBotPinState,
  getBotPinServerSnapshot,
  getBotPinSnapshot,
  subscribeBotPins,
  type PinRoom,
  type PinRosterBot
} from '@/lib/bot-pin-area';
import type { FunctionalGroup } from '@/lib/functional-group-view';
import { ensureMenuGroups, getMenuGroups, getMenuGroupsServer, subscribeMenuGroups } from './bot-group-menu';
import { nextBotPin, nextRoomPin } from './bot-row-pin';

function commitPin(next: BotPinState | null) {
  if (next) commitBotPinState(next);
}

export function BotPinMenuItem({ botId, roster }: { botId: string; roster: readonly PinRosterBot[] }) {
  const { t } = useI18n();
  const state = useSyncExternalStore(subscribeBotPins, getBotPinSnapshot, getBotPinServerSnapshot);
  const pinned = displayPinnedIds(roster, state).includes(botId);
  const label = t(pinned ? 'play.rowMenu.unpin' : 'play.rowMenu.pin');
  return (
    <button type="button" data-testid="bot-row-pin" data-pinned={pinned ? 'true' : 'false'} onClick={() => commitPin(nextBotPin(state, roster, botId, pinned))}>
      {label}
    </button>
  );
}

export function RoomRowActions({
  roomId,
  bots,
  rooms
}: {
  roomId: string;
  bots: readonly PinRosterBot[];
  rooms: readonly PinRoom[];
}) {
  const { t } = useI18n();
  const state = useSyncExternalStore(subscribeBotPins, getBotPinSnapshot, getBotPinServerSnapshot);
  const groups = useSyncExternalStore(subscribeMenuGroups, getMenuGroups, getMenuGroupsServer);
  useEffect(() => { ensureMenuGroups(); }, []);
  const pinned = displayPinnedRoomIds(rooms, state).includes(roomId);
  const current = groups.find((group) => (group.roomIds ?? []).includes(roomId))?.id ?? null;
  return (
    <>
      <button type="button" data-testid="room-row-pin" data-pinned={pinned ? 'true' : 'false'} onClick={() => commitPin(nextRoomPin(state, bots, rooms, roomId, pinned))}>
        {t(pinned ? 'play.rowMenu.unpin' : 'play.rowMenu.pin')}
      </button>
      <RoomMoveButtons roomId={roomId} groups={groups} current={current} />
    </>
  );
}

function RoomMoveButtons({
  roomId,
  groups,
  current
}: {
  roomId: string;
  groups: readonly FunctionalGroup[];
  current: string | null;
}) {
  const { t } = useI18n();
  const targets = groups.filter((group) => group.id !== current);
  return (
    <>
      {targets.map((group) => (
        <button type="button" key={group.id} data-testid="room-move-group" onClick={() => moveRoomGroup(roomId, group.id)}>
          {t('play.rowMenu.moveTo', { name: group.name })}
        </button>
      ))}
      {current ? (
        <button type="button" data-testid="room-move-ungrouped" onClick={() => moveRoomGroup(roomId, null)}>
          {t('play.rowMenu.moveOut')}
        </button>
      ) : null}
    </>
  );
}

function moveRoomGroup(roomId: string, groupId: string | null) {
  void api(`/api/bot-rooms/${encodeURIComponent(roomId)}/functional-group`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId })
  }).then(() => {
    window.dispatchEvent(new Event('lab-bot-placement-saved'));
  });
}
