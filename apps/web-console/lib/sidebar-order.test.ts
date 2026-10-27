import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import {
  arrangeSidebarRows,
  moveSidebarItem,
  regionRefs,
  sortBotRows,
  type BotSidebarRow,
  type RoomSidebarRow
} from './sidebar-order.ts';
import {
  BOT_PIN_STORAGE_KEY,
  forgetRegionRef,
  loadBotPinState,
  pinBot,
  saveBotPinState,
  savedRegionRefs,
  unpinBot,
  withRegionOrder,
  type BotPinState,
  type SidebarRef
} from './bot-pin.ts';
import { nextStateAfterPinDrop } from './bot-pin-area.ts';
import { moveBotInGroups } from './functional-group-view.ts';

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

function bot(id: string, extra: Partial<BotSidebarRow<string>> = {}): BotSidebarRow<string> {
  return { kind: 'bot', id, value: id, tie: id, ...extra };
}

function room(id: string): RoomSidebarRow<string> {
  return { kind: 'room', id, value: id };
}

function idsOf(rows: readonly { kind: string; id: string }[]): string[] {
  return rows.map((row) => `${row.kind}:${row.id}`);
}

const fresh: BotPinState = { customized: true, ids: ['a', 'b'], roomIds: ['jarvis'] };

test('同一区域内拖拽后的顺序能保存，置顶和分组归属不变 [AC:bot-sidebar-order#AC-1]', () => {
  const pinMoved = moveSidebarItem(
    [{ kind: 'bot', id: 'a' }, { kind: 'bot', id: 'b' }, { kind: 'room', id: 'jarvis' }],
    { kind: 'room', id: 'jarvis' },
    { kind: 'bot', id: 'a' },
    'before'
  );
  assert.deepEqual(pinMoved, [
    { kind: 'room', id: 'jarvis' },
    { kind: 'bot', id: 'a' },
    { kind: 'bot', id: 'b' }
  ]);
  const pinState = withRegionOrder(fresh, { type: 'pin' }, pinMoved!);
  assert.deepEqual(pinState.ids, ['a', 'b']);
  assert.deepEqual(pinState.roomIds, ['jarvis']);
  assert.deepEqual(idsOf(arrangeSidebarRows([bot('a'), bot('b')], [room('jarvis')], savedRegionRefs(pinState, { type: 'pin' }))), [
    'room:jarvis',
    'bot:a',
    'bot:b'
  ]);

  const membership = [
    { id: 'dev', name: '开发', botIds: ['a', 'b'], roomIds: ['jarvis'] },
    { id: 'life', name: '生活', botIds: [] as string[], roomIds: [] as string[] }
  ];
  const before = structuredClone(membership);
  const groupMoved = moveSidebarItem(
    [{ kind: 'bot', id: 'a' }, { kind: 'room', id: 'jarvis' }, { kind: 'bot', id: 'b' }],
    { kind: 'bot', id: 'b' },
    { kind: 'bot', id: 'a' },
    'before'
  );
  const grouped = withRegionOrder(pinState, { type: 'group', id: 'dev' }, groupMoved!);
  assert.deepEqual(membership, before);
  assert.deepEqual(idsOf(arrangeSidebarRows(
    [bot('a'), bot('b')],
    [room('jarvis')],
    savedRegionRefs(grouped, { type: 'group', id: 'dev' })
  )), ['bot:b', 'bot:a', 'room:jarvis']);
  assert.deepEqual(moveBotInGroups(membership, 'b', 'life').map((group) => group.botIds), [['a'], ['b']]);

  const ungrouped = withRegionOrder(grouped, { type: 'ungrouped' }, [
    { kind: 'bot', id: 'd' },
    { kind: 'bot', id: 'c' }
  ]);
  assert.deepEqual(savedRegionRefs(ungrouped, { type: 'ungrouped' }), [
    { kind: 'bot', id: 'd' },
    { kind: 'bot', id: 'c' }
  ]);
  const loose = withRegionOrder(ungrouped, { type: 'looseRooms' }, [
    { kind: 'room', id: 'other' },
    { kind: 'room', id: 'jarvis' }
  ]);
  assert.deepEqual(savedRegionRefs(loose, { type: 'looseRooms' })?.map((ref) => ref.id), ['other', 'jarvis']);

  const pinned = nextStateAfterPinDrop(
    { customized: false, ids: [], roomIds: [], orders: loose.orders },
    [{ id: 'super', name: 'Super Bot', builtin: true }, { id: 'desk', name: 'DeskBot' }],
    'desk'
  );
  assert.ok(pinned);
  assert.equal(pinned.ids.includes('desk'), true);
  assert.equal(pinned.ids.includes('super'), true);
  assert.deepEqual(pinned.orders?.groups?.dev?.map((ref) => ref.id), ['b', 'a', 'jarvis']);

  const pinView = readFileSync(new URL('../components/BotPinArea.tsx', import.meta.url), 'utf8');
  const groupsView = readFileSync(new URL('../components/BotFunctionalGroups.tsx', import.meta.url), 'utf8');
  const looseView = readFileSync(new URL('../components/play-group/PlayBotGroupList.tsx', import.meta.url), 'utf8');
  const rail = readFileSync(new URL('../components/shell/Rail.tsx', import.meta.url), 'utf8');
  for (const source of [pinView, groupsView, looseView]) {
    assert.match(source, /arrangeSidebarRows\(/);
    assert.match(source, /commitRegionOrder\(/);
  }
  assert.match(groupsView, /moveBotInGroups\(/);
  assert.match(groupsView, /moveRoomInGroups\(/);
  assert.match(looseView, /looseRooms\(/);
  assert.equal(rail.includes('arrangeSidebarRows'), false);
  assert.equal(rail.includes('commitRegionOrder'), false);
  assert.notEqual(zh.play.sidebar.reorder, en.play.sidebar.reorder);
});

test('刷新后拖拽顺序还在 [AC:bot-sidebar-order#AC-2]', () => {
  const storage = memoryStorage();
  const saved = withRegionOrder(
    withRegionOrder(fresh, { type: 'pin' }, [
      { kind: 'room', id: 'jarvis' },
      { kind: 'bot', id: 'b' },
      { kind: 'bot', id: 'a' }
    ]),
    { type: 'group', id: 'dev' },
    [{ kind: 'bot', id: 'b' }, { kind: 'bot', id: 'a' }]
  );
  const withLoose = withRegionOrder(saved, { type: 'ungrouped' }, [
    { kind: 'bot', id: 'c' },
    { kind: 'bot', id: 'a' }
  ]);
  saveBotPinState(withLoose, storage);
  assert.equal(storage.data.has(BOT_PIN_STORAGE_KEY), true);

  const loaded = loadBotPinState(storage);
  assert.deepEqual(savedRegionRefs(loaded, { type: 'pin' }), [
    { kind: 'room', id: 'jarvis' },
    { kind: 'bot', id: 'b' },
    { kind: 'bot', id: 'a' }
  ]);
  assert.deepEqual(savedRegionRefs(loaded, { type: 'group', id: 'dev' }), [
    { kind: 'bot', id: 'b' },
    { kind: 'bot', id: 'a' }
  ]);
  assert.deepEqual(idsOf(arrangeSidebarRows(
    [bot('a', { createdAt: '2026-01-01', updatedAt: '2026-10-01', status: 'running' }), bot('c'), bot('b')],
    [],
    savedRegionRefs(loaded, { type: 'ungrouped' })
  )), ['bot:c', 'bot:a', 'bot:b']);
});

test('新消息和执行中不会打乱已保存顺序 [AC:bot-sidebar-order#AC-3]', () => {
  const running = bot('a', { createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', status: 'running' });
  const quiet = bot('b', { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', status: 'idle' });
  const saved: SidebarRef[] = [{ kind: 'bot', id: 'b' }, { kind: 'bot', id: 'a' }];
  assert.deepEqual(idsOf(arrangeSidebarRows(sortBotRows([running, quiet]), [], saved)), ['bot:b', 'bot:a']);
  assert.deepEqual(idsOf(arrangeSidebarRows([running, quiet], [room('jarvis')], saved)), ['bot:b', 'bot:a', 'room:jarvis']);
  assert.deepEqual(sortBotRows([running, quiet]).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(sortBotRows([quiet, running]).map((row) => row.id), ['a', 'b']);
});

test('新 Bot 或群聊出现在已保存顺序的末尾 [AC:bot-sidebar-order#AC-4]', () => {
  const saved: SidebarRef[] = [{ kind: 'bot', id: 'b' }, { kind: 'bot', id: 'a' }];
  const newbie = bot('c', { createdAt: '2019-01-01T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', status: 'running' });
  assert.deepEqual(idsOf(arrangeSidebarRows(sortBotRows([bot('a'), bot('b'), newbie]), [], saved)), ['bot:b', 'bot:a', 'bot:c']);
  assert.deepEqual(idsOf(arrangeSidebarRows([bot('b'), bot('a')], [room('jarvis')], saved)), ['bot:b', 'bot:a', 'room:jarvis']);

  const stored = withRegionOrder({ customized: true, ids: ['a', 'b'], roomIds: [] }, { type: 'group', id: 'dev' }, saved);
  const left = forgetRegionRef(stored, { type: 'group', id: 'dev' }, { kind: 'bot', id: 'a' });
  assert.deepEqual(idsOf(arrangeSidebarRows([bot('a'), bot('b')], [], savedRegionRefs(left, { type: 'group', id: 'dev' }))), [
    'bot:b',
    'bot:a'
  ]);

  const pins = withRegionOrder({ customized: true, ids: ['a', 'b'], roomIds: [] }, { type: 'pin' }, [
    { kind: 'bot', id: 'a' },
    { kind: 'bot', id: 'b' }
  ]);
  const unpinned = unpinBot(pins, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'a');
  const returned = pinBot(unpinned, 'a');
  assert.deepEqual(idsOf(arrangeSidebarRows([bot('b'), bot('a')], [], savedRegionRefs(returned, { type: 'pin' }))), [
    'bot:b',
    'bot:a'
  ]);
  assert.deepEqual(regionRefs([bot('b'), bot('a')]).map((ref) => ref.id), ['b', 'a']);
});
