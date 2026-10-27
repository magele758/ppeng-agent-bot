import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import {
  BOT_PIN_STORAGE_KEY,
  displayPinnedIds,
  displayPinnedRoomIds,
  loadBotPinState,
  saveBotPinState,
  type BotPinState
} from './bot-pin.ts';
import {
  nextStateAfterPinDrop,
  nextStateAfterRoomPinDragEnd,
  nextStateAfterRoomPinDrop,
  visiblePinnedRooms
} from './bot-pin-area.ts';
import { looseRooms, moveRoomInGroups, roomsInGroup } from './functional-group-view.ts';

const superBot = { id: 'super', name: 'Super Bot', builtin: true };
const desk = { id: 'desk', name: 'DeskBot' };
const bots = [desk, superBot];
const fresh: BotPinState = { customized: false, ids: [], roomIds: [] };
const jarvis = { id: 'jarvis', title: 'Jarvis 开发群', botIds: ['desk', 'super'] };
const other = { id: 'other', title: '其他群', botIds: ['desk', 'super'] };
const rooms = [jarvis, other];

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    data
  };
}

test('群聊拖进置顶后和已置顶 Bot 一起留下，刷新仍在且不重复出现在顶部 [AC:group-chat-sidebar-placement#AC-1] [AC:group-chat-sidebar-placement#AC-4]', () => {
  const storage = memoryStorage();
  const pinned = nextStateAfterRoomPinDrop(fresh, bots, rooms, 'jarvis');
  assert.ok(pinned);
  assert.deepEqual(displayPinnedIds(bots, pinned), ['super']);
  assert.deepEqual(visiblePinnedRooms(rooms, pinned).map((room) => room.title), ['Jarvis 开发群']);
  assert.deepEqual(displayPinnedRoomIds(rooms, pinned).filter((id) => id === 'jarvis'), ['jarvis']);
  const again = nextStateAfterRoomPinDrop(pinned, bots, rooms, 'jarvis');
  assert.ok(again);
  assert.deepEqual(displayPinnedRoomIds(rooms, again).filter((id) => id === 'jarvis'), ['jarvis']);
  saveBotPinState(pinned, storage);
  const loaded = loadBotPinState(storage);
  assert.deepEqual(displayPinnedRoomIds(rooms, loaded), ['jarvis']);
  assert.deepEqual(displayPinnedIds(bots, loaded), ['super']);
  assert.equal(looseRooms(rooms, [], displayPinnedRoomIds(rooms, loaded)).some((room) => room.id === 'jarvis'), false);
  assert.equal(storage.data.get(BOT_PIN_STORAGE_KEY)?.includes('jarvis'), true);

  const pinSource = readFileSync(new URL('../components/BotPinArea.tsx', import.meta.url), 'utf8');
  assert.match(pinSource, /visiblePinnedRooms\(/);
  assert.match(pinSource, /ROOM_DRAG_MIME/);
  assert.match(zh.play.pin.empty, /群聊/);
  assert.match(zh.play.pin.hint, /群聊/);
  assert.match(en.play.pin.empty, /group chat/i);
  assert.match(en.play.pin.hint, /group chat/i);
  assert.notEqual(zh.play.pin.hint, en.play.pin.hint);
  assert.notEqual(zh.play.pin.empty, en.play.pin.empty);
  assert.equal(zh.play.pin.hint.includes(en.play.pin.hint), false);
  assert.equal(en.play.pin.hint.includes(zh.play.pin.hint), false);
});

test('群聊可拖入功能分组并在分组之间移动，顶部不再重复 [AC:group-chat-sidebar-placement#AC-2] [AC:group-chat-sidebar-placement#AC-5]', () => {
  const groups = [
    { id: 'dev', name: '开发', botIds: ['desk'], roomIds: [] as string[] },
    { id: 'life', name: '生活', botIds: [], roomIds: [] as string[] }
  ];
  const placed = moveRoomInGroups(groups, 'jarvis', 'dev');
  assert.deepEqual(roomsInGroup(rooms, placed[0]!, []).map((room) => room.title), ['Jarvis 开发群']);
  assert.deepEqual(looseRooms(rooms, placed, []).map((room) => room.id), ['other']);
  assert.deepEqual(placed[0]!.botIds, ['desk']);
  const moved = moveRoomInGroups(placed, 'jarvis', 'life');
  assert.deepEqual(roomsInGroup(rooms, moved[0]!, []).map((room) => room.id), []);
  assert.deepEqual(roomsInGroup(rooms, moved[1]!, []).map((room) => room.title), ['Jarvis 开发群']);
  assert.equal(looseRooms(rooms, moved, []).some((room) => room.id === 'jarvis'), false);
  assert.deepEqual(looseRooms(rooms, moved, []).map((room) => room.id), ['other']);
  const cleared = moveRoomInGroups(moved, 'jarvis', null);
  assert.deepEqual(looseRooms(rooms, cleared, []).map((room) => room.id), ['jarvis', 'other']);

  const source = readFileSync(new URL('../components/BotFunctionalGroups.tsx', import.meta.url), 'utf8');
  assert.match(source, /moveRoomInGroups\(/);
  assert.match(source, /\/api\/bot-rooms\/\$\{encodeURIComponent\(roomId\)\}\/functional-group/);
  assert.match(source, /ROOM_DRAG_MIME/);
  const list = readFileSync(new URL('../components/play-group/PlayBotGroupList.tsx', import.meta.url), 'utf8');
  assert.match(list, /looseRooms\(/);
  assert.equal(list.includes('draggable={false}'), false);
});

test('群聊拖出置顶区后取消置顶，刷新不会回来，并回到原来的分组或顶部 [AC:group-chat-sidebar-placement#AC-3] [AC:group-chat-sidebar-placement#AC-5]', () => {
  const storage = memoryStorage();
  const groups = [{ id: 'dev', name: '开发', botIds: [], roomIds: ['jarvis'] }];
  const pinned = nextStateAfterRoomPinDrop(fresh, bots, rooms, 'jarvis');
  assert.ok(pinned);
  assert.equal(nextStateAfterRoomPinDragEnd(pinned, bots, rooms, 'jarvis', true), null);
  assert.deepEqual(roomsInGroup(rooms, groups[0]!, displayPinnedRoomIds(rooms, pinned)).map((room) => room.id), []);
  assert.equal(looseRooms(rooms, groups, displayPinnedRoomIds(rooms, pinned)).some((room) => room.id === 'jarvis'), false);

  const left = nextStateAfterRoomPinDragEnd(pinned, bots, rooms, 'jarvis', false);
  assert.ok(left);
  saveBotPinState(left, storage);
  const loaded = loadBotPinState(storage);
  assert.deepEqual(displayPinnedRoomIds(rooms, loaded), []);
  assert.equal(displayPinnedIds(bots, loaded).includes('super'), true);
  assert.deepEqual(roomsInGroup(rooms, groups[0]!, displayPinnedRoomIds(rooms, loaded)).map((room) => room.id), ['jarvis']);
  assert.equal(looseRooms(rooms, groups, displayPinnedRoomIds(rooms, loaded)).some((room) => room.id === 'jarvis'), false);
  assert.deepEqual(looseRooms(rooms, [], displayPinnedRoomIds(rooms, loaded)).map((room) => room.id), ['jarvis', 'other']);

  const ungrouped = nextStateAfterRoomPinDrop(fresh, bots, rooms, 'other');
  assert.ok(ungrouped);
  const ungroupedLeft = nextStateAfterRoomPinDragEnd(ungrouped, bots, rooms, 'other', false);
  assert.ok(ungroupedLeft);
  assert.deepEqual(looseRooms(rooms, groups, displayPinnedRoomIds(rooms, ungroupedLeft)).map((room) => room.id), ['other']);

  const pinSource = readFileSync(new URL('../components/BotPinArea.tsx', import.meta.url), 'utf8');
  assert.match(pinSource, /nextStateAfterRoomPinDragEnd\(/);
  const kept = nextStateAfterPinDrop(pinned, bots, 'desk');
  assert.ok(kept);
  assert.deepEqual(displayPinnedIds(bots, kept), ['super', 'desk']);
  assert.deepEqual(displayPinnedRoomIds(rooms, kept), ['jarvis']);
});

test('没进分组也没置顶的群聊留在原来的位置，文案同时写 Bot 和群聊 [AC:group-chat-sidebar-placement#AC-5]', () => {
  assert.deepEqual(looseRooms(rooms, [], []).map((room) => room.title), ['Jarvis 开发群', '其他群']);
  const placed = moveRoomInGroups([{ id: 'dev', name: '开发', botIds: [], roomIds: [] }], 'jarvis', 'dev');
  assert.deepEqual(looseRooms(rooms, placed, []).map((room) => room.id), ['other']);
  assert.match(zh.play.functionalGroups.dropHint, /群聊/);
  assert.match(en.play.functionalGroups.dropHint, /group chat/i);
  assert.match(zh.play.functionalGroups.deleteConfirm, /Bot 将回到未分组/);
  assert.match(zh.play.functionalGroups.deleteConfirm, /群聊/);
  assert.notEqual(zh.play.functionalGroups.dropHint, en.play.functionalGroups.dropHint);
  const panel = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /<PlaySidebarToggle/);
});
