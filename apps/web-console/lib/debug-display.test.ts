import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDebugDisplay } from './debug-display.ts';

test('debug display is opt-in [AC:global-debug-visibility#AC-1]', () => {
  for (const value of [null, undefined, '', '0', 'true', 'invalid']) assert.equal(parseDebugDisplay(value), false);
  assert.equal(parseDebugDisplay('1'), true);
});
test('all chat diagnostics share the debug gate [AC:global-debug-visibility#AC-1]', () => {
  const source = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');
  for (const name of ['GoalStatusCard', 'GoalHistory', 'BotGoals', 'ChatStopReasonFooter']) {
    assert.match(source, new RegExp(`<DebugOnly><${name}\\b[^]*?</DebugOnly>`));
  }
  assert.match(source, /<DebugOnly><button[^]*?onClick=\{onOpenTrace\}[^]*?<\/button><\/DebugOnly>/);
});

test('successful saves update all subscribers; failures preserve visibility [AC:global-debug-visibility#AC-2]', async () => {
  const { readDebugDisplay, saveDebugDisplay, subscribeDebugDisplay } = await import('./debug-display.ts');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const cache = new Map<string, string>();
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(target, {
    localStorage: { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value) }
  }) });
  // Node has no StorageEvent; same-tab notification is sufficient here.
  const oldStorageEvent = Object.getOwnPropertyDescriptor(globalThis, 'StorageEvent');
  Object.defineProperty(globalThis, 'StorageEvent', { configurable: true, value: Event });
  let updates = 0;
  const unsubscribe = subscribeDebugDisplay(() => updates++);
  try {
    const request = async (path: string, init?: RequestInit) => {
      assert.equal(path, '/api/user/preferences');
      assert.equal(init?.method, 'PATCH');
      return { values: JSON.parse(String(init?.body)).values };
    };
    assert.equal(readDebugDisplay(), false);
    await saveDebugDisplay(true, request);
    assert.equal(readDebugDisplay(), true);
    assert.ok(updates > 0);
    await assert.rejects(saveDebugDisplay(false, async () => { throw new Error('offline'); }));
    assert.equal(readDebugDisplay(), true);
    await saveDebugDisplay(false, request);
    assert.equal(readDebugDisplay(), false);
  } finally {
    unsubscribe();
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorageEvent) Object.defineProperty(globalThis, 'StorageEvent', oldStorageEvent); else Reflect.deleteProperty(globalThis, 'StorageEvent');
  }
});
