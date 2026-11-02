import assert from 'node:assert/strict';
import test from 'node:test';
import { shownGroupMembers } from './group-members.ts';

test('群头像最多拼四个成员 [AC:group-face#AC-1]', () => {
  const members = ['Ubuntu1 Bot', 'Ubuntu2 Bot', '4090 bot', 'macbook', 'Super Bot'];
  assert.deepEqual(shownGroupMembers(members), members.slice(0, 4));
  assert.deepEqual(shownGroupMembers(['只有一个']), ['只有一个']);
  assert.deepEqual(shownGroupMembers([]), []);
});
