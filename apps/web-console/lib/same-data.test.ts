import assert from 'node:assert/strict';
import test from 'node:test';
import { sameData } from './same-data.ts';

test('sameData keeps an unchanged poll snapshot', () => {
  assert.equal(sameData([{ id: 'a', n: 1 }], [{ id: 'a', n: 1 }]), true);
  assert.equal(sameData([], []), true);
  assert.equal(sameData(null, null), true);
  assert.equal(sameData([{ id: 'a' }], [{ id: 'b' }]), false);
  assert.equal(sameData({ ok: true }, { ok: false }), false);
});
