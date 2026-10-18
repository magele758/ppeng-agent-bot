import assert from 'node:assert/strict';
import test from 'node:test';
import { dialogTabTarget, nextMenuIndex } from './entry-navigation.ts';

test('create menu keyboard navigation enters, wraps and jumps to bounds', () => {
  assert.equal(nextMenuIndex('ArrowDown', -1, 3), 0);
  assert.equal(nextMenuIndex('ArrowUp', -1, 3), 2);
  assert.equal(nextMenuIndex('ArrowDown', 2, 3), 0);
  assert.equal(nextMenuIndex('ArrowUp', 0, 3), 2);
  assert.equal(nextMenuIndex('ArrowDown', 0, 3), 1);
  assert.equal(nextMenuIndex('Home', 2, 3), 0);
  assert.equal(nextMenuIndex('End', 0, 3), 2);
  assert.equal(nextMenuIndex('ArrowDown', -1, 0), -1);
});

test('dialog tabbing traps only boundaries and restores focus entering from outside', () => {
  const items = [{ id: 'name' }, { id: 'face' }, { id: 'cancel' }];
  assert.equal(dialogTabTarget(items, items[0], true, true), items[2]);
  assert.equal(dialogTabTarget(items, items[2], true, false), items[0]);
  assert.equal(dialogTabTarget(items, items[1], true, false), null);
  assert.equal(dialogTabTarget(items, items[1], true, true), null);
  assert.equal(dialogTabTarget(items, null, false, false), items[0]);
  assert.equal(dialogTabTarget(items, null, false, true), items[2]);
  assert.equal(dialogTabTarget([], null, false, false), null);
});
