import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import {
  explicitGroupReplyMode,
  groupReplyRoomPath,
  loadGroupReplyMode,
  readGroupReplyMode,
  saveGroupReplyMode
} from './group-reply-mode.ts';

const helper = readFileSync(new URL('./group-reply-mode.ts', import.meta.url), 'utf8');
const rooms = readFileSync(new URL('../components/bot-work/BotRooms.tsx', import.meta.url), 'utf8');
const control = readFileSync(new URL('../components/play-group/GroupReplyModeControl.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../components/play-group/PlayBotGroupChat.tsx', import.meta.url), 'utf8');
const capacity = readFileSync(new URL('../components/RoomCapacitySettingsCard.tsx', import.meta.url), 'utf8');

test('群聊设置能在两种模式间切换并把 replyMode 交给现有保存 API [AC:group-reply-mode#AC-5]', async () => {
  assert.equal(groupReplyRoomPath('room_a'), '/api/bot-rooms/room_a');
  assert.equal(groupReplyRoomPath('room/a b'), '/api/bot-rooms/room%2Fa%20b');
  assert.doesNotMatch(helper, /\/api\/bot-rooms\/settings/);
  assert.equal(readGroupReplyMode(undefined), 'coordinator');
  assert.equal(readGroupReplyMode({ room: {} }), 'coordinator');
  assert.equal(readGroupReplyMode({ room: { replyMode: 'nope' } }), 'coordinator');
  assert.equal(readGroupReplyMode({ room: { replyMode: 'coordinator' } }), 'coordinator');
  assert.equal(readGroupReplyMode({ room: { replyMode: 'all-members' } }), 'all-members');
  assert.equal(explicitGroupReplyMode({ room: {} }), null);
  assert.equal(await loadGroupReplyMode(async (path) => {
    assert.equal(path, '/api/bot-rooms/room_a');
    return { room: { replyMode: 'all-members' } };
  }, 'room_a'), 'all-members');
  assert.equal(await loadGroupReplyMode(async (path) => {
    assert.equal(path, '/api/bot-rooms/room_b');
    return { room: {} };
  }, 'room_b'), 'coordinator');

  const calls: { path: string; init?: RequestInit }[] = [];
  const switched = await saveGroupReplyMode(async (path, init) => {
    calls.push({ path, init });
    return { room: { replyMode: 'all-members' } };
  }, 'room_a', 'coordinator', 'all-members');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/api/bot-rooms/room_a');
  assert.equal(calls[0]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { replyMode: 'all-members' });
  assert.equal(switched.saved, true);
  assert.equal(switched.mode, 'all-members');
  assert.equal(switched.error, '');

  const back = await saveGroupReplyMode(async (path, init) => {
    assert.equal(path, '/api/bot-rooms/room_b');
    assert.deepEqual(JSON.parse(String(init?.body)), { replyMode: 'coordinator' });
    return { room: { replyMode: 'coordinator' } };
  }, 'room_b', 'all-members', 'coordinator');
  assert.equal(back.mode, 'coordinator');
  assert.equal(back.saved, true);

  const failed = await saveGroupReplyMode(async () => {
    throw new Error('replyMode must be coordinator or all-members');
  }, 'room_a', 'coordinator', 'all-members');
  assert.equal(failed.saved, false);
  assert.equal(failed.mode, 'coordinator');
  assert.match(failed.error, /replyMode must be coordinator or all-members/);

  const unconfirmed = await saveGroupReplyMode(async () => ({ room: { id: 'room_a' } }), 'room_a', 'coordinator', 'all-members');
  assert.equal(unconfirmed.saved, false);
  assert.equal(unconfirmed.mode, 'coordinator');
  assert.equal(unconfirmed.error, 'not-confirmed');

  assert.equal(zh.play.groupSettings.coordinator, '协调者回复');
  assert.equal(en.play.groupSettings.coordinator, 'Coordinator speaks');
  assert.equal(zh.play.groupSettings.allMembers, '全员各自回复');
  assert.equal(en.play.groupSettings.allMembers, 'All members reply');
  assert.notEqual(zh.play.groupSettings.coordinatorHint, en.play.groupSettings.coordinatorHint);
  assert.notEqual(zh.play.groupSettings.allMembersHint, en.play.groupSettings.allMembersHint);
  assert.ok(zh.play.groupSettings.replyMode.length > 0);
  assert.ok(en.play.groupSettings.saveFailed.length > 0);

  assert.match(chat, /data-testid="room-settings"[\s\S]*<BotRooms/);
  assert.match(rooms, /selectedRoomId \? <GroupReplyModeControl roomId=\{selectedRoomId\} \/> : null/);
  assert.match(control, /saveGroupReplyMode\(api, roomId, previous, next\)/);
  assert.match(control, /setMode\(result\.mode\)/);
  assert.match(control, /loadGroupReplyMode\(api, roomId\)/);
  assert.match(control, /data-testid="group-reply-mode"/);
  assert.match(control, /play\.groupSettings\.saveFailed/);
  assert.match(control, /data-testid=\{`group-reply-mode-\$\{option\.mode\}`\}/);
  assert.equal(control.includes('协调者'), false);
  assert.equal(control.includes('Coordinator speaks'), false);
  assert.equal(control.includes('All members'), false);
  assert.equal(control.includes('localStorage'), false);
  assert.equal(control.includes('/api/bot-rooms/settings'), false);
  assert.match(capacity, /\/api\/bot-rooms\/settings/);
  assert.match(capacity, /method: 'PATCH'/);
});
