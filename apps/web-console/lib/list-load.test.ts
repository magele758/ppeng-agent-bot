import test from 'node:test';
import assert from 'node:assert/strict';
import { idleLabListState, settleList } from './list-load.ts';

test('settleList keeps previous rows and marks an error when the request fails', () => {
  const idle = idleLabListState().tasks;
  const first = settleList(['a'], idle, { ok: false });
  assert.deepEqual(first.items, ['a']);
  assert.deepEqual(first.state, { loaded: false, error: true });

  const loaded = settleList(['a'], { loaded: true, error: false }, { ok: false });
  assert.deepEqual(loaded.items, ['a']);
  assert.deepEqual(loaded.state, { loaded: true, error: true });
});

test('settleList replaces rows after a successful response, including an empty list', () => {
  const failed = { loaded: true, error: true };
  const next = settleList(['stale'], failed, { ok: true, items: [] });
  assert.deepEqual(next.items, []);
  assert.deepEqual(next.state, { loaded: true, error: false });
});
