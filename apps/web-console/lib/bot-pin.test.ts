import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_PIN_STORAGE_KEY,
  displayPinnedIds,
  loadBotPinState,
  pinBot,
  saveBotPinState,
  superBotId,
  unpinBot,
  type BotPinState
} from './bot-pin.ts';

type Bot = { id: string; name: string; builtin?: boolean };

const superBot: Bot = { id: 'super', name: 'Super Bot', builtin: true };
const desk: Bot = { id: 'desk', name: 'DeskBot' };
const xiaoba: Bot = { id: 'xiaoba', name: '小八' };

function memoryStorage(initial?: string | null) {
  const data = new Map<string, string>();
  if (typeof initial === 'string') data.set(BOT_PIN_STORAGE_KEY, initial);
  return {
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    }
  };
}

function names(bots: Bot[], ids: string[]): string[] {
  return ids.map((id) => bots.find((bot) => bot.id === id)?.name ?? id);
}

test('a new visitor sees Super Bot pinned and only that bot [AC:bot-pin-area#AC-3]', () => {
  const bots = [desk, superBot, xiaoba];
  const storage = memoryStorage();
  const state = loadBotPinState(storage);

  assert.deepEqual(state, { customized: false, ids: [] });
  assert.equal(superBotId(bots), 'super');
  assert.deepEqual(displayPinnedIds(bots, state), ['super']);
  assert.deepEqual(names(bots, displayPinnedIds(bots, state)), ['Super Bot']);
});

test('several bots named Super Bot prefer the builtin one [AC:bot-pin-area#AC-3]', () => {
  const bots: Bot[] = [
    { id: 'copy', name: 'Super Bot' },
    { id: 'boss', name: 'Super Bot', builtin: true },
    { id: 'other', name: 'super bot' }
  ];
  assert.equal(superBotId(bots), 'boss');
  assert.deepEqual(displayPinnedIds(bots, { customized: false, ids: [] }), ['boss']);
  assert.equal(superBotId([{ id: 'none', name: 'DeskBot' }]), null);
  assert.deepEqual(displayPinnedIds([{ id: 'none', name: 'DeskBot' }], { customized: false, ids: [] }), []);
});

test('dragging a bot into the pin area keeps existing pins and does not duplicate [AC:bot-pin-area#AC-2]', () => {
  const bots = [superBot, desk, xiaoba];
  const storage = memoryStorage();
  const start: BotPinState = { customized: true, ids: ['super', 'desk'] };

  const pinned = pinBot(pinBot(start, 'xiaoba'), 'xiaoba');
  saveBotPinState(pinned, storage);
  const reloaded = loadBotPinState(storage);

  assert.equal(pinned.customized, true);
  assert.deepEqual(displayPinnedIds(bots, pinned), ['super', 'desk', 'xiaoba']);
  assert.deepEqual(displayPinnedIds(bots, reloaded), ['super', 'desk', 'xiaoba']);
  assert.deepEqual(names(bots, displayPinnedIds(bots, reloaded)), ['Super Bot', 'DeskBot', '小八']);
  assert.equal(displayPinnedIds(bots, reloaded).filter((id) => id === 'xiaoba').length, 1);
});

test('a pinned bot stays after refresh and a missing bot is dropped without bringing Super Bot back [AC:bot-pin-area#AC-2]', () => {
  const bots = [superBot, desk];
  const storage = memoryStorage();
  saveBotPinState(pinBot({ customized: false, ids: [] }, 'desk'), storage);

  const refreshed = loadBotPinState(storage);
  assert.deepEqual(displayPinnedIds(bots, refreshed), ['desk']);

  const gone = displayPinnedIds([superBot], refreshed);
  assert.deepEqual(gone, []);
});

test('unpinning Super Bot before any custom pin keeps it out after refresh [AC:bot-pin-area#AC-4]', () => {
  const bots = [superBot, desk, xiaoba];
  const storage = memoryStorage();
  const fresh = loadBotPinState(storage);
  assert.deepEqual(displayPinnedIds(bots, fresh), ['super']);

  const unpinned = unpinBot(fresh, bots, 'super');
  saveBotPinState(unpinned, storage);
  const refreshed = loadBotPinState(storage);

  assert.equal(unpinned.customized, true);
  assert.deepEqual(displayPinnedIds(bots, refreshed), []);
  assert.equal(displayPinnedIds(bots, refreshed).includes('super'), false);
});

test('dragging a bot out does not put Super Bot back [AC:bot-pin-area#AC-4]', () => {
  const bots = [superBot, desk, xiaoba];
  const storage = memoryStorage();
  const pinned = pinBot(pinBot({ customized: true, ids: ['desk'] }, 'xiaoba'), 'xiaoba');
  const unpinned = unpinBot(pinned, bots, 'xiaoba');
  saveBotPinState(unpinned, storage);
  const refreshed = loadBotPinState(storage);

  assert.deepEqual(displayPinnedIds(bots, refreshed), ['desk']);
  assert.equal(displayPinnedIds(bots, refreshed).includes('super'), false);

  const cleared = unpinBot({ customized: true, ids: ['super', 'desk'] }, bots, 'super');
  assert.deepEqual(displayPinnedIds(bots, cleared), ['desk']);
});

test('missing or corrupt pin storage is treated as never customized [AC:bot-pin-area#AC-3]', () => {
  const bots = [desk, superBot];
  const samples = [
    memoryStorage(),
    memoryStorage(''),
    memoryStorage('not-json'),
    memoryStorage('[]'),
    memoryStorage('{"customized":true}'),
    memoryStorage('{"customized":"yes","ids":[]}'),
    memoryStorage('{"customized":true,"ids":[1]}'),
    memoryStorage('{"ids":["desk"]}'),
    {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('quota');
      }
    }
  ];

  for (const storage of samples) {
    const state = loadBotPinState(storage);
    assert.deepEqual(state, { customized: false, ids: [] });
    assert.deepEqual(displayPinnedIds(bots, state), ['super']);
  }

  const flaky = samples[samples.length - 1]!;
  assert.doesNotThrow(() => saveBotPinState({ customized: true, ids: ['desk'] }, flaky));
  assert.equal(BOT_PIN_STORAGE_KEY, 'lab.botPins');
});
