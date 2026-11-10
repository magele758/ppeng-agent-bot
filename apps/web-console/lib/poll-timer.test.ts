import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadGate, nextPollDelay, startPollTimer, type PollClock, type VisibilitySource } from './poll-timer.ts';

function fakeClock() {
  let nowMs = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: PollClock = {
    setTimeout: (run, ms) => {
      const id = next++;
      timers.set(id, { at: nowMs + ms, run });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    }
  };
  /** Advance time, running due timers in order and letting each read settle. */
  async function advance(ms: number) {
    const end = nowMs + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      nowMs = due[1].at;
      due[1].run();
      await settle();
    }
    nowMs = end;
  }
  return { clock, advance, pending: () => timers.size };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function fakeVisibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const source: VisibilitySource = {
    hidden: () => hidden,
    subscribe: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    }
  };
  return {
    source,
    set(next: boolean) {
      hidden = next;
      for (const changed of [...listeners]) changed();
    },
    listeners
  };
}

test('reads at once, then again after each interval', async () => {
  const { clock, advance } = fakeClock();
  let reads = 0;
  const stop = startPollTimer({ run: () => { reads += 1; }, delayMs: () => 2000, clock, visibility: fakeVisibility().source });
  await settle();
  assert.equal(reads, 1);
  await advance(6000);
  assert.equal(reads, 4);
  stop();
  await advance(6000);
  assert.equal(reads, 4);
});

test('the next read is scheduled only after the previous one returned [AC:lab-startup-request-load#AC-15]', async () => {
  const { clock, advance, pending } = fakeClock();
  let reads = 0;
  let release = () => {};
  const stop = startPollTimer({
    run: () => {
      reads += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    delayMs: () => 2000,
    clock,
    visibility: fakeVisibility().source
  });
  await settle();
  await advance(10_000);
  assert.equal(reads, 1, 'a slow read has nothing stacked behind it');
  assert.equal(pending(), 0);
  release();
  await settle();
  await advance(1999);
  assert.equal(reads, 1);
  await advance(1);
  assert.equal(reads, 2, 'the interval counts from when the previous read ended');
  stop();
});

test('a failed read still schedules the next one [AC:lab-startup-request-load#AC-15]', async () => {
  const { clock, advance } = fakeClock();
  let reads = 0;
  const stop = startPollTimer({
    run: () => { reads += 1; return Promise.reject(new Error('down')); },
    delayMs: () => 1000,
    clock,
    visibility: fakeVisibility().source
  });
  await settle();
  await advance(2000);
  assert.equal(reads, 3);
  stop();
});

test('a hidden tab stops reading and reads at once when shown again [AC:lab-startup-request-load#AC-10]', async () => {
  const { clock, advance } = fakeClock();
  const visibility = fakeVisibility();
  let reads = 0;
  const stop = startPollTimer({ run: () => { reads += 1; }, delayMs: () => 2000, clock, visibility: visibility.source });
  await settle();
  visibility.set(true);
  await advance(60_000);
  assert.equal(reads, 1, 'nothing is read while hidden');
  visibility.set(false);
  await settle();
  assert.equal(reads, 2, 'showing the tab reads immediately');
  await advance(4000);
  assert.equal(reads, 4, 'the usual pace resumes');
  stop();
  assert.equal(visibility.listeners.size, 0);
});

test('a read that must continue in a hidden tab slows down instead of stopping [AC:lab-startup-request-load#AC-10]', async () => {
  const { clock, advance } = fakeClock();
  const visibility = fakeVisibility();
  let reads = 0;
  const stop = startPollTimer({
    run: () => { reads += 1; },
    delayMs: () => 1000,
    hiddenDelayMs: () => 5000,
    clock,
    visibility: visibility.source
  });
  await settle();
  visibility.set(true);
  await advance(10_000);
  assert.equal(reads, 3);
  visibility.set(false);
  await settle();
  assert.equal(reads, 4);
  stop();
});

test('without an immediate read the first one waits one interval', async () => {
  const { clock, advance } = fakeClock();
  let reads = 0;
  const stop = startPollTimer({ run: () => { reads += 1; }, delayMs: () => 2800, immediate: false, clock, visibility: fakeVisibility().source });
  await settle();
  assert.equal(reads, 0);
  await advance(2800);
  assert.equal(reads, 1);
  stop();
});

test('a wake-up reads at once and the interval follows the new pace [AC:lab-startup-request-load#AC-12]', async () => {
  const { clock, advance } = fakeClock();
  let reads = 0;
  let pace = 6000;
  let wake = () => {};
  let unsubscribed = false;
  const stop = startPollTimer({
    run: () => { reads += 1; },
    delayMs: () => pace,
    wake: (readNow) => { wake = readNow; return () => { unsubscribed = true; }; },
    clock,
    visibility: fakeVisibility().source
  });
  await settle();
  await advance(3000);
  assert.equal(reads, 1);
  pace = 2000;
  wake();
  await settle();
  assert.equal(reads, 2, 'the change is read without waiting out the slow interval');
  await advance(4000);
  assert.equal(reads, 4);
  stop();
  assert.equal(unsubscribed, true);
});

test('nextPollDelay pauses a hidden tab unless a hidden pace is given', () => {
  assert.equal(nextPollDelay(false, () => 2000), 2000);
  assert.equal(nextPollDelay(true, () => 2000), undefined);
  assert.equal(nextPollDelay(true, () => 2000, () => 5000), 5000);
});

test('remote edits are read every fifteen seconds, local edits on the next check [AC:lab-startup-request-load#AC-14]', () => {
  let now = 0;
  let hidden = false;
  const gate = createReadGate(15_000, () => now, () => hidden);
  assert.equal(gate.due(false), true, 'the first check always reads');
  now = 3000;
  assert.equal(gate.due(false), false);
  assert.equal(gate.due(true), true, 'a pending local edit goes out now');
  now = 17_000;
  assert.equal(gate.due(false), false, 'the interval counts from the last exchange');
  now = 18_000;
  assert.equal(gate.due(false), true);
  hidden = true;
  now = 60_000;
  assert.equal(gate.due(false), false, 'a hidden tab does not pull remote edits');
  assert.equal(gate.due(true), true, 'but still pushes local ones');
  hidden = false;
  now = 76_000;
  assert.equal(gate.due(false), true);
});
