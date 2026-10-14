import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationGuard } from './bot-console-selection.ts';
import {
  ownedByBot,
  pauseChange,
  readBotPanel,
  shownPause,
  shownRows
} from './bot-panel-reset.ts';

const clearedPause = { paused: false, disabled: false };

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function generation() {
  const generations = createGenerationGuard();
  return {
    begin: () => generations.begin(),
    isCurrent: (value: number) => generations.isCurrent(value),
    invalidate: () => generations.invalidate()
  };
}

async function readAfterSwitch<T>(previous: T, next: T): Promise<{ late: T | null; current: T | null }> {
  const generations = generation();
  let selected = 'bot-a';
  const hold = gate();
  const late = readBotPanel({
    selectedBotId: () => selected,
    requestedBotId: 'bot-a',
    begin: generations.begin,
    isCurrent: generations.isCurrent,
    read: async () => {
      await hold.promise;
      return previous;
    }
  });
  selected = 'bot-b';
  generations.invalidate();
  const current = readBotPanel({
    selectedBotId: () => selected,
    requestedBotId: 'bot-b',
    begin: generations.begin,
    isCurrent: generations.isCurrent,
    read: async () => next
  });
  hold.open();
  return { late: await late, current: await current };
}

test('switching bots clears memory rows, the editor, and source context [AC:bot-panel-reset#AC-1]', () => {
  const entries = [{ id: 'mem-a' }];
  const draft = { id: 'mem-a', value: 'from-a' };
  const context = { text: 'from-a' };
  assert.deepEqual(shownRows('bot-a', 'bot-a', entries).map((row) => row.id), ['mem-a']);
  assert.equal(ownedByBot('bot-a', 'bot-a', draft)?.id, 'mem-a');
  assert.deepEqual(ownedByBot('bot-a', 'bot-a', context), context);

  assert.deepEqual(shownRows('bot-b', 'bot-a', entries), []);
  assert.equal(ownedByBot('bot-b', 'bot-a', draft), null);
  assert.equal(ownedByBot('bot-b', 'bot-a', context), null);
});

test('a late memory response does not replace the selected bot or cancel its load [AC:bot-panel-reset#AC-2]', async () => {
  const switched = await readAfterSwitch([{ id: 'mem-a' }], [{ id: 'mem-b' }]);
  assert.equal(switched.late, null);
  assert.deepEqual(switched.current, [{ id: 'mem-b' }]);
  assert.deepEqual(shownRows('bot-b', 'bot-a', [{ id: 'mem-a' }]), []);

  const generations = generation();
  let selected = 'bot-a';
  const hold = gate();
  const lateError = readBotPanel({
    selectedBotId: () => selected,
    requestedBotId: 'bot-a',
    begin: generations.begin,
    isCurrent: generations.isCurrent,
    read: async () => {
      await hold.promise;
      throw new Error('previous bot failed');
    }
  });
  selected = 'bot-b';
  generations.invalidate();
  hold.open();
  assert.equal(await lateError, null);

  const stillSelected = 'bot-b';
  const kept = generations.begin();
  const staleRefresh = await readBotPanel({
    selectedBotId: () => stillSelected,
    requestedBotId: 'bot-a',
    begin: generations.begin,
    isCurrent: generations.isCurrent,
    read: async () => [{ id: 'mem-a' }]
  });
  assert.equal(staleRefresh, null);
  assert.equal(generations.isCurrent(kept), true);

  const cancelled = new AbortController();
  cancelled.abort();
  const dropped = await readBotPanel({
    selectedBotId: () => stillSelected,
    requestedBotId: stillSelected,
    begin: generations.begin,
    isCurrent: generations.isCurrent,
    signal: cancelled.signal,
    read: async () => [{ id: 'mem-b-stale' }]
  });
  assert.equal(dropped, null);
  assert.equal(generations.isCurrent(kept), true);

  const openGenerations = generation();
  let moving = 'bot-a';
  const holdOpen = gate();
  const lateWhileSelected = readBotPanel({
    selectedBotId: () => moving,
    requestedBotId: 'bot-a',
    begin: openGenerations.begin,
    isCurrent: openGenerations.isCurrent,
    read: async () => {
      await holdOpen.promise;
      return [{ id: 'mem-a' }];
    }
  });
  moving = 'bot-b';
  holdOpen.open();
  assert.equal(await lateWhileSelected, null);
  assert.deepEqual(shownRows(moving, 'bot-a', [{ id: 'mem-a' }]), []);
});

test('the pause and disable switches reset before the next bot control returns [AC:bot-panel-reset#AC-3]', () => {
  const control = { paused: true, disabled: true };
  assert.deepEqual(shownPause('bot-a', 'bot-a', control), control);
  assert.deepEqual(shownPause('bot-b', 'bot-a', control), clearedPause);
  assert.equal(
    pauseChange({ selectedBotId: 'bot-b', loadedBotId: 'bot-a', control, paused: false }),
    null
  );
  assert.equal(
    pauseChange({ selectedBotId: 'bot-b', loadedBotId: 'bot-a', control, disabled: false }),
    null
  );
});

test('a late pause response cannot be saved onto the selected bot [AC:bot-panel-reset#AC-4]', async () => {
  const switched = await readAfterSwitch(
    { paused: true, disabled: true },
    { paused: false, disabled: false }
  );
  assert.equal(switched.late, null);
  assert.deepEqual(shownPause('bot-b', 'bot-a', { paused: true, disabled: true }), clearedPause);
  assert.deepEqual(switched.current, { paused: false, disabled: false });
  assert.deepEqual(
    pauseChange({
      selectedBotId: 'bot-b',
      loadedBotId: 'bot-b',
      control: switched.current ?? clearedPause,
      paused: true
    }),
    { botId: 'bot-b', control: { paused: true, disabled: false } }
  );
});

test('switching bots clears software-connection rows and invocation rows [AC:bot-panel-reset#AC-5]', () => {
  const connections = [{ connectorId: 'mail' }];
  const invocations = [{ id: 'inv-a' }];
  assert.deepEqual(shownRows('bot-a', 'bot-a', connections), connections);
  assert.deepEqual(shownRows('bot-a', 'bot-a', invocations), invocations);
  assert.deepEqual(shownRows('bot-b', 'bot-a', connections), []);
  assert.deepEqual(shownRows('bot-b', 'bot-a', invocations), []);
});

test('a late software-connection response does not fill the selected bot [AC:bot-panel-reset#AC-6]', async () => {
  const connections = await readAfterSwitch(
    [{ connectorId: 'mail' }],
    [{ connectorId: 'calendar' }]
  );
  assert.equal(connections.late, null);
  assert.deepEqual(connections.current, [{ connectorId: 'calendar' }]);
  assert.deepEqual(shownRows('bot-b', 'bot-a', [{ connectorId: 'mail' }]), []);

  const invocations = await readAfterSwitch([{ id: 'inv-a' }], [{ id: 'inv-b' }]);
  assert.equal(invocations.late, null);
  assert.deepEqual(invocations.current, [{ id: 'inv-b' }]);
  assert.deepEqual(shownRows('bot-b', 'bot-a', [{ id: 'inv-a' }]), []);

  const generations = generation();
  const kept = generations.begin();
  const stale = await readBotPanel({
    selectedBotId: () => 'bot-b',
    requestedBotId: 'bot-a',
    begin: generations.begin,
    isCurrent: generations.isCurrent,
    read: async () => [{ connectorId: 'mail' }]
  });
  assert.equal(stale, null);
  assert.equal(generations.isCurrent(kept), true);
});
