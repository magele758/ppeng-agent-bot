import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultBotLoadGuard,
  createGenerationGuard,
  defaultBotLoadMaySelect,
  loadSelectedBotDetail,
  rowsForSession,
  selectionForBot,
  startDefaultBotLoadEffect
} from './bot-console-selection.ts';

const botA = { id: 'bot-a', canonicalSessionId: 'sess-a' };
const botB = { id: 'bot-b', canonicalSessionId: 'sess-b' };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('switching bots shows the new session and hides the previous history before open returns [AC:bot-console-selection#AC-1]', () => {
  let selection = selectionForBot(botA);
  const loadedSessionId = selection.sessionId;
  const history = ['message-from-a'];
  assert.deepEqual(rowsForSession(selection.sessionId, loadedSessionId, history), ['message-from-a']);

  selection = selectionForBot(botB);
  assert.equal(selection.botId, 'bot-b');
  assert.equal(selection.sessionId, 'sess-b');
  assert.deepEqual(rowsForSession(selection.sessionId, loadedSessionId, history), []);
});

test('a late open for the previous bot does not replace the current session [AC:bot-console-selection#AC-2]', async () => {
  const generations = createGenerationGuard();
  let selection = selectionForBot(botA);
  const openA = deferred<string>();
  const generationA = generations.begin();
  const pendingA = loadSelectedBotDetail({
    botId: botA.id,
    generation: generationA,
    isCurrent: (generation) => generations.isCurrent(generation),
    openSession: () => openA.promise,
    readSettings: async () => {
      throw new Error('stale settings should not be read');
    }
  });

  generations.invalidate();
  selection = selectionForBot(botB);
  const openB = deferred<string>();
  const generationB = generations.begin();
  let settings: string | null = null;
  const pendingB = loadSelectedBotDetail({
    botId: botB.id,
    generation: generationB,
    isCurrent: (generation) => generations.isCurrent(generation),
    openSession: async (botId) => {
      assert.equal(botId, 'bot-b');
      return openB.promise;
    },
    readSettings: async (sessionId) => `settings:${sessionId}`
  });

  openA.resolve('sess-a-late');
  assert.equal((await pendingA).status, 'stale');
  assert.equal(selection.sessionId, 'sess-b');
  assert.equal(settings, null);

  openB.resolve('sess-b-opened');
  const ready = await pendingB;
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') return;
  assert.equal(generations.isCurrent(generationB), true);
  selection = { botId: botB.id, sessionId: ready.sessionId };
  settings = ready.settings;
  assert.equal(selection.sessionId, 'sess-b-opened');
  assert.equal(settings, 'settings:sess-b-opened');
  assert.equal(generations.isCurrent(generationA), false);
});

test('default bot load runs again after the first pass is cancelled [AC:bot-console-selection#AC-3]', async () => {
  const guard = createDefaultBotLoadGuard();
  const input = { playSurface: 'bot', botId: '', selectedSessionId: null };
  const selected: string[] = [];
  const firstGate = deferred<void>();
  const stopFirst = startDefaultBotLoadEffect(guard, input, async (isCancelled) => {
    await firstGate.promise;
    if (!isCancelled()) selected.push('first');
  });
  assert.equal(typeof stopFirst, 'function');
  assert.equal(guard.held, true);

  stopFirst();
  assert.equal(guard.held, false);

  const secondGate = deferred<void>();
  const stopSecond = startDefaultBotLoadEffect(guard, input, async (isCancelled) => {
    await secondGate.promise;
    if (!isCancelled()) selected.push('second');
  });
  assert.equal(typeof stopSecond, 'function');
  assert.equal(guard.held, true);

  firstGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard.held, true);
  assert.deepEqual(selected, []);

  secondGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected, ['second']);
  assert.equal(guard.held, false);
  stopSecond?.();
});

test('a click before the default Bot open starts keeps that chat [AC:bot-settings-flow#AC-12]', async () => {
  let selected: string | null = null;
  const selectionAtStart = selected;
  const arrived = deferred<void>();
  let opened = '';
  const load = (async () => {
    await arrived.promise;
    if (!defaultBotLoadMaySelect(selectionAtStart, selected, false)) return;
    opened = 'super-bot';
    selected = 'super-session';
  })();

  selected = 'alpha-session';
  arrived.resolve();
  await load;
  assert.equal(opened, '');
  assert.equal(selected, 'alpha-session');
  assert.equal(defaultBotLoadMaySelect(null, null, false), true);
  assert.equal(defaultBotLoadMaySelect(null, 'alpha-session', false), false);
  assert.equal(defaultBotLoadMaySelect(null, null, true), false);
});
