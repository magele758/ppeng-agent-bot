import assert from 'node:assert/strict';
import test from 'node:test';
import { armedDeleteAction } from './armed-delete.ts';

test('第一次点击只进入确认，不删除 [AC:remove-needs-confirm#AC-1]', () => {
  assert.equal(armedDeleteAction(false), 'arm');
});

test('确认后再点一次才删除 [AC:remove-needs-confirm#AC-2]', () => {
  assert.equal(armedDeleteAction(true), 'delete');
});
