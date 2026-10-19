import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import {
  BOT_DRAG_MIME,
  BOT_PIN_DRAG_MIME,
  commitBotPinState,
  getBotPinSnapshot,
  nextStateAfterPinDragEnd,
  nextStateAfterPinDrop,
  pinDragKind,
  resultOfPinAreaDrop,
  visiblePinnedBots
} from './bot-pin-area.ts';
import { BOT_PIN_STORAGE_KEY, displayPinnedIds, loadBotPinState, type BotPinState } from './bot-pin.ts';

const superBot = { id: 'super', name: 'Super Bot', builtin: true, canonicalSessionId: 'sess-super' };
const desk = { id: 'desk', name: 'DeskBot', canonicalSessionId: 'sess-desk' };
const blank = { id: 'blank', name: '   ', canonicalSessionId: 'sess-blank' };
const hidden = { id: 'hidden', name: 'Hidden', hidden: true, canonicalSessionId: 'sess-hidden' };
const bots = [desk, superBot, blank, hidden];
const fresh: BotPinState = { customized: false, ids: [] };

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

test('pin area stays above functional groups and does not accept a room [AC:bot-pin-area#AC-1]', () => {
  const play = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');
  const pin = play.indexOf('<BotPinArea');
  const rooms = play.indexOf('<PlayBotGroupList');
  const groups = play.indexOf('<BotFunctionalGroups');
  assert.ok(pin > 0 && rooms > pin && groups > rooms);
  const groupList = readFileSync(new URL('../components/play-group/PlayBotGroupList.tsx', import.meta.url), 'utf8');
  assert.match(groupList, /draggable=\{false\}/);
  const names = visiblePinnedBots(bots, { customized: true, ids: ['room-1', 'super'] }).map((bot) => bot.name);
  assert.deepEqual(names, ['Super Bot']);
  assert.equal(names.includes('room-1'), false);
});

test('dragging a bot in keeps Super Bot, skips duplicates, and reloads in the same groups [AC:bot-pin-area#AC-2]', () => {
  const storage = memoryStorage();
  const groups = [{ id: 'home', botIds: ['desk'] }];
  const before = structuredClone(groups);
  const once = nextStateAfterPinDrop(fresh, bots, 'desk');
  assert.ok(once);
  assert.deepEqual(displayPinnedIds(bots, once), ['super', 'desk']);
  const twice = nextStateAfterPinDrop(once, bots, 'desk');
  assert.ok(twice);
  assert.deepEqual(displayPinnedIds(bots, twice).filter((id) => id === 'desk'), ['desk']);
  assert.equal(displayPinnedIds(bots, twice).includes('super'), true);
  storage.setItem(BOT_PIN_STORAGE_KEY, JSON.stringify(twice));
  assert.deepEqual(displayPinnedIds(bots, loadBotPinState(storage)), ['super', 'desk']);
  assert.deepEqual(groups, before);
});

test('a new visitor sees only Super Bot and empty storage stays untouched [AC:bot-pin-area#AC-3]', () => {
  const shown = visiblePinnedBots(bots, fresh);
  assert.deepEqual(shown.map((bot) => bot.name), ['Super Bot']);
  assert.equal(shown[0]?.id, 'super');
  assert.equal(loadBotPinState(memoryStorage()).customized, false);
});

test('dragging a pin out keeps it out, including Super Bot [AC:bot-pin-area#AC-4]', () => {
  const storage = memoryStorage();
  const pinned = nextStateAfterPinDrop(fresh, bots, 'desk');
  assert.ok(pinned);
  const left = nextStateAfterPinDragEnd(pinned, bots, 'desk', false);
  assert.ok(left);
  storage.setItem(BOT_PIN_STORAGE_KEY, JSON.stringify(left));
  const reloaded = loadBotPinState(storage);
  assert.equal(reloaded.customized, true);
  assert.deepEqual(displayPinnedIds(bots, reloaded), ['super']);
  assert.equal(nextStateAfterPinDragEnd(pinned, bots, 'desk', true), null);

  const cleared = nextStateAfterPinDragEnd(fresh, bots, 'super', false);
  assert.ok(cleared);
  storage.setItem(BOT_PIN_STORAGE_KEY, JSON.stringify(cleared));
  assert.deepEqual(displayPinnedIds(bots, loadBotPinState(storage)), []);
});

test('text, files, blank names and drops that are not a bot do not create pin items [AC:bot-pin-area#AC-6]', () => {
  const text = resultOfPinAreaDrop(fresh, bots, ['text/plain'], 'loose text');
  const file = resultOfPinAreaDrop(fresh, bots, ['Files'], '');
  const outside = resultOfPinAreaDrop(fresh, bots, [], '');
  const missing = resultOfPinAreaDrop(fresh, bots, [BOT_DRAG_MIME], 'room-1');
  const nameless = resultOfPinAreaDrop(fresh, bots, [BOT_DRAG_MIME], 'blank');
  assert.equal(text.next, null);
  assert.equal(file.next, null);
  assert.equal(outside.accept, false);
  assert.equal(missing.next, null);
  assert.equal(nameless.next, null);
  const shown = visiblePinnedBots(bots, { customized: true, ids: ['', 'blank', 'missing', 'desk', 'desk'] });
  assert.deepEqual(shown.map((bot) => bot.name), ['DeskBot']);
  assert.equal(shown.every((bot) => bot.name.trim().length > 0), true);
  assert.equal(pinDragKind(['text/plain']), 'foreign');
  assert.equal(pinDragKind(['Files', BOT_DRAG_MIME]), 'foreign');
  assert.equal(pinDragKind([BOT_PIN_DRAG_MIME]), 'pin');
});

test('pin chrome follows the active language and does not translate Super Bot [AC:bot-pin-area#AC-7]', () => {
  for (const key of ['title', 'empty', 'hint'] as const) {
    assert.notEqual(zh.play.pin[key], en.play.pin[key]);
    assert.equal(zh.play.pin[key].includes('Super Bot'), false);
    assert.equal(en.play.pin[key].includes('Super Bot'), false);
    assert.equal(zh.play.pin[key].includes(en.play.pin[key]), false);
    assert.equal(en.play.pin[key].includes(zh.play.pin[key]), false);
  }
  assert.match(zh.play.pin.title, /\p{Script=Han}/u);
  assert.doesNotMatch(en.play.pin.title, /\p{Script=Han}/u);
  assert.match(zh.play.pin.empty, /\p{Script=Han}/u);
  assert.doesNotMatch(en.play.pin.empty, /\p{Script=Han}/u);
  assert.match(en.play.pin.empty, /[A-Za-z]/);
});

test('commitBotPinState writes the list the bot page reloads [AC:bot-pin-area#AC-2]', () => {
  const previous = globalThis.localStorage;
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }
    }
  });
  try {
    const next = nextStateAfterPinDrop(fresh, bots, 'desk');
    assert.ok(next);
    commitBotPinState(next);
    assert.deepEqual(displayPinnedIds(bots, getBotPinSnapshot()), ['super', 'desk']);
    assert.deepEqual(displayPinnedIds(bots, loadBotPinState()), ['super', 'desk']);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
